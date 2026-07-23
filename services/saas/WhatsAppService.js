const axios = require('axios');
const { decrypt } = require('../../helpers/encryption');
const SaasWhatsAppAccount = require('../../models/SaasWhatsAppAccount');
const SaasUsageEvent = require('../../models/SaasUsageEvent');
const Client = require('../../models/client');
const { usageBillingQueue } = require('../../queues/saasQueues');
const { normalizePhoneE164 } = require('../../helpers/whatsappLink');
const BillingService = require('./BillingService');
const PricingService = require('./PricingService');

const WA_API_BASE = process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com/v25.0';
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

/** Dynamic CTA URL button — template must define Visit website with …/{{1}} suffix. */
function urlButtonParam(suffix, index = 0) {
  const text = String(suffix ?? '')
    .trim()
    .replace(/^\/+/, '')
    .slice(0, 2000);
  return {
    type: 'button',
    sub_type: 'url',
    index: String(index),
    parameters: [{ type: 'text', text: text || 'ORD-78421' }],
  };
}

/**
 * Path suffix for order_confirmation URL button.
 * Meta template base must match WHATSAPP_ORDER_BUTTON_BASE (default: demo order page).
 */
function orderViewButtonSuffix({ clientId, orderRef }) {
  const ref = String(orderRef || 'ORD-78421').trim() || 'ORD-78421';
  // Demo / review sample stays a simple path segment.
  if (/^ORD-78421$/i.test(ref) || /^TEST-/i.test(ref)) {
    return 'ORD-78421';
  }
  const cid = String(clientId || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64);
  if (cid) return `${cid}-${ref}`.slice(0, 200);
  return ref.slice(0, 200);
}

