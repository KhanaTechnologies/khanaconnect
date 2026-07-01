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

/** Minimum monthly partnership fee (ZAR). */
const MIN_MONTHLY_PARTNERSHIP = 450;

/** Plan-builder line prices — authoritative for estimates (not admin DB overrides). */
const PLAN_BUILDER_PRICES = {
  revenueToolsMonthly: 99,
  customSystemSetup: 3000,
  customSystemMonthly: MIN_MONTHLY_PARTNERSHIP,
  standaloneApiSetup: 5000,
};

const CUSTOM_SYSTEM_DISCLAIMER =
  'Custom systems must be reasonable in scope — something Khana can develop and maintain on our platform. ' +
  'The system runs on shared Khana infrastructure and is not exclusive to your business unless you add a private standalone API ' +
  '(quoted once-off on top of custom setup). We confirm final scope and pricing before development starts.';

const EXISTING_WEBSITE_PATHS = new Set([
  'none',
  'full_khana',
  'keep_hosting_free_rebuild',
  'no_rebuild',
]);

function resolveExistingWebsitePath(selections) {
  const path = selections?.existingWebsitePath;
  if (EXISTING_WEBSITE_PATHS.has(path)) return path;
  if (selections?.wantsWebsiteRebuild) return 'full_khana';
  return 'none';
}

function existingWebsitePathLabel(path) {
  switch (path) {
    case 'full_khana':
      return 'Full Khana platform rebuild & integration';
    case 'keep_hosting_free_rebuild':
      return 'Keep my hosting & domain — free website rebuild';
    case 'no_rebuild':
      return 'Not looking for a rebuild right now';
    default:
      return '—';
  }
}

function normalizePlanSelections(selections) {
  const next = { ...selections };

  if (next.teamMembers != null) {
    next.teamMembers = Math.min(50, Math.max(1, parseInt(next.teamMembers, 10) || 1));
  }

  if (next.customBrief != null) {
    next.customBrief = String(next.customBrief).trim().slice(0, 2000);
  }
  if (next.customScope != null) {
    const scope = String(next.customScope).trim();
    next.customScope = scope === 'addon' ? 'addon' : 'standalone';
  }
  if (next.needsCustom === false) {
    next.customBrief = '';
    next.wantsStandaloneApi = false;
  }
  if (next.wantsStandaloneApi != null) {
    next.wantsStandaloneApi = !!next.wantsStandaloneApi;
  }
  if (next.hasExistingWebsite != null) {
    next.hasExistingWebsite = !!next.hasExistingWebsite;
  }
  if (next.hasExistingWebsite === false) {
    next.existingWebsiteUrl = '';
    next.wantsWebsiteRebuild = false;
    next.existingWebsitePath = 'none';
  }
  if (next.existingWebsiteUrl != null) {
    next.existingWebsiteUrl = String(next.existingWebsiteUrl).trim().slice(0, 500);
  }
  if (next.existingWebsitePath != null) {
    const path = String(next.existingWebsitePath).trim();
    next.existingWebsitePath = EXISTING_WEBSITE_PATHS.has(path) ? path : 'none';
  } else if (next.wantsWebsiteRebuild) {
    next.existingWebsitePath = 'full_khana';
  }
  next.wantsWebsiteRebuild = ['full_khana', 'keep_hosting_free_rebuild'].includes(
    resolveExistingWebsitePath(next)
  );
  if (next.hasExistingWebsite === true) {
    next.siteSize = 'established';
  }

  return next;
}

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

/** Monthly add-ons billed separately — custom monthly is the partnership base via resolveMonthlyPartnershipFee. */
const MONTHLY_ADDON_SKIP_IDS = new Set(['custom-system']);

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

