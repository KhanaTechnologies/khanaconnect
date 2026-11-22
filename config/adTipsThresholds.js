/**
 * Thresholds for the admin-only ad tips (services/saas/adTipsRules.js).
 *
 * One place to tune them. Money values are in `currency` (ZAR) and are tuned for small
 * South African businesses on Meta. Money-based rules are skipped for ad accounts billed
 * in another currency, so a USD account never gets a "CPM above R60" tip.
 *
 * Rough SA benchmarks used here (2026): CPM R20–R50, link CTR around 1%, a click-to-WhatsApp
 * chat R5–R40. Meta needs about 50 optimisation events a week per ad set to leave learning.
 */
module.exports = {
  currency: 'ZAR',

  /** Ignore rate-based rules until there is enough delivery to judge. */
  minImpressions: 1000,

  /** Cost per 1,000 impressions. */
  cpm: { warning: 60, critical: 100 },

  /** Click-through rate, in percent (Meta's `ctr`). Below these = weak creative. */
  ctr: { warning: 0.8, critical: 0.4 },

  /** Average times each person saw the ads in the period. */
  frequency: { warning: 3, critical: 5 },

  /** Daily budget per active ad set below which spreading across ad sets hurts. */
  budget: { minDailyPerAdSet: 50, minAdSetsToFlag: 2 },

  /** Learning phase. */
  learning: {
    weeklyResultsNeeded: 50,
    /** Ad sets still "learning" after this many days get flagged. */
    maxLearningDays: 7,
  },

  /** No conversions tracked: flag once this much was spent in the period. */
  tracking: { minSpendForNoResults: 500 },

  /** Weekend vs weekday: flag when one side is at least this much cheaper per result (or better CTR). */
  dayOfWeek: { minDifferencePct: 30, minWeekendDays: 2, minWeekdayDays: 5 },

  /** CTR trend: compare the first and second half of the period. */
  trend: { ctrDropPct: 25, minDays: 6 },
};
