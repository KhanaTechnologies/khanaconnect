const crypto = require('crypto');
const axios = require('axios');
const { decrypt } = require('../../helpers/encryption');
const Client = require('../../models/client');
const SaasWhatsAppAccount = require('../../models/SaasWhatsAppAccount');
const SaasWhatsAppThread = require('../../models/SaasWhatsAppThread');
const SaasWhatsAppMessage = require('../../models/SaasWhatsAppMessage');

const WA_API_BASE = process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com/v25.0';
const PARTNER_AGENT = process.env.WHATSAPP_CAPI_PARTNER_AGENT || 'KhanaConnect';

// Meta CAPI for Business Messaging allowlist (not the same as website Pixel events).
// Website uses "Lead"; messaging requires "LeadSubmitted". Sending "Lead" with
// action_source=business_messaging is rejected (Messaging Event Invalid Event Type).
const MESSAGING_EVENTS = new Set([
  'LeadSubmitted',
  'Purchase',
  'AddToCart',
  'InitiateCheckout',
  'ViewContent',
  'QualifiedLead',
  'OrderCreated',
  'OrderShipped',
  'OrderDelivered',
  'OrderCanceled',
  'OrderReturned',
  'CartAbandoned',
]);

function hashSha256(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

function normalizeMessagingEventName(raw) {
  const name = String(raw || 'LeadSubmitted').trim() || 'LeadSubmitted';
  // Alias website Pixel "Lead" → messaging "LeadSubmitted"
  if (name === 'Lead') return 'LeadSubmitted';
  return name;
}

async function resolvePageId(clientId) {
  try {
    const client = await Client.findOne({ clientID: clientId }).select('metaAds.pageId');
    const pageId = client?.toObject({ getters: true })?.metaAds?.pageId;
    return pageId ? String(pageId).trim() : '';
  } catch {
    return '';
  }
}

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
 * Website Pixel IDs must never be used as the default messaging dataset for tenants.
 * Override with KHANA_WEBSITE_PIXEL_ID if the site pixel changes.
 */
const FORBIDDEN_SHARED_DATASET_IDS = new Set(
  String(process.env.KHANA_WEBSITE_PIXEL_ID || '1063249069528132')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function isForbiddenSharedDataset(datasetId) {
  return FORBIDDEN_SHARED_DATASET_IDS.has(String(datasetId || '').trim());
}

/**
 * Resolve the Conversions dataset that Meta attaches to a WABA.
 * GET existing → POST create if missing.
 * Requires whatsapp_business_management + whatsapp_business_manage_events.
 */
async function fetchOrCreateWabaDatasetId(wabaId, token) {
  let datasetId = '';

  try {
    const getRes = await axios.get(`${WA_API_BASE}/${wabaId}/dataset`, {
      params: { access_token: token },
      timeout: 25000,
    });
    datasetId = String(getRes.data?.id || getRes.data?.data?.[0]?.id || '').trim();
  } catch (err) {
    const status = err?.response?.status;
    if (status && status !== 404) {
      console.warn('[whatsapp capi] GET /{waba}/dataset:', err?.response?.data?.error?.message || err.message);
      // Permission / auth errors should surface — do not pretend create will work.
      if (status === 401 || status === 403 || err?.response?.data?.error?.code === 190) {
        throw formatMetaError(err);
      }
    }
  }

  if (!datasetId) {
    try {
      const postRes = await axios.post(`${WA_API_BASE}/${wabaId}/dataset`, null, {
        params: { access_token: token },
        timeout: 25000,
      });
      datasetId = String(postRes.data?.id || '').trim();
    } catch (err) {
      throw formatMetaError(err);
    }
  }

  if (!datasetId) {
    throw httpError('Meta did not return a dataset_id for this WhatsApp Business Account', 502);
  }
  if (isForbiddenSharedDataset(datasetId)) {
    throw httpError(
      'Refusing to bind messaging conversions to the shared website Pixel. Use the WABA dataset from Meta.',
      502
    );
  }
  return datasetId;
}

/**
 * Ensure this client has their own WABA-linked Conversions dataset saved.
 * @param {string} clientId
 * @param {{ force?: boolean }} [opts] force=true always re-reads from Meta (fixes wrongly saved shared pixels)
 */
async function ensureDataset(clientId, opts = {}) {
  const force = opts.force === true;
  const account = await loadOwnAccount(clientId);
  const token = decryptToken(account);
  const wabaId = String(account.waba_id || '').trim();
  if (!wabaId) throw httpError('WABA ID is missing on the WhatsApp account', 400);

  let datasetId = String(account.dataset_id || '').trim();
  const source = String(account.dataset_source || '').trim();
  const needsRefresh =
    force ||
    !datasetId ||
    source === 'cleared' ||
    isForbiddenSharedDataset(datasetId);

  if (needsRefresh) {
    datasetId = await fetchOrCreateWabaDatasetId(wabaId, token);
  }

  account.dataset_id = datasetId;
  account.dataset_source = 'waba';
  account.dataset_linked_at = new Date();
  account.dataset_decommissioned_at = null;
  account.last_conversion_error = '';
  await account.save();

  return {
    wabaId,
    datasetId,
    linkedAt: account.dataset_linked_at,
    source: 'waba',
    refreshed: needsRefresh,
    clientId: String(account.client_id),
  };
}

/**
 * Stop using this client's messaging dataset locally (offboarding).
 * Does not delete the Meta-side asset (Meta may retain it on the WABA); we clear
 * stored ids so Khana never sends further events for this tenant.
 */
async function decommissionDataset(clientId) {
  const result = await SaasWhatsAppAccount.updateMany(
    { client_id: clientId },
    {
      $set: {
        dataset_id: '',
        dataset_source: 'cleared',
        dataset_linked_at: null,
        dataset_decommissioned_at: new Date(),
        last_conversion_error: '',
        last_conversion_event_name: '',
        last_conversion_at: null,
      },
    }
  );
  return {
    clientId: String(clientId),
    decommissioned: true,
    matched: result.matchedCount ?? result.n ?? 0,
    modified: result.modifiedCount ?? result.nModified ?? 0,
  };
}

/**
 * Disable Cloud API credentials + clear conversions dataset for this tenant.
 */
async function disconnectCloudAccount(clientId) {
  const decommission = await decommissionDataset(clientId);
  const result = await SaasWhatsAppAccount.updateMany(
    { client_id: clientId, status: 'active' },
    { $set: { status: 'disabled' } }
  );
  return {
    ...decommission,
    accountsDisabled: result.modifiedCount ?? result.nModified ?? 0,
    disconnected: true,
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
 * Send a conversion event to THIS client's WABA dataset (Events Manager).
 */
async function sendConversionEvent(clientId, input = {}) {
  let account = await loadOwnAccount(clientId);
  let datasetId = String(account.dataset_id || '').trim();
  if (!datasetId || isForbiddenSharedDataset(datasetId) || account.dataset_source === 'cleared') {
    const ensured = await ensureDataset(clientId, { force: true });
    datasetId = ensured.datasetId;
    account = await loadOwnAccount(clientId);
  }

  const token = decryptToken(account);
  const wabaId = String(account.waba_id || '').trim();
  const eventName = normalizeMessagingEventName(input.eventName);
  if (!MESSAGING_EVENTS.has(eventName)) {
    throw httpError(
      `Unsupported messaging event_name: ${eventName}. Use LeadSubmitted (not Lead), Purchase, AddToCart, InitiateCheckout, or ViewContent.`,
      400
    );
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
  const eventId =
    String(input.eventId || '').trim() ||
    `wa_${String(clientId).slice(0, 24)}_${eventName}_${ctwaClid.slice(0, 16)}_${eventTime}`;

  const pageId = String(input.pageId || '').trim() || (await resolvePageId(clientId));
  const messagingChannel = String(input.messagingChannel || 'whatsapp').trim() || 'whatsapp';

  const userData = {
    whatsapp_business_account_id: wabaId,
    ctwa_clid: ctwaClid,
  };
  if (pageId) userData.page_id = pageId;

  // Optional match keys declared in Events Manager setup (hashed per Meta CAPI rules).
  const email = String(input.email || '').trim();
  const phone = String(input.phone || contactWaId || '').trim();
  if (email) {
    const hashed = hashSha256(email);
    if (hashed) userData.em = [hashed];
  }
  if (phone) {
    // WhatsApp contact ids are usually digits-only MSISDNs — strip non-digits before hash.
    const digits = phone.replace(/\D/g, '');
    const hashed = hashSha256(digits || phone);
    if (hashed) userData.ph = [hashed];
  }
  if (input.pageScopedUserId) {
    userData.page_scoped_user_id = String(input.pageScopedUserId).trim();
  }

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: eventTime,
        event_id: eventId,
        action_source: 'business_messaging',
        messaging_channel: messagingChannel,
        user_data: userData,
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

  // Reload in case ensureDataset updated fields on a different document instance
  const fresh = await loadOwnAccount(clientId);
  fresh.last_conversion_event_name = eventName;
  fresh.last_conversion_at = new Date();
  fresh.last_conversion_error = '';
  await fresh.save();

  return {
    ok: true,
    datasetId,
    wabaId,
    clientId: String(clientId),
    eventName,
    eventId,
    pageId: pageId || undefined,
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
      datasetSource: '',
      wabaId: '',
      hasCtwaClid: false,
      lastConversionAt: null,
      lastConversionEventName: '',
      lastConversionError: '',
      sharedDatasetBlocked: false,
    };
  }

  const datasetId = String(account.dataset_id || '');
  const found = await findLatestCtwaClid(clientId);
  return {
    configured: true,
    hasAccount: true,
    datasetId,
    datasetSource: String(account.dataset_source || ''),
    datasetLinkedAt: account.dataset_linked_at || null,
    datasetDecommissionedAt: account.dataset_decommissioned_at || null,
    wabaId: String(account.waba_id || ''),
    hasCtwaClid: Boolean(found?.ctwaClid),
    ctwaContactWaId: found?.contactWaId || '',
    lastConversionAt: account.last_conversion_at || null,
    lastConversionEventName: account.last_conversion_event_name || '',
    lastConversionError: account.last_conversion_error || '',
    sharedDatasetBlocked: isForbiddenSharedDataset(datasetId),
    needsRelink: !datasetId || isForbiddenSharedDataset(datasetId) || account.dataset_source === 'cleared',
  };
}

/**
 * Persist Click-to-WhatsApp click id from an inbound webhook message.
 * On first capture for this contact, auto-send LeadSubmitted to Events Manager.
 */
async function captureCtwaFromInbound({ clientId, contactWaId, rawMsg, timestamp }) {
  const ctwaClid = extractCtwaClidFromRaw(rawMsg);
  if (!ctwaClid || !clientId || !contactWaId) return null;

  const at = timestamp instanceof Date ? timestamp : new Date();
  let isFirstCapture = false;
  try {
    const existing = await SaasWhatsAppThread.findOne({
      client_id: clientId,
      contact_wa_id: contactWaId,
      ctwa_clid: { $exists: true, $nin: [null, ''] },
    })
      .select('ctwa_clid')
      .lean();
    isFirstCapture = !existing?.ctwa_clid || existing.ctwa_clid !== ctwaClid;

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

  if (isFirstCapture) {
    try {
      await sendConversionEvent(clientId, {
        eventName: 'LeadSubmitted',
        ctwaClid,
        contactWaId,
        eventTime: Math.floor(at.getTime() / 1000),
      });
    } catch (e) {
      console.warn('[whatsapp capi] auto LeadSubmitted failed:', e.message);
      try {
        const account = await loadOwnAccount(clientId);
        account.last_conversion_error = String(e.message || 'auto LeadSubmitted failed').slice(0, 500);
        await account.save();
      } catch {
        /* ignore */
      }
    }
  }

  return ctwaClid;
}

module.exports = {
  ensureDataset,
  decommissionDataset,
  disconnectCloudAccount,
  sendConversionEvent,
  getConversionsStatus,
  captureCtwaFromInbound,
  extractCtwaClidFromRaw,
  findLatestCtwaClid,
  isForbiddenSharedDataset,
};
