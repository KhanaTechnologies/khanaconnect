const SaasPricingRule = require('../models/SaasPricingRule');

/**
 * WhatsApp credit pricing (1 credit ≈ R1 unless CREDITS_PER_ZAR overrides top-ups).
 *
 * Meta bills the WABA in USD. Defaults use observed / SA-ish Meta rates × USD→ZAR × markup
 * so Khana covers Meta when sending on the platform number, plus platform margin.
 *
 * Env overrides:
 *   WHATSAPP_USD_ZAR_RATE     default 18.5
 *   WHATSAPP_PRICE_MARKUP     default 3 (multiplier on Meta ZAR cost)
 *   WHATSAPP_META_USD_UTILITY / _AUTH / _MARKETING  (optional USD per message)
 */
const PRICING_SEED_VERSION = 2;

function usdZarRate() {
  const n = Number(process.env.WHATSAPP_USD_ZAR_RATE || 18.5);
  return Number.isFinite(n) && n > 0 ? n : 18.5;
}

function priceMarkup() {
  const n = Number(process.env.WHATSAPP_PRICE_MARKUP || 3);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

function metaUsd(envKey, fallback) {
  const n = Number(process.env[envKey]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function creditsFromMetaUsd(usdPerMessage) {
  const zar = Number(usdPerMessage) * usdZarRate();
  const withMarkup = zar * priceMarkup();
  // Round up to nearest 0.05 credit so we never under-cover Meta FX drift.
  return Math.ceil(withMarkup * 20) / 20;
}

function buildDefaultWhatsAppRules() {
  // User Meta estimate: $0.03 utility for 3 msgs ≈ $0.01 each.
  // Marketing / auth use published SA-ish USD ballparks; tune via env if Meta changes rates.
  const utilityUsd = metaUsd('WHATSAPP_META_USD_UTILITY', 0.01);
  const authUsd = metaUsd('WHATSAPP_META_USD_AUTH', 0.01);
  const marketingUsd = metaUsd('WHATSAPP_META_USD_MARKETING', 0.04);
  const rate = usdZarRate();
  const markup = priceMarkup();

  return [
    {
      message_type: 'utility',
      cost_per_unit: creditsFromMetaUsd(utilityUsd),
      markup_percentage: 0,
      notes:
        `v${PRICING_SEED_VERSION}: Meta ~$${utilityUsd}/msg × R${rate}/$ × ${markup}x markup (orders, bookings, status). Covers USD Meta bill when using Khana WABA.`,
    },
    {
      message_type: 'auth',
      cost_per_unit: creditsFromMetaUsd(authUsd),
      markup_percentage: 0,
      notes:
        `v${PRICING_SEED_VERSION}: Meta ~$${authUsd}/msg × R${rate}/$ × ${markup}x markup (OTP / verification).`,
    },
    {
      message_type: 'marketing',
      cost_per_unit: creditsFromMetaUsd(marketingUsd),
      markup_percentage: 0,
      notes:
        `v${PRICING_SEED_VERSION}: Meta ~$${marketingUsd}/msg × R${rate}/$ × ${markup}x markup (promotional templates).`,
    },
    {
      message_type: 'service',
      // Meta service messages are typically free; small platform fee only.
      cost_per_unit: 0.2,
      markup_percentage: 0,
      notes: `v${PRICING_SEED_VERSION}: Platform fee only (Meta service messages usually $0).`,
    },
  ];
}

const DEFAULT_WHATSAPP_RULES = buildDefaultWhatsAppRules();

/**
 * Ensure WhatsApp SaaS pricing rules exist and match the current seed version.
 * Updates existing active tier=all rules when notes version is stale (or missing).
 */
async function ensureWhatsAppPricingDefaults() {
  const rules = buildDefaultWhatsAppRules();
  let created = 0;
  let updated = 0;
  const versionTag = `v${PRICING_SEED_VERSION}:`;

  for (const rule of rules) {
    const existing = await SaasPricingRule.findOne({
      service: 'whatsapp',
      message_type: rule.message_type,
      tier: 'all',
      active: true,
    });

    if (!existing) {
      await SaasPricingRule.create({
        service: 'whatsapp',
        message_type: rule.message_type,
        tier: 'all',
        cost_per_unit: rule.cost_per_unit,
        markup_percentage: rule.markup_percentage,
        active: true,
        updated_by: 'system',
        notes: rule.notes,
      });
      created += 1;
      continue;
    }

    const notes = String(existing.notes || '');
    const needsUpdate =
      !notes.includes(versionTag) ||
      Number(existing.cost_per_unit) !== Number(rule.cost_per_unit);

    if (needsUpdate) {
      existing.cost_per_unit = rule.cost_per_unit;
      existing.markup_percentage = rule.markup_percentage;
      existing.notes = rule.notes;
      existing.updated_by = 'system';
      await existing.save();
      updated += 1;
    }
  }

  if (created > 0 || updated > 0) {
    console.log(
      `[whatsapp] Pricing defaults v${PRICING_SEED_VERSION}: created=${created} updated=${updated} ` +
        `(USD/ZAR=${usdZarRate()} markup=${priceMarkup()}x utility=${rules[0].cost_per_unit} credits)`
    );
  }
}

module.exports = {
  ensureWhatsAppPricingDefaults,
  DEFAULT_WHATSAPP_RULES,
  PRICING_SEED_VERSION,
  buildDefaultWhatsAppRules,
};
