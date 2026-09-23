const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const Client = require('../../models/client');
const Customer = require('../../models/customer');
const Product = require('../../models/product');
const SaasUsageEvent = require('../../models/SaasUsageEvent');
const { usageBillingQueue } = require('../../queues/saasQueues');
const { publishedProductFilter } = require('../../helpers/productCatalogFields');
const {
  loadClientWithMeta,
  normalizeAdAccountId,
  findAdAccountOwner,
  buildTargetingSpec,
  resolveInsightsWindow,
  insightsGraphDateParams,
} = require('./MetaAdsService');

const META_GRAPH_BASE = process.env.META_GRAPH_BASE || 'https://graph.facebook.com/v25.0';

function formatGraphError(err) {
  const fb = err?.response?.data?.error;
  if (fb?.error_user_msg) {
    return fb.error_user_title ? `${fb.error_user_title}: ${fb.error_user_msg}` : fb.error_user_msg;
  }
  if (fb?.message) return fb.message;
  return err?.message || 'Meta API request failed';
}

function httpError(message, status = 400) {
  const err = new Error(String(message || 'Request failed'));
  err.status = status;
  return err;
}

/** Client-visible Meta/Graph failures (avoid opaque wrapRoute 500). */
function throwMeta(err, context = 'Meta API request failed') {
  const msg = formatGraphError(err);
  console.error(`[meta ads] ${context}:`, msg, err?.response?.data || '');
  throw httpError(msg || context, 400);
}

/**
 * Create a Meta ad account under the *client's* Business Manager.
 * Spend billing stays on the client's Meta payment method — never Khana's card.
 * Defaults: ZAR + Africa/Johannesburg (timezone_id 141).
 */
async function createAdAccountForClient(clientId, { name = '', currency = 'ZAR', timezoneId = 141 } = {}) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);

  let businesses = [];
  try {
    const biz = await graphGet('/me/businesses', token, {
      fields: 'id,name,permitted_roles',
      limit: 50,
    });
    businesses = Array.isArray(biz?.data) ? biz.data : [];
  } catch (err) {
    throwMeta(err, 'list businesses');
  }

  if (!businesses.length) {
    throw httpError(
      'No Meta Business Portfolio found on this Facebook login. Create one in Meta Business Settings first, then reconnect Facebook and try again.',
      400
    );
  }

  // Prefer a BM where the user is ADMIN (required to create ad accounts).
  const adminBiz =
    businesses.find((b) =>
      (Array.isArray(b.permitted_roles) ? b.permitted_roles : []).some((r) =>
        /ADMIN/i.test(String(r))
      )
    ) || null;
  const storedBizId = String(client.metaAds.metaBusinessId || '').trim();
  const stored = storedBizId ? businesses.find((b) => String(b.id) === storedBizId) : null;
  const business = adminBiz || stored || businesses[0];
  const businessId = String(business.id);

  if (
    adminBiz == null &&
    !(Array.isArray(business.permitted_roles)
      ? business.permitted_roles
      : []
    ).some((r) => /ADMIN/i.test(String(r)))
  ) {
    throw httpError(
      `You need admin access on Meta Business “${business.name || businessId}” to create an ad account. Ask a Business admin to grant you access, or create the account in Meta Ads Manager.`,
      403
    );
  }

  const ClientModel = require('../../models/client');
  const lean = await ClientModel.findOne({ clientID: clientId }).select('companyName').lean();
  const accountName =
    String(name || '').trim().slice(0, 100) ||
    `${String(lean?.companyName || clientId).trim().slice(0, 60)} Ads`;

  const currencyCode = String(currency || process.env.META_AD_ACCOUNT_CURRENCY || 'ZAR')
    .trim()
    .toUpperCase()
    .slice(0, 3);
  const tz = Number(timezoneId || process.env.META_AD_ACCOUNT_TIMEZONE_ID || 141) || 141;

  let created;
  try {
    // Do not pass invoice / funding_id — that would attach Khana or BM credit lines.
    // Client adds their own card in Meta after create.
    created = await graphPost(`/${businessId}/adaccount`, token, {
      name: accountName,
      currency: currencyCode,
      timezone_id: tz,
      end_advertiser: businessId,
      media_agency: 'NONE',
      partner: 'NONE',
    });
  } catch (err) {
    const msg = formatGraphError(err);
    if (/3979|exceeded.*ad accounts/i.test(msg)) {
      throw httpError(
        'This Meta Business has reached its ad account limit. Free unused accounts in Meta Business Settings, or create the account manually in Ads Manager.',
        400
      );
    }
    if (/3980|bad standing|in review/i.test(msg)) {
      throw httpError(
        'Meta blocked new ad accounts because an existing account is in bad standing or under review. Fix Account Quality in Meta, then retry.',
        400
      );
    }
    if (/permission|(#200)|business_management/i.test(msg)) {
      throw httpError(
        'Missing permission to create ad accounts. Reconnect Facebook and ensure Business Manager admin access (business_management).',
        403
      );
    }
    throwMeta(err, 'create ad account');
  }

  const rawId = String(created?.id || created?.account_id || '').trim();
  const adAccountId = normalizeAdAccountId(rawId);
  if (!adAccountId) {
    throw httpError('Meta created an ad account but did not return an ID. Refresh Ad accounts and select it.', 502);
  }

  client.metaAds.adAccountId = adAccountId;
  client.metaAds.adAccountName = accountName;
  client.metaAds.metaBusinessId = businessId;
  client.metaAds.ownershipType = 'client';
  client.markModified('metaAds');
  await client.save();

  // Best-effort pixel discovery on the new account.
  try {
    const pixRes = await graphGet(`/act_${adAccountId}/adspixels`, token, {
      fields: 'id,name',
      limit: 5,
    });
    const pixels = Array.isArray(pixRes?.data) ? pixRes.data : [];
    if (pixels[0]?.id) {
      client.metaAds.pixelId = String(pixels[0].id);
      client.markModified('metaAds');
      await client.save();
    }
  } catch {
    /* optional */
  }

  const links = buildMetaDeepLinks({ adAccountId, businessId, pageId: client.metaAds.pageId });

  return {
    adAccountId,
    adAccountName: accountName,
    businessId,
    businessName: business.name || '',
    currency: currencyCode,
    timezoneId: tz,
    timezone: 'Africa/Johannesburg',
    ownershipType: 'client',
    billingNote:
      'Ad spend is charged by Meta to YOUR card (not Khana). Khana charges a separate ads service fee from your Khana credits when you create or boost campaigns.',
    serviceFeeNote:
      'Khana service fee uses your prepaid credit balance — separate from Meta media spend.',
    links: {
      paymentSettings: links.paymentSettings,
      accountBilling: links.accountBilling,
      adsManager: links.adsManager,
      adAccountSettings: links.adAccountSettings,
    },
    meta: created,
  };
}

/**
 * Catalogs must live under a Business Manager. Personal ad accounts often have no
 * business edge — fall back to /me/businesses from the connected Facebook Login.
 */
