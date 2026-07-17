const { sendMailWithRetry } = require('../helpers/mailer');
const { decrypt } = require('../helpers/encryption');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('../helpers/mailHost');
const { escapeHtml } = require('../helpers/signatureHtml');
const { buildKhanaEmail, warnPanel } = require('../helpers/transactionalEmailLayout');
const { normalizeEmailBranding, clientEmailBrandingPayload } = require('../helpers/clientEmailBranding');
const { resolveEmailBrand } = require('../helpers/emailDesignTokens');

function variantLabel(item) {
  if (item.variantName && item.variantValue) {
    return `${item.variantName}: ${item.variantValue}`;
  }
  return '';
}

async function sendWarehouseLowStockAlertEmail({ client, recipients, warehouseName, warehouseCode, items }) {
  const businessEmail = decrypt(client.businessEmail);
  const businessPass = decrypt(client.businessEmailPassword);
  const smtpHost = resolveSmtpHost({ businessEmail, smtpHost: client.smtpHost });
  const smtpPort = resolveSmtpPort({ businessEmail, smtpPort: client.smtpPort }, smtpHost);
  const secure = resolveSmtpSecure(smtpPort);

  if (!smtpHost) {
    throw new Error('SMTP host could not be resolved for warehouse low-stock alert');
  }

  const brandName = client.companyName || 'Your store';
  const outCount = items.filter((i) => i.severity === 'out').length;
  const lowCount = items.length - outCount;

  const rowsHtml = items
    .map((item) => {
      const variant = variantLabel(item);
      const badge =
        item.severity === 'out'
          ? '<span style="color:#b91c1c;font-weight:700;">OUT OF STOCK</span>'
          : '<span style="color:#b45309;font-weight:700;">LOW</span>';
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${escapeHtml(item.productName)}${variant ? `<br><span style="font-size:12px;color:#6b7280;">${escapeHtml(variant)}</span>` : ''}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${badge}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:700;">${item.availableQuantity}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${item.threshold}</td>
      </tr>`;
    })
    .join('');

  const bodyHtml = `
    <p style="margin:0 0 16px;">Stock at <strong>${escapeHtml(warehouseName)}</strong> (${escapeHtml(warehouseCode)}) needs attention:</p>
    <p style="margin:0 0 16px;color:#4b5563;">${outCount ? `${outCount} out of stock` : ''}${outCount && lowCount ? ' · ' : ''}${lowCount ? `${lowCount} low` : ''}</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 20px;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:8px 12px;text-align:left;">Product</th>
          <th style="padding:8px 12px;text-align:center;">Status</th>
          <th style="padding:8px 12px;text-align:center;">Available</th>
          <th style="padding:8px 12px;text-align:center;">Threshold</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${warnPanel({
      html: 'Update stock levels or transfer inventory between warehouses in your Khana B2B dashboard.',
    })}
  `;

  const branding = normalizeEmailBranding(clientEmailBrandingPayload(client));
  const brand = resolveEmailBrand(branding);
  const html = buildKhanaEmail({
    title: `Low stock — ${warehouseName}`,
    preheader: `${items.length} product(s) need attention at ${warehouseCode}`,
    bodyHtml,
    brand,
    showKhanaLogo: false,
  });

  const subject =
    outCount > 0
      ? `[Action required] ${warehouseCode}: ${outCount} item(s) out of stock`
      : `[Low stock] ${warehouseCode}: ${items.length} item(s) below threshold`;

  for (const to of recipients) {
    await sendMailWithRetry({
      from: `"${brandName}" <${businessEmail}>`,
      to,
      subject,
      html,
      auth: { user: businessEmail, pass: businessPass },
      host: smtpHost,
      port: smtpPort,
      secure,
    });
  }
}

module.exports = { sendWarehouseLowStockAlertEmail };
