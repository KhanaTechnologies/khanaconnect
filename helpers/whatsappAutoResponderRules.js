/**

 * Keyword rules for delayed WhatsApp auto-replies (lead inbox).

 * First matching rule wins.

 * Replies always frame WhatsApp as one part of the full Khana system

 * (website, bookings/orders, customers, email + WhatsApp), then close to a demo.

 */



const PLATFORM =

  'website, online bookings/orders, customer list, and WhatsApp + email updates — all in one dashboard';



const ROLE =

  'We’re not a one-off website freelancer — we partner with your business to build and run the full system so customers, bookings/orders, and WhatsApp stay connected.';



const DEMO_URL =

  process.env.PUBLIC_DEMO_URL || 'https://khanatechnologies.co.za/demo';



const DEMO_CTA =

  '\n\nYou can explore the live interactive demo yourself (no login): ' +

  DEMO_URL +

  '\nIt covers the owner dashboard, website, bookings/orders, and more.';



const CLOSE =

  DEMO_CTA +

  '\n\nTo see if we’re a fit, reply with:\n' +

  '1) Business name\n' +

  '2) What you do\n' +

  '3) Are you interested after looking at the demo? (yes/no)\n' +

  '4) How would you like us to help? (website / bookings / orders / WhatsApp / not sure)\n' +

  '5) Do you want the full connected system, or only a simple page?\n\n' +

  'If you’re looking for the full system and you’re interested, reply and we’ll take the next step.';



