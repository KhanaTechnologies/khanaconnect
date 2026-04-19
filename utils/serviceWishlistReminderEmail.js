const { sendMail } = require('../helpers/mailer');
const { decrypt } = require('../helpers/encryption');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('../helpers/mailHost');
const { mergeEmailSignature, escapeHtml } = require('../helpers/signatureHtml');

/**
 * One email per customer listing all service wishlist rows due this month.
 * @param {import('../models/customer').Customer} customer - Mongoose doc (getters for email)
 * @param {import('../models/client').Client} client - Mongoose doc with SMTP + companyName
 * @param {Array<{ service?: { name: string; price: number; description?: string }; notes?: string }>} rows - populated lean rows
 * @param {{ year: number, month: number }} period - human-readable in subject/body
 */
async function sendServiceWishlistMonthlyReminder(customer, client, rows, period) {
  if (!rows || !rows.length) return;

  const decryptedEmail = decrypt(client.businessEmail);
  const decryptedPass = decrypt(client.businessEmailPassword);
  const host = resolveSmtpHost({
    smtpHost: client.smtpHost,
    imapHost: client.imapHost,
    businessEmail: decryptedEmail,
    return_url: client.return_url,
  });
  if (!host) {
    throw new Error('SMTP host could not be resolved for client');
  }
  const smtpPort = resolveSmtpPort(client, host);

  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  const label = `${monthNames[period.month - 1]} ${period.year}`;
  const firstName = escapeHtml(String(customer.customerFirstName || 'there'));

  const lines = rows
    .map((r) => {
      const s = r.service || {};
      const name = escapeHtml(String(s.name || 'Service'));
      const price =
        typeof s.price === 'number' && Number.isFinite(s.price)
          ? `R${s.price.toFixed(2)}`
          : '';
      const note = r.notes ? `<p style="margin:4px 0 0;font-size:14px;color:#555">${escapeHtml(String(r.notes))}</p>` : '';
      return `<li style="margin:12px 0"><strong>${name}</strong>${price ? ` — ${escapeHtml(price)}` : ''}${note}</li>`;
    })
    .join('');

  const bookingUrl = client.return_url
    ? String(client.return_url).replace(/\/$/, '') + '/bookings'
    : '#';

  const innerHtml = `
    <div style="font-family: Arial, Helvetica, sans-serif; max-width: 600px; margin: 0 auto; color: #111827;">
      <h2 style="color: #1f2937;">Hi ${firstName},</h2>
      <p>You asked us to remind you in <strong>${escapeHtml(label)}</strong> about these services on your wish list:</p>
      <ul style="padding-left: 20px; margin: 16px 0;">${lines}</ul>
      <p style="margin: 20px 0;">When you are ready, you can book or browse services on our site.</p>
      <div style="text-align: center; margin: 28px 0;">
        <a href="${escapeHtml(bookingUrl)}" style="background-color: #111827; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: 600;">View / book services</a>
      </div>
      <p style="color: #6b7280; font-size: 12px;">This is an automated reminder from ${escapeHtml(String(client.companyName || 'us'))}.</p>
    </div>`;

  const merged = mergeEmailSignature(innerHtml, '', client.emailSignature || '');
  const text = `Hi ${customer.customerFirstName || 'there'},

You asked to be reminded in ${label} about these services:
${rows.map((r) => `- ${r.service?.name || 'Service'}${r.service?.price != null ? ` (${r.service.price})` : ''}${r.notes ? ` — ${r.notes}` : ''}`).join('\n')}

Book or browse: ${bookingUrl}

— ${client.companyName || ''}`;

  await sendMail({
    host,
    port: smtpPort,
    secure: resolveSmtpSecure(smtpPort),
    user: decryptedEmail,
    pass: decryptedPass,
    from: `"${client.companyName}" <${decryptedEmail}>`,
    to: customer.emailAddress,
    subject: `Your service wish list — ${label}`,
    text,
    html: merged.html,
    clientID: client.clientID,
    saveToSent: false,
  });
}

module.exports = { sendServiceWishlistMonthlyReminder };
