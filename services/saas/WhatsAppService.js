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
const TEMPLATE_LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'en_US';

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
    data?.error?.error_user_msg ||
    data?.error?.message ||
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
  const n = Number(code);
  if (n === 133010 || /not registered/i.test(String(metaMsg))) {
    message +=
      ' — Open Account → WhatsApp → Register Cloud API number (6-digit PIN), then retry.';
  } else if (n === 131047) {
    message +=
      ' — The 24-hour customer-service window is closed. Send an approved template instead of a free-form message.';
  } else if (n === 131026) {
    message +=
      ' — Undeliverable: check the number is on WhatsApp, E.164 formatted (e.g. 2782… not 082…), and the user has not blocked you. Do not keep retrying the same recipient.';
  } else if (n === 131048 || n === 131049) {
    message +=
      ' — Meta rate/spam limit on this sender. Pause broadcasts, check quality rating in WhatsApp Manager, and retry later.';
  } else if (n === 131050) {
    message += ' — Recipient opted out of marketing messages from this business.';
  } else if (n === 132000) {
    message +=
      ' — Template variable count mismatch. Header, body, and button placeholders each need their own parameter values.';
  } else if (n === 132001) {
    message +=
      ' — Template name/language not found or not APPROVED on this WABA (en vs en_US are different). Sync templates, then use the exact language Meta shows.';
  } else if (n === 131045) {
    message += ' — Phone registration error. Re-register the Cloud API number, then retry.';
  } else if (n === 133016) {
    message += ' — Too many register attempts. Wait before Retry register.';
  }
  if (/not available for SMB/i.test(String(metaMsg))) {
    message +=
      ' — This number is on an SMB / WhatsApp Business App account. Meta blocks /register for SMB. Use coexistence Embedded Signup, or a dedicated Cloud API number.';
  }
  if (n === 100 && Number(subcode) === 33) {
    message +=
      ' — Token cannot access this Phone number ID. Reconnect WhatsApp (Embedded Signup) so the BISU token matches this WABA.';
  }
  return httpError(message, status, { meta: data?.error || data || null });
}

