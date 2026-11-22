/**
 * Admin-only ad tips for one client: pull the client's ad numbers (read-only, ads_read),
 * then run the rules in adTipsRules.js. Never creates, edits or spends anything on Meta.
 */
const Client = require('../../models/client');
const MetaAdsService = require('./MetaAdsService');
const { buildAdTips } = require('./adTipsRules');
const { mapAdSet, buildSnapshot } = require('./adTipsSnapshot');
const THRESHOLDS = require('../../config/adTipsThresholds');
const { metaCampaignCapStatus } = require('../../helpers/clientPlan');

const META_GRAPH_BASE = process.env.META_GRAPH_BASE || 'https://graph.facebook.com/v25.0';

function formatGraphError(err) {
  const fb = err?.response?.data?.error;
  return fb?.error_user_msg || fb?.message || err?.message || 'Meta request failed';
}

/** Ad sets with budgets and learning status. Read-only GET. */
async function fetchAdSets(adAccountId, token) {
  const axios = require('axios');
  const res = await axios.get(`${META_GRAPH_BASE}/act_${adAccountId}/adsets`, {
    params: {
      access_token: token,
      fields: 'id,name,campaign_id,effective_status,daily_budget,lifetime_budget,learning_stage_info,created_time',
      limit: 100,
      effective_status: JSON.stringify(['ACTIVE', 'PAUSED', 'CAMPAIGN_PAUSED', 'IN_PROCESS', 'WITH_ISSUES']),
    },
    timeout: 20000,
  });
  const rows = Array.isArray(res.data?.data) ? res.data.data : [];
  return rows.map(mapAdSet);
}

async function getAdTipsForClient(clientId, { days = 30, month = '', preset = '' } = {}) {
  // Lean: encrypted fields (token, pixel id) come back as ciphertext — only used for "is it set".
  const client = await Client.findOne({ clientID: clientId })
    .select('clientID companyName subscription metaAds.pixelId metaAds.adAccountId metaAds.adAccountName metaAds.campaigns metaAds.accessToken')
    .lean();
  if (!client) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }
  if (!client.metaAds?.accessToken || !client.metaAds?.adAccountId) {
    return {
      clientId,
      companyName: client.companyName || clientId,
      connected: false,
      tips: [],
      summary: { critical: 0, warning: 0, info: 0 },
      message: 'This client has not connected Facebook or selected an ad account yet.',
      campaignCap: metaCampaignCapStatus(client),
      thresholds: THRESHOLDS,
    };
  }

  const insights = await MetaAdsService.getInsights(clientId, { days, month, preset });
  const warnings = [...(insights.warnings || [])];

  let adsets = [];
  try {
    // Lean reads skip the decrypt getter, so load the token through the normal loader.
    const full = await MetaAdsService.loadClientWithMeta(clientId, { refreshToken: false });
    adsets = await fetchAdSets(insights.adAccountId, String(full.metaAds.accessToken));
  } catch (err) {
    warnings.push(`Ad sets could not be read (budget and learning tips skipped): ${formatGraphError(err)}`);
  }

  const snapshot = buildSnapshot({ insights, adsets, client });
  const { tips, summary, moneyRulesSkipped } = buildAdTips(snapshot);
  if (moneyRulesSkipped) {
    warnings.push(
      `Ad account bills in ${snapshot.currency}; CPM, budget and spend thresholds are set in ${THRESHOLDS.currency}, so those tips were skipped.`
    );
  }

  return {
    clientId,
    companyName: client.companyName || clientId,
    connected: true,
    adAccountId: insights.adAccountId,
    adAccountName: insights.adAccountName,
    label: insights.label,
    since: insights.since,
    until: insights.until,
    currency: snapshot.currency,
    account: insights.account,
    campaigns: insights.campaigns,
    daily: insights.daily,
    adsets,
    tips,
    summary,
    warnings,
    campaignCap: metaCampaignCapStatus(client),
    thresholds: THRESHOLDS,
  };
}

/** Clients with Meta connected, for the admin picker. */
async function listClientsWithAds() {
  const rows = await Client.find({ 'metaAds.accessToken': { $exists: true, $ne: '' } })
    .select('clientID companyName subscription.plan metaAds.adAccountId metaAds.adAccountName metaAds.pixelId')
    .lean();
  return rows
    .map((c) => ({
      clientId: c.clientID,
      companyName: c.companyName || c.clientID,
      plan: c.subscription?.plan || 'starter',
      adAccountId: c.metaAds?.adAccountId || '',
      adAccountName: c.metaAds?.adAccountName || '',
      pixelLinked: !!c.metaAds?.pixelId,
    }))
    .sort((a, b) => String(a.companyName).localeCompare(String(b.companyName)));
}

module.exports = { getAdTipsForClient, listClientsWithAds, buildSnapshot, mapAdSet };
