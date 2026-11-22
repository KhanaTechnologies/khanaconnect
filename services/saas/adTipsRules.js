/**
 * Admin-only ad tips: turn a client's Meta ad numbers into concrete suggestions Khana can act on
 * (the managed ad service). Rule-based and pure — no network, no database.
 *
 * Thresholds live in config/adTipsThresholds.js. Each rule returns zero or more tips:
 *   { id, severity: 'critical'|'warning'|'info', title, why, action, scope, metrics: [{ label, value, threshold? }] }
 *
 * Snapshot shape (built by MetaAdTipsService from data pulled with ads_read):
 *   {
 *     currency: 'ZAR', label: 'Last 30 days',
 *     account: { spend, impressions, reach, clicks, ctr, cpm, frequency, results, resultLabel, costPerResult, conversionsTracked },
 *     campaigns: [{ campaignId, name, spend, impressions, reach, clicks, ctr, cpm, frequency, results }],
 *     adsets: [{ id, name, campaignId, status, dailyBudget, learningStatus, createdTime }],
 *     daily: [{ date: 'YYYY-MM-DD', spend, impressions, clicks, results }],
 *     tracking: { pixelLinked },
 *     now: Date (optional, for tests)
 *   }
 */
const DEFAULT_THRESHOLDS = require('../../config/adTipsThresholds');

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round(n, dp = 2) {
  const f = 10 ** dp;
  return Math.round(num(n) * f) / f;
}

function money(n, currency) {
  const v = round(n, 2).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return currency === 'ZAR' ? `R${v}` : `${currency} ${v}`;
}

function pct(n) {
  return `${round(n, 2)}%`;
}

function accountScope() {
  return { type: 'account', id: '', name: 'Whole ad account' };
}

function moneyRulesApply(snapshot, t) {
  return String(snapshot.currency || t.currency).toUpperCase() === String(t.currency).toUpperCase();
}

/** Campaign rows worth judging on their own (enough delivery). */
function judgeableCampaigns(snapshot, t) {
  return (snapshot.campaigns || []).filter((c) => num(c.impressions) >= t.minImpressions);
}

// ------------------------------------------------------------------ rules

/** High CPM → people are expensive to reach: refresh the creative or loosen the audience. */
function ruleHighCpm(snapshot, t) {
  if (!moneyRulesApply(snapshot, t)) return [];
  const cur = snapshot.currency || t.currency;
  const tips = [];
  const acc = snapshot.account || {};
  const check = (row, scope) => {
    if (num(row.impressions) < t.minImpressions) return;
    const cpm = num(row.cpm) || (num(row.impressions) ? (num(row.spend) / num(row.impressions)) * 1000 : 0);
    if (cpm <= t.cpm.warning) return;
    const severity = cpm > t.cpm.critical ? 'critical' : 'warning';
    tips.push({
      id: 'high_cpm',
      severity,
      title: 'Reaching people is expensive (high CPM)',
      why: `It costs ${money(cpm, cur)} to show the ads 1,000 times. Small SA businesses usually pay R20–R50.`,
      action:
        'Refresh the creative (new image or short video, clear offer in the first line). If the audience is very narrow, widen it or switch to Advantage+ placements so Meta can find cheaper inventory.',
      scope,
      metrics: [
        { label: 'CPM', value: money(cpm, cur), threshold: `> ${money(t.cpm.warning, cur)}` },
        { label: 'Impressions', value: num(row.impressions).toLocaleString('en-ZA') },
        { label: 'Spend', value: money(row.spend, cur) },
      ],
    });
  };
  check(acc, accountScope());
  for (const c of judgeableCampaigns(snapshot, t)) {
    check(c, { type: 'campaign', id: c.campaignId || '', name: c.name });
  }
  return dedupeAccountAndCampaign(tips);
}

