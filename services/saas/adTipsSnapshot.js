/**
 * Pure helpers for the admin ad tips: map Meta ad sets and build the rules' snapshot.
 * Kept apart from MetaAdTipsService so tests can load them without queues or Meta.
 */
const THRESHOLDS = require('../../config/adTipsThresholds');

/** Meta budgets are in the currency's minor unit (cents). */
function mapAdSet(r) {
  const cents = Number(r.daily_budget);
  return {
    id: String(r.id || ''),
    name: String(r.name || 'Ad set'),
    campaignId: String(r.campaign_id || ''),
    status: String(r.effective_status || '').toUpperCase(),
    dailyBudget: Number.isFinite(cents) && cents > 0 ? cents / 100 : 0,
    learningStatus: r.learning_stage_info?.status ? String(r.learning_stage_info.status).toUpperCase() : '',
    learningConversions:
      r.learning_stage_info?.conversions != null ? Number(r.learning_stage_info.conversions) : null,
    createdTime: r.created_time || null,
  };
}

/** Pure: shape getInsights output + ad sets + client into the rules' snapshot. */
function buildSnapshot({ insights, adsets, client, now }) {
  return {
    currency: insights?.currency || THRESHOLDS.currency,
    label: insights?.label || '',
    account: insights?.account || {},
    campaigns: Array.isArray(insights?.campaigns) ? insights.campaigns : [],
    daily: Array.isArray(insights?.daily) ? insights.daily : [],
    adsets: Array.isArray(adsets) ? adsets : [],
    tracking: { pixelLinked: !!client?.metaAds?.pixelId },
    now,
  };
}

module.exports = { mapAdSet, buildSnapshot };
