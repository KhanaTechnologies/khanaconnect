const WhatsAppInboxService = require('../../services/saas/WhatsAppInboxService');

async function processWhatsAppBroadcast(data = {}) {
  return WhatsAppInboxService.processBroadcastTick(data);
}

module.exports = { processWhatsAppBroadcast };