async function resolveBusinessIdForCatalog(client, token) {
  if (client.metaAds?.metaBusinessId) {
    return String(client.metaAds.metaBusinessId);
  }

  const adAccountId = normalizeAdAccountId(client.metaAds?.adAccountId);
  if (adAccountId) {
    try {
      const acc = await graphGet(`/act_${adAccountId}`, token, { fields: 'business' });
      if (acc?.business?.id) return String(acc.business.id);
    } catch (err) {
      console.warn('[meta ads] ad account business lookup failed:', formatGraphError(err));
    }
  }

  try {
    const biz = await graphGet('/me/businesses', token, { fields: 'id,name' });
    const first = (biz?.data || [])[0];
    if (first?.id) return String(first.id);
  } catch (err) {
    console.warn('[meta ads] /me/businesses failed:', formatGraphError(err));
  }

  return '';
}

async function graphGet(path, accessToken, params = {}) {
  const { data } = await axios.get(`${META_GRAPH_BASE}${path}`, {
    params: { access_token: accessToken, ...params },
    timeout: 30000,
  });
  return data;
}

async function graphPost(path, accessToken, params = {}) {
  const { data } = await axios.post(`${META_GRAPH_BASE}${path}`, null, {
    params: { access_token: accessToken, ...params },
    timeout: 45000,
  });
  return data;
}

async function graphPostJson(path, accessToken, body = {}) {
  const { data } = await axios.post(`${META_GRAPH_BASE}${path}`, body, {
    params: { access_token: accessToken },
    timeout: 60000,
    headers: { 'Content-Type': 'application/json' },
  });
  return data;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizePhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  // Prefer E.164-ish: if local SA 0xxxxxxxxx → 27…
  if (digits.startsWith('0') && digits.length === 10) return `27${digits.slice(1)}`;
  return digits;
}

function hashField(value) {
  const v = String(value || '').trim().toLowerCase();
  if (!v) return '';
  return sha256(v);
}

/** Deep links that land clients on the exact Meta screens they need. */
function buildMetaDeepLinks({ adAccountId, businessId, pageId } = {}) {
  const act = normalizeAdAccountId(adAccountId);
  const actParam = act ? `act=${act}` : '';
  const assetId = act || '';

  return {
    /** Add / manage payment method for this ad account */
    paymentSettings: assetId
      ? `https://business.facebook.com/billing_hub/payment_settings?asset_id=${assetId}`
      : 'https://business.facebook.com/billing_hub/payment_settings',
    /** Alternate Ads Manager billing path */
    accountBilling: act
      ? `https://www.facebook.com/ads/manager/account_settings/account_billing/?${actParam}`
      : 'https://www.facebook.com/ads/manager/account_settings/account_billing/',
    /** Ads Manager campaigns for this account */
    adsManager: act
      ? `https://adsmanager.facebook.com/adsmanager/manage/campaigns?${actParam}`
      : 'https://adsmanager.facebook.com/adsmanager',
    /** Create campaign wizard in Ads Manager (fallback) */
    createCampaign: act
      ? `https://adsmanager.facebook.com/adsmanager/creation?${actParam}`
      : 'https://adsmanager.facebook.com/adsmanager/creation',
    /** Business settings — ad accounts */
    adAccountSettings: 'https://business.facebook.com/settings/ad-accounts',
    /** Account quality / policy issues */
    accountQuality: 'https://www.facebook.com/accountquality',
    /** Page settings */
    pageSettings: pageId
      ? `https://www.facebook.com/${pageId}/settings/`
      : 'https://www.facebook.com/pages/manage',
    /** Commerce Manager (catalogs) */
    commerceManager: businessId
      ? `https://business.facebook.com/commerce_manager/${businessId}/`
      : 'https://business.facebook.com/commerce',
    businessId: businessId || '',
    adAccountId: act,
  };
}

/**
 * Setup hub: what is ready, what still needs Meta (payment/policy),
 * and one-click links so clients don't hunt through Business Manager.
 */
async function getSetupHub(clientId) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const adAccountId = normalizeAdAccountId(client.metaAds.adAccountId);
  const pageId = client.metaAds.pageId || '';
  const businessId = client.metaAds.metaBusinessId || '';

  if (pageId && !client.metaAds.instagramUserId) {
    try {
      const pageToken = client.metaAds.pageAccessToken
        ? String(client.metaAds.pageAccessToken)
        : token;
      const { resolveInstagramFromPage } = require('./MetaAdsService');
      const ig = await resolveInstagramFromPage(pageId, pageToken);
      if (ig.instagramUserId) {
        client.metaAds.instagramUserId = ig.instagramUserId;
        client.metaAds.instagramUsername = ig.instagramUsername;
        client.markModified('metaAds');
        await client.save();
      }
    } catch (err) {
      console.warn('[meta ads] setup hub IG resolve failed:', err.message);
    }
  }

  const checklist = {
    facebookConnected: true,
    pageSelected: !!pageId,
    adAccountSelected: !!adAccountId,
    pixelLinked: !!client.metaAds.pixelId,
    instagramLinked: !!client.metaAds.instagramUserId,
    paymentReady: null,
    accountActive: null,
    whatsappReady: !!(client.whatsapp?.phoneE164 || client.whatsapp?.enabled),
    catalogSynced: !!client.metaAds.catalogId,
  };

  let account = null;
  let paymentHint = '';

  if (adAccountId) {
    try {
      account = await graphGet(`/act_${adAccountId}`, token, {
        fields:
          'id,name,account_status,disable_reason,currency,balance,amount_spent,funding_source,funding_source_details,business',
      });
      const status = Number(account.account_status);
      checklist.accountActive = status === 1;
      // funding_source present usually means a payment method is attached
      checklist.paymentReady = Boolean(account.funding_source || account.funding_source_details);
      if (status === 3) paymentHint = 'Ad account has an unpaid balance — settle billing in Meta.';
      else if (status === 2) paymentHint = 'Ad account is disabled — check Account Quality in Meta.';
      else if (!checklist.paymentReady) {
        paymentHint =
          'Add YOUR payment method in Meta before ads can deliver. Ad spend → your Meta card. Khana service fee → your Khana credits (when you create/boost).';
      }
      if (account.business?.id && !client.metaAds.metaBusinessId) {
        client.metaAds.metaBusinessId = String(account.business.id);
        client.markModified('metaAds');
        await client.save();
      }
    } catch (err) {
      console.warn('[meta ads] setup hub account fetch failed:', err.message);
      paymentHint = formatGraphError(err);
    }
  }

  const links = buildMetaDeepLinks({
    adAccountId,
    businessId: client.metaAds.metaBusinessId || businessId,
    pageId,
  });

  const nextSteps = [];
  if (!checklist.pageSelected) nextSteps.push({ id: 'page', label: 'Select your Facebook Page', action: 'select_page' });
  if (!checklist.adAccountSelected) {
    nextSteps.push({
      id: 'ad_account_create',
      label: 'Create a Meta ad account (ZAR · South Africa) — your card, not Khana’s',
      action: 'create_ad_account',
    });
    nextSteps.push({
      id: 'ad_account',
      label: 'Or select an existing ad account',
      action: 'select_ad_account',
    });
  }
  if (checklist.pageSelected && !checklist.instagramLinked) {
    nextSteps.push({
      id: 'instagram',
      label: 'Link Instagram Professional to your Facebook Page (for IG boosts)',
      action: 'open_link',
      url: 'https://www.facebook.com/business/help/connect-instagram-to-page',
    });
  }
  if (checklist.adAccountSelected && checklist.paymentReady === false) {
    nextSteps.push({
      id: 'payment',
      label: 'Add YOUR payment method in Meta (ad spend bills to you, not Khana)',
      action: 'open_link',
      url: links.paymentSettings,
    });
  }
  if (!checklist.pixelLinked) nextSteps.push({ id: 'pixel', label: 'Link a Meta Pixel (auto-detected when available)', action: 'pixel' });
  if (checklist.paymentReady !== false && checklist.pageSelected && checklist.adAccountSelected) {
    nextSteps.push({
      id: 'create',
      label: 'Create your first campaign in Khana',
      action: 'create_campaign',
    });
  }

  return {
    checklist,
    paymentHint,
    account: account
      ? {
          id: normalizeAdAccountId(account.id),
          name: account.name || '',
          status: Number(account.account_status) || 0,
          currency: account.currency || 'ZAR',
          disableReason: account.disable_reason || null,
          hasFundingSource: checklist.paymentReady,
        }
      : null,
    links,
    nextSteps,
    pageName: client.metaAds.pageName || '',
    adAccountName: client.metaAds.adAccountName || '',
    instagramConnected: !!client.metaAds.instagramUserId,
    instagramUsername: client.metaAds.instagramUsername || '',
    catalogId: client.metaAds.catalogId || '',
  };
}

