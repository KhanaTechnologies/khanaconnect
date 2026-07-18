const axios = require('axios');
const { decrypt } = require('../../helpers/encryption');
const SaasWhatsAppAccount = require('../../models/SaasWhatsAppAccount');
const SaasUsageEvent = require('../../models/SaasUsageEvent');
const Client = require('../../models/client');
const { usageBillingQueue } = require('../../queues/saasQueues');
const { normalizePhoneE164 } = require('../../helpers/whatsappLink');
const BillingService = require('./BillingService');
const PricingService = require('./PricingService');

const WA_API_BASE = process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com/v21.0';
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'en';

function bodyTextParams(values) {
  return {
    type: 'body',
    parameters: (values || []).map((text) => ({
      type: 'text',
      text: String(text ?? '').slice(0, 1024) || '—',
    })),
  };
}

class WhatsAppService {
  static async getClientAccount(clientId) {
    const account = await SaasWhatsAppAccount.findOne({ client_id: clientId, status: 'active' });
    if (account) return { account, resolvedClientId: clientId };

    if (clientId !== 'Khana') {
      const khana = await SaasWhatsAppAccount.findOne({ client_id: 'Khana', status: 'active' });
      if (khana) return { account: khana, resolvedClientId: 'Khana' };
    }

    throw new Error('No active WhatsApp Cloud API account for client or Khana fallback');
  }

  static async clientAllowsNotifications(clientId) {
    if (!clientId) return false;
    const client = await Client.findOne({ clientID: clientId }).select('whatsapp');
    return client?.whatsapp?.notificationsEnabled === true;
  }

  /** Ensure the billed client has enough SaaS credits for one WhatsApp unit. */
  static async assertCreditsAvailable(clientId, messageType = 'utility') {
    if (!clientId || clientId === 'Khana') return;
    const client = await Client.findOne({ clientID: clientId }).select('tier').lean();
    const tier = client?.tier || 'bronze';
    const rule = await PricingService.getActiveRule('whatsapp', messageType, tier);
    const need = PricingService.computeCredits(rule, 1);
    const account = await BillingService.ensureAccount(clientId);
    if (Number(account.credit_balance || 0) < need) {
      throw new Error(
        `Insufficient WhatsApp credits (need ${need}, have ${account.credit_balance}). Top up in Account Management.`
      );
    }
  }