class WhatsAppService {
  static async getClientAccount(clientId) {
    const account = await SaasWhatsAppAccount.findOne({ client_id: clientId, status: 'active' }).sort({
      updated_at: -1,
    });
    if (account) return { account, resolvedClientId: clientId };

    // Do not fall back to Khana's WABA — that mixes tenant traffic and credentials.
    throw httpError(
      'No active WhatsApp Cloud API account for this client. Open Account → Connect WhatsApp first.',
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

    const ourAppId = String(
      process.env.WHATSAPP_APP_ID || process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || ''
    ).trim();
    const url = `${WA_API_BASE}/${waba_id}/subscribed_apps`;
    try {
      const existing = await axios.get(url, {
        timeout: 15000,
        headers: { Authorization: `Bearer ${token}` },
      });
      const apps = existing.data?.data || [];
      const alreadyOurs = ourAppId
        ? apps.some((a) => String(a.id || a) === ourAppId)
        : false;
      if (alreadyOurs) {
        console.log(`[whatsapp] WABA ${waba_id} already subscribed to app ${ourAppId}`);
        return { ok: true, alreadySubscribed: true, apps };
      }
      if (apps.length > 0 && !ourAppId) {
        // Without our app id we cannot tell if *this* app is subscribed — still POST.
        console.warn(
          `[whatsapp] WABA ${waba_id} has ${apps.length} subscribed app(s) but WHATSAPP_APP_ID/META_APP_ID is unset; attempting subscribe`
        );
      } else if (apps.length > 0) {
        console.log(
          `[whatsapp] WABA ${waba_id} has ${apps.length} subscribed app(s); our app ${ourAppId} missing — subscribing`
        );
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
    const BillingService = require('./BillingService');
    await BillingService.assertCreditsForAction(clientId, 'whatsapp', messageType, 1);
  }

  /** Queue usage + billing for one WhatsApp unit (templates and inbox freeform). */
  static async recordWhatsAppUsage({
    clientId,
    messageType = 'utility',
    sourceRef,
    metadata = {},
  }) {
    const billingClientId = String(clientId || '').trim();
    if (!billingClientId) return;
    try {
      await SaasUsageEvent.create({
        client_id: billingClientId,
        service: 'whatsapp',
        message_type: messageType,
        units: 1,
        source_ref: String(sourceRef || ''),
        status: 'queued',
        metadata: metadata && typeof metadata === 'object' ? metadata : {},
      });

      await usageBillingQueue.add('bill-whatsapp-message', {
        clientId: billingClientId,
        service: 'whatsapp',
        messageType,
        units: 1,
        sourceRef: String(sourceRef || ''),
        metadata: metadata && typeof metadata === 'object' ? metadata : {},
      });
    } catch (usageErr) {
      console.warn('[whatsapp] usage/billing record failed:', usageErr.message);
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

    // Prefer the exact APPROVED language Meta stored (en vs en_US is a common 132001).
    let resolvedLanguage = String(languageCode || TEMPLATE_LANG).trim() || TEMPLATE_LANG;
    try {
      const SaasWhatsAppTemplate = require('../../models/SaasWhatsAppTemplate');
      const exact = await SaasWhatsAppTemplate.findOne({
        client_id: clientId,
        name: templateName,
        language: resolvedLanguage,
        status: { $regex: /^APPROVED$/i },
      })
        .select('language')
        .lean();
      if (!exact) {
        const any = await SaasWhatsAppTemplate.findOne({
          client_id: clientId,
          name: templateName,
          status: { $regex: /^APPROVED$/i },
        })
          .select('language')
          .lean();
        if (any?.language) resolvedLanguage = String(any.language).trim();
      }
    } catch {
      /* keep caller language */
    }

    console.log(
      `[whatsapp] send template=${templateName} lang=${resolvedLanguage} client=${clientId} resolved=${resolvedClientId} phone_number_id=${account.phone_number_id} to=${e164}`
    );
    const payload = {
      messaging_product: 'whatsapp',
      to: e164,
      type: 'template',
      template: {
        name: templateName,
        language: { code: resolvedLanguage },
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

    await this.recordWhatsAppUsage({
      clientId: billingClientId,
      messageType,
      sourceRef: messageId,
      metadata: { to: e164, templateName, resolvedClientId, channel: 'template' },
    });

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

  /**
   * Pull message templates from Meta for the tenant WABA and upsert locally.
   */
  static async syncMessageTemplates(clientId) {
    const SaasWhatsAppTemplate = require('../../models/SaasWhatsAppTemplate');
    const { account, resolvedClientId } = await this.getClientAccount(clientId);
    const wabaId = String(account.waba_id || '').trim();
    if (!wabaId) throw httpError('WhatsApp account is missing waba_id', 400);

    const token = decrypt(account.access_token_encrypted);
    const syncedAt = new Date();
    let fetched = 0;
    let after = null;
    const upserted = [];

    do {
      const params = {
        fields: 'name,status,language,category,components,rejected_reason,quality_score',
        limit: 100,
      };
      if (after) params.after = after;

      let response;
      try {
        response = await axios.get(`${WA_API_BASE}/${wabaId}/message_templates`, {
          timeout: 30000,
          headers: { Authorization: `Bearer ${token}` },
          params,
        });
      } catch (err) {
        throw formatMetaSendError(err);
      }

      const rows = Array.isArray(response.data?.data) ? response.data.data : [];
      for (const row of rows) {
        const name = String(row.name || '').trim();
        const language = String(row.language || 'en').trim() || 'en';
        if (!name) continue;
        fetched += 1;
        const status = String(row.status || '').trim();
        const rejectedReason = String(row.rejected_reason || '').trim();
        const doc = await SaasWhatsAppTemplate.findOneAndUpdate(
          { client_id: clientId, name, language },
          {
            $set: {
              waba_id: wabaId,
              status,
              category: String(row.category || '').trim(),
              components: row.components || [],
              rejected_reason: /^REJECTED$/i.test(status) ? rejectedReason : '',
              synced_at: syncedAt,
            },
          },
          { upsert: true, new: true }
        );
        upserted.push({
          id: String(doc._id),
          name: doc.name,
          language: doc.language,
          status: doc.status,
          category: doc.category,
          rejected_reason: doc.rejected_reason || '',
        });
      }

      after = response.data?.paging?.cursors?.after || null;
      if (!response.data?.paging?.next) after = null;
    } while (after);

    return {
      client_id: clientId,
      resolved_client_id: resolvedClientId,
      waba_id: wabaId,
      fetched,
      upserted: upserted.length,
      templates: upserted,
      synced_at: syncedAt,
      auto_wire: await this.maybeAutoWireNotifications(clientId),
    };
  }

  /**
   * Submit a message template to Meta for review (POST /{WABA}/message_templates).
   * Body can be a Khana starter id, or a custom name/category/language/components payload.
   */
  static async createMessageTemplate(clientId, body = {}) {
    const SaasWhatsAppTemplate = require('../../models/SaasWhatsAppTemplate');
    const {
      getWhatsAppTemplateStarter,
      listWhatsAppTemplateStarters,
    } = require('../../helpers/whatsappTemplateStarters');

    const { account } = await this.getClientAccount(clientId);
    const wabaId = String(account.waba_id || '').trim();
    if (!wabaId) throw httpError('WhatsApp account is missing waba_id', 400);
    const token = decrypt(account.access_token_encrypted);

    const starterKey = String(body.starter || body.starter_id || body.starterId || '').trim();
    let name = String(body.name || '').trim().toLowerCase();
    let language = String(body.language || body.language_code || TEMPLATE_LANG).trim() || TEMPLATE_LANG;
    let category = String(body.category || 'UTILITY').trim().toUpperCase();
    let components = Array.isArray(body.components) ? body.components : null;
    let allowCategoryChange = body.allow_category_change !== false && body.allowCategoryChange !== false;

    if (starterKey) {
      const starter = getWhatsAppTemplateStarter(starterKey);
      if (!starter) {
        throw httpError(
          `Unknown starter "${starterKey}". Use one of: ${listWhatsAppTemplateStarters()
            .map((s) => s.id)
            .join(', ')}`,
          400
        );
      }
      name = starter.name;
      language = String(body.language || starter.language || language).trim() || language;
      category = starter.category;
      components = starter.components;
    } else if (!components) {
      // Simple custom builder: body (+ optional header/footer/URL button).
      const bodyText = String(body.body || body.body_text || body.text || '').trim();
      if (!bodyText) throw httpError('body text is required (or pass starter / components)', 400);
      components = [];
      const headerText = String(body.header || body.header_text || '').trim();
      if (headerText) {
        components.push({ type: 'HEADER', format: 'TEXT', text: headerText.slice(0, 60) });
      }
      const bodyExample = Array.isArray(body.body_examples)
        ? body.body_examples.map((x) => String(x ?? ''))
        : String(body.body_examples || '')
            .split('|')
            .map((x) => x.trim())
            .filter(Boolean);
      const bodyComp = { type: 'BODY', text: bodyText.slice(0, 1024) };
      const varCount = [...bodyText.matchAll(/\{\{(\d+)\}\}/g)].reduce(
        (m, x) => Math.max(m, Number(x[1]) || 0),
        0
      );
      if (varCount > 0) {
        const row = [];
        for (let i = 1; i <= varCount; i += 1) {
          row.push(bodyExample[i - 1] || `Sample ${i}`);
        }
        bodyComp.example = { body_text: [row] };
      }
      components.push(bodyComp);
      const footerText = String(body.footer || body.footer_text || '').trim();
      if (footerText) components.push({ type: 'FOOTER', text: footerText.slice(0, 60) });
      const buttonUrl = String(body.button_url || body.buttonUrl || '').trim();
      const buttonText = String(body.button_text || body.buttonText || 'Open').trim().slice(0, 25);
      if (buttonUrl) {
        const btn = { type: 'URL', text: buttonText || 'Open', url: buttonUrl };
        if (buttonUrl.includes('{{')) {
          btn.example = [String(body.button_example || body.buttonExample || 'sample').slice(0, 200)];
        }
        components.push({ type: 'BUTTONS', buttons: [btn] });
      }
    }

    if (!name) throw httpError('Template name is required', 400);
    if (!/^[a-z0-9_]+$/.test(name)) {
      throw httpError('Template name must be lowercase letters, numbers, and underscores only', 400);
    }
    if (!['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(category)) {
      throw httpError('category must be UTILITY, MARKETING, or AUTHENTICATION', 400);
    }
    if (!Array.isArray(components) || !components.length) {
      throw httpError('components are required', 400);
    }

    const payload = {
      name,
      language,
      category,
      allow_category_change: !!allowCategoryChange,
      components,
    };

    let response;
    try {
      response = await axios.post(`${WA_API_BASE}/${wabaId}/message_templates`, payload, {
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      throw formatMetaSendError(err);
    }

    const metaId = String(response.data?.id || '').trim();
    const status = String(response.data?.status || 'PENDING').trim() || 'PENDING';
    const syncedAt = new Date();

    const doc = await SaasWhatsAppTemplate.findOneAndUpdate(
      { client_id: clientId, name, language },
      {
        $set: {
          waba_id: wabaId,
          status,
          category,
          components,
          meta_template_id: metaId,
          rejected_reason: '',
          synced_at: syncedAt,
        },
      },
      { upsert: true, new: true }
    );

    await this.writeAudit(clientId, {
      action: 'template_submit',
      templateName: name,
      detail: `status=${status} category=${category}`,
      meta: { meta_template_id: metaId, language },
    });

    return {
      id: String(doc._id),
      meta_template_id: metaId,
      name: doc.name,
      language: doc.language,
      status: doc.status,
      category: doc.category,
      components: doc.components,
      synced_at: syncedAt,
      meta: response.data,
    };
  }

  /** Delete a template on the client WABA (by name; language optional). */
  static async deleteMessageTemplate(clientId, { name, language = '' } = {}) {
    const SaasWhatsAppTemplate = require('../../models/SaasWhatsAppTemplate');
    const templateName = String(name || '').trim().toLowerCase();
    if (!templateName) throw httpError('Template name is required', 400);

    const { account } = await this.getClientAccount(clientId);
    const wabaId = String(account.waba_id || '').trim();
    if (!wabaId) throw httpError('WhatsApp account is missing waba_id', 400);
    const token = decrypt(account.access_token_encrypted);

    const params = { name: templateName };
    const lang = String(language || '').trim();
    if (lang) params.language = lang;

    try {
      await axios.delete(`${WA_API_BASE}/${wabaId}/message_templates`, {
        timeout: 30000,
        headers: { Authorization: `Bearer ${token}` },
        params,
      });
    } catch (err) {
      throw formatMetaSendError(err);
    }

    const filter = { client_id: clientId, name: templateName };
    if (lang) filter.language = lang;
    await SaasWhatsAppTemplate.deleteMany(filter);

    await this.writeAudit(clientId, {
      action: 'template_delete',
      templateName: templateName,
      detail: lang ? `language=${lang}` : '',
    });

    return { deleted: true, name: templateName, language: lang || null };
  }

  static async writeAudit(clientId, { action, actor = '', templateName = '', detail = '', meta = null } = {}) {
    try {
      const SaasWhatsAppAuditLog = require('../../models/SaasWhatsAppAuditLog');
      await SaasWhatsAppAuditLog.create({
        client_id: clientId,
        actor: String(actor || '').slice(0, 120),
        action: String(action || 'event').slice(0, 80),
        template_name: String(templateName || '').slice(0, 120),
        detail: String(detail || '').slice(0, 500),
        meta: meta && typeof meta === 'object' ? meta : null,
      });
    } catch (e) {
      console.warn('[whatsapp audit]', e.message);
    }
  }

  /** When required Khana templates are APPROVED, enable Cloud notifications automatically. */
  static async maybeAutoWireNotifications(clientId) {
    const SaasWhatsAppTemplate = require('../../models/SaasWhatsAppTemplate');
    const required = [
      'order_confirmation',
      'order_status_update',
      'booking_confirmation',
      'booking_reminder',
      'account_verification',
    ];
    const approved = await SaasWhatsAppTemplate.find({
      client_id: clientId,
      name: { $in: required },
      status: { $regex: /^APPROVED$/i },
    })
      .select('name')
      .lean();
    const approvedNames = new Set(approved.map((r) => r.name));
    const ready = required.filter((n) => approvedNames.has(n));
    // Auto-wire when at least one core transactional template is approved.
    const coreReady =
      approvedNames.has('order_confirmation') || approvedNames.has('booking_confirmation');
    if (!coreReady) {
      return { enabled: false, reason: 'waiting_for_core_template', approved: ready };
    }

    const bill = await BillingService.ensureAccount(clientId);
    const creditsOk = clientId === 'Khana' || Number(bill.credit_balance || 0) > 0;
    if (!creditsOk) {
      return { enabled: false, reason: 'needs_credits', approved: ready };
    }

    const client = await Client.findOne({ clientID: clientId }).select('whatsapp').lean();
    if (client?.whatsapp?.notificationsEnabled) {
      return { enabled: true, already: true, approved: ready };
    }
    await Client.updateOne(
      { clientID: clientId },
      { $set: { 'whatsapp.notificationsEnabled': true } }
    );
    await this.writeAudit(clientId, {
      action: 'auto_wire_notifications',
      detail: `Enabled notifications; approved=${ready.join(',')}`,
    });
    return { enabled: true, already: false, approved: ready };
  }

  /** Submit all Khana starter templates that are not already APPROVED/PENDING. */
  static async installTemplatePack(clientId, { actor = '' } = {}) {
    // Fail fast with a clear message before iterating starters.
    await this.getClientAccount(clientId);
    const SaasWhatsAppTemplate = require('../../models/SaasWhatsAppTemplate');
    const { listWhatsAppTemplateStarters } = require('../../helpers/whatsappTemplateStarters');
    const starters = listWhatsAppTemplateStarters();
    const results = [];

    for (const starter of starters) {
      const existing = await SaasWhatsAppTemplate.findOne({
        client_id: clientId,
        name: starter.name,
      })
        .select('status language')
        .lean();
      const st = String(existing?.status || '');
      if (/^APPROVED$/i.test(st) || /^PENDING$/i.test(st)) {
        results.push({
          starter: starter.id,
          name: starter.name,
          skipped: true,
          status: st,
        });
        continue;
      }
      // Rejected / missing: clear local+Meta name when possible, then resubmit.
      if (/^REJECTED$/i.test(st)) {
        try {
          await this.deleteMessageTemplate(clientId, {
            name: starter.name,
            language: existing?.language || '',
          });
        } catch (delErr) {
          console.warn('[whatsapp pack] delete rejected failed:', delErr.message);
        }
      }
      try {
        const created = await this.createMessageTemplate(clientId, { starter: starter.id });
        results.push({
          starter: starter.id,
          name: created.name,
          skipped: false,
          status: created.status,
          id: created.id,
        });
      } catch (err) {
        results.push({
          starter: starter.id,
          name: starter.name,
          skipped: false,
          error: err.message || 'create failed',
        });
      }
    }

    await this.writeAudit(clientId, {
      action: 'install_template_pack',
      actor,
      detail: `submitted=${results.filter((r) => !r.skipped && !r.error).length} skipped=${results.filter((r) => r.skipped).length}`,
      meta: { results },
    });

    return {
      results,
      submitted: results.filter((r) => !r.skipped && !r.error).length,
      skipped: results.filter((r) => r.skipped).length,
      failed: results.filter((r) => r.error).length,
    };
  }

  static async getHealth(clientId) {
    const SaasWhatsAppTemplate = require('../../models/SaasWhatsAppTemplate');
    const SaasWhatsAppWebhookEvent = require('../../models/SaasWhatsAppWebhookEvent');
    let account = null;
    try {
      ({ account } = await this.getClientAccount(clientId));
    } catch {
      account = null;
    }
    const client = await Client.findOne({ clientID: clientId }).select('whatsapp').lean();
    const templates = await SaasWhatsAppTemplate.find({ client_id: clientId })
      .select('name status category rejected_reason language')
      .lean();
    const required = [
      'order_confirmation',
      'order_status_update',
      'booking_confirmation',
      'booking_reminder',
      'account_verification',
    ];
    const byName = new Map(templates.map((t) => [t.name, t]));
    const requiredStatus = required.map((name) => ({
      name,
      status: byName.get(name)?.status || 'missing',
      rejected_reason: byName.get(name)?.rejected_reason || '',
    }));
    const approvedRequired = requiredStatus.filter((r) => /^APPROVED$/i.test(r.status)).length;
    let lastWebhookAt = null;
    try {
      if (account?.phone_number_id) {
        const last = await SaasWhatsAppWebhookEvent.findOne({
          phone_number_id: account.phone_number_id,
        })
          .sort({ created_at: -1 })
          .select('created_at')
          .lean();
        lastWebhookAt = last?.created_at || null;
      }
    } catch {
      lastWebhookAt = null;
    }

    let creditBalance = 0;
    try {
      const bill = await BillingService.ensureAccount(clientId);
      creditBalance = Number(bill.credit_balance || 0) || 0;
    } catch {
      creditBalance = 0;
    }

    const checks = [
      { id: 'cloud_connected', label: 'WhatsApp Cloud connected', ok: !!account?.access_token_encrypted },
      {
        id: 'phone_registered',
        label: 'Number registered for Cloud API',
        ok: !!account?.phone_registered_at || !!account?.coexistence,
      },
      {
        id: 'notifications',
        label: 'Order/booking notifications on',
        ok: !!client?.whatsapp?.notificationsEnabled,
      },
      {
        id: 'chat_number',
        label: 'Website chat number set',
        ok: !!String(client?.whatsapp?.phoneE164 || '').trim(),
      },
      {
        id: 'core_templates',
        label: 'Core templates approved',
        ok: requiredStatus.some(
          (r) =>
            (r.name === 'order_confirmation' || r.name === 'booking_confirmation') &&
            /^APPROVED$/i.test(r.status)
        ),
      },
      {
        id: 'credits',
        label: creditBalance > 0 ? 'Credits available' : 'Top up WhatsApp credits',
        ok: clientId === 'Khana' || creditBalance > 0,
      },
    ];
    const score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);

    return {
      score,
      ready: checks.every((c) => c.ok),
      checks,
      coexistence: !!account?.coexistence,
      display_phone_number: account?.display_phone_number || client?.whatsapp?.phoneE164 || '',
      phone_number_id: account?.phone_number_id || '',
      waba_id: account?.waba_id || '',
      mode: account?.mode || '',
      notifications_enabled: !!client?.whatsapp?.notificationsEnabled,
      credit_balance: creditBalance,
      templates: {
        total: templates.length,
        approved: templates.filter((t) => /^APPROVED$/i.test(t.status)).length,
        pending: templates.filter((t) => /^PENDING$/i.test(t.status)).length,
        rejected: templates.filter((t) => /^REJECTED$/i.test(t.status)).length,
        required: requiredStatus,
        approved_required: approvedRequired,
      },
      last_webhook_at: lastWebhookAt,
      tips: [
        !account?.access_token_encrypted
          ? 'Connect WhatsApp under Account to link your business number.'
          : null,
        account?.access_token_encrypted && !account?.phone_registered_at && !account?.coexistence
          ? 'Number not registered yet — use Retry register under Account → WhatsApp (6-digit PIN).'
          : null,
        account?.coexistence
          ? 'Coexistence is on — you can keep using the WhatsApp Business app on this number.'
          : account?.access_token_encrypted
            ? 'Cloud-only number — use Connect WhatsApp with coexistence if you also need the Business app.'
            : null,
        clientId !== 'Khana' && creditBalance <= 0
          ? 'Top up WhatsApp credits so order/booking notifications and tests can send.'
          : null,
        approvedRequired < required.length
          ? 'Open WA Templates → Install Khana pack, then Sync until templates show APPROVED.'
          : 'Required Khana templates look good.',
        !lastWebhookAt && account?.phone_number_id
          ? 'No webhook events yet — send yourself a message or reconnect if inbox stays empty.'
          : null,
      ].filter(Boolean),
    };
  }

  static async estimateBroadcastCredits(clientId, { recipientCount = 0, messageType = 'utility' } = {}) {
    const count = Math.max(0, Math.min(200, Number(recipientCount) || 0));
    let creditsPer = 1;
    try {
      const priced = await PricingService.computeWhatsAppCredits(clientId, messageType, 1);
      creditsPer = Number(priced.credits || 1) || 1;
    } catch {
      creditsPer = messageType === 'marketing' ? 2.25 : 1;
    }
    const total = Math.round(count * creditsPer * 100) / 100;
    let balance = 0;
    try {
      const bill = await BillingService.ensureAccount(clientId);
      balance = Number(bill.credit_balance || 0) || 0;
    } catch {
      balance = 0;
    }
    return {
      recipient_count: count,
      message_type: messageType,
      credits_per_message: creditsPer,
      estimated_credits: total,
      credit_balance: balance,
      can_afford: balance >= total,
    };
  }

  /** Send a test template to the account owner's phone (or provided to). */
  static async sendTestToMe(clientId, { to = '', templateName = '', language = '' } = {}) {
    const SaasWhatsAppTemplate = require('../../models/SaasWhatsAppTemplate');
    const client = await Client.findOne({ clientID: clientId })
      .select('whatsapp companyName')
      .lean();
    const dest =
      normalizePhoneE164(to) ||
      normalizePhoneE164(client?.whatsapp?.phoneE164 || '') ||
      '';
    if (!dest) {
      throw httpError(
        'No test phone. Set website chat number or pass { to: "+27…" }.',
        400
      );
    }

    let name = String(templateName || '').trim();
    if (!name) {
      const preferred = await SaasWhatsAppTemplate.findOne({
        client_id: clientId,
        name: { $in: ['hello_world', 'order_confirmation', 'booking_confirmation'] },
        status: { $regex: /^APPROVED$/i },
      })
        .select('name language')
        .lean();
      const anyApproved = preferred
        || (await SaasWhatsAppTemplate.findOne({
              client_id: clientId,
              status: { $regex: /^APPROVED$/i },
            })
              .select('name language')
              .lean());
      if (!anyApproved) {
        throw httpError(
          'No APPROVED template yet. Install the Khana pack, wait for Meta approval, Sync, then retry Test to me.',
          400
        );
      }
      name = anyApproved.name;
      if (!language) language = anyApproved.language || '';
    }

    const WhatsAppInboxService = require('./WhatsAppInboxService');
    const data = await WhatsAppInboxService.sendInboxTemplate({
      clientId,
      contactWaId: dest,
      templateName: name,
      language,
      companyName: client?.companyName || clientId,
    });
    await this.writeAudit(clientId, {
      action: 'test_to_me',
      templateName: name,
      detail: `to=${dest}`,
    });
    return { ...data, template_name: name };
  }

  /**
   * Apply Meta message_template_status_update webhook so clients see APPROVED/REJECTED
   * without waiting for a manual Sync (common go-live delay others hit).
   */
  static async applyTemplateStatusWebhook({ wabaId = '', value = {} } = {}) {
    const SaasWhatsAppTemplate = require('../../models/SaasWhatsAppTemplate');
    const name = String(value.message_template_name || value.name || '').trim();
    const language = String(value.message_template_language || value.language || '').trim();
    const event = String(value.event || value.status || '').trim().toUpperCase();
    const reason = String(value.reason || value.rejected_reason || '').trim();
    const metaId = String(value.message_template_id || value.id || '').trim();
    if (!name || !event) return { updated: 0 };

    let clientIds = [];
    const waba = String(wabaId || '').trim();
    if (waba) {
      const accounts = await SaasWhatsAppAccount.find({ waba_id: waba, status: 'active' })
        .select('client_id')
        .lean();
      clientIds = [...new Set(accounts.map((a) => a.client_id).filter(Boolean))];
    }
    if (!clientIds.length && metaId) {
      const byMeta = await SaasWhatsAppTemplate.find({ meta_template_id: metaId })
        .select('client_id')
        .lean();
      clientIds = [...new Set(byMeta.map((t) => t.client_id).filter(Boolean))];
    }
    if (!clientIds.length) return { updated: 0, reason: 'no_tenant' };

    const status =
      event === 'APPROVED'
        ? 'APPROVED'
        : event === 'REJECTED'
          ? 'REJECTED'
          : event === 'PENDING' || event === 'IN_APPEAL'
            ? 'PENDING'
            : event;

    let updated = 0;
    for (const clientId of clientIds) {
      const filter = { client_id: clientId, name };
      if (language) filter.language = language;
      const set = {
        status,
        synced_at: new Date(),
        rejected_reason: status === 'REJECTED' ? reason : '',
      };
      if (waba) set.waba_id = waba;
      if (metaId) set.meta_template_id = metaId;
      const result = await SaasWhatsAppTemplate.updateMany(filter, { $set: set });
      updated += result.modifiedCount || 0;
      if (!(result.matchedCount || 0) && language) {
        await SaasWhatsAppTemplate.findOneAndUpdate(
          { client_id: clientId, name, language },
          {
            $set: {
              ...set,
              category: '',
              components: [],
            },
            $setOnInsert: { client_id: clientId, name, language },
          },
          { upsert: true }
        );
        updated += 1;
      }
    }
    return { updated, status, name, language, clientIds };
  }
}

module.exports = WhatsAppService;
