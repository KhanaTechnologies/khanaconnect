const axios = require('axios');
const { decrypt } = require('../../helpers/encryption');
const SaasWhatsAppAccount = require('../../models/SaasWhatsAppAccount');
const SaasWhatsAppThread = require('../../models/SaasWhatsAppThread');
const SaasWhatsAppMessage = require('../../models/SaasWhatsAppMessage');

const WA_API_BASE = process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com/v25.0';
const PARTNER_AGENT = process.env.WHATSAPP_CAPI_PARTNER_AGENT || 'KhanaConnect';

function httpError(message, status = 400, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function formatMetaError(err) {
  const data = err?.response?.data;
  const metaMsg =
    data?.error?.message ||
    data?.error?.error_user_msg ||
    data?.message ||
    err?.message ||
    'WhatsApp Conversions API request failed';
  const code = data?.error?.code;
  const status = err?.response?.status && err.response.status >= 400 ? err.response.status : 502;
  return httpError(code != null ? `${metaMsg} (#${code})` : metaMsg, status, {
    meta: data?.error || data || null,
  });
}

function extractCtwaClidFromRaw(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const referral = msg.referral || msg.context?.referral || null;
  if (!referral || typeof referral !== 'object') return '';
  return String(referral.ctwa_clid || referral.ctwaClid || '').trim();
}

async function loadOwnAccount(clientId) {
  const account = await SaasWhatsAppAccount.findOne({
    client_id: clientId,
    status: 'active',
  }).sort({ updated_at: -1 });
  if (!account) {
    throw httpError(
      'No active WhatsApp Cloud API account for this client. Save WABA credentials first.',
      400
    );
  }
  return account;
}

function decryptToken(account) {
  const token = decrypt(account.access_token_encrypted);
  if (!token) throw httpError('WhatsApp access token could not be decrypted', 500);
  return String(token).trim();
}

/**
 * Create or fetch the Conversions dataset linked to this WABA.
 * Requires whatsapp_business_management + whatsapp_business_manage_events.
 */
async function ensureDataset(clientId) {
  const account = await loadOwnAccount(clientId);
  const token = decryptToken(account);
  const wabaId = String(account.waba_id || '').trim();
  if (!wabaId) throw httpError('WABA ID is missing on the WhatsApp account', 400);

  let datasetId = String(account.dataset_id || '').trim();

  if (!datasetId) {
    try {
      const getRes = await axios.get(`${WA_API_BASE}/${wabaId}/dataset`, {
        params: { access_token: token },
        timeout: 25000,
      });
      datasetId = String(getRes.data?.id || getRes.data?.data?.[0]?.id || '').trim();
    } catch (err) {
      // Dataset may not exist yet — create below
      if (err?.response?.status && err.response.status !== 404) {
        console.warn('[whatsapp capi] GET dataset:', err?.response?.data?.error?.message || err.message);
      }
    }
  }

  if (!datasetId) {
    try {
      const postRes = await axios.post(
        `${WA_API_BASE}/${wabaId}/dataset`,
        null,
        { params: { access_token: token }, timeout: 25000 }
      );
      datasetId = String(postRes.data?.id || '').trim();
    } catch (err) {
      throw formatMetaError(err);
    }
  }

  if (!datasetId) {
    throw httpError('Meta did not return a dataset_id for this WhatsApp Business Account', 502);
  }

  account.dataset_id = datasetId;
  account.dataset_linked_at = new Date();
  await account.save();

  return {
    wabaId,
    datasetId,
    linkedAt: account.dataset_linked_at,
  };
}

async function findLatestCtwaClid(clientId) {
  const thread = await SaasWhatsAppThread.findOne({
    client_id: clientId,
    ctwa_clid: { $exists: true, $nin: [null, ''] },
  })
    .sort({ ctwa_clid_at: -1, updated_at: -1 })
    .select('ctwa_clid contact_wa_id ctwa_clid_at')
    .lean();
  if (thread?.ctwa_clid) {
    return {
      ctwaClid: String(thread.ctwa_clid),
      contactWaId: String(thread.contact_wa_id || ''),
      source: 'thread',
      at: thread.ctwa_clid_at || null,
    };
  }

  const msg = await SaasWhatsAppMessage.findOne({
    client_id: clientId,
    direction: 'inbound',
    ctwa_clid: { $exists: true, $nin: [null, ''] },
  })
    .sort({ timestamp: -1 })
    .select('ctwa_clid contact_wa_id timestamp')
    .lean();
  if (msg?.ctwa_clid) {
    return {
      ctwaClid: String(msg.ctwa_clid),
      contactWaId: String(msg.contact_wa_id || ''),
      source: 'message',
      at: msg.timestamp || null,
    };
  }

  return null;
}

/**
 * Send a conversion event to the WABA dataset (Events Manager).
 */
async function sendConversionEvent(clientId, input = {}) {
  const account = await loadOwnAccount(clientId);
  let datasetId = String(account.dataset_id || '').trim();
  if (!datasetId) {
    const ensured = await ensureDataset(clientId);
    datasetId = ensured.datasetId;
  }

  const token = decryptToken(account);
  const wabaId = String(account.waba_id || '').trim();
  const eventName = String(input.eventName || 'Lead').trim() || 'Lead';
  const allowed = new Set(['Lead', 'Purchase', 'AddToCart', 'InitiateCheckout', 'CompleteRegistration']);
  if (!allowed.has(eventName)) {
    throw httpError(`Unsupported event_name: ${eventName}`, 400);
  }

  let ctwaClid = String(input.ctwaClid || '').trim();
  let contactWaId = String(input.contactWaId || '').trim();
  if (!ctwaClid) {
    const found = await findLatestCtwaClid(clientId);
    if (found) {
      ctwaClid = found.ctwaClid;
      if (!contactWaId) contactWaId = found.contactWaId;
    }
  }

  if (!ctwaClid) {
    throw httpError(
      'No ctwa_clid available. Open a Click-to-WhatsApp ad conversation first, or paste a ctwa_clid from an inbound ad referral webhook.',
      400
    );
  }

  const eventTime = Number(input.eventTime) || Math.floor(Date.now() / 1000);
  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: eventTime,
        action_source: 'business_messaging',
        messaging_channel: 'whatsapp',
        user_data: {
          whatsapp_business_account_id: wabaId,
          ctwa_clid: ctwaClid,
        },
      },
    ],
    partner_agent: PARTNER_AGENT,
  };

  if (eventName === 'Purchase' || eventName === 'AddToCart' || eventName === 'InitiateCheckout') {
    const currency = String(input.currency || 'ZAR').trim().toUpperCase() || 'ZAR';
    const value = Number(input.value);
    payload.data[0].custom_data = {
      currency,
      value: Number.isFinite(value) ? value : 1,
    };
  }

  let response;
  try {
    const { data } = await axios.post(`${WA_API_BASE}/${datasetId}/events`, payload, {
      params: { access_token: token },
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
    response = data;
  } catch (err) {
    throw formatMetaError(err);
  }

  account.last_conversion_event_name = eventName;
  account.last_conversion_at = new Date();
  account.last_conversion_error = '';
  await account.save();

  return {
    ok: true,
    datasetId,
    wabaId,
    eventName,
    ctwaClid: `${ctwaClid.slice(0, 12)}…`,
    contactWaId: contactWaId || undefined,
    eventsReceived: response?.events_received,
    fbtraceId: response?.fbtrace_id,
    messages: response?.messages,
  };
}

async function getConversionsStatus(clientId) {
  const account = await SaasWhatsAppAccount.findOne({
    client_id: clientId,
    status: 'active',
  })
    .sort({ updated_at: -1 })
    .lean();

  if (!account) {
    return {
      configured: false,
      hasAccount: false,
      datasetId: '',
      wabaId: '',
      hasCtwaClid: false,
      lastConversionAt: null,
      lastConversionEventName: '',
      lastConversionError: '',
    };
  }

  const found = await findLatestCtwaClid(clientId);
  return {
    configured: true,
    hasAccount: true,
    datasetId: String(account.dataset_id || ''),
    wabaId: String(account.waba_id || ''),
    datasetLinkedAt: account.dataset_linked_at || null,
    hasCtwaClid: Boolean(found?.ctwaClid),
    ctwaContactWaId: found?.contactWaId || '',
    lastConversionAt: account.last_conversion_at || null,
    lastConversionEventName: account.last_conversion_event_name || '',
    lastConversionError: account.last_conversion_error || '',
  };
}

/**
 * Persist Click-to-WhatsApp click id from an inbound webhook message.
 */
async function captureCtwaFromInbound({ clientId, contactWaId, rawMsg, timestamp }) {
  const ctwaClid = extractCtwaClidFromRaw(rawMsg);
  if (!ctwaClid || !clientId || !contactWaId) return null;

  const at = timestamp instanceof Date ? timestamp : new Date();
  try {
    await SaasWhatsAppThread.findOneAndUpdate(
      { client_id: clientId, contact_wa_id: contactWaId },
      {
        $set: {
          ctwa_clid: ctwaClid,
          ctwa_clid_at: at,
        },
      },
      { upsert: true }
    );
  } catch (e) {
    console.warn('[whatsapp capi] thread ctwa save failed:', e.message);
  }
  return ctwaClid;
}

module.exports = {
  ensureDataset,
  sendConversionEvent,
  getConversionsStatus,
  captureCtwaFromInbound,
  extractCtwaClidFromRaw,
  findLatestCtwaClid,
};