function mapLocalCampaign(c) {
  return {
    id: String(c._id),
    name: c.name,
    objective: c.objective || '',
    budget: c.budget,
    status: c.status,
    campaignType: c.campaign_type || 'standard',
    metaCampaignId: c.meta_campaign_id || '',
    metaAdsetId: c.meta_adset_id || '',
    metaAdId: c.meta_ad_id || '',
    boostPostId: c.boostPostId || '',
    boostSource: c.boostSource || '',
    source: 'local',
    createdAt: c.createdAt || null,
    updatedAt: c.updatedAt || null,
  };
}

async function listMetaAdAccountCampaigns(clientId) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const adAccountId = normalizeAdAccountId(client.metaAds.adAccountId);
  if (!adAccountId) return { campaigns: [], ok: false };

  try {
    const fields = 'id,name,objective,status,effective_status,daily_budget,lifetime_budget,created_time,updated_time';
    const res = await graphGet(`/act_${adAccountId}/campaigns`, token, {
      fields,
      limit: 50,
      effective_status: JSON.stringify([
        'ACTIVE',
        'PAUSED',
        'PENDING_REVIEW',
        'PREAPPROVED',
        'IN_PROCESS',
        'WITH_ISSUES',
        'CAMPAIGN_PAUSED',
        'ARCHIVED',
      ]),
    });
    let rows = Array.isArray(res?.data) ? res.data : [];
    if (!rows.length) {
      const retry = await graphGet(`/act_${adAccountId}/campaigns`, token, {
        fields,
        limit: 50,
      });
      rows = Array.isArray(retry?.data) ? retry.data : [];
    }
    return {
      ok: true,
      campaigns: rows.map((c) => {
        const statusRaw = String(c.effective_status || c.status || 'PAUSED').toLowerCase();
        const status =
          statusRaw === 'active'
            ? 'active'
            : statusRaw === 'archived' || statusRaw === 'deleted'
              ? 'archived'
              : 'paused';
        const budgetCents = Number(c.daily_budget);
        return {
          id: `meta_${c.id}`,
          name: String(c.name || 'Campaign'),
          objective: String(c.objective || ''),
          budget: Number.isFinite(budgetCents) && budgetCents > 0 ? budgetCents / 100 : undefined,
          status,
          campaignType: String(c.objective || '').includes('OUTCOME_ENGAGEMENT')
            || String(c.objective || '').includes('POST_ENGAGEMENT')
            ? 'boost'
            : 'meta',
          metaCampaignId: String(c.id),
          metaAdsetId: '',
          metaAdId: '',
          boostPostId: '',
          source: 'meta',
          createdAt: c.created_time || null,
          updatedAt: c.updated_time || null,
        };
      }),
    };
  } catch (err) {
    console.warn('[meta ads] list meta campaigns failed:', formatGraphError(err));
    return { campaigns: [], ok: false };
  }
}

function pruneLocalCampaignsToMeta(local, metaIds) {
  const seenMeta = new Set();
  const kept = [];
  for (const c of [...local].reverse()) {
    const mid = String(c.meta_campaign_id || '').replace(/^meta_/, '');
    if (mid) {
      if (!metaIds.has(mid) || seenMeta.has(mid)) continue;
      seenMeta.add(mid);
    }
    kept.push(c);
  }
  return kept.reverse();
}

async function persistPrunedCampaigns(clientId, next) {
  await Client.updateOne(
    { clientID: clientId },
    { $set: { 'metaAds.campaigns': next, 'metaAds.lastSync': new Date() } }
  );
}

/**
 * Own ad account → full Meta campaign list (what Ads Manager shows).
 * Someone else's ad account → only campaigns this workspace created.
 */
async function listLocalCampaigns(clientId) {
  const client = await Client.findOne({ clientID: clientId })
    .select('metaAds.campaigns metaAds.adAccountId metaAds.accessToken')
    .lean();
  const local = Array.isArray(client?.metaAds?.campaigns) ? client.metaAds.campaigns : [];
  const { campaigns: fromMeta, ok: metaOk } = await listMetaAdAccountCampaigns(clientId);
  const metaById = new Map(fromMeta.map((c) => [String(c.metaCampaignId), c]));
  const metaIds = new Set(metaById.keys());

  if (metaOk && fromMeta.length) {
    const pruned = pruneLocalCampaignsToMeta(local, metaIds);
    if (pruned.length !== local.length) {
      persistPrunedCampaigns(clientId, pruned).catch((err) =>
        console.warn('[meta ads] prune local campaigns failed:', err.message)
      );
    }
  }

  const localByMetaId = new Map();
  for (const c of local) {
    const mid = String(c.meta_campaign_id || '').replace(/^meta_/, '');
    if (mid && !localByMetaId.has(mid)) localByMetaId.set(mid, c);
  }

  const act = normalizeAdAccountId(client?.metaAds?.adAccountId);
  const sharedOwner =
    act && String(clientId) !== 'Khana' ? await findAdAccountOwner(act, clientId) : '';
  const showFullMetaList = !sharedOwner;

  let campaigns = [];
  if (showFullMetaList && metaOk && fromMeta.length) {
    campaigns = fromMeta.map((metaRow) => {
      const loc = localByMetaId.get(String(metaRow.metaCampaignId));
      if (!loc) return metaRow;
      return {
        ...metaRow,
        id: String(loc._id),
        campaignType: loc.campaign_type || metaRow.campaignType,
        metaAdsetId: loc.meta_adset_id || '',
        metaAdId: loc.meta_ad_id || '',
        boostPostId: loc.boostPostId || '',
        boostSource: loc.boostSource || '',
        source: 'meta',
      };
    });
  } else {
    const seen = new Set();
    for (const loc of [...local].reverse()) {
      const mid = String(loc.meta_campaign_id || '').replace(/^meta_/, '');
      if (mid && seen.has(mid)) continue;
      if (mid) seen.add(mid);
      const metaRow = mid ? metaById.get(mid) : null;
      const mapped = mapLocalCampaign(loc);
      campaigns.push({
        ...mapped,
        name: metaRow?.name || mapped.name,
        status: metaRow?.status || mapped.status,
        budget: metaRow?.budget != null ? metaRow.budget : mapped.budget,
        source: metaRow ? 'meta' : 'local',
      });
    }
  }

  return {
    campaigns,
    syncedFrom: showFullMetaList ? 'meta' : 'workspace',
    adAccountWarning: sharedOwner
      ? `This Meta ad account is already used by workspace ${sharedOwner}. Create or select this client’s own ad account so you do not see or create ads on ${sharedOwner}.`
      : '',
  };
}

