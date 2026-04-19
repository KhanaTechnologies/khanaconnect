const axios = require('axios');
const Client = require('../../models/Client');
const SaasUsageEvent = require('../../models/SaasUsageEvent');
const { usageBillingQueue } = require('../../queues/saasQueues');

const META_GRAPH_BASE = process.env.META_GRAPH_BASE || 'https://graph.facebook.com/v21.0';
const DEFAULT_AGENCY_BM_ID = process.env.AGENCY_META_BUSINESS_ID || '';
const DEFAULT_OWNERSHIP = process.env.DEFAULT_AD_OWNERSHIP_TYPE === 'client' ? 'client' : 'agency';

const TIER_META_CAMPAIGN_LIMIT = {
  bronze: Number(process.env.TIER_BRONZE_META_CAMPAIGN_CAP || 5),
  silver: Number(process.env.TIER_SILVER_META_CAMPAIGN_CAP || 25),
  gold: 0,
};

function normalizeMetaAdAccountId(raw) {
  if (!raw) return '';
  return String(raw).trim().replace(/^act_/i, '');
}

function campaignCapForTier(tier) {
  const cap = TIER_META_CAMPAIGN_LIMIT[tier];
  return cap !== undefined ? cap : TIER_META_CAMPAIGN_LIMIT.bronze;
}

class AdsService {
  static async attachAdAccount({ clientId, adAccountId, ownershipType = DEFAULT_OWNERSHIP, metaBusinessId = DEFAULT_AGENCY_BM_ID }) {
    const normId = normalizeMetaAdAccountId(adAccountId);
    if (!normId) throw new Error('ad_account_id is required');

    const client = await Client.findOneAndUpdate(
      { clientID: clientId },
      {
        $set: {
          'metaAds.adAccountId': normId,
          'metaAds.ownershipType': ownershipType === 'client' ? 'client' : 'agency',
          'metaAds.metaBusinessId': String(metaBusinessId || DEFAULT_AGENCY_BM_ID || '').trim(),
        },
      },
      { new: true }
    ).select('metaAds');

    if (!client) throw new Error('Client not found');

    return {
      ad_account_id: normId,
      ownership_type: client.metaAds.ownershipType,
      meta_business_id: client.metaAds.metaBusinessId,
    };
  }

  static async createCampaign({ clientId, name, objective, budget, accessToken: accessTokenOverride }) {
    const client = await Client.findOne({ clientID: clientId }).select('metaAds tier');
    if (!client) throw new Error('Client not found');

    const adId = normalizeMetaAdAccountId(client.metaAds?.adAccountId);
    if (!adId) throw new Error('Attach a Meta ad account first (Client.metaAds.adAccountId or POST /saas/ads/accounts)');

    const cap = campaignCapForTier(client.tier);
    const current = Array.isArray(client.metaAds?.campaigns) ? client.metaAds.campaigns.length : 0;
    if (cap > 0 && current >= cap) {
      throw new Error(`Campaign limit reached for ${client.tier} tier (${cap}). Upgrade to create more.`);
    }

    const token =
      (accessTokenOverride && String(accessTokenOverride)) ||
      (client.metaAds?.accessToken ? String(client.metaAds.accessToken) : '');
    if (!token) throw new Error('Meta access token required on the client (ad-integrations) or pass access_token in the request');

    const url = `${META_GRAPH_BASE}/act_${adId}/campaigns`;
    const payload = {
      name,
      objective,
      status: 'PAUSED',
      special_ad_categories: [],
      access_token: token,
    };
    const response = await axios.post(url, null, { params: payload, timeout: 20000 });
    const metaCampaignId = response.data?.id || '';

    const campaignDoc = {
      name,
      objective,
      budget: budget != null ? Number(budget) : undefined,
      status: 'draft',
      meta_campaign_id: metaCampaignId,
    };

    const updated = await Client.findOneAndUpdate(
      { clientID: clientId },
      { $push: { 'metaAds.campaigns': campaignDoc } },
      { new: true }
    ).select('metaAds.campaigns');

    if (!updated?.metaAds?.campaigns?.length) throw new Error('Failed to save campaign');

    const campaign = updated.metaAds.campaigns[updated.metaAds.campaigns.length - 1];

    await SaasUsageEvent.create({
      client_id: clientId,
      service: 'ads_service_fee',
      message_type: 'setup',
      units: 1,
      source_ref: String(campaign._id),
      status: 'queued',
      metadata: { metaCampaignSubdocId: String(campaign._id), objective },
    });

    await usageBillingQueue.add('bill-ads-setup', {
      clientId,
      service: 'ads_service_fee',
      messageType: 'setup',
      units: 1,
      sourceRef: String(campaign._id),
      metadata: { metaCampaignSubdocId: String(campaign._id), objective },
    });

    return campaign;
  }
}

module.exports = AdsService;
