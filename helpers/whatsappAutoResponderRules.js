/**
 * Keyword rules for delayed WhatsApp auto-replies (Khana's own lead inbox).
 * First matching rule wins.
 *
 * Keep replies short: answer the question in plain words, then ask ONE easy question
 * so the person replies and a human takes over. No forms, no jargon, no walls of text.
 * (Before Nov 2026 every reply ended in a five-question form and a demo pitch; leads found it a lot.)
 */

const DEMO_URL =
  process.env.PUBLIC_DEMO_URL || 'https://khanatechnologies.co.za/demo';

const ASK_BUSINESS = 'What’s your business, and what would you like help with?';

const DEFAULT_RULES = [
  {
    id: 'more_info',
    keywords: [
      'more info',
      'more information',
      'tell me more',
      'more details',
      'send info',
      'send me info',
      'what is this',
      'what do you offer',
      'what do you do',
      'how does it work',
      'explain',
    ],
    reply:
      'Hi, thanks for reaching out.\n\n' +
      'We build your website with online bookings or an online store, and connect it to your WhatsApp and email, so confirmations and reminders go out on their own. Then we host it and look after it.\n\n' +
      ASK_BUSINESS,
  },
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
      'You can try the live demo yourself, no login needed:\n' +
      DEMO_URL +
      '\n\nWhat’s your business? I’ll point you to the part of the demo that fits.',
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
      'It connects to your WhatsApp Business number. When someone books or orders on your site, they get the confirmation on WhatsApp and a reminder they can confirm or reschedule with one tap. You get a WhatsApp on your phone too.\n\n' +
      'What kind of business is it for?',
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
      'Any business that works with appointments: salons, clinics, beauty, wellness, consultations, car washes with time slots. We set up your services and times the way you work.\n\n' +
      'What do you take bookings for?',
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
      'Yes, we do online stores too: your products, checkout, collection or delivery, and order updates on WhatsApp.\n\n' +
      'What do you sell?',
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
      'Yes, we build the website on your own domain and connect it to bookings or orders and your WhatsApp. We host it and keep it updated after launch.\n\n' +
      'Do you have a website at the moment, or would this be your first?',
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
      'Fair question. We don’t charge on results, and we won’t promise more customers, because that depends on your area, pricing and marketing. What we do promise is a site that takes bookings or orders properly, and a team that looks after it.\n\n' +
      'You can see exactly what you’d get here, no login needed:\n' +
      DEMO_URL,
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
      'Plans start at R450 a month, plus a once-off setup fee from R1,999 that you can split over 6 months. No commission on your sales.\n\n' +
      'What’s your business? I’ll tell you which plan fits.',
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
      'Happy to help. What’s the business, and what would you most like sorted: a website, bookings, online orders, or WhatsApp?',
  },
  {
    id: 'greeting',
    keywords: ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'interested'],
    shortOnly: true,
    maxLength: 40,
    reply:
      'Hi, thanks for messaging Khana Technologies. We build websites with bookings or online orders, connected to your WhatsApp.\n\n' +
      'What can we help you with?',
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
  DEMO_URL,
};