async function findCampaignSubdoc(client, campaignId) {
  const campaigns = client.metaAds?.campaigns || [];
  const sub = campaigns.id(campaignId) || campaigns.find((c) => String(c._id) === String(campaignId));
  if (sub) return { sub, source: 'local' };

  const rawId = String(campaignId || '').replace(/^meta_/, '');
  const byMeta =
    campaigns.find((c) => String(c.meta_campaign_id) === String(campaignId))
    || campaigns.find((c) => String(c.meta_campaign_id) === rawId);
  if (byMeta) return { sub: byMeta, source: 'local' };

  if (/^\d+$/.test(rawId)) {
    return {
      sub: {
        _id: `meta_${rawId}`,
        meta_campaign_id: rawId,
        meta_adset_id: '',
        meta_ad_id: '',
        status: 'paused',
      },
      source: 'meta',
    };
  }

  throw new Error('Campaign not found');
}

async function updateCampaignStatus(clientId, { campaignId, status }) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const { sub, source } = await findCampaignSubdoc(client, campaignId);

  const next = String(status || '').toLowerCase();
  if (!['active', 'paused', 'archived', 'deleted'].includes(next)) {
    throw new Error('status must be active, paused, archived, or deleted');
  }

  const metaStatus =
    next === 'active'
      ? 'ACTIVE'
      : next === 'archived'
        ? 'ARCHIVED'
        : next === 'deleted'
          ? 'DELETED'
          : 'PAUSED';

  const campaignMetaId = String(sub.meta_campaign_id || '').replace(/^meta_/, '');
  if (!campaignMetaId && next !== 'deleted') {
    throw new Error('Campaign has no Meta campaign ID to update');
  }

  try {
    if (campaignMetaId) {
      if (next === 'deleted') {
        await graphPost(`/${campaignMetaId}`, token, { status: 'DELETED' });
      } else if (next === 'archived') {
        await graphPost(`/${campaignMetaId}`, token, { status: 'ARCHIVED' });
      } else {
        // Restore/pause/activate: update campaign (and child objects when we have them).
        const targets = [sub.meta_ad_id, sub.meta_adset_id, sub.meta_campaign_id]
          .map((id) => String(id || '').replace(/^meta_/, ''))
          .filter(Boolean);
        const unique = [...new Set(targets.length ? targets : [campaignMetaId])];
        for (const id of unique) {
          await graphPost(`/${id}`, token, { status: metaStatus });
        }
      }
    }
  } catch (err) {
    const msg = formatGraphError(err);
    const gone = /does not exist|has been deleted|does not support|Object with ID/i.test(msg);
    if (!(next === 'deleted' && gone)) {
      throw new Error(msg);
    }
  }

  if (source === 'local') {
    // Soft-delete (archive) keeps the subdoc so admins can Restore → paused.
    // Hard delete (DELETED) removes every local copy of this Meta campaign.
    if (next === 'deleted') {
      const dropId = String(sub._id);
      const dropMeta = campaignMetaId;
      client.metaAds.campaigns = (client.metaAds.campaigns || []).filter((c) => {
        if (String(c._id) === dropId) return false;
        const mid = String(c.meta_campaign_id || '').replace(/^meta_/, '');
        return !dropMeta || mid !== dropMeta;
      });
    } else {
      sub.status = next;
      const mid = campaignMetaId;
      if (mid) {
        for (const c of client.metaAds.campaigns || []) {
          if (String(c.meta_campaign_id || '').replace(/^meta_/, '') === mid) {
            c.status = next;
          }
        }
      }
    }
    client.metaAds.lastSync = new Date();
    client.markModified('metaAds');
    await client.save();
  }

  return {
    id: String(sub._id),
    status: next,
    metaCampaignId: campaignMetaId,
  };
}

async function updateCampaignBudget(clientId, { campaignId, dailyBudget }) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const { sub, source } = await findCampaignSubdoc(client, campaignId);

  const budgetNum = Number(dailyBudget);
  if (!Number.isFinite(budgetNum) || budgetNum <= 0) {
    throw new Error('daily_budget must be a positive number');
  }
  const cents = Math.round(budgetNum * 100);
  if (cents < 100) throw new Error('Minimum daily budget is 1.00');

  let adsetId = sub.meta_adset_id ? String(sub.meta_adset_id) : '';
  if (!adsetId && sub.meta_campaign_id) {
    try {
      const adsets = await graphGet(`/${sub.meta_campaign_id}/adsets`, token, {
        fields: 'id,daily_budget',
        limit: 5,
      });
      adsetId = adsets?.data?.[0]?.id ? String(adsets.data[0].id) : '';
    } catch (err) {
      console.warn('[meta ads] adset lookup for budget failed:', formatGraphError(err));
    }
  }

  if (!adsetId) {
    throw new Error('This campaign has no ad set — budget can only be edited on boosts/ads created with an ad set');
  }

  try {
    await graphPost(`/${adsetId}`, token, { daily_budget: cents });
  } catch (err) {
    throw new Error(formatGraphError(err));
  }

  if (source === 'local') {
    sub.budget = budgetNum;
    if (!sub.meta_adset_id) sub.meta_adset_id = adsetId;
    client.metaAds.lastSync = new Date();
    client.markModified('metaAds');
    await client.save();
  }

  return {
    id: String(sub._id),
    budget: budgetNum,
    metaAdsetId: adsetId,
  };
}

const AUDIENCE_PRESETS = [
  { id: 'all', label: 'All customers with email or phone' },
  { id: 'cart_abandoned', label: 'Abandoned carts' },
  { id: 'high_value', label: 'High-value (spent ≥ R500)' },
  { id: 'inactive_60', label: 'Inactive 60+ days' },
  { id: 'product_buyers', label: 'Past buyers' },
];

async function loadCustomersForAudience(clientId, { preset = 'all', limit = 5000 } = {}) {
  const cap = Math.min(Math.max(Number(limit) || 5000, 1), 10000);
  let customers;

  if (preset === 'all') {
    customers = await Customer.find({ clientID: clientId })
      .select('emailAddress phoneNumber customerFirstName customerLastName')
      .limit(cap);
  } else {
    const { resolveSegmentCustomers } = require('../../helpers/revenueCommandCenter');
    customers = await resolveSegmentCustomers(clientId, { preset });
    // Re-fetch with phone — segment helper historically omits phoneNumber
    const ids = customers.map((c) => c._id).slice(0, cap);
    customers = await Customer.find({ clientID: clientId, _id: { $in: ids } }).select(
      'emailAddress phoneNumber customerFirstName customerLastName'
    );
  }

  return customers;
}

