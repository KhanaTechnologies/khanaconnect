const { sendMailWithRetry } = require('../helpers/mailer');
const { escapeHtml, buildKhanaEmail, infoPanel, ctaButton } = require('../helpers/transactionalEmailLayout');
const { normalizeEmailBranding, clientEmailBrandingPayload } = require('../helpers/clientEmailBranding');
const { resolveEmailBrand } = require('../helpers/emailDesignTokens');
const { resolveMailbox } = require('./sendWhatsAppWindowCloseAlert');

function dashboardInboxUrl() {
  const base = (process.env.DASHBOARD_URL || 'https://khanatechnologies.co.za').replace(/\/$/, '');
  return `${base}/dashboard/whatsapp-inbox`;
}

function messagePreview(body, type) {
  const text = String(body || '').replace(/\s+/g, ' ').trim();
  if (!text) return type && type !== 'text' ? `(${type})` : '(no text)';
  return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}

function formatTime(date) {
  try {
    return new Intl.DateTimeFormat('en-ZA', {
      timeZone: 'Africa/Johannesburg',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return new Date(date).toISOString();
  }
}

function buildNewContactEmail({ client, contact, autoReplyActive = false }) {
  const who = contact.contactName || `+${contact.contactWaId}`;
  const subject = contact.firstEver
    ? `New WhatsApp enquiry from ${who}`
    : `${who} messaged again on WhatsApp`;
  const preview = messagePreview(contact.body, contact.type);
  const waLink = `https://wa.me/${contact.contactWaId}`;

  const bodyHtml = `
    <p style="margin:0 0 16px;">${
      contact.firstEver
        ? 'Someone new just messaged you on WhatsApp.'
        : 'Someone you’ve spoken to before just started a new conversation on WhatsApp.'
    }</p>
    ${infoPanel({
      title: 'Message',
      rows: [
        ['From', escapeHtml(contact.contactName || '—')],
        ['Number', `<a href="${escapeHtml(waLink)}">+${escapeHtml(contact.contactWaId)}</a>`],
        ['When', escapeHtml(formatTime(contact.timestamp))],
        ['Message', escapeHtml(preview)],
      ],
    })}
    ${
      autoReplyActive
        ? '<p style="margin:0 0 16px;font-size:14px;color:#4b5563;">If nobody replies within 5 minutes, a short automatic reply goes out for common questions. Reply yourself to take over the chat.</p>'
        : ''
    }
    ${ctaButton({ href: dashboardInboxUrl(), label: 'Open WhatsApp Inbox' })}
  `;

  const brandName = client.companyName || 'KhanaConnect';
  const brand = resolveEmailBrand({
    companyName: brandName,
    ...normalizeEmailBranding(clientEmailBrandingPayload(client)),
  });
  const html = buildKhanaEmail({
    title: subject,
    headline: contact.firstEver ? 'New WhatsApp enquiry' : 'New WhatsApp conversation',
    preheader: `${who}: ${preview.slice(0, 90)}`,
    bodyHtml,
    brandName,
    logoUrl: brand.logoUrl || undefined,
    primaryColor: brand.primaryColor,
    showKhanaLogo: false,
  });

  return { subject, html };
}

async function sendWhatsAppNewContactAlertEmail({ client, recipients, contact, autoReplyActive = false }) {
  if (!recipients?.length || !contact) return { sent: 0 };
  const mailbox = await resolveMailbox(client);
  const { subject, html } = buildNewContactEmail({ client, contact, autoReplyActive });

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

module.exports = { sendWhatsAppNewContactAlertEmail, buildNewContactEmail };
