const crypto = require('crypto');
const axios = require('axios');
const SaasWhatsAppAccount = require('../../models/SaasWhatsAppAccount');
const Client = require('../../models/client');
const { encrypt } = require('../../helpers/encryption');
const WhatsAppService = require('./WhatsAppService');

const META_GRAPH_BASE = process.env.META_GRAPH_BASE || 'https://graph.facebook.com/v25.0';
const META_APP_ID = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '';
const META_APP_SECRET = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '';
const EMBEDDED_CONFIG_ID = String(
  process.env.META_WHATSAPP_EMBEDDED_CONFIG_ID ||
    process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID ||
    ''
).trim();

function graphVersionFromBase() {
  const m = String(META_GRAPH_BASE).match(/\/(v\d+(?:\.\d+)?)/i);
  return m ? m[1] : 'v25.0';
}

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function formatGraphError(err) {
  const fb = err?.response?.data?.error;
  if (fb?.error_user_msg) {
    return fb.error_user_title ? `${fb.error_user_title}: ${fb.error_user_msg}` : fb.error_user_msg;
  }
  if (fb?.message) return fb.message;
  return err?.message || 'Meta API request failed';
}

function isConfigured() {
  return Boolean(META_APP_ID && META_APP_SECRET && EMBEDDED_CONFIG_ID);
}

function coexistenceEnabled() {
  const flag = String(process.env.WHATSAPP_EMBEDDED_COEXISTENCE || '1').trim().toLowerCase();
  return flag !== '0' && flag !== 'false' && flag !== 'off';
}

function getPublicConfig() {
  return {
    enabled: isConfigured(),
    appId: META_APP_ID || null,
    configId: EMBEDDED_CONFIG_ID || null,
    graphVersion: graphVersionFromBase(),
    coexistence: coexistenceEnabled(),
    missing: [
      !META_APP_ID ? 'META_APP_ID' : null,
      !META_APP_SECRET ? 'META_APP_SECRET' : null,
      !EMBEDDED_CONFIG_ID ? 'META_WHATSAPP_EMBEDDED_CONFIG_ID' : null,
    ].filter(Boolean),
  };
}

function appAccessToken() {
  return `${META_APP_ID}|${META_APP_SECRET}`;
}

/**
 * Exchange Embedded Signup one-time code for a Business Integration System User token.
 * Codes expire in ~30s — call immediately from the complete route.
 */
async function exchangeCodeForBusinessToken(code) {
  const authCode = String(code || '').trim();
  if (!authCode) throw httpError('Missing Embedded Signup authorization code', 400);
  if (!isConfigured()) {
    throw httpError(
      'WhatsApp Embedded Signup is not configured (META_APP_ID, META_APP_SECRET, META_WHATSAPP_EMBEDDED_CONFIG_ID)',
      503
    );
  }

  try {
    const { data } = await axios.get(`${META_GRAPH_BASE}/oauth/access_token`, {
      timeout: 20000,
      params: {
        client_id: META_APP_ID,
        client_secret: META_APP_SECRET,
        code: authCode,
      },
    });
    const token = String(data?.access_token || '').trim();
    if (!token) throw httpError('Meta did not return a business access token', 502);
    return {
      accessToken: token,
      expiresIn: data?.expires_in != null ? Number(data.expires_in) : null,
      tokenType: data?.token_type || 'bearer',
    };
  } catch (err) {
    if (err.status) throw err;
    throw httpError(formatGraphError(err), err?.response?.status || 400);
  }
}

async function debugToken(inputToken) {
  try {
    const { data } = await axios.get(`${META_GRAPH_BASE}/debug_token`, {
      timeout: 15000,
      params: {
        input_token: inputToken,
        access_token: appAccessToken(),
      },
    });
    return data?.data || null;
  } catch (err) {
    console.warn('[whatsapp embedded] debug_token failed:', formatGraphError(err));
    return null;
  }
}

function wabaIdsFromDebug(debug) {
  const scopes = Array.isArray(debug?.granular_scopes) ? debug.granular_scopes : [];
  const ids = new Set();
  for (const row of scopes) {
    const scope = String(row?.scope || '');
    if (!/whatsapp_business_(management|messaging)/i.test(scope)) continue;
    for (const id of row.target_ids || []) {
      if (id) ids.add(String(id));
    }
  }
  return [...ids];
}

