const { applyEmailBannerImageAsync } = require('./emailBannerImage');
const { inlineEmailBannerLogosAsync } = require('./inlineEmailBannerLogo');

/** Generate banner image + inline remaining public logo assets before send. */
async function prepareTransactionalEmailHtml(html, baseAttachments = [], options = {}) {
  const { html: withBanner, attachments: bannerAttachments } = await applyEmailBannerImageAsync(
    html,
    baseAttachments,
    options
  );
  return inlineEmailBannerLogosAsync(withBanner, bannerAttachments, options);
}

module.exports = {
  prepareTransactionalEmailHtml,
  applyEmailBannerImageAsync,
};