/** Low CTR → the ad doesn't make people stop: new creative / hook. */
function ruleLowCtr(snapshot, t) {
  const tips = [];
  const check = (row, scope) => {
    if (num(row.impressions) < t.minImpressions) return;
    const ctr = num(row.ctr) || (num(row.impressions) ? (num(row.clicks) / num(row.impressions)) * 100 : 0);
    if (ctr >= t.ctr.warning) return;
    tips.push({
      id: 'low_ctr',
      severity: ctr < t.ctr.critical ? 'critical' : 'warning',
      title: 'Few people click (low CTR)',
      why: `Only ${pct(ctr)} of people who saw the ad clicked. Around 1% is normal; below ${pct(t.ctr.warning)} the ad is not stopping the scroll.`,
      action:
        'Swap in a new creative: a real photo of the product or team, the price or offer in the image, and one clear call to action (e.g. "Chat on WhatsApp to book"). Test two versions side by side.',
      scope,
      metrics: [
        { label: 'CTR', value: pct(ctr), threshold: `< ${pct(t.ctr.warning)}` },
        { label: 'Clicks', value: num(row.clicks).toLocaleString('en-ZA') },
        { label: 'Impressions', value: num(row.impressions).toLocaleString('en-ZA') },
      ],
    });
  };
  check(snapshot.account || {}, accountScope());
  for (const c of judgeableCampaigns(snapshot, t)) {
    check(c, { type: 'campaign', id: c.campaignId || '', name: c.name });
  }
  return dedupeAccountAndCampaign(tips);
}

/** Frequency over ~3 → the same people keep seeing it: widen the audience or rotate ads. */
function ruleHighFrequency(snapshot, t) {
  const tips = [];
  const check = (row, scope) => {
    const reach = num(row.reach);
    const freq = num(row.frequency) || (reach ? num(row.impressions) / reach : 0);
    if (freq <= t.frequency.warning) return;
    tips.push({
      id: 'high_frequency',
      severity: freq > t.frequency.critical ? 'critical' : 'warning',
      title: 'The same people keep seeing the ad',
      why: `Each person saw the ads ${round(freq, 1)} times on average. Above ${t.frequency.warning} people tune out and costs climb.`,
      action:
        'Widen the audience (bigger radius, more cities, broader age range, fewer interests) or add 2–3 fresh ads to rotate. Pause the oldest creative.',
      scope,
      metrics: [
        { label: 'Frequency', value: String(round(freq, 1)), threshold: `> ${t.frequency.warning}` },
        { label: 'Reach', value: reach.toLocaleString('en-ZA') },
        { label: 'Impressions', value: num(row.impressions).toLocaleString('en-ZA') },
      ],
    });
  };
  check(snapshot.account || {}, accountScope());
  for (const c of snapshot.campaigns || []) {
    if (num(c.reach) > 0) check(c, { type: 'campaign', id: c.campaignId || '', name: c.name });
  }
  return dedupeAccountAndCampaign(tips);
}

/** A small budget spread over many ad sets → none of them get enough data: consolidate. */
function ruleBudgetFragmentation(snapshot, t) {
  if (!moneyRulesApply(snapshot, t)) return [];
  const cur = snapshot.currency || t.currency;
  const active = (snapshot.adsets || []).filter(
    (a) => String(a.status || '').toUpperCase() === 'ACTIVE' && num(a.dailyBudget) > 0
  );
  if (active.length < t.budget.minAdSetsToFlag) return [];
  const total = active.reduce((s, a) => s + num(a.dailyBudget), 0);
  const avg = total / active.length;
  const small = active.filter((a) => num(a.dailyBudget) < t.budget.minDailyPerAdSet);
  if (avg >= t.budget.minDailyPerAdSet && small.length === 0) return [];
  const suggested = Math.max(1, Math.floor(total / t.budget.minDailyPerAdSet));
  return [
    {
      id: 'budget_fragmented',
      severity: avg < t.budget.minDailyPerAdSet ? 'warning' : 'info',
      title: 'Budget is spread too thin',
      why: `${money(total, cur)}/day is split across ${active.length} active ad sets (about ${money(avg, cur)} each). ${small.length} get less than ${money(t.budget.minDailyPerAdSet, cur)}/day, so none of them collect enough results to learn.`,
      action: `Consolidate into ${suggested === 1 ? 'one ad set' : `${suggested} ad sets or fewer`} with the same total budget, and put several ads inside it instead of one ad per ad set.`,
      scope: accountScope(),
      metrics: [
        { label: 'Active ad sets', value: String(active.length) },
        { label: 'Total daily budget', value: money(total, cur) },
        { label: 'Average per ad set', value: money(avg, cur), threshold: `< ${money(t.budget.minDailyPerAdSet, cur)}` },
      ],
    },
  ];
}