async function listPhoneNumbers(wabaId, accessToken) {
  const { data } = await axios.get(`${META_GRAPH_BASE}/${wabaId}/phone_numbers`, {
    timeout: 20000,
    headers: { Authorization: `Bearer ${accessToken}` },
    params: {
      fields: 'id,display_phone_number,verified_name,code_verification_status,platform_type,is_on_biz_app',
    },
  });
  return Array.isArray(data?.data) ? data.data : [];
}

async function resolveAssets({ accessToken, wabaId, phoneNumberId }) {
  let waba = String(wabaId || '').trim();
  let phone = String(phoneNumberId || '').trim();
  let phones = [];
  let debug = null;

  if (!waba) {
    debug = await debugToken(accessToken);
    const fromDebug = wabaIdsFromDebug(debug);
    if (fromDebug.length === 1) waba = fromDebug[0];
    else if (fromDebug.length > 1) {
      throw httpError(
        'Multiple WhatsApp Business Accounts were granted. Complete signup again and select one WABA.',
        400
      );
    }
  }

  if (!waba) {
    throw httpError(
      'Could not determine WhatsApp Business Account ID from Embedded Signup. Please try Connect WhatsApp again.',
      400
    );
  }

  try {
    phones = await listPhoneNumbers(waba, accessToken);
  } catch (err) {
    throw httpError(
      `Could not list phone numbers on WABA: ${formatGraphError(err)}`,
      err?.response?.status || 400
    );
  }

  if (!phone) {
    if (phones.length === 1) phone = String(phones[0].id);
    else if (phones.length > 1) {
      // Coexistence often omits phone_number_id — prefer the Business-app number, then Cloud API.
      const onBiz = phones.find((p) => p.is_on_biz_app === true);
      const cloud = phones.find((p) => String(p.platform_type || '').toUpperCase() === 'CLOUD_API');
      phone = String((onBiz || cloud || phones[0]).id);
    }
  }

  if (!phone) {
    throw httpError(
      'No WhatsApp business phone number was found on this account. Add a number in the Meta signup popup and try again.',
      400
    );
  }

  const phoneMeta = phones.find((p) => String(p.id) === String(phone)) || null;
  return {
    wabaId: waba,
    phoneNumberId: phone,
    phoneMeta,
    debug,
  };
}

