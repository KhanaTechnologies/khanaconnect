const SaasPricingRule = require('../models/SaasPricingRule');
const { FLAT_RATES, VOLUME_TIERS, describeVolumeTiers } = require('./whatsappVolumePricing');

/**
 * WhatsApp + ads service-fee credit pricing.
 * Prepaid packs (see helpers/creditPacks.js) make credits cheaper when bought ahead.
 */
const PRICING_SEED_VERSION = 4;

function buildDefaultWhatsAppRules() {
  const utilityTiers = describeVolumeTiers('utility').join('; ');
  const authTiers = describeVolumeTiers('auth').join('; ');

  return [
    {
      message_type: 'utility',
      cost_per_unit: VOLUME_TIERS.utility[0].cost,
      markup_percentage: 0,
      notes:
        `v${PRICING_SEED_VERSION}: Client rate starts at ${VOLUME_TIERS.utility[0].cost} credit/msg (orders, bookings, status). Volume: ${utilityTiers}.`,
    },
    {
      message_type: 'auth',
      cost_per_unit: VOLUME_TIERS.auth[0].cost,
      markup_percentage: 0,
      notes:
        `v${PRICING_SEED_VERSION}: Client rate starts at ${VOLUME_TIERS.auth[0].cost} credit/msg (OTP / verification). Volume: ${authTiers}.`,
    },
    {
      message_type: 'marketing',
      cost_per_unit: FLAT_RATES.marketing,
      markup_percentage: 0,
      notes: `v${PRICING_SEED_VERSION}: Flat ${FLAT_RATES.marketing} credits/msg (promotional templates).`,
    },
    {
      message_type: 'service',
      cost_per_unit: FLAT_RATES.service,
      markup_percentage: 0,
      notes: `v${PRICING_SEED_VERSION}: Platform fee only ${FLAT_RATES.service} credits (Meta service messages usually $0).`,
    },
  ];
}

/** Khana platform fee when creating/boosting ads (Meta media spend is separate). */
function buildDefaultAdsServiceFeeRules() {
  return [
    {
      message_type: 'setup',
      cost_per_unit: 15,
      markup_percentage: 0,
      notes: `v${PRICING_SEED_VERSION}: 15 credits per campaign create (prepaid packs cheaper than spot top-ups).`,
    },
    {
      message_type: 'service',
      cost_per_unit: 8,
      markup_percentage: 0,
      notes: `v${PRICING_SEED_VERSION}: 8 credits per boost / standard ads action.`,
    },
    {
      message_type: 'management',
      cost_per_unit: 5,
      markup_percentage: 0,
      notes: `v${PRICING_SEED_VERSION}: 5 credits per lighter ads management action.`,
    },
  ];
}

const DEFAULT_WHATSAPP_RULES = buildDefaultWhatsAppRules();

async function upsertRules(service, rules, versionTag) {
  let created = 0;
  let updated = 0;
  for (const rule of rules) {
    const existing = await SaasPricingRule.findOne({
      service,
      message_type: rule.message_type,
      tier: 'all',
      active: true,
    });

    if (!existing) {
      await SaasPricingRule.create({
        service,
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
  return { created, updated };
}

async function ensureWhatsAppPricingDefaults() {
  const versionTag = `v${PRICING_SEED_VERSION}:`;
  const wa = await upsertRules('whatsapp', buildDefaultWhatsAppRules(), versionTag);
  const ads = await upsertRules('ads_service_fee', buildDefaultAdsServiceFeeRules(), versionTag);

  if (wa.created || wa.updated || ads.created || ads.updated) {
    console.log(
      `[billing] Pricing defaults v${PRICING_SEED_VERSION}: whatsapp created=${wa.created} updated=${wa.updated}; ` +
        `ads_service_fee created=${ads.created} updated=${ads.updated}`
    );
  }
}

module.exports = {
  ensureWhatsAppPricingDefaults,
  DEFAULT_WHATSAPP_RULES,
  PRICING_SEED_VERSION,
  buildDefaultWhatsAppRules,
  buildDefaultAdsServiceFeeRules,
};