  static async sendTemplateMessage({
    clientId,
    to,
    templateName,
    languageCode = TEMPLATE_LANG,
    components = [],
    messageType = 'utility',
  }) {
    const e164 = normalizePhoneE164(to);
    if (!e164) {
      throw new Error('Invalid WhatsApp recipient phone number');
    }

    await this.assertCreditsAvailable(clientId, messageType);

    const { account, resolvedClientId } = await this.getClientAccount(clientId);
    const token = decrypt(account.access_token_encrypted);
    const url = `${WA_API_BASE}/${account.phone_number_id}/messages`;

    const payload = {
      messaging_product: 'whatsapp',
      to: e164,
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
    const billingClientId = clientId || resolvedClientId;

    try {
      await SaasUsageEvent.create({
        client_id: billingClientId,
        service: 'whatsapp',
        message_type: messageType,
        units: 1,
        source_ref: messageId,
        status: 'queued',
        metadata: { to: e164, templateName, resolvedClientId },
      });

      await usageBillingQueue.add('bill-whatsapp-message', {
        clientId: billingClientId,
        service: 'whatsapp',
        messageType,
        units: 1,
        sourceRef: messageId,
        metadata: { to: e164, templateName },
      });
    } catch (usageErr) {
      console.warn('[whatsapp] usage/billing record failed:', usageErr.message);
    }

    return response.data;
  }

  static async notifyOrderConfirmation({ clientId, to, companyName, orderRef, total }) {
    return this.sendTemplateMessage({
      clientId,
      to,
      templateName: 'order_confirmation',
      messageType: 'utility',
      components: [
        bodyTextParams([
          companyName || 'Store',
          orderRef || '—',
          total != null ? String(total) : '—',
        ]),
      ],
    });
  }

  static async notifyOrderStatus({ clientId, to, companyName, orderRef, status }) {
    return this.sendTemplateMessage({
      clientId,
      to,
      templateName: 'order_status_update',
      messageType: 'utility',
      components: [
        bodyTextParams([
          companyName || 'Store',
          orderRef || '—',
          status || 'updated',
        ]),
      ],
    });
  }

  static async notifyBookingConfirmation({ clientId, to, companyName, bookingRef, when }) {
    return this.sendTemplateMessage({
      clientId,
      to,
      templateName: 'booking_confirmation',
      messageType: 'utility',
      components: [
        bodyTextParams([
          companyName || 'Business',
          bookingRef || '—',
          when || '—',
        ]),
      ],
    });
  }

  static async notifyBookingReminder({ clientId, to, companyName, bookingRef, when }) {
    return this.sendTemplateMessage({
      clientId,
      to,
      templateName: 'booking_reminder',
      messageType: 'utility',
      components: [
        bodyTextParams([
          companyName || 'Business',
          bookingRef || '—',
          when || '—',
        ]),
      ],
    });
  }

  static async notifyVerificationCode({ clientId, to, companyName, code }) {
    return this.sendTemplateMessage({
      clientId,
      to,
      templateName: 'account_verification',
      messageType: 'auth',
      components: [
        bodyTextParams([
          companyName || 'Account',
          String(code || ''),
        ]),
      ],
    });
  }

  /**
   * Soft-fail wrapper: never throws to callers. Returns { ok, skipped?, error?, data? }.
   * @param {'order_confirmation'|'order_status'|'booking_confirmation'|'booking_reminder'|'verification'} kind
   */
  static async safeNotify(kind, opts) {
    try {
      const clientId = opts.clientId;
      if (!(await this.clientAllowsNotifications(clientId))) {
        return { ok: false, skipped: true, reason: 'notifications_disabled' };
      }
      const to = normalizePhoneE164(opts.to);
      if (!to) {
        return { ok: false, skipped: true, reason: 'no_phone' };
      }
      const payload = { ...opts, to };
      let data;
      switch (kind) {
        case 'order_confirmation':
          data = await this.notifyOrderConfirmation(payload);
          break;
        case 'order_status':
          data = await this.notifyOrderStatus(payload);
          break;
        case 'booking_confirmation':
          data = await this.notifyBookingConfirmation(payload);
          break;
        case 'booking_reminder':
          data = await this.notifyBookingReminder(payload);
          break;
        case 'verification':
          data = await this.notifyVerificationCode(payload);
          break;
        default:
          throw new Error(`Unknown WhatsApp notify kind: ${kind}`);
      }
      return { ok: true, data };
    } catch (err) {
      console.error(`[whatsapp] ${kind} failed:`, err.response?.data || err.message);
      return { ok: false, error: err.message };
    }
  }

  static safeNotifyOrderConfirmation(opts) {
    return this.safeNotify('order_confirmation', opts);
  }

  static safeNotifyOrderStatus(opts) {
    return this.safeNotify('order_status', opts);
  }

  static safeNotifyBookingConfirmation(opts) {
    return this.safeNotify('booking_confirmation', opts);
  }

  static safeNotifyBookingReminder(opts) {
    return this.safeNotify('booking_reminder', opts);
  }

  static safeNotifyVerificationCode(opts) {
    return this.safeNotify('verification', opts);
  }

  static formatBookingWhen(booking) {
    if (!booking) return '—';
    try {
      const d = new Date(booking.date);
      const dateStr = Number.isNaN(d.getTime())
        ? String(booking.date || '—')
        : d.toLocaleDateString('en-ZA', {
            weekday: 'short',
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          });
      return booking.time ? `${dateStr} ${booking.time}` : dateStr;
    } catch {
      return String(booking.date || '—');
    }
  }
}

module.exports = WhatsAppService;
