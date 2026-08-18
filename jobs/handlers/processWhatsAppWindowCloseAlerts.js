const { processAllWhatsAppWindowCloseAlerts } = require('../../helpers/whatsappWindowCloseAlerts');

async function processWhatsAppWindowCloseAlerts() {
  const data = await processAllWhatsAppWindowCloseAlerts({});
  if (data.skipped) {
    console.log(`📱 WhatsApp window-close alerts skipped (${data.reason})`);
    return data;
  }
  const emailed = (data.results || []).filter((r) => r.emailsSent > 0).length;
  const threads = (data.results || []).reduce((sum, r) => sum + (r.emailed || 0), 0);
  console.log(
    `📱 WhatsApp window-close alerts: ${data.clients} clients, ${emailed} emails, ${threads} chats`
  );
  return data;
}

module.exports = { processWhatsAppWindowCloseAlerts };
