const { DEFAULT_PLAN_BUILDER, mergePlanBuilderConfig } = require('./planBuilderPricing');

const PRICING_CONFIG_VERSION = 17;

/**
 * Launch offer for the first partners: shown as a banner on the homepage and
 * pricing page while enabled and spots remain. Edited at /dashboard/website-pricing.
 */
const DEFAULT_FOUNDING_OFFER = {
  enabled: true,
  title: 'Founding partner offer',
  details:
    'No setup fee and your monthly fee locked for 12 months. In return, we ask for an honest review after 90 days and permission to share your results.',
  spotsTotal: 5,
  spotsTaken: 0,
};

/** Default partnership pricing for the SA market. */
const DEFAULT_PARTNERSHIP_PRICING = {
  pricingConfigVersion: PRICING_CONFIG_VERSION,
  showPublishedPrices: true,
  currency: 'ZAR',
  currencySymbol: 'R',
  billingNote:
    'Monthly fees are billed after go-live. The setup fee can be paid up front or split over 6 equal monthly payments. Each plan includes monthly WhatsApp/ads credits (unused expire at month-end); top up prepaid packs when you need more.',
  vatNote:
    'Khana is not registered for VAT. Setup fees, monthly fees, and credit packs do not have VAT added.',
  tiers: [
    {
      id: 'starter',
      name: 'Starter',
      tagline: 'Perfect for startups & sole traders',
      description:
        'Get online fast with a professional presence. A good fit when you are launching and need reliability without enterprise pricing.',
      setupFee: 1999,
      monthlyFee: 450,
      setupLabel: 'R1,999 setup',
      setupInstalments: 6,
      monthlyLabel: 'R450/mo',
      featured: false,
      active: true,
      sortOrder: 0,
      highlights: [
        'Up to 5-page business website',
        'Online store or booking system',
        '50 WhatsApp/ads credits included each month (unused expire)',
        'WhatsApp confirmations & updates (we help set up)',
        'Managed hosting & SSL',
        'Mobile-responsive design',
        'Contact form & basic analytics',
        'Email support',
      ],
    },
    {
      id: 'launch',
      name: 'Launch',
      tagline: 'Professional business online',
      description:
        'For established small businesses that need a polished site with ongoing management and local support.',
      setupFee: 3499,
      monthlyFee: 650,
      setupLabel: 'R3,499 setup',
      setupInstalments: 6,
      monthlyLabel: 'R650/mo',
      featured: false,
      active: true,
      sortOrder: 1,
      highlights: [
        'Up to 10-page website',
        'Everything in Starter',
        '100 WhatsApp/ads credits included each month (unused expire)',
        'Online store or booking system',
        'WhatsApp customer alerts',
        'Blog or news section',
        'SEO-ready structure',
        'Priority email support',
        'One small content update per quarter, using text and images you supply',
      ],
    },
    {
      id: 'growth',
      name: 'Growth',
      tagline: 'Sell or book online + revenue tools',
      description:
        'Our most popular plan. Full Revenue Command Center to recover sales, segment customers, and run campaigns on top of your store or bookings.',
      setupFee: 6999,
      monthlyFee: 899,
      setupLabel: 'R6,999 setup',
      setupInstalments: 6,
      monthlyLabel: 'R899/mo',
      featured: true,
      active: true,
      sortOrder: 2,
      highlights: [
        'Everything in Launch',
        '200 WhatsApp/ads credits included each month (unused expire)',
        'Revenue Command Center',
        'Cart recovery & customer segments',
        'Orders & appointment dashboard',
        'WhatsApp order & booking notifications',
        'Campaign & promo tools',
        'Priority support',
      ],
    },
    {
      id: 'scale',
      name: 'Scale',
      tagline: 'Retail + services on one platform',
      description:
        'For growing businesses running products and appointments together, with full revenue and marketing tools.',
      setupFee: 14999,
      monthlyFee: 1799,
      setupLabel: 'R14,999 setup',
      setupInstalments: 6,
      monthlyLabel: 'R1,799/mo',
      featured: false,
      active: true,
      sortOrder: 3,
      highlights: [
        'Everything in Growth',
        '500 WhatsApp/ads credits included each month (unused expire)',
        'Store and bookings together',
        'Guided onboarding with your team',
        'Advanced campaigns and preorder tools',
        'Bundles, upsells, and social proof',
        'Priority support',
      ],
    },
    {
      id: 'enterprise',
      name: 'Enterprise',
      tagline: 'Institutions & custom scope',
      description:
        'For universities, large organisations, and complex integrations. Scoped and quoted to your requirements.',
      setupFee: null,
      monthlyFee: null,
      setupLabel: 'Scoped on enquiry',
      monthlyLabel: 'Quoted on enquiry',
      featured: false,
      active: false,
      sortOrder: 4,
      highlights: [
        'Custom platform scope',
        'Multi-module & multi-site setups',
        'SLA & institution-grade support',
        'Custom requested integrations (within reason)',
        'Dedicated account management',
        'Training & documentation',
      ],
    },
  ],
  addOns: [
    {
      id: 'mixed-module',
      name: 'Mixed business module',
      description: 'Not sold separately. Store and bookings together is the Scale plan.',
      monthlyFee: 0,
      onceOffFee: null,
      pricingType: 'monthly',
      active: false,
      sortOrder: 0,
    },
    {
      id: 'revenue-tools',
      name: 'Revenue Command Center',
      description: 'For an existing Starter or Launch account. Already included on Growth and Scale.',
      monthlyFee: 99,
      onceOffFee: null,
      pricingType: 'monthly',
      active: true,
      sortOrder: 1,
    },
    {
      id: 'large-catalogue',
      name: 'Large product catalogue',
      description: '500+ SKUs or advanced category structures',
      monthlyFee: 199,
      onceOffFee: null,
      pricingType: 'monthly',
      active: true,
      sortOrder: 2,
    },
    {
      id: 'email-campaigns',
      name: 'Advanced email campaigns',
      description: 'Higher-volume newsletter sends and campaign support',
      monthlyFee: 99,
      onceOffFee: null,
      pricingType: 'monthly',
      active: true,
      sortOrder: 3,
    },
    {
      id: 'b2b-module',
      name: 'B2B trade ordering',
      description:
        'Buyer portal with trade pricing, bulk ordering, 2FA security, multi-warehouse stock, and separate B2B order queue',
      monthlyFee: 299,
      onceOffFee: 85000,
      pricingType: 'monthly',
      active: true,
      sortOrder: 5,
    },
    {
      id: 'custom-system',
      name: 'Custom system development',
      description:
        'Reasonable bespoke module on Khana — quoted once-off setup plus monthly partnership (R450/mo is the typical base when custom is included, not stacked on top of Starter/Launch)',
      monthlyFee: 450,
      onceOffFee: 3000,
      pricingType: 'monthly',
      active: true,
      sortOrder: 4,
    },
    {
      id: 'custom-integration',
      name: 'Custom requested integration',
      description: 'Third-party API, ERP, accounting, or payment gateway work (within reason)',
      monthlyFee: null,
      onceOffFee: 2000,
      pricingType: 'once',
      active: true,
      sortOrder: 3,
    },
  ],
  faqs: [
    {
      question: 'How much does Khana cost?',
      answer:
        'Starter is R450/month, Launch R650, Growth R899 and Scale R1,799, plus a once-off setup fee that you can split over 6 months. Custom systems and Enterprise are quoted on scope. Every plan includes monthly WhatsApp/ads credits (unused expire); extra usage is topped up with prepaid credit packs.',
      sortOrder: 0,
    },
    {
      question: 'Do monthly fees include WhatsApp credits?',
      answer:
        'Yes. Starter includes 50 credits/month, Launch 100, Growth 200, and Scale 500. Unused included credits expire at month-end. Prepaid packs never expire and are used after your included balance is finished.',
      sortOrder: 0.5,
    },
    {
      question: "What's included in the setup fee?",
      answer:
        'Setup covers discovery, design, platform configuration, content structure, go-live, and onboarding. Growth and above include store or booking configuration and Revenue Command Center setup. Exact setup is quoted per project.',
      sortOrder: 1,
    },
    {
      question: 'Can I start small and upgrade later?',
      answer:
        'Yes. Starter and Launch already include a store or bookings. Move to Growth when you want revenue tools, and to Scale when you want the store and bookings together.',
      sortOrder: 2,
    },
    {
      question: 'Do you take commission on my sales?',
      answer:
        'No. Khana charges a managed partnership fee (setup + monthly). Payment gateway fees from PayFast, Ozow, or your provider are separate.',
      sortOrder: 3,
    },
    {
      question: 'Which plan is right for a startup?',
      answer:
        'Starter suits new businesses getting online. When you need more pages or are ready to transact online, Launch or Growth is the next step. Request an estimate — we will recommend a tier after a quick scope chat.',
      sortOrder: 4,
    },
    {
      question: 'How does custom system pricing work?',
      answer:
        'Custom development is quoted once-off for setup plus a monthly partnership fee (typically from R450/mo as your platform base while the custom module is included). Optional private standalone API is quoted separately. Scope must be reasonable for us to build and support.',
      sortOrder: 5,
    },
    {
      question: 'Is Khana just a website builder?',
      answer:
        'No. We partner with your business to set up and run a connected system — website, bookings or orders, customers, and WhatsApp/email — not a one-off brochure page that sits separate from how you operate. If you only need a simple static page with no ongoing system, we may not be the right fit.',
      sortOrder: 6,
    },
  ],
  foundingOffer: { ...DEFAULT_FOUNDING_OFFER },
  planBuilder: {
    includedSeats: { ...DEFAULT_PLAN_BUILDER.includedSeats },
    extraSeatMonthlyFee: DEFAULT_PLAN_BUILDER.extraSeatMonthlyFee,
  },
  comparisonFeatures: [
    { label: 'Managed hosting & SSL', starter: true, launch: true, growth: true, scale: true, enterprise: true },
    { label: 'Business website', starter: true, launch: true, growth: true, scale: true, enterprise: true },
    { label: 'Up to 5 pages', starter: true, launch: false, growth: false, scale: false, enterprise: false },
    { label: 'Up to 10 pages + blog', starter: false, launch: true, growth: true, scale: true, enterprise: true },
    { label: 'Online store', starter: true, launch: true, growth: true, scale: true, enterprise: true },
    { label: 'Booking system', starter: true, launch: true, growth: true, scale: true, enterprise: true },
    { label: 'Monthly included credits (expire unused)', starter: '50', launch: '100', growth: '200', scale: '500', enterprise: '500' },
    { label: 'Store + bookings (mixed)', starter: false, launch: false, growth: false, scale: true, enterprise: true },
    { label: 'Revenue Command Center', starter: false, launch: false, growth: true, scale: true, enterprise: true },
    { label: 'Cart recovery', starter: false, launch: false, growth: true, scale: true, enterprise: true },
    { label: 'Customer segments & promos', starter: false, launch: false, growth: true, scale: true, enterprise: true },
    { label: 'Preorder & advanced campaigns', starter: false, launch: false, growth: true, scale: true, enterprise: true },
    { label: 'Custom requested integrations (within reason)', starter: false, launch: false, growth: false, scale: false, enterprise: true },
    { label: 'Guided onboarding', starter: false, launch: false, growth: true, scale: true, enterprise: true },
    { label: 'Dedicated account manager', starter: false, launch: false, growth: false, scale: false, enterprise: true },
  ],
};

