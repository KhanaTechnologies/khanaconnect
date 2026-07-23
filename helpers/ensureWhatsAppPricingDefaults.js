const SaasPricingRule = require('../models/SaasPricingRule');
const { FLAT_RATES, VOLUME_TIERS, describeVolumeTiers } = require('./whatsappVolumePricing');

/**
 * WhatsApp credit pricing (1 credit ≈ R1 unless CREDITS_PER_ZAR overrides top-ups).
 *
 * v3: Client-facing rates — utility/auth R1 with monthly volume discounts;
 * marketing flat R2.25; service R0.20 platform fee.
 */
const PRICING_SEED_VERSION = 3;

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
        `(utility=${rules[0].cost_per_unit} → volume tiers; marketing=${rules[2].cost_per_unit})`
    );
  }
}

module.exports = {
  ensureWhatsAppPricingDefaults,
  DEFAULT_WHATSAPP_RULES,
  PRICING_SEED_VERSION,
  buildDefaultWhatsAppRules,
};
