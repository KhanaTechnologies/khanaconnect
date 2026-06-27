const sharp = require('sharp');
const {
  EMAIL_TOKENS,
  buildBrandGradientFallback,
  sanitizeHexColor,
} = require('./emailDesignTokens');

/**
 * Email clients (especially Outlook) render PNG transparency as black on dark
 * gradient banners. Flatten alpha onto the banner matte color so logos blend in.
 */
async function prepareEmailBannerLogo(buffer, options = {}) {
  if (!buffer || !buffer.length) return buffer;

  const matte = sanitizeHexColor(
    options.matteColor,
    buildBrandGradientFallback(options.primaryColor)
  );
  const mimetype = String(options.mimetype || '').toLowerCase();
  const originalname = String(options.originalname || '');
  const isSvg = mimetype === 'image/svg+xml' || /\.svg$/i.test(originalname);

  try {
    const input = sharp(buffer, isSvg ? { density: 300 } : undefined);
    const meta = await input.metadata();

    if (!isSvg && !meta.hasAlpha) {
      return buffer;
    }

    return await sharp(buffer, isSvg ? { density: 300 } : undefined)
      .flatten({ background: matte })
      .png()
      .toBuffer();
  } catch (err) {
    console.warn('prepareEmailBannerLogo: using original image:', err.message);
    return buffer;
  }
}

function emailBannerMatteColor(primaryColor) {
  return buildBrandGradientFallback(
    sanitizeHexColor(primaryColor, EMAIL_TOKENS.brand.primary)
  );
}

module.exports = {
  prepareEmailBannerLogo,
  emailBannerMatteColor,
};