function httpError(message, status = 400, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function formatMetaSendError(err) {
  const data = err?.response?.data;
  const metaMsg =
    data?.error?.message ||
    data?.error?.error_user_msg ||
    data?.message ||
    err?.message ||
    'WhatsApp send failed';
  const code = data?.error?.code;
  const subcode = data?.error?.error_subcode;
  const status = err?.response?.status && err.response.status >= 400 ? err.response.status : 502;
  const detail = [code != null ? `#${code}` : null, subcode != null ? `sub ${subcode}` : null]
    .filter(Boolean)
    .join(' ');
  let message = detail ? `${metaMsg} (${detail})` : metaMsg;
  if (Number(code) === 133010 || /not registered/i.test(String(metaMsg))) {
    message +=
      ' — Open WhatsApp usage → Register Cloud API number (6-digit PIN), then retry Send test.';
  }
  if (/not available for SMB/i.test(String(metaMsg))) {
    message +=
      ' — This number is on an SMB / WhatsApp Business App account. Meta blocks /register for SMB. Use a Cloud API (API) number, Meta’s test number, or migrate via Embedded Signup / full API migration — not the Register button.';
  }
  if (Number(code) === 100 && Number(subcode) === 33) {
    message +=
      ' — Token cannot access this Phone number ID. Generate a Temporary access token on the same API Setup page as this ID (or assign that WABA to your System User), then paste both again. Do not mix a production System User token with a different app’s test number ID.';
  }
  return httpError(message, status, { meta: data?.error || data || null });
}

class WhatsAppService {
  static async getClientAccount(clientId) {
    const account = await SaasWhatsAppAccount.findOne({ client_id: clientId, status: 'active' }).sort({
      updated_at: -1,
    });
    if (account) return { account, resolvedClientId: clientId };

    if (clientId !== 'Khana') {
      const khana = await SaasWhatsAppAccount.findOne({ client_id: 'Khana', status: 'active' }).sort({
        updated_at: -1,
      });
      if (khana) return { account: khana, resolvedClientId: 'Khana' };
    }

    throw httpError(
      'No active WhatsApp Cloud API account for this client or Khana fallback. Save Cloud API credentials first.',
      400
    );
  }

  /**
   * Subscribe this developer app to a WABA so Meta delivers inbound customer messages
   * (and statuses) to the configured webhook. Without this, outbound works but replies never arrive.
   */
  static async subscribeWabaApp({ wabaId, accessToken }) {
    const waba_id = String(wabaId || '').trim();
    const token = String(accessToken || '').trim();
    if (!waba_id || !token) {
      return { ok: false, skipped: true, reason: 'missing waba_id or token' };
    }

    const url = `${WA_API_BASE}/${waba_id}/subscribed_apps`;
    try {
      const existing = await axios.get(url, {
        timeout: 15000,
        headers: { Authorization: `Bearer ${token}` },
      });
      const apps = existing.data?.data || [];
      if (apps.length > 0) {
        console.log(`[whatsapp] WABA ${waba_id} already has ${apps.length} subscribed app(s)`);
        return { ok: true, alreadySubscribed: true, apps };
      }
    } catch (e) {
      console.warn(
        '[whatsapp] could not list subscribed_apps:',
        e.response?.data?.error?.message || e.message
      );
    }

    try {
      const response = await axios.post(url, null, {
        timeout: 15000,
        headers: { Authorization: `Bearer ${token}` },
      });
      console.log(`[whatsapp] subscribed app to WABA ${waba_id}:`, response.data);
      return { ok: true, subscribed: true, data: response.data };
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      console.error(`[whatsapp] failed to subscribe app to WABA ${waba_id}:`, msg);
      return { ok: false, error: msg, meta: e.response?.data?.error || null };
    }
  }

  static async clientAllowsNotifications(clientId) {
    if (!clientId) return false;
    const client = await Client.findOne({ clientID: clientId }).select('whatsapp');
    return client?.whatsapp?.notificationsEnabled === true;
  }

  /**
   * List phone numbers a token can access on a WABA (debug #100/33 pairing).
   */
  static async listSandboxPhoneNumbers({ wabaId, accessToken }) {
    const waba_id = String(
      wabaId || process.env.WHATSAPP_TEST_WABA_ID || process.env.WHATSAPP_WABA_ID || ''
    ).trim();
    const token = String(accessToken || process.env.WHATSAPP_TEST_ACCESS_TOKEN || '').trim();

    if (!waba_id || !token) {
      throw httpError(
        'Paste WhatsApp Business Account ID (WABA) and access token to list phone numbers.',
        400
      );
    }

    const url = `${WA_API_BASE}/${waba_id}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`;
    let response;
    try {
      response = await axios.get(url, {
        timeout: 20000,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw formatMetaSendError(err);
    }

    const phones = Array.isArray(response.data?.data) ? response.data.data : [];
    return {
      waba_id,
      count: phones.length,
      phones,
      hint:
        phones.length > 0
          ? 'Use one of the id values below as Test Phone number ID with this same token.'
          : 'Token cannot list phones on this WABA. Generate a Temporary access token on API Setup for this app/WABA.',
    };
  }

  /**
   * Validate that an access token can read a Phone number ID (debug #100/33).
   */
  static async validateSandboxCredentials({ phoneNumberId, accessToken }) {
    const phone_number_id = String(
      phoneNumberId || process.env.WHATSAPP_TEST_PHONE_NUMBER_ID || ''
    ).trim();
    const token = String(accessToken || process.env.WHATSAPP_TEST_ACCESS_TOKEN || '').trim();

    if (!phone_number_id || !token) {
      throw httpError(
        'Paste Phone number ID and access token (or set WHATSAPP_TEST_* on Render).',
        400
      );
    }

    const url = `${WA_API_BASE}/${phone_number_id}?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status`;
    let response;
    try {
      response = await axios.get(url, {
        timeout: 20000,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      throw formatMetaSendError(err);
    }

    return {
      ok: true,
      phone_number_id,
      graphBase: WA_API_BASE,
      meta: response.data,
      hint: 'Token can read this Phone number ID. Retry Send Meta sandbox test with the same pair.',
    };
  }

  /**
   * Send via Meta's API Setup sandbox / test phone number (usually hello_world).
   * Bypasses SaasWhatsAppAccount + credit billing — credentials from args or WHATSAPP_TEST_* env.
   */
  static async sendSandboxTemplateMessage({
    to,
    phoneNumberId,
    accessToken,
    templateName = 'hello_world',
    languageCode = TEMPLATE_LANG,
  }) {
    const e164 = normalizePhoneE164(to);
    if (!e164) {
      throw httpError(
        'Invalid WhatsApp recipient phone number. Use e.g. 0766356790 or +27766356790.',
        400
      );
    }

    const phone_number_id = String(
      phoneNumberId || process.env.WHATSAPP_TEST_PHONE_NUMBER_ID || ''
    ).trim();
    const token = String(accessToken || process.env.WHATSAPP_TEST_ACCESS_TOKEN || '').trim();

    if (!phone_number_id || !token) {
      throw httpError(
        'Sandbox credentials missing. Paste Meta API Setup test Phone number ID + temporary token, or set WHATSAPP_TEST_PHONE_NUMBER_ID and WHATSAPP_TEST_ACCESS_TOKEN on Render.',
        400
      );
    }

    const url = `${WA_API_BASE}/${phone_number_id}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      to: e164,
      type: 'template',
      template: {
        name: templateName || 'hello_world',
        language: { code: languageCode || 'en_US' },
      },
    };

    let response;
    try {
      response = await axios.post(url, payload, {
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      throw formatMetaSendError(err);
    }

    return {
      phone_number_id,
      to: e164,
      templateName: templateName || 'hello_world',
      meta: response.data,
    };
  }

  /**
   * Register a Cloud API phone number (required once before sending).
   * Meta error 133010 = number added/verified but not registered yet.
   * @param {{ clientId: string, pin?: string }} opts
   */
  static async registerPhoneNumber({ clientId, pin }) {
    const pinDigits = String(pin || '').replace(/\D/g, '');
    if (pinDigits.length !== 6) {
      throw httpError('Two-step PIN must be exactly 6 digits', 400);
    }

    const { account, resolvedClientId } = await this.getClientAccount(clientId);
    const token = decrypt(account.access_token_encrypted);
    const url = `${WA_API_BASE}/${account.phone_number_id}/register`;

    let response;
    try {
      response = await axios.post(
        url,
        {
          messaging_product: 'whatsapp',
          pin: pinDigits,
        },
        {
          timeout: 20000,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );
    } catch (err) {
      throw formatMetaSendError(err);
    }

    return {
      clientId: resolvedClientId,
      phone_number_id: account.phone_number_id,
      waba_id: account.waba_id,
      meta: response.data,
    };
  }

  /** Ensure the billed client has enough SaaS credits for one WhatsApp unit. */
  static async assertCreditsAvailable(clientId, messageType = 'utility') {
    if (!clientId || clientId === 'Khana') return;
    const priced = await PricingService.computeWhatsAppCredits(clientId, messageType, 1);
    const need = priced.credits;
    const account = await BillingService.ensureAccount(clientId);
    if (Number(account.credit_balance || 0) < need) {
      throw httpError(
        `Insufficient WhatsApp credits (need ${need}, have ${account.credit_balance}). Top up in Account Management.`,
        402
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
      throw httpError(
        'Invalid WhatsApp recipient phone number. Use e.g. 0766356790 or +27766356790.',
        400
      );
    }

    await this.assertCreditsAvailable(clientId, messageType);

    const { account, resolvedClientId } = await this.getClientAccount(clientId);
    const token = decrypt(account.access_token_encrypted);
    const url = `${WA_API_BASE}/${account.phone_number_id}/messages`;

    console.log(
      `[whatsapp] send template=${templateName} client=${clientId} resolved=${resolvedClientId} phone_number_id=${account.phone_number_id} to=${e164}`
    );
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

    let response;
    try {
      response = await axios.post(url, payload, {
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      throw formatMetaSendError(err);
    }

    const messageId = response.data?.messages?.[0]?.id || `wa-${Date.now()}`;
    const billingClientId = clientId || resolvedClientId;

    try {
      const WhatsAppInboxService = require('./WhatsAppInboxService');
      await WhatsAppInboxService.recordOutbound({
        clientId: billingClientId,
        phoneNumberId: account.phone_number_id,
        to: e164,
        wamid: messageId,
        type: 'template',
        body: `Template: ${templateName}`,
        templateName,
        status: 'sent',
        raw: response.data,
      });
    } catch (inboxErr) {
      console.warn('[whatsapp] inbox outbound record failed:', inboxErr.message);
    }

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
        urlButtonParam(orderViewButtonSuffix({ clientId, orderRef }), 0),
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
