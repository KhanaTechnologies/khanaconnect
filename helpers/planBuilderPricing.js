const DEFAULT_PLAN_BUILDER = {
  includedSeats: {
    starter: 1,
    launch: 1,
    growth: 3,
    scale: 5,
    enterprise: 10,
  },
  extraSeatMonthlyFee: 99,
};

function mergePlanBuilderConfig(config) {
  const src = config?.planBuilder || {};
  return {
    includedSeats: { ...DEFAULT_PLAN_BUILDER.includedSeats, ...(src.includedSeats || {}) },
    extraSeatMonthlyFee:
      Number(src.extraSeatMonthlyFee) >= 0
        ? Number(src.extraSeatMonthlyFee)
        : DEFAULT_PLAN_BUILDER.extraSeatMonthlyFee,
  };
}

function resolveTierId(selections) {
  const store = !!selections.needsStore;
  const bookings = !!selections.needsBookings;
  const established = selections.siteSize === 'established';

  // Mixed retail + services — Scale only when already established; otherwise Launch + mixed add-on
  if (store && bookings) {
    return established ? 'scale' : 'launch';
  }

  if (store || bookings) {
    return established ? 'launch' : 'starter';
  }

  return established ? 'launch' : 'starter';
}

const TIERS_WITH_REVENUE_INCLUDED = new Set(['growth', 'scale']);

function applyRevenueToolsAddOn(selections, tierId, addOns, addOnLines, monthlyAddOns) {
  if (!selections.needsRevenueTools || TIERS_WITH_REVENUE_INCLUDED.has(tierId)) {
    return monthlyAddOns;
  }

  const rcc = addOns.find((a) => a.id === 'revenue-tools' && a.active !== false);
  const monthly = rcc?.monthlyFee ?? 299;
  addOnLines.push({ name: rcc?.name || 'Revenue Command Center', monthly });
  return monthlyAddOns + monthly;
}

function calculatePlanEstimate(selections, pricingConfig) {
  const tiers = (pricingConfig.tiers || []).filter((t) => t.active !== false);
  const addOns = pricingConfig.addOns || [];
  const planBuilder = mergePlanBuilderConfig(pricingConfig);

  const tierId = resolveTierId(selections);
  const tier =
    tiers.find((t) => t.id === tierId) ||
    tiers.find((t) => t.id === 'growth') ||
    tiers[0];

  if (!tier) {
    return {
      tierId: 'custom',
      tierName: 'Custom',
      setupFee: null,
      monthlyFee: null,
      totalSetup: null,
      totalMonthly: null,
      note: 'Contact us for a tailored quote.',
      addOnLines: [],
      includedSeats: 1,
      extraSeats: 0,
      seatMonthlyFee: planBuilder.extraSeatMonthlyFee,
      seatMonthly: 0,
    };
  }

  const addOnLines = [];
  let monthlyAddOns = 0;
  let setupAddOns = 0;

  const store = !!selections.needsStore;
  const bookings = !!selections.needsBookings;

  if (store && bookings && tierId !== 'scale') {
    const mixed = addOns.find((a) => a.id === 'mixed-module' && a.active !== false);
    if (mixed?.monthlyFee) {
      monthlyAddOns += mixed.monthlyFee;
      addOnLines.push({ name: mixed.name, monthly: mixed.monthlyFee });
    }
  }

  if (selections.catalogueSize === 'large' && store) {
    const cat = addOns.find((a) => a.id === 'large-catalogue' && a.active !== false);
    if (cat?.monthlyFee) {
      monthlyAddOns += cat.monthlyFee;
      addOnLines.push({ name: cat.name, monthly: cat.monthlyFee });
    }
  }

  if (selections.advancedEmail) {
    const email = addOns.find((a) => a.id === 'email-campaigns' && a.active !== false);
    if (email?.monthlyFee) {
      monthlyAddOns += email.monthlyFee;
      addOnLines.push({ name: email.name, monthly: email.monthlyFee });
    }
  }

  monthlyAddOns = applyRevenueToolsAddOn(selections, tierId, addOns, addOnLines, monthlyAddOns);

  if (selections.customIntegration) {
    const custom = addOns.find((a) => a.id === 'custom-integration' && a.active !== false);
    const once = custom?.onceOffFee ?? 2000;
    setupAddOns += once;
    addOnLines.push({ name: custom?.name || 'Custom integration', onceOff: once });
  }

  const teamMembers = Math.max(1, Number(selections.teamMembers) || 1);
  const included = planBuilder.includedSeats[tier.id] ?? 1;
  const extraSeats = Math.max(0, teamMembers - included);
  const seatMonthly = extraSeats * planBuilder.extraSeatMonthlyFee;

  const setupFee = tier.setupFee ?? 0;
  const monthlyFee = tier.monthlyFee ?? 0;

  return {
    tierId: tier.id,
    tierName: tier.name,
    setupFee,
    monthlyFee,
    includedSeats: included,
    extraSeats,
    seatMonthlyFee: planBuilder.extraSeatMonthlyFee,
    seatMonthly,
    addOnLines,
    totalSetup: setupFee + setupAddOns,
    totalMonthly: monthlyFee + monthlyAddOns + seatMonthly,
    highlights: tier.highlights || [],
    note: '',
  };
}

module.exports = {
  DEFAULT_PLAN_BUILDER,
  mergePlanBuilderConfig,
  calculatePlanEstimate,
  resolveTierId,
  applyRevenueToolsAddOn,
};
