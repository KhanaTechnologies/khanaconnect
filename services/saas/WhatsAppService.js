const axios = require('axios');
const { decrypt } = require('../../helpers/encryption');
const SaasWhatsAppAccount = require('../../models/SaasWhatsAppAccount');
const SaasUsageEvent = require('../../models/SaasUsageEvent');
const { usageBillingQueue } = require('../../queues/saasQueues');

const WA_API_BASE = process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com/v21.0';

class WhatsAppService {
  static async getClientAccount(clientId) {
    const account = await SaasWhatsAppAccount.findOne({ client_id: clientId, status: 'active' });
    if (!account) throw new Error('No active WhatsApp account for client');
    return account;
  }

  static async sendTemplateMessage({ clientId, to, templateName, languageCode = 'en', components = [] }) {
    const account = await this.getClientAccount(clientId);
    const token = decrypt(account.access_token_encrypted);
    const url = `${WA_API_BASE}/${account.phone_number_id}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components,
      },
    };

    const response = await axios.post(url, payload, {
      timeout: 20000,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    const messageId = response.data?.messages?.[0]?.id || `wa-${Date.now()}`;
    await SaasUsageEvent.create({
      client_id: clientId,
      service: 'whatsapp',
      message_type: 'marketing',
      units: 1,
      source_ref: messageId,
      status: 'queued',
      metadata: { to, templateName },
    });

    await usageBillingQueue.add('bill-whatsapp-message', {
      clientId,
      service: 'whatsapp',
      messageType: 'marketing',
      units: 1,
      sourceRef: messageId,
      metadata: { to, templateName },
    });

    return response.data;
  }
}

module.exports = WhatsAppService;
