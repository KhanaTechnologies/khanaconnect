const {
  escapeHtml,
  buildKhanaEmail,
} = require('./transactionalEmailLayout');

const QUOTE_VALIDITY_DAYS = 30;

function formatZar(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return 'On enquiry';
  return `R${Number(amount).toLocaleString('en-ZA')}`;
}

function formatDisplayDate(date) {
  try {
    return new Date(date).toLocaleDateString('en-ZA', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

function computeValidUntil(quote) {
  if (quote.validUntil) return new Date(quote.validUntil);
  const base = quote.createdAt ? new Date(quote.createdAt) : new Date();
  const until = new Date(base);
  until.setDate(until.getDate() + QUOTE_VALIDITY_DAYS);
  return until;
}

function isQuoteExpired(quote) {
  return Date.now() > computeValidUntil(quote).getTime();
}

function yesNo(value) {
  return value ? 'Yes' : 'No';
}

const PLAN_QUOTE_FOOTER =
  'Khana Technologies · Partnership enquiries · <a href="https://khanatechnologies.co.za" style="color:#2563eb;text-decoration:none;">khanatechnologies.co.za</a>';

function buildEstimateRows(quote) {
  const est = quote.estimate || {};
  const sel = quote.selections || {};
  const rows = [];

  rows.push(['Plan', est.tierName || '—']);
  rows.push(['Once-off setup', formatZar(est.totalSetup)]);
  rows.push(['Monthly partnership', formatZar(est.totalMonthly)]);
  rows.push(['Team members', String(sel.teamMembers || 1)]);

  if (est.extraSeats > 0) {
    rows.push([
      'Extra team seats',
      `${est.extraSeats} × ${formatZar(est.seatMonthlyFee)}/mo`,
    ]);
  }

  if (est.addOnLines?.length) {
    est.addOnLines.forEach((line) => {
      if (line.monthly != null) {
        rows.push([line.name, `${formatZar(line.monthly)}/mo`]);
      }
      if (line.onceOff != null) {
        rows.push([line.name, `${formatZar(line.onceOff)} once-off`]);
      }
    });
  }

  return rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#6b7280;font-size:14px;">${escapeHtml(label)}</td>
        <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-size:14px;font-weight:600;color:#111827;">${escapeHtml(value)}</td>
      </tr>`
    )
    .join('');
}

function buildPlanQuoteTeamHtml(quote, shareUrl, validUntil) {
  const est = quote.estimate || {};
  const sel = quote.selections || {};
  const validLabel = formatDisplayDate(validUntil);

  const bodyHtml = `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151;">
      A prospect completed the plan builder and requested their estimate.
    </p>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:20px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;">
      <tr>
        <td style="padding:16px 18px;">
          <p style="margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#1d4ed8;font-weight:600;">Prospect</p>
          <p style="margin:0;font-size:18px;font-weight:700;color:#111827;">${escapeHtml(quote.prospectName)}${quote.businessName ? ` <span style="font-weight:500;color:#6b7280;">· ${escapeHtml(quote.businessName)}</span>` : ''}</p>
          <p style="margin:8px 0 0;font-size:14px;color:#374151;">
            <a href="mailto:${escapeHtml(quote.prospectEmail)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(quote.prospectEmail)}</a>
            ${quote.prospectPhone ? ` · ${escapeHtml(quote.prospectPhone)}` : ''}
          </p>
        </td>
      </tr>
    </table>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:20px;">
      <tr>
        <td style="padding:14px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;font-size:13px;color:#4b5563;line-height:1.7;">
          <strong style="color:#111827;">Quote ID:</strong> ${escapeHtml(quote.quoteId)}<br />
          <strong style="color:#111827;">Source:</strong> ${escapeHtml(quote.sourceRef || 'direct')}<br />
          <strong style="color:#111827;">Valid until:</strong> ${escapeHtml(validLabel)}
        </td>
      </tr>
    </table>

    <h2 style="margin:0 0 12px;font-size:16px;color:#111827;">Their selections</h2>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px;font-size:14px;color:#374151;line-height:1.8;">
      <tr><td>Online store</td><td align="right"><strong>${yesNo(sel.needsStore)}</strong></td></tr>
      <tr><td>Bookings</td><td align="right"><strong>${yesNo(sel.needsBookings)}</strong></td></tr>
      <tr><td>Custom system</td><td align="right"><strong>${yesNo(sel.needsCustom)}</strong></td></tr>
      ${
        sel.needsCustom
          ? `<tr><td>Custom scope</td><td align="right"><strong>${escapeHtml(
              sel.customScope === 'addon' ? 'Add-on to store/bookings' : 'Standalone'
            )}</strong></td></tr>
      <tr><td>Private standalone API</td><td align="right"><strong>${yesNo(sel.wantsStandaloneApi)}</strong></td></tr>`
          : ''
      }
      <tr><td>Revenue tools add-on</td><td align="right"><strong>${yesNo(sel.needsRevenueTools)}</strong></td></tr>
      <tr><td>Site size</td><td align="right"><strong>${escapeHtml(sel.siteSize || '—')}</strong></td></tr>
      <tr><td>Catalogue</td><td align="right"><strong>${escapeHtml(sel.catalogueSize || '—')}</strong></td></tr>
      <tr><td>Advanced email</td><td align="right"><strong>${yesNo(sel.advancedEmail)}</strong></td></tr>
    </table>
    ${
      sel.needsCustom && String(sel.customBrief || '').trim()
        ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px;">
      <tr>
        <td style="padding:14px 16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;font-size:13px;color:#374151;line-height:1.7;">
          <strong style="color:#111827;">Custom brief</strong><br />
          ${escapeHtml(String(sel.customBrief).trim())}
        </td>
      </tr>
    </table>`
        : ''
    }

    <h2 style="margin:0 0 12px;font-size:16px;color:#111827;">Estimate summary</h2>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px;">
      ${buildEstimateRows(quote)}
      <tr>
        <td colspan="2" style="padding-top:14px;font-size:12px;color:#6b7280;line-height:1.5;">
          ${escapeHtml(est.tierName ? `Based on the ${est.tierName} partnership plan.` : '')}
        </td>
      </tr>
    </table>

    <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 auto;">
      <tr>
        <td style="border-radius:8px;background:#2563eb;">
          <a href="${escapeHtml(shareUrl)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">View quote in plan builder</a>
        </td>
      </tr>
    </table>
  `;

  return buildKhanaEmail({
    headline: 'New plan estimate',
    title: `Plan estimate — ${quote.prospectName}`,
    preheader: `${quote.prospectName} requested a Khana plan estimate (${formatZar(est.totalMonthly)}/mo).`,
    bodyHtml,
    brandName: 'Khana Technologies',
    showKhanaLogo: true,
    footerHtml: PLAN_QUOTE_FOOTER,
  });
}

function buildPlanQuoteProspectHtml(quote, shareUrl, validUntil, companyName) {
  const est = quote.estimate || {};
  const firstName = String(quote.prospectName || '').trim().split(/\s+/)[0] || 'there';
  const validLabel = formatDisplayDate(validUntil);

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:16px;line-height:1.6;color:#374151;">
      Hi ${escapeHtml(firstName)},
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151;">
      Thanks for building your Khana plan estimate${quote.businessName ? ` for <strong>${escapeHtml(quote.businessName)}</strong>` : ''}.
      Here is a summary of what you selected. Our team will follow up with you personally.
    </p>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px;">
      <tr>
        <td style="padding:18px 20px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;text-align:center;">
          <p style="margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#15803d;font-weight:600;">Your estimate</p>
          <p style="margin:0;font-size:28px;font-weight:800;color:#111827;">${escapeHtml(formatZar(est.totalMonthly))}<span style="font-size:14px;font-weight:600;color:#6b7280;">/mo</span></p>
          <p style="margin:8px 0 0;font-size:14px;color:#374151;">${escapeHtml(formatZar(est.totalSetup))} once-off setup · ${escapeHtml(est.tierName || 'Partnership plan')}</p>
        </td>
      </tr>
    </table>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:20px;">
      ${buildEstimateRows(quote)}
    </table>

    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin-bottom:24px;">
      <tr>
        <td style="padding:14px 16px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;font-size:13px;color:#92400e;line-height:1.6;">
          <strong>This estimate is valid until ${escapeHtml(validLabel)}.</strong>
          Pricing may be revised after that date if partnership rates change.
        </td>
      </tr>
    </table>

    <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 auto 20px;">
      <tr>
        <td style="border-radius:8px;background:#0f172a;">
          <a href="${escapeHtml(shareUrl)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">View your estimate online</a>
        </td>
      </tr>
    </table>

    <p style="margin:0;font-size:14px;line-height:1.6;color:#6b7280;">
      Questions? Reply to this email and we will help you choose the right setup.
    </p>
    <p style="margin:16px 0 0;font-size:14px;line-height:1.6;color:#374151;">
      Warm regards,<br />
      <strong>${escapeHtml(companyName || 'Khana Technologies')}</strong>
    </p>
  `;

  return buildKhanaEmail({
    headline: 'Your Khana plan estimate',
    title: 'Your Khana plan estimate',
    preheader: `Your Khana estimate: ${formatZar(est.totalMonthly)}/mo. Valid until ${validLabel}.`,
    bodyHtml,
    brandName: companyName || 'Khana Technologies',
    showKhanaLogo: true,
    footerHtml: PLAN_QUOTE_FOOTER,
  });
}

module.exports = {
  QUOTE_VALIDITY_DAYS,
  computeValidUntil,
  isQuoteExpired,
  formatDisplayDate,
  buildPlanQuoteTeamHtml,
  buildPlanQuoteProspectHtml,
};
