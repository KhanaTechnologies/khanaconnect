const SaasPricingRule = require('../../models/SaasPricingRule');

async function pickRuleForTier(service, messageType, clientTier) {
  const tierNorm = ['bronze', 'silver', 'gold'].includes(clientTier) ? clientTier : 'bronze';
  const candidates = await SaasPricingRule.find({
    service,
    message_type: messageType,
    active: true,
    $or: [{ tier: tierNorm }, { tier: 'all' }, { tier: null }, { tier: { $exists: false } }],
  })
    .sort({ updated_at: -1 })
    .lean();

  const specific = candidates.find((r) => r.tier === tierNorm);
  if (specific) return specific;
  const allTier = candidates.find((r) => !r.tier || r.tier === 'all');
  if (allTier) return allTier;
  return candidates[0] || null;
}

class PricingService {
  /**
   * @param {string} clientTier - Client.tier (bronze|silver|gold); drives cost and tier-specific rules.
   */
  static async getActiveRule(service, messageType = 'service', clientTier = 'bronze') {
    let rule = await pickRuleForTier(service, messageType, clientTier);
    if (rule) return rule;

    rule = await pickRuleForTier(service, 'service', clientTier);
    if (rule) return rule;

    throw new Error(`No active pricing rule found for ${service}:${messageType}`);
  }

  static computeCredits(rule, units = 1) {
    const base = Number(rule.cost_per_unit || 0) * Number(units || 1);
    const markedUp = base * (1 + Number(rule.markup_percentage || 0) / 100);
    return Number(markedUp.toFixed(4));
  }
}

module.exports = PricingService;
