/**
 * Offline tests for the admin ad tips: one block per rule, plus results summary, plan caps
 * and the snapshot mapping. No database, no network:  node tests/adTipsRules.test.js
 */
const assert = require('assert');
const crypto = require('crypto');

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex');

const T = require('../config/adTipsThresholds');
const { buildAdTips, rules, isWeekend } = require('../services/saas/adTipsRules');
const { summariseResults } = require('../helpers/metaAdResults');
const { metaCampaignCapStatus } = require('../helpers/clientPlan');

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err.message}`);
  }
}

/** A healthy account: nothing should fire. */
function healthy(overrides = {}) {
  return {
    currency: 'ZAR',
    label: 'Last 14 days',
    account: {
      spend: 1400,
      impressions: 50000,
      reach: 25000,
      clicks: 600,
      ctr: 1.2,
      cpm: 28,
      frequency: 2,
      results: 70,
      resultLabel: 'Chats started',
      resultSingular: 'chat',
      costPerResult: 20,
      conversionsTracked: true,
    },
    campaigns: [
      { campaignId: 'c1', name: 'WhatsApp chats', spend: 1400, impressions: 50000, reach: 25000, clicks: 600, ctr: 1.2, cpm: 28, frequency: 2, results: 70 },
    ],
    adsets: [
      { id: 'a1', name: 'Pretoria 25-55', campaignId: 'c1', status: 'ACTIVE', dailyBudget: 100, learningStatus: 'SUCCESS', createdTime: '2026-10-01T08:00:00Z' },
    ],
    daily: flatDaily('2026-11-02', 14, { spend: 100, impressions: 3500, clicks: 42, results: 5 }),
    tracking: { pixelLinked: true },
    now: new Date('2026-11-22T10:00:00Z'),
    ...overrides,
  };
}

function flatDaily(startDate, days, row, perDay = () => ({})) {
  const out = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  for (let i = 0; i < days; i += 1) {
    const d = new Date(start.getTime() + i * 86400000);
    const date = d.toISOString().slice(0, 10);
    out.push({ date, ...row, ...perDay(date, i) });
  }
  return out;
}

function ids(tips) {
  return tips.map((t) => t.id);
}

console.log('adTipsRules');

test('healthy account produces no tips', () => {
  const { tips, summary } = buildAdTips(healthy());
  assert.deepStrictEqual(tips, [], `unexpected tips: ${ids(tips).join(', ')}`);
  assert.deepStrictEqual(summary, { critical: 0, warning: 0, info: 0 });
});

test('every tip carries severity, action and the numbers behind it', () => {
  const snap = healthy({ account: { ...healthy().account, cpm: 120, ctr: 0.3, frequency: 6 } });
  const { tips } = buildAdTips(snap);
  assert.ok(tips.length >= 3);
  for (const tip of tips) {
    assert.ok(['critical', 'warning', 'info'].includes(tip.severity), tip.id);
    assert.ok(tip.title && tip.why && tip.action, tip.id);
    assert.ok(Array.isArray(tip.metrics) && tip.metrics.length > 0, tip.id);
    assert.ok(tip.scope && tip.scope.type, tip.id);
  }
  // Critical first.
  const order = tips.map((t) => t.severity);
  assert.deepStrictEqual(order, [...order].sort((a, b) => ['critical', 'warning', 'info'].indexOf(a) - ['critical', 'warning', 'info'].indexOf(b)));
});

// ---------------------------------------------------------------- high CPM
test('high_cpm: warning above threshold, critical above critical, with CPM metric', () => {
  const warn = rules.ruleHighCpm(healthy({ account: { ...healthy().account, cpm: T.cpm.warning + 5 }, campaigns: [] }), T);
  assert.strictEqual(warn.length, 1);
  assert.strictEqual(warn[0].severity, 'warning');
  assert.strictEqual(warn[0].metrics[0].label, 'CPM');
  assert.strictEqual(warn[0].metrics[0].value, 'R65.00');
  const crit = rules.ruleHighCpm(healthy({ account: { ...healthy().account, cpm: T.cpm.critical + 1 }, campaigns: [] }), T);
  assert.strictEqual(crit[0].severity, 'critical');
});
test('high_cpm: ignored below minimum impressions and for non-ZAR accounts', () => {
  const few = rules.ruleHighCpm(healthy({ account: { ...healthy().account, cpm: 200, impressions: 500 }, campaigns: [] }), T);
  assert.strictEqual(few.length, 0);
  const usd = rules.ruleHighCpm(healthy({ currency: 'USD', account: { ...healthy().account, cpm: 200 } }), T);
  assert.strictEqual(usd.length, 0);
  const { moneyRulesSkipped } = buildAdTips(healthy({ currency: 'USD' }));
  assert.strictEqual(moneyRulesSkipped, true);
});
test('high_cpm: a single bad campaign is flagged with campaign scope', () => {
  const snap = healthy({
    campaigns: [
      ...healthy().campaigns,
      { campaignId: 'c2', name: 'Promo', spend: 500, impressions: 4000, reach: 3000, clicks: 40, ctr: 1, cpm: 125, frequency: 1.3 },
    ],
  });
  const tips = rules.ruleHighCpm(snap, T);
  assert.strictEqual(tips.length, 1);
  assert.deepStrictEqual(tips[0].scope, { type: 'campaign', id: 'c2', name: 'Promo' });
});

// ---------------------------------------------------------------- low CTR
test('low_ctr: warning below 0.8%, critical below 0.4%', () => {
  const w = rules.ruleLowCtr(healthy({ account: { ...healthy().account, ctr: 0.6 }, campaigns: [] }), T);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].severity, 'warning');
  assert.strictEqual(w[0].metrics[0].value, '0.6%');
  const c = rules.ruleLowCtr(healthy({ account: { ...healthy().account, ctr: 0.2 }, campaigns: [] }), T);
  assert.strictEqual(c[0].severity, 'critical');
  assert.match(c[0].action, /creative/i);
});
test('low_ctr: campaign duplicate of the account tip is dropped unless worse', () => {
  const snap = healthy({
    account: { ...healthy().account, ctr: 0.6 },
    campaigns: [{ campaignId: 'c1', name: 'Same', impressions: 50000, clicks: 300, ctr: 0.6, reach: 25000 }],
  });
  assert.deepStrictEqual(ids(rules.ruleLowCtr(snap, T)), ['low_ctr']);
});

// ---------------------------------------------------------------- frequency
test('high_frequency: over 3 warns and suggests widening / rotating; over 5 is critical', () => {
  const w = rules.ruleHighFrequency(healthy({ account: { ...healthy().account, frequency: 3.4 }, campaigns: [] }), T);
  assert.strictEqual(w.length, 1);
  assert.strictEqual(w[0].severity, 'warning');
  assert.match(w[0].action, /widen/i);
  assert.match(w[0].action, /rotate/i);
  const c = rules.ruleHighFrequency(healthy({ account: { ...healthy().account, frequency: 5.5 }, campaigns: [] }), T);
  assert.strictEqual(c[0].severity, 'critical');
});
test('high_frequency: computed from impressions / reach when Meta omits frequency', () => {
  const snap = healthy({ account: { ...healthy().account, frequency: 0, impressions: 40000, reach: 10000 }, campaigns: [] });
  const tips = rules.ruleHighFrequency(snap, T);
  assert.strictEqual(tips.length, 1);
  assert.strictEqual(tips[0].metrics[0].value, '4');
});

// ---------------------------------------------------------------- budget fragmentation
test('budget_fragmented: small budget across many ad sets → consolidate', () => {
  const snap = healthy({
    adsets: [1, 2, 3, 4].map((n) => ({ id: `a${n}`, name: `Set ${n}`, status: 'ACTIVE', dailyBudget: 25, learningStatus: 'SUCCESS' })),
  });
  const tips = rules.ruleBudgetFragmentation(snap, T);
  assert.strictEqual(tips.length, 1);
  assert.strictEqual(tips[0].severity, 'warning');
  assert.match(tips[0].action, /Consolidate into 2 ad sets/);
  assert.strictEqual(tips[0].metrics[0].value, '4');
  assert.strictEqual(tips[0].metrics[1].value, 'R100.00');
});
test('money amounts use a space as thousands separator', () => {
  const tips = rules.ruleConversionTracking(
    healthy({ account: { ...healthy().account, spend: 12345.5, conversionsTracked: false }, tracking: { pixelLinked: false } }),
    T
  );
  assert.strictEqual(tips[0].metrics[0].value, 'R12 345.50');
});
test('budget_fragmented: one ad set, paused ad sets, or healthy budgets do not fire', () => {
  assert.strictEqual(rules.ruleBudgetFragmentation(healthy(), T).length, 0);
  const paused = healthy({
    adsets: [
      { id: 'a1', status: 'ACTIVE', dailyBudget: 100 },
      { id: 'a2', status: 'PAUSED', dailyBudget: 20 },
    ],
  });
  assert.strictEqual(rules.ruleBudgetFragmentation(paused, T).length, 0);
  const fine = healthy({
    adsets: [
      { id: 'a1', status: 'ACTIVE', dailyBudget: 80 },
      { id: 'a2', status: 'ACTIVE', dailyBudget: 60 },
    ],
  });
  assert.strictEqual(rules.ruleBudgetFragmentation(fine, T).length, 0);
});

// ---------------------------------------------------------------- learning phase
test('learning_not_exiting: "learning limited" ad set warns', () => {
  const snap = healthy({
    adsets: [{ id: 'a9', name: 'Narrow', status: 'ACTIVE', dailyBudget: 60, learningStatus: 'FAIL', createdTime: '2026-11-18T00:00:00Z' }],
  });
  const tips = rules.ruleLearningPhase(snap, T);
  assert.strictEqual(tips.length, 1);
  assert.strictEqual(tips[0].severity, 'warning');
  assert.deepStrictEqual(tips[0].scope, { type: 'adset', id: 'a9', name: 'Narrow' });
});
test('learning_not_exiting: still learning after 7 days is flagged; a new ad set is not', () => {
  const old = healthy({
    adsets: [{ id: 'a1', name: 'Old', status: 'ACTIVE', learningStatus: 'LEARNING', createdTime: '2026-11-10T00:00:00Z' }],
  });
  const tips = rules.ruleLearningPhase(old, T);
  assert.strictEqual(tips.length, 1);
  assert.strictEqual(tips[0].severity, 'info');
  assert.ok(tips[0].metrics.some((m) => m.label === 'Ad set age' && m.value === '12 days'));
  const fresh = healthy({
    adsets: [{ id: 'a1', name: 'New', status: 'ACTIVE', learningStatus: 'LEARNING', createdTime: '2026-11-19T00:00:00Z' }],
  });
  assert.strictEqual(rules.ruleLearningPhase(fresh, T).length, 0);
});

// ---------------------------------------------------------------- tracking
test('no_conversion_tracking: no pixel and no conversions → critical once spend is meaningful', () => {
  const snap = healthy({
    account: { ...healthy().account, spend: 800, conversionsTracked: false },
    tracking: { pixelLinked: false },
  });
  const tips = rules.ruleConversionTracking(snap, T);
  assert.strictEqual(tips.length, 1);
  assert.strictEqual(tips[0].id, 'no_conversion_tracking');
  assert.strictEqual(tips[0].severity, 'critical');
  assert.match(tips[0].action, /Conversions API/);
  const small = rules.ruleConversionTracking(
    healthy({ account: { ...healthy().account, spend: 100, conversionsTracked: false }, tracking: { pixelLinked: false } }),
    T
  );
  assert.strictEqual(small[0].severity, 'warning');
});
test('pixel_no_conversions: pixel linked but nothing recorded', () => {
  const snap = healthy({ account: { ...healthy().account, spend: 900, conversionsTracked: false }, tracking: { pixelLinked: true } });
  assert.deepStrictEqual(ids(rules.ruleConversionTracking(snap, T)), ['pixel_no_conversions']);
});
test('tracking: no spend, or conversions tracked → nothing', () => {
  assert.strictEqual(rules.ruleConversionTracking(healthy(), T).length, 0);
  const idle = healthy({ account: { ...healthy().account, spend: 0, conversionsTracked: false }, tracking: { pixelLinked: false } });
  assert.strictEqual(rules.ruleConversionTracking(idle, T).length, 0);
});

// ---------------------------------------------------------------- weekend vs weekday
test('isWeekend reads YYYY-MM-DD as a calendar day', () => {
  assert.strictEqual(isWeekend('2026-11-21'), true); // Saturday
  assert.strictEqual(isWeekend('2026-11-22'), true); // Sunday
  assert.strictEqual(isWeekend('2026-11-23'), false); // Monday
});
test('weekday_weekend_gap: weekends much cheaper per result → info tip with both numbers', () => {
  const daily = flatDaily('2026-11-02', 14, { spend: 100, impressions: 3500, clicks: 42 }, (date) => ({
    results: isWeekend(date) ? 10 : 4,
  }));
  const tips = rules.ruleWeekdayWeekend(healthy({ daily }), T);
  assert.strictEqual(tips.length, 1);
  assert.strictEqual(tips[0].severity, 'info');
  assert.strictEqual(tips[0].title, 'Weekends perform much better');
  assert.ok(tips[0].metrics.find((m) => m.label.endsWith('(weekends)')).value === 'R10.00');
  assert.strictEqual(tips[0].metrics[0].label, 'Cost per chat (weekends)');
  assert.ok(tips[0].metrics.find((m) => m.label.endsWith('(weekdays)')).value === 'R25.00');
});
test('weekday_weekend_gap: falls back to CTR when there are no results; small gaps ignored', () => {
  const daily = flatDaily('2026-11-02', 14, { spend: 100, impressions: 3500, results: 0 }, (date) => ({
    clicks: isWeekend(date) ? 20 : 45,
  }));
  const tips = rules.ruleWeekdayWeekend(healthy({ daily }), T);
  assert.strictEqual(tips.length, 1);
  assert.strictEqual(tips[0].title, 'Weekdays perform much better');
  assert.match(tips[0].metrics[0].label, /CTR/);
  assert.strictEqual(rules.ruleWeekdayWeekend(healthy(), T).length, 0);
  // Too few days to judge.
  assert.strictEqual(rules.ruleWeekdayWeekend(healthy({ daily: daily.slice(0, 4) }), T).length, 0);
});

// ---------------------------------------------------------------- CTR trend
test('ctr_declining: CTR halves between first and second half → fatigue warning', () => {
  const daily = flatDaily('2026-11-02', 14, { spend: 100, impressions: 3500 }, (_d, i) => ({ clicks: i < 7 ? 50 : 20 }));
  const tips = rules.ruleCtrDeclining(healthy({ daily }), T);
  assert.strictEqual(tips.length, 1);
  assert.strictEqual(tips[0].severity, 'warning');
  assert.strictEqual(tips[0].metrics[2].value, '60%');
  assert.strictEqual(rules.ruleCtrDeclining(healthy(), T).length, 0);
});

// ---------------------------------------------------------------- thresholds are overridable
test('threshold overrides merge with the config file', () => {
  const snap = healthy({ account: { ...healthy().account, frequency: 2.5 }, campaigns: [] });
  assert.strictEqual(buildAdTips(snap).tips.length, 0);
  const { tips } = buildAdTips(snap, { frequency: { warning: 2 } });
  assert.deepStrictEqual(ids(tips), ['high_frequency']);
  assert.strictEqual(tips[0].severity, 'warning'); // critical still 5 from config
});

console.log('metaAdResults');

test('summariseResults picks chats over link clicks and computes cost per result', () => {
  const r = summariseResults(
    [
      { action_type: 'link_click', value: '120' },
      { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '25' },
    ],
    500
  );
  assert.strictEqual(r.results, 25);
  assert.strictEqual(r.resultLabel, 'Chats started');
  assert.strictEqual(r.resultSingular, 'chat');
  assert.strictEqual(r.costPerResult, 20);
  assert.strictEqual(r.conversionsTracked, true);
});
test('summariseResults: link clicks only → not a tracked conversion; empty → zero', () => {
  const r = summariseResults([{ action_type: 'link_click', value: '40' }], 100);
  assert.strictEqual(r.resultLabel, 'Link clicks');
  assert.strictEqual(r.conversionsTracked, false);
  const none = summariseResults(undefined, 100);
  assert.strictEqual(none.results, 0);
  assert.strictEqual(none.costPerResult, null);
});

console.log('metaCampaignCapStatus');

test('starter cap 5: archived campaigns do not count; reaching the cap is flagged', () => {
  const camps = (n, status = 'active') => Array.from({ length: n }, () => ({ status }));
  const s1 = metaCampaignCapStatus({ subscription: { plan: 'starter' }, metaAds: { campaigns: [...camps(4), ...camps(3, 'archived')] } });
  assert.deepStrictEqual(
    { cap: s1.cap, used: s1.used, remaining: s1.remaining, reached: s1.reached, planLabel: s1.planLabel },
    { cap: 5, used: 4, remaining: 1, reached: false, planLabel: 'Starter' }
  );
  const s2 = metaCampaignCapStatus({ subscription: { plan: 'starter' }, metaAds: { campaigns: camps(5, 'paused') } });
  assert.strictEqual(s2.reached, true);
});
test('growth is unlimited', () => {
  const s = metaCampaignCapStatus({ subscription: { plan: 'growth' }, metaAds: { campaigns: new Array(40).fill({ status: 'active' }) } });
  assert.strictEqual(s.unlimited, true);
  assert.strictEqual(s.remaining, null);
  assert.strictEqual(s.reached, false);
});

console.log('adTipsSnapshot');

test('mapAdSet converts cents and learning status; buildSnapshot reads pixel', () => {
  const { mapAdSet, buildSnapshot } = require('../services/saas/adTipsSnapshot');
  const a = mapAdSet({ id: '1', name: 'X', campaign_id: '9', effective_status: 'active', daily_budget: '4500', learning_stage_info: { status: 'learning', conversions: 12 }, created_time: '2026-11-01T00:00:00+0200' });
  assert.deepStrictEqual(
    { budget: a.dailyBudget, status: a.status, learning: a.learningStatus, conv: a.learningConversions },
    { budget: 45, status: 'ACTIVE', learning: 'LEARNING', conv: 12 }
  );
  const snap = buildSnapshot({ insights: { currency: 'ZAR', account: { spend: 1 }, campaigns: [], daily: [] }, adsets: [a], client: { metaAds: { pixelId: 'abc' } } });
  assert.strictEqual(snap.tracking.pixelLinked, true);
  assert.strictEqual(snap.adsets.length, 1);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
// Requiring the service pulls in queue modules that keep the event loop open.
process.exit(failures.length ? 1 : 0);
