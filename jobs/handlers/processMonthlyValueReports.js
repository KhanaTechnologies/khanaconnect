/**
 * Early each month, email every active client a short report of what the
 * platform did for them last month: paid orders, bookings, and revenue
 * recovered by cart reminders. Runs daily; each client is claimed atomically
 * for the month so a restart or a second instance never sends twice.
 */
const Client = require('../../models/client');
const { buildValueReport, previousMonthRange } = require('../../helpers/valueReport');
const { resolveBusinessEmail } = require('../../helpers/mailHost');
const { createSystemSmtpTransport, getSystemSmtpConfig, isSystemSmtpConfigured } = require('../../helpers/systemSmtpTransport');
const { decrypt } = require('../../helpers/encryption');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://khanatechnologies.co.za';
/** Only send during the first days of the month (catches up after downtime). */
const SEND_UNTIL_DAY = 7;

const zar = (n) => `R${Math.round(Number(n) || 0).toLocaleString('en-ZA')}`;
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hasActivity(r) {
  return r.orders.count > 0 || r.bookings.count > 0 || r.recoveredCarts.count > 0;
}

function renderEmail(client, report, monthLabel) {
  const rows = [];
  if (report.orders.count > 0) {
    rows.push(['Paid orders', `${report.orders.count} · ${zar(report.orders.revenue)}`]);
  }
  if (report.bookings.count > 0) {
    rows.push(['Bookings', String(report.bookings.count)]);
  }
  if (report.recoveredCarts.count > 0) {
    rows.push([
      'Recovered by cart reminders',
      `${zar(report.recoveredCarts.revenue)} from ${report.recoveredCarts.count} customer${report.recoveredCarts.count === 1 ? '' : 's'}`,
    ]);
  }

  const headline = report.recoveredCarts.revenue > 0
    ? `Cart reminders brought back ${zar(report.recoveredCarts.revenue)} in ${monthLabel}.`
    : `Here is how ${monthLabel} went on your Khana platform.`;

  const text = [
    `Hi ${client.companyName},`,
    '',
    headline,
    '',
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    `See the details in your dashboard: ${DASHBOARD_URL}/dashboard`,
    '',
    'Khana Technologies',
    'To stop these monthly reports, reply and let us know.',
  ].join('\n');

  const html = `<!doctype html><html><body style="margin:0;background:#f5f6f8;font-family:Arial,Helvetica,sans-serif;color:#1f2937">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td>
<p style="margin:0 0 4px;font-size:13px;color:#6b7280">Your ${esc(monthLabel)} report</p>
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.35">${esc(headline)}</h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 20px">
${rows.map(([k, v]) => `<tr><td style="padding:10px 0;border-bottom:1px solid #e5e7eb;font-size:14px;color:#4b5563">${esc(k)}</td><td align="right" style="padding:10px 0;border-bottom:1px solid #e5e7eb;font-size:15px;font-weight:bold">${esc(v)}</td></tr>`).join('\n')}
</table>
<a href="${esc(DASHBOARD_URL)}/dashboard" style="display:inline-block;background:#3b6fc9;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px">Open your dashboard</a>
<p style="margin:24px 0 0;font-size:12px;color:#9ca3af">Khana Technologies · To stop these monthly reports, reply and let us know.</p>
</td></tr></table></td></tr></table></body></html>`;

  return { subject: `${client.companyName}: your ${monthLabel} report`, text, html };
}

async function processMonthlyValueReports({ now = new Date(), limit = 1000 } = {}) {
  const summary = { scanned: 0, sent: 0, skipped: 0, errors: 0 };
  if (now.getUTCDate() > SEND_UNTIL_DAY) return summary;
  if (!isSystemSmtpConfigured()) {
    console.warn('[value-report] system SMTP not configured; skipping');
    return summary;
  }

  const { from, to, label, key } = previousMonthRange(now);
  const candidates = await Client.find({
    role: { $ne: 'admin' },
    valueReportEmails: { $ne: false },
    valueReportLastSent: { $ne: key },
    'subscription.status': { $in: ['active', 'trialing'] },
  })
    .select('_id clientID companyName businessEmail')
    .limit(limit); // documents, not lean: businessEmail is decrypted by a getter

  const transport = createSystemSmtpTransport();
  const fromAddress = decrypt(process.env.REPORT_EMAIL_FROM || process.env.ERROR_EMAIL_FROM || getSystemSmtpConfig().user);

  for (const c of candidates) {
    summary.scanned += 1;
    // Claim this client for the month first so nothing sends twice.
    const claimed = await Client.updateOne(
      { _id: c._id, valueReportLastSent: { $ne: key } },
      { $set: { valueReportLastSent: key } }
    );
    if (!claimed.modifiedCount) {
      summary.skipped += 1;
      continue;
    }

    try {
      const to_ = resolveBusinessEmail(c);
      const report = await buildValueReport(c.clientID, from, to);
      if (!to_ || !hasActivity(report)) {
        summary.skipped += 1;
        continue;
      }
      const mail = renderEmail(c, report, label);
      await transport.sendMail({ from: `Khana Technologies <${fromAddress}>`, to: to_, ...mail });
      summary.sent += 1;
    } catch (err) {
      summary.errors += 1;
      console.error(`[value-report] ${c.clientID}: ${err.message}`);
      // Release the claim so tomorrow's run retries this client.
      await Client.updateOne({ _id: c._id, valueReportLastSent: key }, { $set: { valueReportLastSent: '' } }).catch(() => {});
    }
  }

  console.log(`[value-report] ${key}: scanned=${summary.scanned} sent=${summary.sent} skipped=${summary.skipped} errors=${summary.errors}`);
  return summary;
}

module.exports = { processMonthlyValueReports, renderEmail };
