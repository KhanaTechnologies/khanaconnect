/**
 * Keyword rules for delayed WhatsApp auto-replies (lead inbox).
 * First matching rule wins.
 * Every reply ends with a direct close: book a live demo (not a free custom trial).
 */

const CLOSE =
  '\n\nIf you want to see it, reply with:\n' +
  '1) Business name\n' +
  '2) What you do\n' +
  '3) A time that suits you today or tomorrow\n\n' +
  'I’ll send a short live demo link / WhatsApp walkthrough.';

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
      'We don’t do blank free trials because every business needs custom setup (domain, bookings, WhatsApp, etc).\n\n' +
      'What we can do is a quick live demo so you can see the real system first. If it fits, we start setup properly.' +
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
      'We use Meta’s official WhatsApp Cloud API — business inbox, confirmations, and customer replies in one dashboard.\n\n' +
      'Easiest is a short live demo so I can show you on screen how it works for a business like yours.' +
      CLOSE,
  },
  {
    id: 'bookings_types',
    keywords: [
      'what kind of bookings',
      'kind of bookings',
      'what bookings',
      'booking system',
      'appointments',
    ],
    reply:
      'It works for appointment businesses — salons, clinics, car washes with time slots, beauty, wellness, consultations, and similar. We customise it to how you operate.\n\n' +
      'I can show you a live bookings demo in about 10–15 minutes.' +
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
      'What we give you is the system to run smoother: bookings, customer details, and WhatsApp/email updates in one place.\n\n' +
      'Best next step is a live demo so you can judge it yourself before any setup.' +
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
      'Most partnerships start from about R450/month after go-live, plus a once-off setup fee depending on scope. WhatsApp messages use prepaid credits.\n\n' +
      'I’ll give you an exact figure after a quick demo once I know your business.' +
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
      'Happy to help.\n\n' +
      'We set up bookings, customer management, and WhatsApp/email updates so your business is easier to run.\n\n' +
      'Let’s start with a short live demo for your type of business.' +
      CLOSE,
  },
  {
    id: 'greeting',
    keywords: ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'interested'],
    shortOnly: true,
    maxLength: 40,
    reply:
      'Hi, thanks for messaging Khana Technologies.\n\n' +
      'We help SA businesses with websites, bookings/orders, and WhatsApp messaging.\n\n' +
      'If you want to see how it works, I can do a short live demo.' +
      CLOSE,
  },
];

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @returns {{ id: string, reply: string } | null}
 */
function matchAutoReplyRule(body, rules = DEFAULT_RULES) {
  const text = normalizeText(body);
  if (!text) return null;

  for (const rule of rules) {
    if (rule.shortOnly && text.length > (rule.maxLength || 40)) continue;
    const hit = (rule.keywords || []).some((kw) => text.includes(normalizeText(kw)));
    if (hit) {
      return { id: rule.id, reply: rule.reply };
    }
  }
  return null;
}

module.exports = {
  DEFAULT_RULES,
  matchAutoReplyRule,
  normalizeText,
  CLOSE,
};
