/**
 * One place for "what does this client's plan allow".
 *
 * The plan is client.subscription.plan (starter | launch | growth | scale | enterprise),
 * the same plan the client is quoted and billed on. Team seats, Meta campaign limits,
 * monthly credits and WhatsApp/ads pricing rules all follow it.
 *
 * The old Bronze / Silver / Gold tier is retired. Old values still read correctly:
 * bronze → starter, silver → launch, gold → growth (see monthlyCreditAllowance PLAN_ALIASES).
 */
const { normalizePlanId, PLAN_ALIASES, PLAN_ALLOWANCES } = require('./monthlyCreditAllowance');
const { DEFAULT_PLAN_BUILDER, mergePlanBuilderConfig } = require('./planBuilderPricing');

const PLAN_IDS = ['starter', 'launch', 'growth', 'scale', 'enterprise'];

const PLAN_LABELS = {
  starter: 'Starter',
  launch: 'Launch',
  growth: 'Growth',
  scale: 'Scale',
  enterprise: 'Enterprise',
};

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Meta campaigns a client may create from the dashboard. 0 = no limit. */
const META_CAMPAIGN_CAPS = {
  starter: envNumber('PLAN_STARTER_META_CAMPAIGN_CAP', 5),
  launch: envNumber('PLAN_LAUNCH_META_CAMPAIGN_CAP', 25),
  growth: envNumber('PLAN_GROWTH_META_CAMPAIGN_CAP', 0),
  scale: envNumber('PLAN_SCALE_META_CAMPAIGN_CAP', 0),
  enterprise: envNumber('PLAN_ENTERPRISE_META_CAMPAIGN_CAP', 0),
};

/** Seat limit returned for platform admins (treated as unlimited). */
const UNLIMITED_SEATS = 999;

/**
 * Strict parse for admin input: a known plan id or an old tier name, else null.
 * (normalizePlanId falls back to starter, which would hide typos.)
 */
function parsePlanInput(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (PLAN_IDS.includes(raw)) return raw;
  if (PLAN_ALIASES[raw]) return PLAN_ALIASES[raw];
  return null;
}

function planIdForClient(client) {
  return normalizePlanId(client?.subscription?.plan);
}

function planLabel(planId) {
  return PLAN_LABELS[normalizePlanId(planId)] || 'Starter';
}

function metaCampaignCapForPlan(planId) {
  const cap = META_CAMPAIGN_CAPS[normalizePlanId(planId)];
  return cap !== undefined ? cap : META_CAMPAIGN_CAPS.starter;
}

function metaCampaignCapForClient(client) {
  return metaCampaignCapForPlan(planIdForClient(client));
}

function includedSeatsForPlan(planId, planBuilder = DEFAULT_PLAN_BUILDER) {
  const seats = planBuilder?.includedSeats || DEFAULT_PLAN_BUILDER.includedSeats;
  const n = Number(seats[normalizePlanId(planId)]);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function extraSeatsForClient(client) {
  const n = Math.floor(Number(client?.subscription?.extraSeats) || 0);
  return n > 0 ? n : 0;
}

/** Included seats come from the live pricing config (Dashboard → Website Pricing), falling back to defaults. */
async function loadPlanBuilder() {
  try {
    const PartnershipPricingConfig = require('../models/PartnershipPricingConfig');
    const doc = await PartnershipPricingConfig.findOne({ configKey: 'default' }).select('planBuilder').lean();
    return mergePlanBuilderConfig(doc);
  } catch {
    return mergePlanBuilderConfig(null);
  }
}

/** Seats = the plan's included seats + extra seats the client pays for. */
function seatLimitForClient(client, planBuilder = DEFAULT_PLAN_BUILDER) {
  if (!client) return includedSeatsForPlan('starter', planBuilder);
  if (client.role === 'admin') return UNLIMITED_SEATS;
  return includedSeatsForPlan(planIdForClient(client), planBuilder) + extraSeatsForClient(client);
}

/** Pricing-rule keys to try for a plan: the plan id, plus the old tier name rules may still be saved under. */
function pricingRuleKeysForPlan(planId) {
  const plan = normalizePlanId(planId);
  const legacy = Object.keys(PLAN_ALIASES).filter((k) => k !== 'partnership' && PLAN_ALIASES[k] === plan);
  return [plan, ...legacy];
}

/** Small summary for API responses. */
function planSummary(client) {
  const plan = planIdForClient(client);
  return {
    plan,
    planLabel: PLAN_LABELS[plan],
    includedCredits: PLAN_ALLOWANCES[plan] ?? 0,
    metaCampaignCap: metaCampaignCapForPlan(plan) || null,
  };
}

module.exports = {
  PLAN_IDS,
  PLAN_LABELS,
  META_CAMPAIGN_CAPS,
  UNLIMITED_SEATS,
  parsePlanInput,
  planIdForClient,
  planLabel,
  metaCampaignCapForPlan,
  metaCampaignCapForClient,
  includedSeatsForPlan,
  extraSeatsForClient,
  loadPlanBuilder,
  seatLimitForClient,
  pricingRuleKeysForPlan,
  planSummary,
};
