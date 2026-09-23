/**
 * Khana Cloud API message-template starters.
 * Bodies/variable counts must stay aligned with WhatsAppService notify* senders.
 */

function orderButtonBase() {
  const raw = String(process.env.WHATSAPP_ORDER_BUTTON_BASE || 'https://khanaconnect.onrender.com/orders/').trim();
  return raw.endsWith('/') ? raw : `${raw}/`;
}

/**
 * @returns {Array<{
 *   id: string,
 *   name: string,
 *   language: string,
 *   category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION',
 *   description: string,
 *   components: object[],
 * }>}
 */
function summarizeStarter(starter) {
  const comps = Array.isArray(starter.components) ? starter.components : [];
  const body = comps.find((c) => String(c.type || '').toUpperCase() === 'BODY');
  const header = comps.find((c) => String(c.type || '').toUpperCase() === 'HEADER');
  const footer = comps.find((c) => String(c.type || '').toUpperCase() === 'FOOTER');
  const buttons = comps.find((c) => String(c.type || '').toUpperCase() === 'BUTTONS');
  const firstBtn = Array.isArray(buttons?.buttons) ? buttons.buttons[0] : null;
  const examples = body?.example?.body_text?.[0] || [];
  return {
    id: starter.id,
    name: starter.name,
    language: starter.language,
    category: starter.category,
    description: starter.description,
    header: header?.text || '',
    body: body?.text || '',
    footer: footer?.text || '',
    button_text: firstBtn?.text || '',
    button_url: firstBtn?.url || '',
    body_examples: examples,
  };
}

function listWhatsAppTemplateStarters() {
  const lang = String(process.env.WHATSAPP_TEMPLATE_LANG || 'en_US').trim() || 'en_US';
  const orderBase = orderButtonBase();

  return [
    {
      id: 'order_confirmation',
      name: 'order_confirmation',
      language: lang,
      category: 'UTILITY',
      description: 'Order placed — company, order ref, total + view-order button',
      components: [
        {
          type: 'BODY',
          text: 'Hi! Your order from {{1}} is confirmed.\n\nOrder: {{2}}\nTotal: {{3}}\n\nThank you for shopping with us.',
          example: { body_text: [['Demo Store', 'ORD-78421', 'R249.00']] },
        },
        {
          type: 'BUTTONS',
          buttons: [
            {
              type: 'URL',
              text: 'View order',
              url: `${orderBase}{{1}}`,
              example: ['ORD-78421'],
            },
          ],
        },
      ],
    },
    {
      id: 'order_status_update',
      name: 'order_status_update',
      language: lang,
      category: 'UTILITY',
      description: 'Order status changed — company, order ref, status',
      components: [
        {
          type: 'BODY',
          text: 'Update from {{1}}:\n\nOrder {{2}} is now {{3}}.',
          example: { body_text: [['Demo Store', 'ORD-78421', 'out for delivery']] },
        },
      ],
    },
    {
      id: 'booking_confirmation',
      name: 'booking_confirmation',
      language: lang,
      category: 'UTILITY',
      description: 'Booking confirmed — business, booking ref, when',
      components: [
        {
          type: 'BODY',
          text: 'Your booking with {{1}} is confirmed.\n\nReference: {{2}}\nWhen: {{3}}',
          example: { body_text: [['Demo Salon', 'BK-1001', 'Tue 10:00']] },
        },
      ],
    },
    {
      id: 'booking_reminder',
      name: 'booking_reminder',
      language: lang,
      category: 'UTILITY',
      description: 'Upcoming booking reminder — business, booking ref, when',
      components: [
        {
          type: 'BODY',
          text: 'Reminder from {{1}}:\n\nBooking {{2}} is coming up at {{3}}. See you soon!',
          example: { body_text: [['Demo Salon', 'BK-1001', 'Tue 10:00']] },
        },
      ],
    },
    {
      id: 'account_verification',
      name: 'account_verification',
      language: lang,
      category: 'UTILITY',
      description: 'One-time verification code — brand + code (utility, not Meta AUTH OTP format)',
      components: [
        {
          type: 'BODY',
          text: 'Your {{1}} verification code is {{2}}. Do not share this code with anyone.',
          example: { body_text: [['Khana Connect', '482193']] },
        },
      ],
    },
  ];
}

function getWhatsAppTemplateStarter(idOrName) {
  const key = String(idOrName || '').trim().toLowerCase();
  if (!key) return null;
  return listWhatsAppTemplateStarters().find((s) => s.id === key || s.name === key) || null;
}

function listWhatsAppTemplateStarterSummaries() {
  return listWhatsAppTemplateStarters().map(summarizeStarter);
}

module.exports = {
  listWhatsAppTemplateStarters,
  listWhatsAppTemplateStarterSummaries,
  getWhatsAppTemplateStarter,
  orderButtonBase,
  summarizeStarter,
};
