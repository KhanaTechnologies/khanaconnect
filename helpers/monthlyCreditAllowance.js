/**
 * Monthly included Khana credits by partnership plan.
 * Unused included credits expire at calendar month-end; purchased packs never expire.
 */

const PLAN_ALLOWANCES = {
  starter: 50,
  launch: 100,
  growth: 200,
  scale: 500,
  enterprise: 500,
};

/** Legacy subscription.plan values map onto Starter. */
const PLAN_ALIASES = {
  partnership: 'starter',
  bronze: 'starter',
  silver: 'launch',
  gold: 'growth',
};

function normalizePlanId(planId) {
  const raw = String(planId || '')
    .trim()
    .toLowerCase();
  if (!raw) return 'starter';
  if (PLAN_ALLOWANCES[raw] != null) return raw;
  if (PLAN_ALIASES[raw]) return PLAN_ALIASES[raw];
  return 'starter';
}

function allowanceForPlan(planId) {
  const plan = normalizePlanId(planId);
  return {
    plan,
    credits: Number(PLAN_ALLOWANCES[plan] || 0),
  };
}

function listAllowances() {
  return Object.entries(PLAN_ALLOWANCES).map(([plan, credits]) => ({
    plan,
    credits,
  }));
}

/** Calendar period key in Africa/Johannesburg (YYYY-MM). */
function currentPeriodKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  return `${year}-${month}`;
}

/** ISO end of current calendar month (SA), exclusive-ish display as last moment of month. */
function periodExpiresAt(periodKey = currentPeriodKey()) {
  const [y, m] = String(periodKey).split('-').map(Number);
  if (!y || !m) return null;
  // Last day of month 23:59:59.999 in local interpretation — store as UTC end of that SA day
  const lastDay = new Date(Date.UTC(y, m, 0, 21, 59, 59, 999)); // approx SA UTC+2 end of last day
  return lastDay.toISOString();
}

function includedCreditsHint(planId) {
  const { plan, credits } = allowanceForPlan(planId);
  return `${credits} WhatsApp/ads credits included each month on ${plan} (unused expire; top up packs for more)`;
}

module.exports = {
  PLAN_ALLOWANCES,
  PLAN_ALIASES,
  normalizePlanId,
  allowanceForPlan,
  listAllowances,
  currentPeriodKey,
  periodExpiresAt,
  includedCreditsHint,
};