async function createCustomAudienceFromCustomers(
  clientId,
  { name, preset = 'all', description = '' } = {}
) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const adAccountId = normalizeAdAccountId(client.metaAds.adAccountId);
  if (!adAccountId) throw new Error('Select an ad account first');

  const audienceName =
    String(name || '').trim() ||
    `Khana · ${AUDIENCE_PRESETS.find((p) => p.id === preset)?.label || preset}`;

  const customers = await loadCustomersForAudience(clientId, { preset });
  const schema = ['EMAIL', 'PHONE', 'FN', 'LN'];
  const rows = [];

  for (const c of customers) {
    const email = normalizeEmail(c.emailAddress);
    const phone = normalizePhone(c.phoneNumber);
    if (!email && !phone) continue;
    rows.push([
      email ? sha256(email) : '',
      phone ? sha256(phone) : '',
      hashField(c.customerFirstName),
      hashField(c.customerLastName),
    ]);
  }

  if (!rows.length) {
    throw new Error('No customers with email or phone found for this audience');
  }

  let audienceId;
  try {
    const created = await graphPost(`/act_${adAccountId}/customaudiences`, token, {
      name: audienceName,
      description:
        String(description || '').trim() ||
        `Synced from Khana customers (${preset}) on ${new Date().toISOString().slice(0, 10)}`,
      subtype: 'CUSTOM',
      customer_file_source: 'USER_PROVIDED_ONLY',
    });
    audienceId = created.id;
  } catch (err) {
    throw new Error(formatGraphError(err));
  }

  // Upload in chunks of 10k (Meta limit per request is higher; keep modest)
  const CHUNK = 5000;
  let matchedApprox = 0;
  try {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const payload = {
        schema,
        data: chunk,
      };
      const session = await graphPostJson(`/${audienceId}/users`, token, {
        payload,
      });
      matchedApprox += Number(session?.num_received || chunk.length);
    }
  } catch (err) {
    throw new Error(
      `Audience created (${audienceId}) but user upload failed: ${formatGraphError(err)}`
    );
  }

  return {
    audienceId: String(audienceId),
    name: audienceName,
    uploaded: rows.length,
    received: matchedApprox,
    preset,
  };
}

/**
 * Preview how many Khana customers would be uploaded for a preset (no Meta write).
 */
async function previewCustomAudienceFromCustomers(clientId, { preset = 'all' } = {}) {
  const presetId = String(preset || 'all');
  const presetMeta = AUDIENCE_PRESETS.find((p) => p.id === presetId) || {
    id: presetId,
    label: presetId,
  };

  const customers = await loadCustomersForAudience(clientId, { preset: presetId });
  let withEmail = 0;
  let withPhone = 0;
  let uploadable = 0;

  for (const c of customers) {
    const email = normalizeEmail(c.emailAddress);
    const phone = normalizePhone(c.phoneNumber);
    if (email) withEmail += 1;
    if (phone) withPhone += 1;
    if (email || phone) uploadable += 1;
  }

  return {
    preset: presetMeta.id,
    label: presetMeta.label,
    scanned: customers.length,
    uploadable,
    withEmail,
    withPhone,
    skipped: Math.max(0, customers.length - uploadable),
  };
}

async function getInsightBreakdowns(clientId, { days = 30, month = '', preset = '', breakdown = 'age' } = {}) {
  const client = await loadClientWithMeta(clientId);
  const adAccountId = normalizeAdAccountId(client.metaAds?.adAccountId);
  if (!adAccountId) throw new Error('Select an ad account first');

  const token = String(client.metaAds.accessToken);
  const window = resolveInsightsWindow({ days, month, preset });
  const dateParams = insightsGraphDateParams(window);

  const allowed = new Set(['age', 'gender', 'age,gender', 'publisher_platform', 'impression_device', 'country']);
  const breakdownKey = allowed.has(String(breakdown)) ? String(breakdown) : 'age';

  try {
    const res = await graphGet(`/act_${adAccountId}/insights`, token, {
      fields: 'spend,impressions,clicks,reach,ctr',
      ...dateParams,
      breakdowns: breakdownKey,
      level: 'account',
      limit: 50,
    });
    const rows = Array.isArray(res?.data) ? res.data : [];
    return {
      breakdown: breakdownKey,
      datePreset: window.datePreset,
      month: window.month,
      since: window.since,
      until: window.until,
      label: window.label,
      rows: rows.map((r) => ({
        age: r.age || null,
        gender: r.gender || null,
        publisherPlatform: r.publisher_platform || null,
        impressionDevice: r.impression_device || null,
        country: r.country || null,
        spend: Number(r.spend) || 0,
        impressions: Number(r.impressions) || 0,
        clicks: Number(r.clicks) || 0,
        reach: Number(r.reach) || 0,
        ctr: Number(r.ctr) || 0,
      })),
    };
  } catch (err) {
    throw new Error(formatGraphError(err));
  }
}

function resolveWhatsAppDigits(client) {
  const fromClick = String(client.whatsapp?.phoneE164 || '').replace(/\D/g, '');
  if (fromClick) return fromClick;
  return '';
}