/** Ad sets stuck in learning (or "learning limited") → not enough results per week. */
function ruleLearningPhase(snapshot, t) {
  const now = snapshot.now ? new Date(snapshot.now) : new Date();
  const tips = [];
  for (const a of snapshot.adsets || []) {
    if (String(a.status || '').toUpperCase() !== 'ACTIVE') continue;
    const status = String(a.learningStatus || '').toUpperCase();
    const created = a.createdTime ? new Date(a.createdTime) : null;
    const ageDays = created && !Number.isNaN(created.getTime()) ? (now - created) / 86400000 : null;
    const limited = status === 'FAIL';
    const stuck = status === 'LEARNING' && ageDays != null && ageDays > t.learning.maxLearningDays;
    if (!limited && !stuck) continue;
    const metrics = [
      { label: 'Learning status', value: limited ? 'Learning limited' : 'Still learning' },
      { label: 'Results needed / week', value: String(t.learning.weeklyResultsNeeded) },
    ];
    if (ageDays != null) metrics.push({ label: 'Ad set age', value: `${Math.floor(ageDays)} days`, threshold: `> ${t.learning.maxLearningDays} days` });
    if (a.learningConversions != null) metrics.push({ label: 'Results in learning window', value: String(num(a.learningConversions)) });
    tips.push({
      id: 'learning_not_exiting',
      severity: limited ? 'warning' : 'info',
      title: limited ? 'Ad set is "learning limited"' : 'Ad set has not left the learning phase',
      why: `Meta needs about ${t.learning.weeklyResultsNeeded} results a week per ad set to settle. This one isn't getting there, so delivery stays unstable and costs stay high.`,
      action:
        'Combine it with similar ad sets, raise the daily budget, or optimise for a more frequent result (e.g. chats or link clicks instead of purchases). Avoid editing it often: each big edit restarts learning.',
      scope: { type: 'adset', id: a.id || '', name: a.name || 'Ad set' },
      metrics,
    });
  }
  return tips;
}

/** No pixel / no conversions → Meta can't optimise for sales or bookings. */
function ruleConversionTracking(snapshot, t) {
  const cur = snapshot.currency || t.currency;
  const acc = snapshot.account || {};
  const spend = num(acc.spend);
  if (spend <= 0) return [];
  const pixelLinked = !!snapshot.tracking?.pixelLinked;
  const tracked = !!acc.conversionsTracked;
  if (!pixelLinked && !tracked) {
    const big = moneyRulesApply(snapshot, t) && spend >= t.tracking.minSpendForNoResults;
    return [
      {
        id: 'no_conversion_tracking',
        severity: big ? 'critical' : 'warning',
        title: 'No conversions are tracked',
        why: `${money(spend, cur)} was spent but no pixel is linked and Meta recorded no bookings, leads, purchases or chats. Meta can only optimise for clicks, not customers.`,
        action:
          'Link the Meta Pixel on the client site and turn on the Conversions API (server events) for bookings and orders, then test it from Meta Ads → Setup → Send test event.',
        scope: accountScope(),
        metrics: [
          { label: 'Spend', value: money(spend, cur) },
          { label: 'Pixel linked', value: 'No' },
          { label: 'Tracked conversions', value: '0' },
        ],
      },
    ];
  }
  if (pixelLinked && !tracked && moneyRulesApply(snapshot, t) && spend >= t.tracking.minSpendForNoResults) {
    return [
      {
        id: 'pixel_no_conversions',
        severity: 'warning',
        title: 'Pixel is linked but no conversions came through',
        why: `${money(spend, cur)} spent and the pixel recorded no bookings, leads or purchases in ${snapshot.label || 'this period'}.`,
        action:
          'Check the pixel fires on the booking / checkout thank-you page and that Conversions API events are arriving (Events Manager → Test events). If it works, the ads may be optimising for clicks — switch the goal to leads, chats or purchases.',
        scope: accountScope(),
        metrics: [
          { label: 'Spend', value: money(spend, cur), threshold: `≥ ${money(t.tracking.minSpendForNoResults, cur)}` },
          { label: 'Pixel linked', value: 'Yes' },
          { label: 'Tracked conversions', value: '0' },
        ],
      },
    ];
  }
  return [];
}

