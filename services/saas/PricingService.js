const SaasPricingRule = require('../../models/SaasPricingRule');
const { pricingRuleKeysForPlan, planIdForClient } = require('../../helpers/clientPlan');
const SaasUsageEvent = require('../../models/SaasUsageEvent');
const { creditsForUnits, unitCostAtVolume, describeVolumeTiers, VOLUME_TIERS } = require('../../helpers/whatsappVolumePricing');

/** Rules are saved per plan (SaasPricingRule.tier holds a plan id, or "all"). Old bronze/silver/gold rules still match their plan. */
async function pickRuleForTier(service, messageType, planId) {
  const keys = pricingRuleKeysForPlan(planId);
  const candidates = await SaasPricingRule.find({
    service,
    message_type: messageType,
    active: true,
    $or: [{ tier: { $in: keys } }, { tier: 'all' }, { tier: null }, { tier: { $exists: false } }],
  })
    .sort({ updated_at: -1 })
    .lean();

  const specific = candidates.find((r) => keys.includes(r.tier));
  if (specific) return specific;
  const allTier = candidates.find((r) => !r.tier || r.tier === 'all');
  if (allTier) return allTier;
  return candidates[0] || null;
}

function startOfUtcMonth(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 0, 0, 0, 0));
}

class PricingService {
  /**
   * @param {string} planId - the client's plan (starter|launch|growth|scale|enterprise); picks plan-specific rules.
   */
  static async getActiveRule(service, messageType = 'service', planId = 'starter') {
    let rule = await pickRuleForTier(service, messageType, planId);
    if (rule) return rule;

    rule = await pickRuleForTier(service, 'service', planId);
    if (rule) return rule;

    throw new Error(`No active pricing rule found for ${service}:${messageType}`);
  }

  static computeCredits(rule, units = 1) {
    const base = Number(rule.cost_per_unit || 0) * Number(units || 1);
    const markedUp = base * (1 + Number(rule.markup_percentage || 0) / 100);
    return Number(markedUp.toFixed(4));
  }

  /** Count WhatsApp sends for this client + message type in the current UTC month. */
  static async countWhatsAppMonthUsage(clientId, messageType) {
    const since = startOfUtcMonth();
    const rows = await SaasUsageEvent.aggregate([
      {
        $match: {
          client_id: clientId,
          service: 'whatsapp',
          message_type: messageType,
          status: { $in: ['queued', 'processed'] },
          created_at: { $gte: since },
        },
      },
      { $group: { _id: null, units: { $sum: '$units' } } },
    ]);
    return Number(rows[0]?.units || 0);
  }

  /**
   * Credits to charge for WhatsApp (applies volume tiers for utility/auth).
   * Falls back to rule cost_per_unit for unknown types.
   */
  static async computeWhatsAppCredits(clientId, messageType, units = 1, rule = null) {
    const monthCount = await this.countWhatsAppMonthUsage(clientId, messageType);
    const volumeCredits = creditsForUnits(messageType, monthCount, units);
    if (volumeCredits != null) {
      return {
        credits: volumeCredits,
        monthCount,
        unitRate: unitCostAtVolume(messageType, monthCount),
        volumeApplied: true,
      };
    }

    let activeRule = rule;
    if (!activeRule) {
      const Client = require('../../models/client');
      const client = await Client.findOne({ clientID: clientId }).select('subscription.plan').lean();
      activeRule = await this.getActiveRule('whatsapp', messageType, planIdForClient(client));
    }
    return {
      credits: this.computeCredits(activeRule, units),
      monthCount,
      unitRate: Number(activeRule.cost_per_unit || 0),
      volumeApplied: false,
    };
  }

  static getWhatsAppVolumeSchedule() {
    return {
      utility: VOLUME_TIERS.utility,
      auth: VOLUME_TIERS.auth,
      descriptions: {
        utility: describeVolumeTiers('utility'),
        auth: describeVolumeTiers('auth'),
        marketing: describeVolumeTiers('marketing'),
        service: describeVolumeTiers('service'),
      },
    };
  }
}

module.exports = PricingService;
