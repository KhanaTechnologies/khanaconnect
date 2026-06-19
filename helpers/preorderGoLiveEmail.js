const { sendMail } = require('./mailer');
const { decrypt } = require('./encryption');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('./mailHost');
const { escapeHtml } = require('./signatureHtml');

async function sendPreorderGoLiveEmail({ signup, campaign, client, subject, message, orderUrl }) {
  const decryptedEmail = decrypt(client.businessEmail);
  const decryptedPass = decrypt(client.businessEmailPassword);
  const smtpHost = resolveSmtpHost({
    smtpHost: client.smtpHost,
    imapHost: client.imapHost,
    businessEmail: decryptedEmail,
    return_url: client.return_url,
  });
  const smtpPort = resolveSmtpPort(client, smtpHost);

  const name = escapeHtml(signup.customerInfo?.firstName || signup.customerInfo?.name || 'there');
  const brand = escapeHtml(client.companyName || 'Our store');
  const campaignName = escapeHtml(campaign.name || 'Our campaign');
  const bodyHtml = escapeHtml(message || '').replace(/\n/g, '<br>');
  const shopUrl = escapeHtml(orderUrl || client.return_url || '#');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827">
      <h2 style="color:#0f79bf">${brand}</h2>
      <p>Hi ${name},</p>
      <p><strong>${campaignName} is live!</strong></p>
      <p>${bodyHtml}</p>
      <p style="margin:24px 0">
        <a href="${shopUrl}" style="display:inline-block;padding:14px 28px;background:#0f79bf;color:#fff;text-decoration:none;border-radius:6px;font-weight:bold">
          Order now
        </a>
      </p>
      <p style="font-size:13px;color:#6b7280">You signed up for updates about this campaign.</p>
    </div>`;

  const text = `Hi ${signup.customerInfo?.firstName || 'there'},\n\n${campaign.name} is live!\n\n${message}\n\nOrder now: ${orderUrl || client.return_url}`;

  await sendMail({
    host: smtpHost,
    port: smtpPort,
    secure: resolveSmtpSecure(smtpPort),
    user: decryptedEmail,
    pass: decryptedPass,
    from: `"${client.companyName}" <${decryptedEmail}>`,
    to: signup.customerInfo.email,
    subject: subject || `${campaign.name} — we're live! Order now`,
    text,
    html,
  });
}

module.exports = { sendPreorderGoLiveEmail };
