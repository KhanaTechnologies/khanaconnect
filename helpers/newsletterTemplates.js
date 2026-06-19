/**
 * Khana Templates — schema-driven newsletter starters for the dashboard builder.
 * Frontend fills blocks from starter layouts and sends composed HTML on preview/send.
 */

const KHANA_COLLECTION = 'Khana Templates';

const NEWSLETTER_TEMPLATES = [
  {
    id: 'blank',
    name: 'Khana Blank Canvas',
    category: 'custom',
    collection: KHANA_COLLECTION,
    description: 'Start from scratch — add any puzzle pieces you like.',
    previewImage: null,
    schema: { fields: [{ key: 'bodyHtml', label: 'Email body HTML', type: 'richtext', maxLength: 500000, required: true }] },
    htmlStructure: '<!-- Builder composes HTML from puzzle pieces -->',
  },
  {
    id: 'khana_hero',
    name: 'Khana Hero',
    category: 'general',
    collection: KHANA_COLLECTION,
    description: 'Hero image, headline, intro text, and a CTA button.',
    previewImage: null,
    schema: { fields: [] },
    htmlStructure: '<!-- image + heading + text + button -->',
    aliases: ['hero_cta'],
  },
  {
    id: 'khana_promo_stack',
    name: 'Khana Promo Stack',
    category: 'sales',
    collection: KHANA_COLLECTION,
    description: 'Stacked promo banners with a shop button at the bottom.',
    previewImage: null,
    schema: { fields: [] },
    htmlStructure: '<!-- heading + images + button -->',
    legacyPromoTemplate: 'one',
    aliases: ['promo_stack'],
  },
  {
    id: 'khana_promotion',
    name: 'Khana Promotion',
    category: 'sales',
    collection: KHANA_COLLECTION,
    description: 'Simple checkout-code promotion — headline, intro, and promo code box.',
    previewImage: null,
    schema: { fields: [] },
    htmlStructure: '<!-- heading + text + promo_code + footer -->',
    aliases: ['promotion', 'checkout_promo'],
  },
  {
    id: 'khana_announcement',
    name: 'Khana Announcement',
    category: 'general',
    collection: KHANA_COLLECTION,
    description: 'Logo, title, message, and read-more link.',
    previewImage: null,
    schema: { fields: [] },
    htmlStructure: '<!-- logo + heading + text + button -->',
    aliases: ['announcement'],
  },
  {
    id: 'khana_product_grid',
    name: 'Khana Product Grid',
    category: 'sales',
    collection: KHANA_COLLECTION,
    description: 'Three products side by side in one row.',
    previewImage: null,
    schema: { fields: [] },
    htmlStructure: '<!-- heading + grid_3 products + button -->',
    aliases: ['product_spotlight'],
  },
  {
    id: 'khana_product_row',
    name: 'Khana Product Duo',
    category: 'sales',
    collection: KHANA_COLLECTION,
    description: 'Two products next to each other in a 2-column grid.',
    previewImage: null,
    schema: { fields: [] },
    htmlStructure: '<!-- heading + grid_2 products + button -->',
  },
  {
    id: 'khana_service_row',
    name: 'Khana Services',
    category: 'bookings',
    collection: KHANA_COLLECTION,
    description: 'Two bookable services in a side-by-side row.',
    previewImage: null,
    schema: { fields: [] },
    htmlStructure: '<!-- heading + grid_2 services -->',
  },
  {
    id: 'khana_image_gallery',
    name: 'Khana Image Gallery',
    category: 'media',
    collection: KHANA_COLLECTION,
    description: 'Three images in a single grid row.',
    previewImage: null,
    schema: { fields: [] },
    htmlStructure: '<!-- heading + grid_3 images -->',
  },
  {
    id: 'khana_mixed_grid',
    name: 'Khana Mixed Grid',
    category: 'general',
    collection: KHANA_COLLECTION,
    description: 'Image, product, and service in one 3-column row.',
    previewImage: null,
    schema: { fields: [] },
    htmlStructure: '<!-- grid_3 mixed cell types -->',
  },
  {
    id: 'khana_welcome',
    name: 'Khana Welcome',
    category: 'general',
    collection: KHANA_COLLECTION,
    description: 'Onboarding email with logo, welcome copy, CTA, and social links.',
    previewImage: null,
    schema: { fields: [] },
    htmlStructure: '<!-- logo + heading + text + button + social -->',
  },
  {
    id: 'khana_story',
    name: 'Khana Story',
    category: 'general',
    collection: KHANA_COLLECTION,
    description: 'Image, customer quote, story text, and CTA.',
    previewImage: null,
    schema: { fields: [] },
    htmlStructure: '<!-- image + quote + text + button -->',
  },
];

function publicTemplate(t) {
  return {
    id: t.id,
    name: t.name,
    category: t.category,
    collection: t.collection || KHANA_COLLECTION,
    description: t.description,
    previewImage: t.previewImage,
    schema: t.schema,
    legacyPromoTemplate: t.legacyPromoTemplate || null,
    aliases: t.aliases || [],
  };
}

function listNewsletterTemplates() {
  return NEWSLETTER_TEMPLATES.map(publicTemplate);
}

function findTemplate(templateId) {
  if (!templateId) return null;
  return NEWSLETTER_TEMPLATES.find(
    (x) => x.id === templateId || (x.aliases || []).includes(templateId)
  );
}

function getNewsletterTemplate(templateId) {
  const t = findTemplate(templateId);
  if (!t) return null;
  return {
    ...publicTemplate(t),
    htmlStructure: t.htmlStructure,
  };
}

function isKnownTemplateId(templateId) {
  return !!findTemplate(templateId);
}

module.exports = {
  listNewsletterTemplates,
  getNewsletterTemplate,
  isKnownTemplateId,
  KHANA_COLLECTION,
};