function isWeekend(dateStr) {
  // Dates are the ad account's local day (YYYY-MM-DD). Parse as UTC to avoid timezone shifts.
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function sumRows(rows) {
  return rows.reduce(
    (s, r) => ({
      spend: s.spend + num(r.spend),
      impressions: s.impressions + num(r.impressions),
      clicks: s.clicks + num(r.clicks),
      results: s.results + num(r.results),
    }),
    { spend: 0, impressions: 0, clicks: 0, results: 0 }
  );
}

/** Weekend vs weekday: if one is clearly better, shift budget toward it. */
function ruleWeekdayWeekend(snapshot, t) {
  const daily = (snapshot.daily || []).filter((r) => r && r.date && num(r.impressions) > 0);
  const weekend = daily.filter((r) => isWeekend(r.date));
  const weekday = daily.filter((r) => !isWeekend(r.date));
  if (weekend.length < t.dayOfWeek.minWeekendDays || weekday.length < t.dayOfWeek.minWeekdayDays) return [];
  const we = sumRows(weekend);
  const wd = sumRows(weekday);
  const cur = snapshot.currency || t.currency;

  let metricLabel;
  let weVal;
  let wdVal;
  let betterIsLower;
  if (we.results > 0 && wd.results > 0) {
    metricLabel = `Cost per ${String(snapshot.account?.resultSingular || 'result').toLowerCase()}`;
    weVal = we.spend / we.results;
    wdVal = wd.spend / wd.results;
    betterIsLower = true;
  } else {
    metricLabel = 'CTR';
    weVal = we.impressions ? (we.clicks / we.impressions) * 100 : 0;
    wdVal = wd.impressions ? (wd.clicks / wd.impressions) * 100 : 0;
    betterIsLower = false;
    if (we.impressions < t.minImpressions / 2 || wd.impressions < t.minImpressions / 2) return [];
  }
  if (!weVal || !wdVal) return [];
  const worse = betterIsLower ? Math.max(weVal, wdVal) : Math.min(weVal, wdVal);
  const better = betterIsLower ? Math.min(weVal, wdVal) : Math.max(weVal, wdVal);
  const diffPct = betterIsLower ? ((worse - better) / worse) * 100 : ((better - worse) / worse) * 100;
  if (diffPct < t.dayOfWeek.minDifferencePct) return [];
  const weekendBetter = betterIsLower ? weVal < wdVal : weVal > wdVal;
  const fmt = (v) => (metricLabel === 'CTR' ? pct(v) : money(v, cur));
  return [
    {
      id: 'weekday_weekend_gap',
      severity: 'info',
      title: weekendBetter ? 'Weekends perform much better' : 'Weekdays perform much better',
      why: `${metricLabel} is ${fmt(weekendBetter ? weVal : wdVal)} on ${weekendBetter ? 'weekends' : 'weekdays'} vs ${fmt(weekendBetter ? wdVal : weVal)} on ${weekendBetter ? 'weekdays' : 'weekends'} (${Math.round(diffPct)}% better).`,
      action: weekendBetter
        ? 'Raise the budget Friday to Sunday (or use a lifetime budget with an ad schedule) and post fresh content before the weekend.'
        : 'Use a lifetime budget with an ad schedule that favours Monday to Friday, or lower the budget on weekends.',
      scope: accountScope(),
      metrics: [
        { label: `${metricLabel} (weekends)`, value: fmt(weVal) },
        { label: `${metricLabel} (weekdays)`, value: fmt(wdVal) },
        { label: 'Difference', value: `${Math.round(diffPct)}%`, threshold: `≥ ${t.dayOfWeek.minDifferencePct}%` },
        { label: 'Days compared', value: `${weekend.length} weekend · ${weekday.length} weekday` },
      ],
    },
  ];
}

/** CTR falling between the first and second half of the period → creative fatigue. */
function ruleCtrDeclining(snapshot, t) {
  const daily = (snapshot.daily || [])
    .filter((r) => r && r.date && num(r.impressions) > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (daily.length < t.trend.minDays) return [];
  const mid = Math.floor(daily.length / 2);
  const first = sumRows(daily.slice(0, mid));
  const second = sumRows(daily.slice(daily.length - mid));
  if (first.impressions < t.minImpressions / 2 || second.impressions < t.minImpressions / 2) return [];
  const ctr1 = (first.clicks / first.impressions) * 100;
  const ctr2 = (second.clicks / second.impressions) * 100;
  if (!ctr1) return [];
  const drop = ((ctr1 - ctr2) / ctr1) * 100;
  if (drop < t.trend.ctrDropPct) return [];
  return [
    {
      id: 'ctr_declining',
      severity: 'warning',
      title: 'Clicks are dropping off (ad fatigue)',
      why: `CTR fell from ${pct(ctr1)} to ${pct(ctr2)} between the first and second half of the period (${Math.round(drop)}% lower).`,
      action: 'Plan a creative refresh now: new image or video, new headline. Keep the best-performing ad running alongside it.',
      scope: accountScope(),
      metrics: [
        { label: 'CTR first half', value: pct(ctr1) },
        { label: 'CTR second half', value: pct(ctr2) },
        { label: 'Drop', value: `${Math.round(drop)}%`, threshold: `≥ ${t.trend.ctrDropPct}%` },
      ],
    },
  ];
}

/**
 * When the account-level tip already fires, campaign-level copies of the same rule add noise
 * unless they are worse than the account. Keep the account tip plus campaigns more severe than it.
 */
function dedupeAccountAndCampaign(tips) {
  const accountTip = tips.find((tip) => tip.scope.type === 'account');
  if (!accountTip) return tips;
  return tips.filter(
    (tip) => tip === accountTip || SEVERITY_ORDER[tip.severity] < SEVERITY_ORDER[accountTip.severity]
  );
}

const RULES = [
  ruleConversionTracking,
  ruleHighFrequency,
  ruleLowCtr,
  ruleHighCpm,
  ruleCtrDeclining,
  ruleBudgetFragmentation,
  ruleLearningPhase,
  ruleWeekdayWeekend,
];

function mergeThresholds(overrides) {
  if (!overrides) return DEFAULT_THRESHOLDS;
  const out = { ...DEFAULT_THRESHOLDS };
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(DEFAULT_THRESHOLDS[k] || {}), ...v } : v;
  }
  return out;
}

/**
 * @returns {{ tips: Array, summary: { critical: number, warning: number, info: number }, moneyRulesSkipped: boolean }}
 */
function buildAdTips(snapshot, thresholdOverrides) {
  const t = mergeThresholds(thresholdOverrides);
  const snap = snapshot || {};
  const tips = [];
  for (const rule of RULES) {
    try {
      tips.push(...rule(snap, t));
    } catch (err) {
      console.warn(`[ad tips] ${rule.name} failed:`, err.message);
    }
  }
  tips.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  const summary = { critical: 0, warning: 0, info: 0 };
  for (const tip of tips) summary[tip.severity] += 1;
  return { tips, summary, moneyRulesSkipped: !moneyRulesApply(snap, t) };
}

module.exports = {
  buildAdTips,
  RULES,
  rules: {
    ruleHighCpm,
    ruleLowCtr,
    ruleHighFrequency,
    ruleBudgetFragmentation,
    ruleLearningPhase,
    ruleConversionTracking,
    ruleWeekdayWeekend,
    ruleCtrDeclining,
  },
  mergeThresholds,
  isWeekend,
};
