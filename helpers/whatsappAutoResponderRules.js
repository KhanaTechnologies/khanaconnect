/**
 * Keyword rules for delayed WhatsApp auto-replies (lead inbox).
 * First matching rule wins. Keep replies short and ask one next question.
 */

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
      'Yes — we can set you up on a free trial 👍\n\n' +
      'Before I create your account, please share:\n' +
      '1) Do you already have a website?\n' +
      '2) What type of business do you run?\n' +
      '3) Would you like WhatsApp integrated, or is email enough for now?\n\n' +
      'Once I have that, I’ll set up your trial and send login details.',
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
      'Great question 👍\n\n' +
      'We use Meta’s official WhatsApp Cloud API. That gives you a business WhatsApp inbox in our dashboard, automated order/booking messages, and the ability to reply to customers (including voice notes & media) — linked to their orders/bookings.\n\n' +
      'It’s customisable for your business. What type of business do you run?',
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
      'Our booking system is built for appointment-based businesses — salons, clinics, beauty, wellness, consultations, classes, car washes with time slots, and similar.\n\n' +
      'You can manage online bookings, staff/services, confirmations, and reminders (including WhatsApp). Because it’s custom-built, we can tweak it to how *your* business works.\n\n' +
      'What kind of business do you run?',
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
      'Good question 👍\n\n' +
      'Payment isn’t based on “when you get more customers.” We don’t guarantee an uptick in sales or bookings — that depends on your location, pricing, marketing, and demand.\n\n' +
      'What we provide is the system to run your business more smoothly: bookings/enquiries, customer details, WhatsApp or email updates, and a dashboard so you’re not juggling chats and notes.\n\n' +
      'Happy to start with a short trial so you can see if it fits before you commit long-term. What type of business do you run?',
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
      'Pricing depends on scope (website, bookings, WhatsApp, etc.). Most partnerships start from about R450/month after go-live, plus a once-off setup fee.\n\n' +
      'WhatsApp messaging uses prepaid credits for the messages you send.\n\n' +
      'If you tell me your business type and whether you need a website, bookings, and/or WhatsApp, I can recommend the right plan.',
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
      'We can set you up with bookings, customer management, and WhatsApp/email updates — but I need to understand how you operate first.\n\n' +
      'Please share:\n' +
      '1) Business name + location\n' +
      '2) Do you already have a website?\n' +
      '3) How do customers book/enquire now?\n' +
      '4) Would you like WhatsApp integrated, or is email enough for now?',
  },
  {
    id: 'greeting',
    keywords: ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'interested'],
    // Only match short messages (handled in matcher)
    shortOnly: true,
    maxLength: 40,
    reply:
      'Hi! Thanks for getting in touch with Khana Technologies 👍\n\n' +
      'We help South African businesses with websites, bookings/orders, and WhatsApp customer messaging.\n\n' +
      'What type of business do you run, and are you looking for a website, bookings, WhatsApp, or all three?',
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
};