async function createClickToWhatsAppCampaign(
  clientId,
  {
    name,
    dailyBudget,
    days = 7,
    message = '',
    country = 'ZA',
    targeting: targetingInput = {},
    status = 'PAUSED',
    imageHash,
    imageUrl,
  } = {}
) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const pageToken = client.metaAds.pageAccessToken
    ? String(client.metaAds.pageAccessToken)
    : token;
  const pageId = client.metaAds.pageId;
  const adAccountId = normalizeAdAccountId(client.metaAds.adAccountId);
  if (!pageId) throw new Error('Select a Facebook Page first');
  if (!adAccountId) throw new Error('Select an ad account first');

  const waDigits = resolveWhatsAppDigits(client);
  if (!waDigits) {
    throw new Error(
      'Set your WhatsApp business number in Account settings (click-to-chat number) before creating WhatsApp ads'
    );
  }

  const budgetNum = Number(dailyBudget);
  if (!Number.isFinite(budgetNum) || budgetNum <= 0) throw new Error('daily_budget is required');
  const cents = Math.round(budgetNum * 100);
  const durationDays = Math.min(Math.max(Number(days) || 7, 1), 30);
  const adStatus = String(status).toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
  const campaignName = String(name || '').trim() || `Khana WhatsApp ${new Date().toISOString().slice(0, 10)}`;
  const targeting = buildTargetingSpec({
    country,
    ...targetingInput,
    countries: targetingInput.countries || [country],
  });

  const link = `https://wa.me/${waDigits}${
    message ? `?text=${encodeURIComponent(String(message).slice(0, 500))}` : ''
  }`;

  let campaignId;
  let adSetId;
  let creativeId;
  let adId;

  try {
    const campaign = await graphPost(`/act_${adAccountId}/campaigns`, token, {
      name: campaignName,
      objective: 'OUTCOME_ENGAGEMENT',
      status: adStatus,
      special_ad_categories: JSON.stringify([]),
      is_adset_budget_sharing_enabled: false,
    });
    campaignId = campaign.id;

    const startTime = Math.floor(Date.now() / 1000);
    const adSet = await graphPost(`/act_${adAccountId}/adsets`, token, {
      name: `${campaignName} ad set`,
      campaign_id: campaignId,
      daily_budget: cents,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'CONVERSATIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify(targeting),
      promoted_object: JSON.stringify({ page_id: pageId }),
      destination_type: 'WHATSAPP',
      start_time: startTime,
      end_time: startTime + durationDays * 86400,
      status: adStatus,
    });
    adSetId = adSet.id;

    const objectStorySpec = {
      page_id: pageId,
      link_data: {
        link,
        message:
          String(message || '').trim() ||
          `Chat with ${client.companyName || 'us'} on WhatsApp`,
        call_to_action: {
          type: 'WHATSAPP_MESSAGE',
          value: { link },
        },
      },
    };
    if (imageHash) {
      objectStorySpec.link_data.image_hash = imageHash;
    } else if (imageUrl) {
      objectStorySpec.link_data.picture = imageUrl;
    }

    const creative = await graphPost(`/act_${adAccountId}/adcreatives`, token, {
      name: `${campaignName} creative`,
      object_story_spec: JSON.stringify(objectStorySpec),
    });
    creativeId = creative.id;

    const ad = await graphPost(`/act_${adAccountId}/ads`, token, {
      name: `${campaignName} ad`,
      adset_id: adSetId,
      creative: JSON.stringify({ creative_id: creativeId }),
      status: adStatus,
    });
    adId = ad.id;
  } catch (err) {
    // Do not silently fall back to OUTCOME_TRAFFIC / wa.me — that path does not produce
    // ctwa_clid and breaks WhatsApp Conversions / App Review demos.
    // Opt-in only: META_WHATSAPP_TRAFFIC_FALLBACK=1
    if (String(process.env.META_WHATSAPP_TRAFFIC_FALLBACK || '').trim() !== '1') {
      throw new Error(formatGraphError(err));
    }
    try {
      const campaign = await graphPost(`/act_${adAccountId}/campaigns`, token, {
        name: campaignName,
        objective: 'OUTCOME_TRAFFIC',
        status: adStatus,
        special_ad_categories: JSON.stringify([]),
        is_adset_budget_sharing_enabled: false,
      });
      campaignId = campaign.id;
      const startTime = Math.floor(Date.now() / 1000);
      const adSet = await graphPost(`/act_${adAccountId}/adsets`, token, {
        name: `${campaignName} ad set`,
        campaign_id: campaignId,
        daily_budget: cents,
        billing_event: 'IMPRESSIONS',
        optimization_goal: 'LINK_CLICKS',
        bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
        targeting: JSON.stringify(targeting),
        promoted_object: JSON.stringify({ page_id: pageId }),
        destination_type: 'WEBSITE',
        start_time: startTime,
        end_time: startTime + durationDays * 86400,
        status: adStatus,
      });
      adSetId = adSet.id;
      const objectStorySpec = {
        page_id: pageId,
        link_data: {
          link,
          message:
            String(message || '').trim() ||
            `Chat with ${client.companyName || 'us'} on WhatsApp`,
          call_to_action: { type: 'WHATSAPP_MESSAGE', value: { link } },
          ...(imageHash ? { image_hash: imageHash } : {}),
          ...(imageUrl && !imageHash ? { picture: imageUrl } : {}),
        },
      };
      const creative = await graphPost(`/act_${adAccountId}/adcreatives`, pageToken, {
        name: `${campaignName} creative`,
        object_story_spec: JSON.stringify(objectStorySpec),
      });
      creativeId = creative.id;
      const ad = await graphPost(`/act_${adAccountId}/ads`, token, {
        name: `${campaignName} ad`,
        adset_id: adSetId,
        creative: JSON.stringify({ creative_id: creativeId }),
        status: adStatus,
      });
      adId = ad.id;
    } catch (err2) {
      throw new Error(formatGraphError(err2?.response ? err2 : err));
    }
  }

  return pushLocalCampaign(clientId, {
    name: campaignName,
    objective: 'WHATSAPP',
    budget: budgetNum,
    status: adStatus === 'ACTIVE' ? 'active' : 'paused',
    campaign_type: 'whatsapp',
    meta_campaign_id: String(campaignId),
    meta_adset_id: String(adSetId),
    meta_ad_id: String(adId),
    meta_creative_id: String(creativeId || ''),
    targeting,
  });
}

async function uploadAdImage(clientId, { buffer, filename = 'creative.jpg' }) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const adAccountId = normalizeAdAccountId(client.metaAds.adAccountId);
  if (!adAccountId) throw new Error('Select an ad account first');
  if (!buffer?.length) throw new Error('Image file is required');

  const form = new FormData();
  form.append('filename', filename);
  form.append('bytes', buffer, { filename });
  form.append('access_token', token);

  try {
    const { data } = await axios.post(
      `${META_GRAPH_BASE}/act_${adAccountId}/adimages`,
      form,
      {
        headers: form.getHeaders(),
        timeout: 60000,
        maxContentLength: 30 * 1024 * 1024,
      }
    );
    const images = data?.images || {};
    const first = Object.values(images)[0];
    if (!first?.hash) throw new Error('Meta did not return an image hash');
    return {
      hash: String(first.hash),
      url: first.url || first.permalink_url || '',
      name: filename,
    };
  } catch (err) {
    throw new Error(formatGraphError(err));
  }
}

