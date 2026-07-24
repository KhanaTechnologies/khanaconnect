const WhatsAppAutoResponderService = require('../../services/saas/WhatsAppAutoResponderService');

async function processWhatsAppAutoReply(data = {}) {
  return WhatsAppAutoResponderService.executeScheduledReply(data);
}

module.exports = { processWhatsAppAutoReply };
