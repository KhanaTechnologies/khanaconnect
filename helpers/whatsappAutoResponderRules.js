/**
 * Keyword rules for delayed WhatsApp auto-replies (lead inbox).
 * First matching rule wins.
 * Every reply ends with a direct close: ask for details + offer to set up today.
 */

const CLOSE =
  '\n\nReply with:\n' +
  '• Business name\n' +
  '• What you do (e.g. car wash, salon, shop)\n' +
  '• Best email\n\n' +
  'I’ll set up your free trial today and send the login.';

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
      'Yes — free trial is available 👍\n\n' +
      'I can switch it on for you today so you can test bookings/WhatsApp properly.' +
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
      'We use Meta’s official WhatsApp Cloud API — so you get a proper business inbox, confirmations, and customer replies in one dashboard (not an unofficial workaround).\n\n' +
      'Easiest way to see it: I’ll set up your trial and show you on your number.' +
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
      'It works for appointment businesses — salons, clinics, car washes with time slots, beauty, wellness, consultations, and similar. We can also customise it to how you actually operate.\n\n' +
      'Want me to set up a trial with bookings for your business today?' +
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
      'Fair question 👍\n\n' +
      'We don’t charge based on results, and we don’t guarantee more customers — that depends on your location, pricing, and marketing.\n\n' +
      'What we give you is the system to run smoother: bookings, customer details, and WhatsApp/email updates in one place.\n\n' +
      'Best next step is a free trial so you can judge it yourself — I can set that up today.' +
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
      'For many small businesses we also offer a WhatsApp Starter path (setup + monthly + credits).\n\n' +
      'I’ll give you an exact quote once I know your business — and I can start your free trial today while we finalise.' +
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
      'Happy to help 👍\n\n' +
      'We set up bookings, customer management, and WhatsApp/email updates so your business is easier to run.\n\n' +
      'Let’s start with a free trial for your business today.' +
      CLOSE,
  },
  {
    id: 'greeting',
    keywords: ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'interested'],
    shortOnly: true,
    maxLength: 40,
    reply:
      'Hi! Thanks for messaging Khana Technologies 👍\n\n' +
      'We help SA businesses with websites, bookings/orders, and WhatsApp messaging.\n\n' +
      'If you want to try it, I can set up your free trial today.' +
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