async function createLeadAd(
  clientId,
  {
    name,
    dailyBudget,
    days = 7,
    country = 'ZA',
    targeting: targetingInput = {},
    status = 'PAUSED',
    imageHash,
    headline = '',
    body = '',
    privacyPolicyUrl = '',
    thankYouMessage = 'Thanks — we will be in touch shortly.',
  } = {}
) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const pageToken = client.metaAds.pageAccessToken
    ? String(client.metaAds.pageAccessToken)
    : token;
  const pageId = client.metaAds.pageId;
  const adAccountId = normalizeAdAccountId(client.metaAds.adAccountId);
  if (!pageId) throw new Error('Select a Facebook Page first');
  if (!adAccountId) throw new Error('Select an ad account first');
  if (!imageHash) throw new Error('Upload a creative image first (image_hash required)');

  const budgetNum = Number(dailyBudget);
  if (!Number.isFinite(budgetNum) || budgetNum <= 0) throw new Error('daily_budget is required');
  const cents = Math.round(budgetNum * 100);
  const durationDays = Math.min(Math.max(Number(days) || 7, 1), 30);
  const adStatus = String(status).toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
  const campaignName = String(name || '').trim() || `Khana Leads ${new Date().toISOString().slice(0, 10)}`;
  const privacyUrl =
    String(privacyPolicyUrl || '').trim() ||
    `${String(client.return_url || '').replace(/\/$/, '')}/privacy` ||
    'https://www.facebook.com/privacy/explanation';

  const targeting = buildTargetingSpec({
    country,
    ...targetingInput,
    countries: targetingInput.countries || [country],
  });

  let formId;
  let campaignId;
  let adSetId;
  let creativeId;
  let adId;

  try {
    const form = await graphPost(`/${pageId}/leadgen_forms`, pageToken, {
      name: `${campaignName} form`,
      privacy_policy: JSON.stringify({ url: privacyUrl }),
      thank_you_page: JSON.stringify({
        title: 'Thank you',
        body: String(thankYouMessage).slice(0, 200),
        button_type: 'VIEW_WEBSITE',
        website_url: String(client.return_url || privacyUrl),
      }),
      questions: JSON.stringify([
        { type: 'FULL_NAME' },
        { type: 'EMAIL' },
        { type: 'PHONE' },
      ]),
    });
    formId = form.id;

    const campaign = await graphPost(`/act_${adAccountId}/campaigns`, token, {
      name: campaignName,
      objective: 'OUTCOME_LEADS',
      status: adStatus,
      special_ad_categories: JSON.stringify([]),
      is_adset_budget_sharing_enabled: false,
    });
    campaignId = campaign.id;

    const startTime = Math.floor(Date.now() / 1000);
    const adSet = await graphPost(`/act_${adAccountId}/adsets`, token, {
      name: `${campaignName} ad set`,
      campaign_id: campaignId,
      daily_budget: cents,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LEAD_GENERATION',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify(targeting),
      promoted_object: JSON.stringify({ page_id: pageId, lead_gen_form_id: formId }),
      destination_type: 'ON_AD',
      start_time: startTime,
      end_time: startTime + durationDays * 86400,
      status: adStatus,
    });
    adSetId = adSet.id;

    const creative = await graphPost(`/act_${adAccountId}/adcreatives`, token, {
      name: `${campaignName} creative`,
      object_story_spec: JSON.stringify({
        page_id: pageId,
        link_data: {
          link: `https://fb.me/`,
          message: String(body || headline || `Contact ${client.companyName || 'us'}`).slice(0, 500),
          name: String(headline || client.companyName || 'Get in touch').slice(0, 40),
          image_hash: imageHash,
          call_to_action: {
            type: 'SIGN_UP',
            value: { lead_gen_form_id: formId },
          },
        },
      }),
    });
    creativeId = creative.id;

    const ad = await graphPost(`/act_${adAccountId}/ads`, token, {
      name: `${campaignName} ad`,
      adset_id: adSetId,
      creative: JSON.stringify({ creative_id: creativeId }),
      status: adStatus,
    });
    adId = ad.id;
  } catch (err) {
    throw new Error(formatGraphError(err));
  }

  return pushLocalCampaign(clientId, {
    name: campaignName,
    objective: 'OUTCOME_LEADS',
    budget: budgetNum,
    status: adStatus === 'ACTIVE' ? 'active' : 'paused',
    campaign_type: 'lead',
    meta_campaign_id: String(campaignId),
    meta_adset_id: String(adSetId),
    meta_ad_id: String(adId),
    meta_creative_id: String(creativeId || ''),
    meta_form_id: String(formId || ''),
    targeting,
  });
}

async function ensureProductCatalog(clientId, { name } = {}) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);

  if (client.metaAds.catalogId) {
    return {
      catalogId: String(client.metaAds.catalogId),
      catalogName: client.metaAds.catalogName || '',
      created: false,
    };
  }

  const businessId = await resolveBusinessIdForCatalog(client, token);
  if (!businessId) {
    throw httpError(
      'No Meta Business Manager found for this login. Open Meta Business Settings, ensure your user admins a Business that can own catalogs (e.g. Khana Technologies 1), add/claim your ad account there if needed, then reconnect Facebook in KhanaConnect.',
      400
    );
  }

  if (String(client.metaAds.metaBusinessId || '') !== businessId) {
    client.metaAds.metaBusinessId = businessId;
    client.markModified('metaAds');
  }

  const catalogName =
    String(name || '').trim() || `${client.companyName || 'Khana'} Catalog`;

  // Prefer an existing BM catalog when create is blocked (Missing Permission /
  // Product Catalog ToS not yet accepted via Commerce Manager).
  try {
    const owned = await graphGet(`/${businessId}/owned_product_catalogs`, token, {
      fields: 'id,name',
      limit: 25,
    });
    const existing = (owned?.data || [])[0];
    if (existing?.id) {
      client.metaAds.catalogId = String(existing.id);
      client.metaAds.catalogName = String(existing.name || catalogName);
      client.metaAds.catalogSyncedAt = client.metaAds.catalogSyncedAt || new Date();
      client.markModified('metaAds');
      await client.save();
      return {
        catalogId: String(existing.id),
        catalogName: client.metaAds.catalogName,
        created: false,
        reusedExisting: true,
      };
    }
  } catch (err) {
    console.warn('[meta ads] list owned_product_catalogs failed:', formatGraphError(err));
  }

  let catalogId;
  try {
    const created = await graphPost(`/${businessId}/owned_product_catalogs`, token, {
      name: catalogName,
    });
    catalogId = created.id;
  } catch (err) {
    const msg = formatGraphError(err);
    console.error('[meta ads] Create product catalog failed:', msg, err?.response?.data || '');
    throw httpError(
      `${msg}. Fix: (1) In Meta Commerce Manager for this Business, create a product catalog once (accepts Catalog Terms). (2) Ensure your Facebook user is Business Admin. (3) In App → Login for Business config, include business_management (and catalog_management if available). (4) Disconnect + reconnect Facebook in KhanaConnect and accept all permissions. Then Sync again.`,
      400
    );
  }

  if (!catalogId) {
    throw httpError('Meta did not return a catalog id when creating the product catalog', 400);
  }

  client.metaAds.catalogId = String(catalogId);
  client.metaAds.catalogName = catalogName;
  client.metaAds.catalogSyncedAt = new Date();
  client.markModified('metaAds');
  await client.save();

  return { catalogId: String(catalogId), catalogName, created: true };
}

async function syncProductCatalog(clientId, { limit = 200 } = {}) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  let catalogId;
  try {
    ({ catalogId } = await ensureProductCatalog(clientId));
  } catch (err) {
    if (err?.status) throw err;
    throwMeta(err, 'Ensure product catalog failed');
  }

  const products = await Product.find(publishedProductFilter({ clientID: clientId }))
    .select('productName description price images sku slug countInStock brand')
    .limit(Math.min(Math.max(Number(limit) || 200, 1), 500));

  const baseUrl = String(client.return_url || '').replace(/\/$/, '');
  const requests = products
    .map((p) => {
      const retailerId = String(p.sku || p._id);
      const image = Array.isArray(p.images) && p.images[0] ? String(p.images[0]).trim() : '';
      const link = baseUrl
        ? `${baseUrl}/products/${p.slug || p._id}`
        : `https://www.facebook.com/${retailerId}`;
      const availability = Number(p.countInStock) > 0 ? 'in stock' : 'out of stock';
      const price = `${Number(p.price || 0).toFixed(2)} ZAR`;
      const imageLink = /^https?:\/\//i.test(image) ? image : '';

      return {
        method: 'UPDATE',
        retailer_id: retailerId,
        data: {
          name: String(p.productName || 'Product').slice(0, 200),
          description: String(p.description || p.productName || '').slice(0, 5000),
          availability,
          condition: 'new',
          price,
          link: /^https?:\/\//i.test(link) ? link : `https://www.facebook.com/${retailerId}`,
          image_link: imageLink,
          brand: String(p.brand || client.companyName || 'Brand').slice(0, 100),
        },
      };
    })
    .filter((row) => row.data.image_link);

  if (!products.length) {
    throw httpError('No published products to sync. Publish at least one product with an image first.', 400);
  }
  if (!requests.length) {
    throw httpError(
      'No published products have public https image URLs. Add product images, then sync again.',
      400
    );
  }

  // Meta allows batches; keep under 500 items
  try {
    await graphPostJson(`/${catalogId}/items_batch`, token, {
      item_type: 'PRODUCT_ITEM',
      requests,
      allow_upsert: true,
    });
  } catch (err) {
    throwMeta(err, 'Catalog items_batch failed');
  }

  // Reload client in case ensureProductCatalog already saved metaBusinessId/catalogId
  const fresh = await loadClientWithMeta(clientId);
  fresh.metaAds.catalogSyncedAt = new Date();
  if (!fresh.metaAds.catalogId) fresh.metaAds.catalogId = String(catalogId);
  fresh.markModified('metaAds');
  await fresh.save();

  return {
    catalogId,
    synced: requests.length,
    skippedWithoutImage: Math.max(0, products.length - requests.length),
    catalogSyncedAt: fresh.metaAds.catalogSyncedAt,
  };
}

