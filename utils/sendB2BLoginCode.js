const { sendMailWithRetry } = require('../helpers/mailer');
const { decrypt } = require('../helpers/encryption');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('../helpers/mailHost');
const { escapeHtml } = require('../helpers/signatureHtml');
const { buildKhanaEmail, warnPanel } = require('../helpers/transactionalEmailLayout');
const { normalizeEmailBranding, clientEmailBrandingPayload } = require('../helpers/clientEmailBranding');
const { resolveEmailBrand } = require('../helpers/emailDesignTokens');
const WhatsAppService = require('../services/saas/WhatsAppService');

async function sendB2BLoginCodeEmail({ buyer, client, code, expiresMinutes }) {
  const businessEmail = decrypt(client.businessEmail);
  const businessPass = decrypt(client.businessEmailPassword);
  const recipient = decrypt(buyer.email);
  const smtpHost = resolveSmtpHost({ businessEmail, smtpHost: client.smtpHost });
  const smtpPort = resolveSmtpPort({ businessEmail, smtpPort: client.smtpPort }, smtpHost);
  const secure = resolveSmtpSecure(smtpPort);

  if (!smtpHost) {
    throw new Error('SMTP host could not be resolved for B2B login code email');
  }

  const brandName = client.companyName || 'your supplier';
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${escapeHtml(buyer.contactFirstName)},</p>
    <p style="margin:0 0 16px;">Use this verification code to complete your B2B portal sign-in for <strong>${escapeHtml(brandName)}</strong>:</p>
    <p style="margin:0 0 20px;font-size:32px;font-weight:700;letter-spacing:6px;color:#1e3a5f;">${escapeHtml(code)}</p>
    ${warnPanel({
      html: `<strong>Security:</strong> this code expires in ${expiresMinutes} minutes. Never share it with anyone. If you did not attempt to sign in, contact ${escapeHtml(brandName)} immediately.`,
    })}
  `;

  const branding = normalizeEmailBranding(clientEmailBrandingPayload(client));
  const brand = resolveEmailBrand(branding);
  const html = buildKhanaEmail({
    title: 'B2B sign-in verification',
    preheader: `Your verification code: ${code}`,
    bodyHtml,
    brand,
    showKhanaLogo: false,
  });

  await sendMailWithRetry({
    from: `"${brandName}" <${businessEmail}>`,
    to: recipient,
    subject: `${code} — your B2B portal verification code`,
    html,
    auth: { user: businessEmail, pass: businessPass },
    host: smtpHost,
    port: smtpPort,
    secure,
  });

  WhatsAppService.safeNotifyVerificationCode({
    clientId: client.clientID,
    to: buyer.phone,
    companyName: brandName,
    code,
  }).catch(() => {});
}

module.exports = { sendB2BLoginCodeEmail };
