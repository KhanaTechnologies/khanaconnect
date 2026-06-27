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

/** Plan-builder line prices — authoritative for estimates (not admin DB overrides). */
const PLAN_BUILDER_PRICES = {
  revenueToolsMonthly: 99,
  customSystemSetup: 3000,
  customSystemMonthly: 450,
  standaloneApiSetup: 5000,
};

const CUSTOM_SYSTEM_DISCLAIMER =
  'Custom systems must be reasonable in scope — something Khana can develop and maintain on our platform. ' +
  'The system runs on shared Khana infrastructure and is not exclusive to your business unless you add a private standalone API ' +
  '(R5,000 once-off on top of the R3,000 custom setup fee). We confirm final scope before development starts.';

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
  const customOnly = !!selections.needsCustom && !store && !bookings;

  if (customOnly) {
    return 'custom';
  }

  const established = selections.siteSize === 'established';

  if (store && bookings) {
    return established ? 'scale' : 'launch';
  }

  if (store || bookings) {
    return established ? 'launch' : 'starter';
  }

  return established ? 'launch' : 'starter';
}

const TIERS_WITH_REVENUE_INCLUDED = new Set(['growth', 'scale']);

function applyRevenueToolsAddOn(selections, tierId, addOnLines, monthlyAddOns) {
  const store = !!selections.needsStore;
  const bookings = !!selections.needsBookings;

  if (!selections.needsRevenueTools || (!store && !bookings)) {
    return monthlyAddOns;
  }

  if (TIERS_WITH_REVENUE_INCLUDED.has(tierId)) {
    return monthlyAddOns;
  }

  const monthly = PLAN_BUILDER_PRICES.revenueToolsMonthly;
  addOnLines.push({ name: 'Revenue Command Center', monthly });
  return monthlyAddOns + monthly;
}

function applyCustomSystemAddOn(selections, addOnLines) {
  let monthlyAddOns = 0;
  let setupAddOns = 0;

  if (!selections.needsCustom) {
    return { monthlyAddOns, setupAddOns };
  }

  setupAddOns += PLAN_BUILDER_PRICES.customSystemSetup;
  addOnLines.push({
    name: 'Custom system — setup',
    onceOff: PLAN_BUILDER_PRICES.customSystemSetup,
  });

  if (selections.wantsStandaloneApi) {
    setupAddOns += PLAN_BUILDER_PRICES.standaloneApiSetup;
    addOnLines.push({
      name: 'Private standalone API',
      onceOff: PLAN_BUILDER_PRICES.standaloneApiSetup,
    });
  }

  monthlyAddOns += PLAN_BUILDER_PRICES.customSystemMonthly;
  addOnLines.push({
    name: 'Custom system — monthly',
    monthly: PLAN_BUILDER_PRICES.customSystemMonthly,
  });

  return { monthlyAddOns, setupAddOns };
}

function buildCustomEstimateNote(selections) {
  if (!selections.needsCustom) return '';
  const brief = String(selections.customBrief || '').trim();
  const scope =
    selections.customScope === 'addon'
      ? 'Custom system as an add-on to store/bookings'
      : 'Standalone custom system';
  const briefNote = brief ? ' We will review your brief before work begins.' : '';
  return `${scope}.${briefNote}`;
}

function calcTeamSeatCosts(selections, tierId, planBuilder) {
  const teamMembers = Math.max(1, Number(selections.teamMembers) || 1);
  const included = planBuilder.includedSeats[tierId] ?? planBuilder.includedSeats.starter ?? 1;
  const extraSeats = Math.max(0, teamMembers - included);
  const seatMonthly = extraSeats * planBuilder.extraSeatMonthlyFee;
  return { teamMembers, included, extraSeats, seatMonthly };
}

function calculatePlanEstimate(selections, pricingConfig) {
  const tiers = (pricingConfig.tiers || []).filter((t) => t.active !== false);
  const addOns = pricingConfig.addOns || [];
  const planBuilder = mergePlanBuilderConfig(pricingConfig);

  const store = !!selections.needsStore;
  const bookings = !!selections.needsBookings;
  const customOnly = !!selections.needsCustom && !store && !bookings;

  if (customOnly) {
    const addOnLines = [];
    const customPricing = applyCustomSystemAddOn(selections, addOnLines);
    const seats = calcTeamSeatCosts(selections, 'starter', planBuilder);

    return {
      tierId: 'custom',
      tierName: 'Custom scope',
      setupFee: 0,
      monthlyFee: 0,
      totalSetup: customPricing.setupAddOns,
      totalMonthly: customPricing.monthlyAddOns + seats.seatMonthly,
      note: buildCustomEstimateNote(selections),
      customDisclaimer: CUSTOM_SYSTEM_DISCLAIMER,
      addOnLines,
      includedSeats: seats.included,
      extraSeats: seats.extraSeats,
      seatMonthlyFee: planBuilder.extraSeatMonthlyFee,
      seatMonthly: seats.seatMonthly,
    };
  }

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
      note: buildCustomEstimateNote(selections) || 'Contact us for a tailored quote.',
      customDisclaimer: selections.needsCustom ? CUSTOM_SYSTEM_DISCLAIMER : '',
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

  const customPricing = applyCustomSystemAddOn(selections, addOnLines);
  monthlyAddOns += customPricing.monthlyAddOns;
  setupAddOns += customPricing.setupAddOns;

  monthlyAddOns = applyRevenueToolsAddOn(selections, tierId, addOnLines, monthlyAddOns);

  if (selections.customIntegration) {
    const custom = addOns.find((a) => a.id === 'custom-integration' && a.active !== false);
    const once = custom?.onceOffFee ?? 2000;
    setupAddOns += once;
    addOnLines.push({ name: custom?.name || 'Custom integration', onceOff: once });
  }

  const seats = calcTeamSeatCosts(selections, tier.id, planBuilder);

  const setupFee = tier.setupFee ?? 0;
  const monthlyFee = tier.monthlyFee ?? 0;

  return {
    tierId: tier.id,
    tierName: tier.name,
    setupFee,
    monthlyFee,
    includedSeats: seats.included,
    extraSeats: seats.extraSeats,
    seatMonthlyFee: planBuilder.extraSeatMonthlyFee,
    seatMonthly: seats.seatMonthly,
    addOnLines,
    totalSetup: setupFee + setupAddOns,
    totalMonthly: monthlyFee + monthlyAddOns + seats.seatMonthly,
    highlights: tier.highlights || [],
    note: selections.needsCustom ? buildCustomEstimateNote(selections) : '',
    customDisclaimer: selections.needsCustom ? CUSTOM_SYSTEM_DISCLAIMER : '',
  };
}

module.exports = {
  DEFAULT_PLAN_BUILDER,
  PLAN_BUILDER_PRICES,
  CUSTOM_SYSTEM_DISCLAIMER,
  mergePlanBuilderConfig,
  calculatePlanEstimate,
  resolveTierId,
  applyRevenueToolsAddOn,
  applyCustomSystemAddOn,
};
