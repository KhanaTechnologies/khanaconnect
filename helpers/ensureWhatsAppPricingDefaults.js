const SaasPricingRule = require('../models/SaasPricingRule');

/** Default platform fees per WhatsApp message (credits; typically 1 credit ≈ R1). */
const DEFAULT_WHATSAPP_RULES = [
  {
    message_type: 'utility',
    cost_per_unit: 0.4,
    markup_percentage: 0,
    notes: 'Default utility template fee (orders, bookings, status). Excludes Meta WABA charges.',
  },
  {
    message_type: 'auth',
    cost_per_unit: 0.4,
    markup_percentage: 0,
    notes: 'Default authentication / OTP template fee. Excludes Meta WABA charges.',
  },
  {
    message_type: 'marketing',
    cost_per_unit: 0.9,
    markup_percentage: 0,
    notes: 'Default marketing template fee. Excludes Meta WABA charges.',
  },
  {
    message_type: 'service',
    cost_per_unit: 0.15,
    markup_percentage: 0,
    notes: 'Default service / session message fee. Excludes Meta WABA charges.',
  },
];

/**
 * Ensure baseline WhatsApp SaaS pricing rules exist so usage billing can deduct credits.
 * Does not overwrite existing active rules for the same service + message_type + tier.
 */
async function ensureWhatsAppPricingDefaults() {
  let created = 0;
  for (const rule of DEFAULT_WHATSAPP_RULES) {
    const existing = await SaasPricingRule.findOne({
      service: 'whatsapp',
      message_type: rule.message_type,
      tier: 'all',
      active: true,
    }).lean();
    if (existing) continue;

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
  }
  if (created > 0) {
    console.log(`[whatsapp] Seeded ${created} default WhatsApp pricing rule(s)`);
  }
}

module.exports = { ensureWhatsAppPricingDefaults, DEFAULT_WHATSAPP_RULES };
