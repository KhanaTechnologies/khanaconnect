const { DEFAULT_PLAN_BUILDER, mergePlanBuilderConfig } = require('./planBuilderPricing');

const PRICING_CONFIG_VERSION = 11;

/** Default partnership pricing for the SA market. */
const DEFAULT_PARTNERSHIP_PRICING = {
  pricingConfigVersion: PRICING_CONFIG_VERSION,
  showPublishedPrices: false,
  currency: 'ZAR',
  currencySymbol: 'R',
  billingNote:
    'Pricing depends on scope and features. Request a personalised estimate for exact setup and monthly fees — most partnerships start from R450/month after go-live. WhatsApp automated alerts use prepaid credits (platform fee per message; Meta may bill your WABA separately).',
  vatNote: '',
  tiers: [
    {
      id: 'starter',
      name: 'Starter',
      tagline: 'Perfect for startups & sole traders',
      description:
        'Get online fast with a professional presence. A good fit when you are launching and need reliability without enterprise pricing.',
      setupFee: 1999,
      monthlyFee: 450,
      setupLabel: 'Setup quoted on enquiry',
      monthlyLabel: 'From R450/mo',
      featured: false,
      active: true,
      sortOrder: 0,
      highlights: [
        'Up to 5-page business website',
        'Online store',
        'Online booking system',
        'WhatsApp order & booking alerts (usage billed)',
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
      setupLabel: 'Setup quoted on enquiry',
      monthlyLabel: 'Quoted on enquiry',
      featured: false,
      active: true,
      sortOrder: 1,
      highlights: [
        'Up to 10-page website',
        'Everything in Starter',
        'Online store & booking system',
        'Blog or news section',
        'SEO-ready structure',
        'Priority email support',
        'Quarterly content update allowance',
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
      setupLabel: 'Setup quoted on enquiry',
      monthlyLabel: 'Quoted on enquiry',
      featured: true,
      active: true,
      sortOrder: 2,
      highlights: [
        'Everything in Launch',
        'Revenue Command Center',
        'Cart recovery & customer segments',
        'Orders & appointment dashboard',
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
      setupLabel: 'Setup quoted on enquiry',
      monthlyLabel: 'Quoted on enquiry',
      featured: false,
      active: true,
      sortOrder: 3,
      highlights: [
        'Everything in Growth',
        'Store + bookings combined',
        'Mixed-business dashboard permissions',
        'Advanced campaigns & preorder tools',
        'Bundles, upsells & social proof',
        'Dedicated onboarding manager',
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
      description: 'Add bookings to a store or products to a booking site',
      monthlyFee: 299,
      onceOffFee: null,
      pricingType: 'monthly',
      active: true,
      sortOrder: 0,
    },
    {
      id: 'revenue-tools',
      name: 'Revenue Command Center',
      description: 'Cart recovery, customer segments, campaigns, and revenue insights (add-on for store or bookings)',
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
        'We quote based on your scope — website size, store, bookings, team seats, and add-ons. Use the plan estimator on our site for a ballpark figure, then book a short call to confirm. Most partnerships start from R450/month after launch.',
      sortOrder: 0,
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
        'Yes. Many partners begin on Starter or Launch and upgrade to Growth or Scale when ready to sell or take bookings. We migrate your existing content into the expanded platform.',
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
  ],
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
    { label: 'Store + bookings (mixed)', starter: false, launch: false, growth: false, scale: true, enterprise: true },
    { label: 'Revenue Command Center', starter: false, launch: false, growth: true, scale: true, enterprise: true },
    { label: 'Cart recovery', starter: false, launch: false, growth: true, scale: true, enterprise: true },
    { label: 'Customer segments & promos', starter: false, launch: false, growth: true, scale: true, enterprise: true },
    { label: 'Preorder & advanced campaigns', starter: false, launch: false, growth: true, scale: true, enterprise: true },
    { label: 'Custom requested integrations (within reason)', starter: false, launch: false, growth: false, scale: false, enterprise: true },
    { label: 'Dedicated account manager', starter: false, launch: false, growth: false, scale: true, enterprise: true },
  ],
};

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