async function registerPhoneNumber({ phoneNumberId, accessToken, pin }) {
  const pinDigits = String(pin || '').replace(/\D/g, '');
  if (pinDigits.length !== 6) {
    throw httpError('Two-step PIN must be exactly 6 digits', 400);
  }

  try {
    const { data } = await axios.post(
      `${META_GRAPH_BASE}/${phoneNumberId}/register`,
      {
        messaging_product: 'whatsapp',
        pin: pinDigits,
      },
      {
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );
    return { ok: true, meta: data, pin: pinDigits };
  } catch (err) {
    const msg = formatGraphError(err);
    const code = err?.response?.data?.error?.code;
    const subcode = err?.response?.data?.error?.error_subcode;
    // Already registered is success for idempotent onboard (NOT 133016 — that is rate limit).
    if (/already registered/i.test(msg) || Number(code) === 133015) {
      return { ok: true, alreadyRegistered: true, meta: err?.response?.data || null, pin: pinDigits };
    }
    if (Number(code) === 133016 || /too many.*(register|attempt)/i.test(msg)) {
      throw httpError(
        'Meta temporarily blocked registration for this number (too many attempts). Wait 1–24 hours, then use Retry register — do not spam the button.',
        429
      );
    }
    if (Number(subcode) === 2388001 || /still.*(whatsapp|connected|linked)/i.test(msg)) {
      throw httpError(
        'This number still looks attached to WhatsApp / another provider. Use Connect WhatsApp with coexistence if staff keep the Business app, or migrate the number fully before registering.',
        400
      );
    }
    if (/pin|two.?step|verification/i.test(msg) && /incorrect|invalid|wrong|mismatch/i.test(msg)) {
      throw httpError(
        'Wrong 6-digit two-step PIN. Reset it in Meta WhatsApp Manager → Phone numbers → Two-step verification, then Retry register.',
        400
      );
    }
    const e = httpError(msg, err?.response?.status || 400);
    e.meta = err?.response?.data || null;
    throw e;
  }
}

function makeRegisterPin() {
  // Shared env PIN only when explicitly allowed — otherwise unique per onboard.
  if (String(process.env.WHATSAPP_ALLOW_SHARED_REGISTER_PIN || '').trim() === '1') {
    const envPin = String(process.env.WHATSAPP_DEFAULT_REGISTER_PIN || '').replace(/\D/g, '');
    if (envPin.length === 6) return envPin;
  }
  return String(crypto.randomInt(100000, 999999));
}

function isCoexistenceEvent(event) {
  return /FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING/i.test(String(event || ''));
}

/**
 * Full Tech Provider onboard after Embedded Signup popup completes.
 */
async function completeEmbeddedSignup({
  clientId,
  code,
  wabaId = '',
  phoneNumberId = '',
  event = '',
  pin = '',
}) {
  const tenantId = String(clientId || '').trim();
  if (!tenantId) throw httpError('clientId is required', 400);

  const { accessToken } = await exchangeCodeForBusinessToken(code);
  const assets = await resolveAssets({
    accessToken,
    wabaId,
    phoneNumberId,
  });

  const coexistence = isCoexistenceEvent(event) || !!assets.phoneMeta?.is_on_biz_app;

  const conflict = await SaasWhatsAppAccount.findOne({
    phone_number_id: assets.phoneNumberId,
    status: 'active',
    client_id: { $ne: tenantId },
  })
    .select('client_id')
    .lean();
  if (conflict) {
    throw httpError(
      `This WhatsApp Business number is already connected to another Khana client (${conflict.client_id}). Disconnect it there first, then try again.`,
      409
    );
  }

  const prev = await SaasWhatsAppAccount.findOne({
    client_id: tenantId,
    phone_number_id: assets.phoneNumberId,
  }).select('waba_id dataset_id');

  const wabaChanged = prev && String(prev.waba_id) !== String(assets.wabaId);

  const doc = await SaasWhatsAppAccount.findOneAndUpdate(
    { client_id: tenantId, phone_number_id: assets.phoneNumberId },
    {
      $set: {
        client_id: tenantId,
        waba_id: assets.wabaId,
        phone_number_id: assets.phoneNumberId,
        display_phone_number: String(assets.phoneMeta?.display_phone_number || '').trim(),
        verified_name: String(assets.phoneMeta?.verified_name || '').trim(),
        mode: 'embedded',
        coexistence: !!coexistence,
        access_token_encrypted: encrypt(accessToken),
        status: 'active',
        embedded_signup_at: new Date(),
        ...(wabaChanged || !prev
          ? {
              dataset_id: '',
              dataset_source: 'cleared',
              dataset_linked_at: null,
            }
          : {}),
      },
    },
    { upsert: true, new: true }
  );

  // Disable any other active WhatsApp accounts for this tenant so one sender wins.
  await SaasWhatsAppAccount.updateMany(
    {
      client_id: tenantId,
      status: 'active',
      phone_number_id: { $ne: assets.phoneNumberId },
    },
    { $set: { status: 'disabled' } }
  );

  const subscribe = await WhatsAppService.subscribeWabaApp({
    wabaId: assets.wabaId,
    accessToken,
  });

  let registered = false;
  let registerSkipped = false;
  let registerError = '';
  let registerPinHint = '';

  if (coexistence) {
    registerSkipped = true;
    registered = true;
    doc.phone_registered_at = doc.phone_registered_at || new Date();
    await doc.save();
  } else {
    const registerPin = String(pin || '').replace(/\D/g, '').length === 6
      ? String(pin).replace(/\D/g, '')
      : makeRegisterPin();
    try {
      await registerPhoneNumber({
        phoneNumberId: assets.phoneNumberId,
        accessToken,
        pin: registerPin,
      });
      registered = true;
      registerPinHint = registerPin;
      doc.phone_registered_at = new Date();
      doc.last_register_error = '';
      await doc.save();
    } catch (err) {
      registerError = String(err.message || err).slice(0, 500);
      doc.last_register_error = registerError;
      await doc.save();
      console.warn(`[whatsapp embedded] register failed for ${tenantId}:`, registerError);
    }
  }

  let dataset = null;
  let datasetError = '';
  try {
    const WhatsAppConversionsService = require('./WhatsAppConversionsService');
    dataset = await WhatsAppConversionsService.ensureDataset(tenantId, { force: true });
  } catch (e) {
    datasetError = String(e?.message || e).slice(0, 500);
  }

  // Backfill click-to-chat number when empty. Only enable automations when credits exist
  // (otherwise new clients look "on" but every send soft-fails).
  let chatPhoneBackfilled = false;
  let notificationsEnabled = false;
  let needsCredits = false;
  try {
    const displayPhone = String(assets.phoneMeta?.display_phone_number || '').trim();
    const BillingService = require('./BillingService');
    const bill = await BillingService.ensureAccount(tenantId);
    const creditsOk = tenantId === 'Khana' || Number(bill.credit_balance || 0) > 0;
    needsCredits = !creditsOk;
    const setPayload = {};
    if (creditsOk) {
      setPayload['whatsapp.notificationsEnabled'] = true;
      notificationsEnabled = true;
    }
    if (displayPhone) {
      const client = await Client.findOne({ clientID: tenantId }).select('whatsapp').lean();
      const existingChat = String(client?.whatsapp?.phoneE164 || '').trim();
      if (!existingChat) {
        setPayload['whatsapp.phoneE164'] = displayPhone;
        setPayload['whatsapp.enabled'] = true;
        chatPhoneBackfilled = true;
      }
    }
    if (Object.keys(setPayload).length) {
      await Client.updateOne({ clientID: tenantId }, { $set: setPayload });
    }
  } catch (e) {
    console.warn('[whatsapp embedded] could not enable notifications / backfill chat number:', e.message);
  }

  const webhookSubscribed = subscribe?.ok === true;
  const setupComplete = webhookSubscribed && (registered || registerSkipped);

  return {
    client_id: doc.client_id,
    waba_id: doc.waba_id,
    phone_number_id: doc.phone_number_id,
    mode: doc.mode,
    status: doc.status,
    coexistence,
    display_phone_number: assets.phoneMeta?.display_phone_number || '',
    verified_name: assets.phoneMeta?.verified_name || '',
    has_token: true,
    webhook_subscribed: webhookSubscribed,
    webhook_subscribe_error: webhookSubscribed
      ? ''
      : String(subscribe?.error || subscribe?.reason || '').slice(0, 300),
    registered,
    register_skipped: registerSkipped,
    register_error: registerError,
    // Returned once so the client can store 2FA PIN if Meta asks later — not persisted in plaintext.
    two_step_pin: registered && !registerSkipped ? registerPinHint : '',
    dataset_id: dataset?.datasetId || '',
    dataset_source: dataset?.source || doc.dataset_source || '',
    dataset_error: datasetError,
    notifications_enabled: notificationsEnabled,
    needs_credits: needsCredits,
    chat_phone_backfilled: chatPhoneBackfilled,
    setup_complete: setupComplete,
    next_steps: [
      !webhookSubscribed ? 'Retry Connect WhatsApp so webhooks subscribe (inbox will not work until this succeeds).' : null,
      registerError ? 'Enter the 6-digit register PIN under Account → WhatsApp → Retry register.' : null,
      needsCredits ? 'Top up WhatsApp credits before automated order/booking messages will send.' : null,
      'Open WA Templates → Install Khana pack, then Sync until templates show APPROVED.',
      'Optional: WA Templates → Flows → Create & publish booking/lead forms.',
    ].filter(Boolean),
  };
}

module.exports = {
  isConfigured,
  getPublicConfig,
  exchangeCodeForBusinessToken,
  resolveAssets,
  registerPhoneNumber,
  completeEmbeddedSignup,
  coexistenceEnabled,
};