/** Once-off custom setup fees only — monthly partnership is the base fee when custom is selected. */
function applyCustomSystemSetup(selections, addOnLines) {
  let setupAddOns = 0;

  if (!selections.needsCustom) {
    return setupAddOns;
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

  return setupAddOns;
}

function resolveMonthlyPartnershipFee(tier, selections) {
  if (selections.needsCustom) {
    return PLAN_BUILDER_PRICES.customSystemMonthly;
  }
  const fee = tier.monthlyFee ?? 0;
  return Math.max(MIN_MONTHLY_PARTNERSHIP, fee);
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

function buildWebsiteRebuildNote(selections) {
  if (selections.hasExistingWebsite !== true) return '';
  const url = String(selections.existingWebsiteUrl || '').trim();
  const path = resolveExistingWebsitePath(selections);
  let note = 'You already have a website';
  if (url) note += ` (${url})`;
  if (path === 'keep_hosting_free_rebuild') {
    note +=
      '. You chose to keep your hosting and domain with a Khana website rebuild — your plan setup fee is waived on this estimate (custom add-ons may still apply).';
  } else if (path === 'full_khana') {
    note +=
      '. You asked about a full Khana platform rebuild with store, bookings, revenue tools, and branded email on one managed partnership.';
  } else if (path === 'no_rebuild') {
    note += '. You are not looking for a rebuild right now — we can discuss options on your follow-up call.';
  } else {
    note += '. We can walk through migration or integration options on your follow-up call.';
  }
  return note;
}

function applyExistingWebsiteSetupWaiver(selections, tierSetupFee, addOnLines) {
  const path = resolveExistingWebsitePath(selections);
  if (path !== 'keep_hosting_free_rebuild' || !(tierSetupFee > 0)) {
    return 0;
  }
  addOnLines.push({
    name: 'Website rebuild — keep your hosting & domain (setup included)',
    onceOff: 0,
  });
  addOnLines.push({
    name: `Plan setup fee waived (${formatZarForNote(tierSetupFee)})`,
    onceOff: 0,
  });
  return tierSetupFee;
}

function formatZarForNote(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return 'on enquiry';
  return `R${Number(amount).toLocaleString('en-ZA')}`;
}

function appendEstimateNotes(selections, parts) {
  const custom = buildCustomEstimateNote(selections);
  const website = buildWebsiteRebuildNote(selections);
  return [custom, website, ...parts].filter(Boolean).join(' ');
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
    const setupAddOns = applyCustomSystemSetup(selections, addOnLines);
    const seats = calcTeamSeatCosts(selections, 'starter', planBuilder);
    const monthlyFee = PLAN_BUILDER_PRICES.customSystemMonthly;

    return {
      tierId: 'custom',
      tierName: 'Custom system',
      setupFee: 0,
      monthlyFee,
      totalSetup: setupAddOns,
      totalMonthly: monthlyFee + seats.seatMonthly,
      note: appendEstimateNotes(selections, []),
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
      note: appendEstimateNotes(selections, ['Contact us for a tailored quote.']),
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
    const mixed = addOns.find(
      (a) => a.id === 'mixed-module' && a.active !== false && !MONTHLY_ADDON_SKIP_IDS.has(a.id)
    );
    if (mixed?.monthlyFee) {
      monthlyAddOns += mixed.monthlyFee;
      addOnLines.push({ name: mixed.name, monthly: mixed.monthlyFee });
    }
  }

  if (selections.catalogueSize === 'large' && store) {
    const cat = addOns.find(
      (a) => a.id === 'large-catalogue' && a.active !== false && !MONTHLY_ADDON_SKIP_IDS.has(a.id)
    );
    if (cat?.monthlyFee) {
      monthlyAddOns += cat.monthlyFee;
      addOnLines.push({ name: cat.name, monthly: cat.monthlyFee });
    }
  }

  if (selections.advancedEmail) {
    const email = addOns.find(
      (a) => a.id === 'email-campaigns' && a.active !== false && !MONTHLY_ADDON_SKIP_IDS.has(a.id)
    );
    if (email?.monthlyFee) {
      monthlyAddOns += email.monthlyFee;
      addOnLines.push({ name: email.name, monthly: email.monthlyFee });
    }
  }

  setupAddOns += applyCustomSystemSetup(selections, addOnLines);

  monthlyAddOns = applyRevenueToolsAddOn(selections, tierId, addOnLines, monthlyAddOns);

  if (selections.customIntegration) {
    const custom = addOns.find((a) => a.id === 'custom-integration' && a.active !== false);
    const once = custom?.onceOffFee ?? 2000;
    setupAddOns += once;
    addOnLines.push({ name: custom?.name || 'Custom integration', onceOff: once });
  }

  const seats = calcTeamSeatCosts(selections, tier.id, planBuilder);

  const setupFee = tier.setupFee ?? 0;
  const setupWaiver = applyExistingWebsiteSetupWaiver(selections, setupFee, addOnLines);
  const monthlyFee = resolveMonthlyPartnershipFee(tier, selections);
  const tierName = selections.needsCustom ? `${tier.name} + custom system` : tier.name;

  return {
    tierId: tier.id,
    tierName,
    setupFee,
    setupWaiver,
    monthlyFee,
    includedSeats: seats.included,
    extraSeats: seats.extraSeats,
    seatMonthlyFee: planBuilder.extraSeatMonthlyFee,
    seatMonthly: seats.seatMonthly,
    addOnLines,
    totalSetup: Math.max(0, setupFee + setupAddOns - setupWaiver),
    totalMonthly: monthlyFee + monthlyAddOns + seats.seatMonthly,
    highlights: tier.highlights || [],
    note: appendEstimateNotes(selections, []),
    customDisclaimer: selections.needsCustom ? CUSTOM_SYSTEM_DISCLAIMER : '',
  };
}

module.exports = {
  DEFAULT_PLAN_BUILDER,
  MIN_MONTHLY_PARTNERSHIP,
  PLAN_BUILDER_PRICES,
  CUSTOM_SYSTEM_DISCLAIMER,
  mergePlanBuilderConfig,
  calculatePlanEstimate,
  resolveTierId,
  normalizePlanSelections,
  resolveExistingWebsitePath,
  existingWebsitePathLabel,
  applyRevenueToolsAddOn,
  applyCustomSystemSetup,
  resolveMonthlyPartnershipFee,
};