async function createCatalogSalesCampaign(
  clientId,
  {
    name,
    dailyBudget,
    days = 7,
    country = 'ZA',
    targeting: targetingInput = {},
    status = 'PAUSED',
  } = {}
) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const pageId = client.metaAds.pageId;
  const adAccountId = normalizeAdAccountId(client.metaAds.adAccountId);
  const catalogId = client.metaAds.catalogId;
  if (!pageId) throw new Error('Select a Facebook Page first');
  if (!adAccountId) throw new Error('Select an ad account first');
  if (!catalogId) throw new Error('Sync your product catalog first');

  const budgetNum = Number(dailyBudget);
  if (!Number.isFinite(budgetNum) || budgetNum <= 0) throw new Error('daily_budget is required');
  const cents = Math.round(budgetNum * 100);
  const durationDays = Math.min(Math.max(Number(days) || 7, 1), 30);
  const adStatus = String(status).toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
  const campaignName =
    String(name || '').trim() || `Khana Catalog ${new Date().toISOString().slice(0, 10)}`;
  const pixelId = client.metaAds.pixelId ? String(client.metaAds.pixelId) : '';
  if (!pixelId) {
    throw new Error(
      'Connect a Meta Pixel on your ad account (Meta Ads → Setup) before creating catalog sales campaigns'
    );
  }
  const targeting = buildTargetingSpec({
    country,
    ...targetingInput,
    countries: targetingInput.countries || [country],
  });

  let productSetId;
  let campaignId;
  let adSetId;
  let creativeId;
  let adId;

  try {
    const productSet = await graphPost(`/${catalogId}/product_sets`, token, {
      name: `${campaignName} set`,
      filter: JSON.stringify({}),
    });
    productSetId = productSet.id;

    const campaign = await graphPost(`/act_${adAccountId}/campaigns`, token, {
      name: campaignName,
      objective: 'OUTCOME_SALES',
      status: adStatus,
      special_ad_categories: JSON.stringify([]),
      is_adset_budget_sharing_enabled: false,
    });
    campaignId = campaign.id;

    const promotedObject = { product_set_id: productSetId, pixel_id: pixelId };

    const startTime = Math.floor(Date.now() / 1000);
    const adSet = await graphPost(`/act_${adAccountId}/adsets`, token, {
      name: `${campaignName} ad set`,
      campaign_id: campaignId,
      daily_budget: cents,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'OFFSITE_CONVERSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify(targeting),
      promoted_object: JSON.stringify(promotedObject),
      destination_type: 'WEBSITE',
      start_time: startTime,
      end_time: startTime + durationDays * 86400,
      status: adStatus,
    });
    adSetId = adSet.id;

    const creative = await graphPost(`/act_${adAccountId}/adcreatives`, token, {
      name: `${campaignName} creative`,
      product_set_id: productSetId,
      object_story_spec: JSON.stringify({
        page_id: pageId,
        template_data: {
          call_to_action: { type: 'SHOP_NOW' },
          name: '{{product.name}}',
          description: '{{product.price}}',
          link: String(client.return_url || '').replace(/\/$/, '') || 'https://facebook.com',
        },
      }),
    });
    creativeId = creative.id;

    const ad = await graphPost(`/act_${adAccountId}/ads`, token, {
      name: `${campaignName} ad`,
      adset_id: adSetId,
      creative: JSON.stringify({ creative_id: creativeId }),
      status: adStatus,
    });
    adId = ad.id;
  } catch (err) {
    throw new Error(formatGraphError(err));
  }

  return pushLocalCampaign(clientId, {
    name: campaignName,
    objective: 'OUTCOME_SALES',
    budget: budgetNum,
    status: adStatus === 'ACTIVE' ? 'active' : 'paused',
    campaign_type: 'catalog',
    meta_campaign_id: String(campaignId),
    meta_adset_id: String(adSetId),
    meta_ad_id: String(adId),
    meta_creative_id: String(creativeId || ''),
    targeting: { ...targeting, product_set_id: productSetId },
  });
}

async function pushLocalCampaign(clientId, campaignDoc) {
  const BillingService = require('./BillingService');
  const feeType = /boost/i.test(String(campaignDoc.campaign_type || ''))
    ? 'service'
    : 'setup';
  await BillingService.assertCreditsForAction(clientId, 'ads_service_fee', feeType, 1);

  const updated = await Client.findOneAndUpdate(
    { clientID: clientId },
    { $push: { 'metaAds.campaigns': campaignDoc } },
    { new: true }
  ).select('metaAds.campaigns');

  const saved = updated?.metaAds?.campaigns?.[updated.metaAds.campaigns.length - 1];

  if (saved) {
    await SaasUsageEvent.create({
      client_id: clientId,
      service: 'ads_service_fee',
      message_type: feeType,
      units: 1,
      source_ref: String(saved._id),
      status: 'queued',
      metadata: { metaCampaignSubdocId: String(saved._id), type: campaignDoc.campaign_type },
    });
    await usageBillingQueue.add('bill-ads-advanced', {
      clientId,
      service: 'ads_service_fee',
      messageType: feeType,
      units: 1,
      sourceRef: String(saved._id),
      metadata: { metaCampaignSubdocId: String(saved._id) },
    });
  }

  return {
    id: saved?._id ? String(saved._id) : null,
    campaignId: campaignDoc.meta_campaign_id,
    adSetId: campaignDoc.meta_adset_id,
    adId: campaignDoc.meta_ad_id,
    formId: campaignDoc.meta_form_id || null,
    status: campaignDoc.status,
    campaignType: campaignDoc.campaign_type,
    budget: campaignDoc.budget,
  };
}

module.exports = {
  AUDIENCE_PRESETS,
  buildMetaDeepLinks,
  getSetupHub,
  createAdAccountForClient,
  listLocalCampaigns,
  updateCampaignStatus,
  updateCampaignBudget,
  createCustomAudienceFromCustomers,
  previewCustomAudienceFromCustomers,
  getInsightBreakdowns,
  createClickToWhatsAppCampaign,
  uploadAdImage,
  createLeadAd,
  ensureProductCatalog,
  syncProductCatalog,
  createCatalogSalesCampaign,
};