const DEFAULT_RULES = [

  {

    id: 'trial_demo',

    keywords: [

      'free trial',

      'trial',

      'demo',

      'test it',

      'try it',

      'can i try',

      'trial available',

    ],

    reply:

      'We don’t do blank free trials because every business needs custom setup (domain, website, bookings/orders, WhatsApp, etc).\n\n' +

      ROLE +

      '\n\nExplore the live demo first. If it fits, we start setup properly.' +

      CLOSE,

  },

  {

    id: 'whatsapp_integration',

    keywords: [

      'how does your platform integrate with whatsapp',

      'integrate with whatsapp',

      'whatsapp integrate',

      'how does whatsapp',

      'whatsapp work',

      'connect whatsapp',

    ],

    reply:

      'WhatsApp is built into the bigger system — not a standalone chat tool.\n\n' +

      'You get Meta’s official Cloud API inbox in the same dashboard as your ' +

      PLATFORM +

      '. Booking/order confirmations and customer replies stay linked to the right customer.\n\n' +

      'Easiest is to explore the live demo yourself, then reply if you want us to tailor it to your business.' +

      CLOSE,

  },

  {

    id: 'bookings_types',

    keywords: [

      'what kind of bookings',

      'kind of bookings',

      'what types of bookings',

      'types of bookings',

      'what bookings',

      'booking system',

      'appointments',

    ],

    reply:

      'Bookings work for appointment businesses like salons, clinics, car washes with time slots, beauty, wellness, consultations, and similar. We customise slots and services to how you operate.\n\n' +

      ROLE +

      '\n\nThat sits with your website, customer list, and WhatsApp/email updates — not bookings alone.\n\n' +

      'You can see bookings in the live demo yourself — open the tour and try the bookings flow.' +

      CLOSE,

  },

  {

    id: 'orders_ecommerce',

    keywords: [

      'orders',

      'online orders',

      'order system',

      'takeaways',

      'food orders',

      'menu',

      'ecommerce',

      'e-commerce',

      'online shop',

      'shop online',

    ],

    reply:

      'Yes — we also handle online orders (menus, checkout, status updates), not only appointments.\n\n' +

      'Orders tie into customers, your site, and WhatsApp/email so the whole run of the business stays in one place.\n\n' +

      'Best next step is to explore the live demo for your type of business.' +

      CLOSE,

  },

  {

    id: 'website',

    keywords: [

      'website',

      'web site',

      'landing page',

      'do you build websites',

      'need a website',

      'make a website',

    ],

    reply:

      'Yes — we build/set up the website as part of the partnership, then connect it to bookings or orders, customers, and WhatsApp/email.\n\n' +

      ROLE +

      '\n\nSo you don’t get a pretty site that sits separate from how you actually run the business.\n\n' +

      'Explore the live demo of the full system, then reply if you want to go further.' +

      CLOSE,

  },

  {

    id: 'pay_when_works',

    keywords: [

      'pay when',

      'when i see this works',

      'only pay if',

      'pay if it works',

      'guarantee',

      'uptick in customers',

      'more customers',

      'guaranteed',

    ],

    reply:

      'Fair question.\n\n' +

      'We don’t charge based on results, and we don’t guarantee more customers — that depends on your location, pricing, and marketing.\n\n' +

      ROLE +

      '\n\nWhat we give you is the system to run smoother: ' +

      PLATFORM +

      '.\n\n' +

      'Best next step is the live demo so you can judge it yourself before any setup.' +

      CLOSE,

  },

  {

    id: 'pricing',

    keywords: [

      'how much',

      'pricing',

      'price',

      'cost',

      'monthly',

      'setup fee',

      'what do you charge',

      'charges',

    ],

    reply:

      'Most partnerships start from about R450/month after go-live, plus a once-off setup fee depending on scope (website, bookings/orders, WhatsApp setup, etc). WhatsApp message credits are prepaid separately.\n\n' +

      ROLE +

      '\n\nI’ll give you an exact figure after you’ve looked at the demo and I know your business.' +

      CLOSE,

  },

  {

    id: 'help_business',

    keywords: [

      'thought maybe you could help',

      'can you help',

      'need help',

      'help me',

      'car wash',

      'my business',

      'i have a business',

    ],

    reply:

      'Happy to help — if you’re looking for a real operating system for the business, not just a quick brochure page.\n\n' +

      ROLE +

      '\n\nWe set up the full stack for SA businesses: ' +

      PLATFORM +

      '.\n\n' +

      'Start with the live demo for your type of business, then reply with the details below.' +

      CLOSE,

  },

  {

    id: 'greeting',

    keywords: ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'interested'],

    shortOnly: true,

    maxLength: 40,

    reply:

      'Hi, thanks for messaging Khana Technologies.\n\n' +

      ROLE +

      '\n\nThat means a ' +

      PLATFORM +

      '.\n\n' +

      'If that sounds like what you need, explore the live demo and reply below.' +

      CLOSE,

  },

];



function normalizeText(text) {

  return String(text || '')

    .toLowerCase()

    .replace(/\s+/g, ' ')

    .trim();

}



function escapeRegex(s) {

  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

}



/** Short tokens (hi/hey) must be whole words to avoid matching inside "this", "they", etc. */

function keywordMatches(text, keyword) {

  const kw = normalizeText(keyword);

  if (!kw) return false;

  if (kw.length <= 3) {

    return new RegExp(`(?:^|\\s)${escapeRegex(kw)}(?:\\s|$|[!.?,])`, 'i').test(text);

  }

  return text.includes(kw);

}



/**

 * @returns {{ id: string, reply: string } | null}

 */

function matchAutoReplyRule(body, rules = DEFAULT_RULES) {

  const text = normalizeText(body);

  if (!text) return null;



  for (const rule of rules) {

    if (rule.shortOnly && text.length > (rule.maxLength || 40)) continue;

    const hit = (rule.keywords || []).some((kw) => keywordMatches(text, kw));

    if (hit) {

      return { id: rule.id, reply: rule.reply };

    }

  }

  return null;

}



module.exports = {

  DEFAULT_RULES,

  matchAutoReplyRule,

  keywordMatches,

  normalizeText,

  CLOSE,

  PLATFORM,

  ROLE,

  DEMO_URL,

  DEMO_CTA,

};


