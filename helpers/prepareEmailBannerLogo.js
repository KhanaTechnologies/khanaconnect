const sharp = require('sharp');
const {
  EMAIL_TOKENS,
  buildBrandGradientFallback,
  sanitizeHexColor,
} = require('./emailDesignTokens');

const DARK_BG_THRESHOLD = 28;

function parseHexRgb(hex) {
  const normalized = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

/**
 * Email clients render PNG transparency as black on dark gradient banners.
 * Uploaded logos are often JPEG/PNG with an opaque black matte instead of alpha.
 */
async function replaceNearBlackBackground(buffer, matteHex, threshold = DARK_BG_THRESHOLD) {
  const matte = parseHexRgb(matteHex);
  if (!matte) return null;

  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let changed = false;

  for (let i = 0; i < data.length; i += ch) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    const isDark = r <= threshold && g <= threshold && b <= threshold;
    const isTransparent = a < 16;

    if (isTransparent || isDark) {
      data[i] = matte.r;
      data[i + 1] = matte.g;
      data[i + 2] = matte.b;
      data[i + 3] = 255;
      if (isDark && !isTransparent) changed = true;
    }
  }

  if (!changed) return null;

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: ch },
  })
    .png()
    .toBuffer();
}

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
    const meta = await sharp(buffer, isSvg ? { density: 300 } : undefined).metadata();
    const sharpOpts = isSvg ? { density: 300 } : undefined;

    if (isSvg || meta.hasAlpha) {
      return await sharp(buffer, sharpOpts)
        .flatten({ background: matte })
        .png()
        .toBuffer();
    }

    const replaced = await replaceNearBlackBackground(buffer, matte);
    return replaced || buffer;
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
  replaceNearBlackBackground,
};
