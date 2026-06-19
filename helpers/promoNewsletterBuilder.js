/**
 * Build newsletter builder payload when a checkout promotion should notify subscribers.
 * Sending is done from the dashboard email builder after the merchant reviews the draft.
 */
function buildPromoNewsletterBuilderPayload({
  code,
  discount,
  type,
  promoEmailSubject,
  promoEmailIntro,
  checkoutCodeId,
  companyName,
}) {
  const subject =
    (promoEmailSubject && String(promoEmailSubject).trim().slice(0, 200)) ||
    `New offer — ${code} (${discount}% off)`;

  const intro =
    (promoEmailIntro && String(promoEmailIntro).trim()) ||
    `We just published a new checkout code. Use ${code} at checkout to save ${discount}%.`;

  return {
    status: 'builder',
    message: 'Open the email builder to review and send this promotion to subscribers.',
    builder: {
      templateId: 'khana_promotion',
      subject,
      preheader: `${discount}% off with code ${code}`,
      promo: {
        code: String(code),
        discount: Number(discount),
        type: String(type || 'all'),
        intro,
        scopeLabel: String(type || 'all'),
        checkoutCodeId: checkoutCodeId ? String(checkoutCodeId) : '',
        companyName: companyName || '',
      },
    },
  };
}

module.exports = {
  buildPromoNewsletterBuilderPayload,
};