function mergeFoundingOffer(src) {
  const o = { ...DEFAULT_FOUNDING_OFFER, ...(src && typeof src === 'object' ? src : {}) };
  const spotsTotal = Math.max(0, Math.round(Number(o.spotsTotal) || 0));
  const spotsTaken = Math.min(spotsTotal, Math.max(0, Math.round(Number(o.spotsTaken) || 0)));
  return {
    enabled: !!o.enabled,
    title: String(o.title || '').slice(0, 80),
    details: String(o.details || '').slice(0, 400),
    spotsTotal,
    spotsTaken,
  };
}

function mergePartnershipPricing(doc) {
  const src = doc && typeof doc.toObject === 'function' ? doc.toObject() : doc || {};
  const defaults = DEFAULT_PARTNERSHIP_PRICING;
  return {
    showPublishedPrices: src.showPublishedPrices ?? defaults.showPublishedPrices,
    currency: src.currency || defaults.currency,
    currencySymbol: src.currencySymbol || defaults.currencySymbol,
    billingNote: src.billingNote ?? defaults.billingNote,
    vatNote: src.vatNote ?? defaults.vatNote,
    tiers: Array.isArray(src.tiers) && src.tiers.length ? src.tiers : defaults.tiers,
    addOns: Array.isArray(src.addOns) && src.addOns.length ? src.addOns : defaults.addOns,
    faqs: Array.isArray(src.faqs) && src.faqs.length ? src.faqs : defaults.faqs,
    comparisonFeatures:
      Array.isArray(src.comparisonFeatures) && src.comparisonFeatures.length
        ? src.comparisonFeatures
        : defaults.comparisonFeatures,
    planBuilder: mergePlanBuilderConfig({ planBuilder: src.planBuilder || defaults.planBuilder }),
    foundingOffer: mergeFoundingOffer(src.foundingOffer),
    pricingConfigVersion: src.pricingConfigVersion ?? defaults.pricingConfigVersion,
    updatedAt: src.updatedAt,
    updatedBy: src.updatedBy,
  };
}

/** Strip numeric fees from public API when marketing uses quote-first pricing. */
function sanitizePublicPricing(config) {
  if (!config || config.showPublishedPrices !== false) return config;
  return {
    ...config,
    tiers: (config.tiers || []).map((t) => ({
      ...t,
      setupFee: null,
      monthlyFee: null,
    })),
    addOns: (config.addOns || []).map((a) => ({
      ...a,
      monthlyFee: null,
      onceOffFee: null,
    })),
  };
}

module.exports = {
  PRICING_CONFIG_VERSION,
  DEFAULT_PARTNERSHIP_PRICING,
  mergePartnershipPricing,
  sanitizePublicPricing,
};
