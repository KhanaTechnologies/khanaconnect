/**
 * Turn Meta's `actions` array into one plain "result" a non-marketer understands
 * (chats started, leads, purchases, link clicks), plus whether real conversions are tracked.
 * Pure — no network.
 */

/** First match wins: the most valuable result the ad produced. */
const RESULT_TYPES = [
  { types: ['onsite_conversion.messaging_conversation_started_7d'], label: 'Chats started', singular: 'chat', key: 'chats' },
  { types: ['offsite_conversion.fb_pixel_purchase', 'purchase', 'onsite_web_purchase'], label: 'Purchases', singular: 'purchase', key: 'purchases' },
  { types: ['lead', 'onsite_conversion.lead_grouped', 'offsite_conversion.fb_pixel_lead'], label: 'Leads', singular: 'lead', key: 'leads' },
  { types: ['offsite_conversion.fb_pixel_complete_registration', 'complete_registration'], label: 'Sign-ups', singular: 'sign-up', key: 'signups' },
  { types: ['link_click'], label: 'Link clicks', singular: 'link click', key: 'link_clicks' },
  { types: ['post_engagement'], label: 'Engagements', singular: 'engagement', key: 'engagements' },
];

/** Action types that only exist when a pixel / Conversions API or Meta-hosted conversion is tracking. */
function isConversionAction(type) {
  const t = String(type || '');
  return (
    t.startsWith('offsite_conversion.') ||
    t === 'purchase' ||
    t === 'lead' ||
    t === 'onsite_conversion.lead_grouped' ||
    t === 'onsite_conversion.messaging_conversation_started_7d' ||
    t === 'complete_registration'
  );
}

function actionValue(actions, types) {
  if (!Array.isArray(actions)) return 0;
  let best = 0;
  for (const type of types) {
    const row = actions.find((a) => a && a.action_type === type);
    const n = Number(row?.value);
    if (Number.isFinite(n) && n > best) best = n;
  }
  return best;
}

/**
 * @param {Array<{action_type: string, value: string|number}>} actions
 * @param {number} spend
 * @returns {{ results: number, resultLabel: string, resultSingular: string, resultKey: string, costPerResult: number|null, conversionsTracked: boolean }}
 */
function summariseResults(actions, spend = 0) {
  const list = Array.isArray(actions) ? actions : [];
  for (const def of RESULT_TYPES) {
    const value = actionValue(list, def.types);
    if (value > 0) {
      const s = Number(spend) || 0;
      return {
        results: value,
        resultLabel: def.label,
        resultSingular: def.singular,
        resultKey: def.key,
        costPerResult: s > 0 ? Math.round((s / value) * 100) / 100 : null,
        conversionsTracked: list.some((a) => isConversionAction(a?.action_type) && Number(a?.value) > 0),
      };
    }
  }
  return { results: 0, resultLabel: 'Results', resultSingular: 'result', resultKey: 'none', costPerResult: null, conversionsTracked: false };
}

module.exports = { RESULT_TYPES, summariseResults, isConversionAction };
