const { sendMailWithRetry } = require('../helpers/mailer');
const { decrypt } = require('../helpers/encryption');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('../helpers/mailHost');
const { escapeHtml, buildKhanaEmail, warnPanel, ctaButton } = require('../helpers/transactionalEmailLayout');
const { normalizeEmailBranding, clientEmailBrandingPayload } = require('../helpers/clientEmailBranding');
const { resolveEmailBrand } = require('../helpers/emailDesignTokens');

function formatRemaining(ms) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours <= 0) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  if (minutes === 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
  return `${hours}h ${minutes}m`;
}

function previewBody(body) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return '(no text)';
  return text.length > 140 ? `${text.slice(0, 137)}…` : text;
}

async function resolveMailbox(client) {
  try {
    const businessEmail = decrypt(client.businessEmail);
    const businessPass = decrypt(client.businessEmailPassword);
    const smtpHost = resolveSmtpHost({ businessEmail, smtpHost: client.smtpHost });
    const smtpPort = resolveSmtpPort({ businessEmail, smtpPort: client.smtpPort }, smtpHost);
    if (businessEmail && businessPass && smtpHost) {
      return {
        fromEmail: businessEmail,
        user: businessEmail,
        pass: businessPass,
        host: smtpHost,
        port: smtpPort,
        secure: resolveSmtpSecure(smtpPort),
        fromName: client.companyName || 'KhanaConnect',
      };
    }
  } catch {
    // fall through to admin mailbox
  }

  const { getKhanaAdminClient } = require('../helpers/teamPasswordReset');
  const admin = await getKhanaAdminClient();
  const adminEmail = decrypt(admin.businessEmail);
  const adminPass = decrypt(admin.businessEmailPassword);
  const smtpHost = resolveSmtpHost({ businessEmail: adminEmail, smtpHost: admin.smtpHost });
  const smtpPort = resolveSmtpPort({ businessEmail: adminEmail, smtpPort: admin.smtpPort }, smtpHost);
  if (!adminEmail || !adminPass || !smtpHost) {
    throw new Error('No SMTP mailbox configured to send WhatsApp window alerts');
  }
  return {
    fromEmail: adminEmail,
    user: adminEmail,
    pass: adminPass,
    host: smtpHost,
    port: smtpPort,
    secure: resolveSmtpSecure(smtpPort),
    fromName: admin.companyName || 'KhanaConnect',
  };
}

async function sendWhatsAppWindowCloseAlertEmail({ client, recipients, threads, inboxUrl }) {
  if (!recipients?.length || !threads?.length) return { sent: 0 };

  const mailbox = await resolveMailbox(client);
  const brandName = client.companyName || 'KhanaConnect';
  const count = threads.length;
  const subject =
    count === 1
      ? `WhatsApp reply window closing — ${threads[0].contactName || threads[0].contactWaId}`
      : `${count} WhatsApp chats need a reply before the window closes`;

  const rowsHtml = threads
    .map((t) => {
      const name = escapeHtml(t.contactName || t.contactWaId);
      const remaining = formatRemaining(t.remainingMs);
      const preview = escapeHtml(previewBody(t.body));
      return `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;">${name}<br><span style="font-size:12px;color:#6b7280;">${escapeHtml(t.contactWaId)}</span></td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#4b5563;">${preview}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:700;color:#b45309;">${escapeHtml(remaining)}</td>
      </tr>`;
    })
    .join('');

  const bodyHtml = `
    <p style="margin:0 0 16px;">You have unanswered WhatsApp ${count === 1 ? 'message' : 'messages'} and the 24-hour free-reply window is about to close. After it closes you can only reply with a template.</p>
    ${warnPanel({
      title: 'Reply soon',
      html: `Open WhatsApp Inbox and reply while the window is still open.`,
    })}
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 20px;">
      <thead>
        <tr style="background:#f3f4f6;">
          <th style="padding:8px 12px;text-align:left;">Contact</th>
          <th style="padding:8px 12px;text-align:left;">Last message</th>
          <th style="padding:8px 12px;text-align:center;">Time left</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    ${ctaButton({ href: inboxUrl, label: 'Open WhatsApp Inbox' })}
  `;

  const branding = normalizeEmailBranding(clientEmailBrandingPayload(client));
  const brand = resolveEmailBrand({
    companyName: brandName,
    ...branding,
  });
  const html = buildKhanaEmail({
    title: subject,
    headline: count === 1 ? 'WhatsApp window closing' : `${count} chats need a reply`,
    preheader: `${count} unanswered WhatsApp ${count === 1 ? 'chat' : 'chats'} — reply before the 24-hour window closes.`,
    bodyHtml,
    brandName,
    logoUrl: brand.logoUrl || undefined,
    primaryColor: brand.primaryColor,
    showKhanaLogo: false,
  });

  let sent = 0;
  for (const to of recipients) {
    await sendMailWithRetry(
      {
        host: mailbox.host,
        port: mailbox.port,
        secure: mailbox.secure,
        user: mailbox.user,
        pass: mailbox.pass,
        from: `"${mailbox.fromName}" <${mailbox.fromEmail}>`,
        to,
        subject,
        html,
        clientID: client.clientID,
        saveToSent: false,
      },
      3
    );
    sent += 1;
  }

  return { sent };
}

module.exports = { sendWhatsAppWindowCloseAlertEmail, formatRemaining };
