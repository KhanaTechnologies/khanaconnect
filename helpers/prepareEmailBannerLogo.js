const sharp = require('sharp');
const {
  EMAIL_TOKENS,
  buildBrandGradientFallback,
  sanitizeHexColor,
} = require('./emailDesignTokens');

const DARK_BG_THRESHOLD = 32;
const WHITE_LOGO_THRESHOLD = 175;
const MATTE_LUMINANCE_MAX = 165;

function pixelLuminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function pixelSaturation(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return 0;
  return (max - min) / max;
}

function isLogoForeground(r, g, b, a) {
  if (a < 16) return false;
  const lum = pixelLuminance(r, g, b);
  const sat = pixelSaturation(r, g, b);
  if (lum >= WHITE_LOGO_THRESHOLD && sat < 0.2) return true;
  if (sat >= 0.18 && lum >= 40) return true;
  return false;
}

function isMattePixel(r, g, b, a) {
  if (a < 16) return false;
  const lum = pixelLuminance(r, g, b);
  const sat = pixelSaturation(r, g, b);
  if (r <= DARK_BG_THRESHOLD && g <= DARK_BG_THRESHOLD && b <= DARK_BG_THRESHOLD) return true;
  if (sat < 0.12 && lum <= MATTE_LUMINANCE_MAX) return true;
  return false;
}

async function cleanBannerLogoPixels(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let changed = false;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];

    if (isLogoForeground(r, g, b, a)) {
      if (pixelLuminance(r, g, b) >= WHITE_LOGO_THRESHOLD) {
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = 255;
        changed = true;
      }
      continue;
    }

    if (isMattePixel(r, g, b, a) || a > 0) {
      if (data[i + 3] > 0) changed = true;
      data[i + 3] = 0;
    }
  }

  if (!changed) return buffer;

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer();
}

async function trimLogoBounds(buffer, sharpOpts) {
  try {
    return await sharp(buffer, sharpOpts).trim({ threshold: 10 }).png().toBuffer();
  } catch (_) {
    return buffer;
  }
}

async function extractTrimmedLogo(buffer, options = {}) {
  const mimetype = String(options.mimetype || '').toLowerCase();
  const originalname = String(options.originalname || '');
  const isSvg = mimetype === 'image/svg+xml' || /\.svg$/i.test(originalname);
  const sharpOpts = isSvg ? { density: 300 } : undefined;

  let working = await sharp(buffer, sharpOpts).ensureAlpha().png().toBuffer();
  working = await cleanBannerLogoPixels(working);
  return trimLogoBounds(working, sharpOpts);
}

/** Normalize logos to trimmed transparent PNGs — white mark only, no gray/black matte. */
async function prepareEmailBannerLogo(buffer, options = {}) {
  if (!buffer || !buffer.length) return buffer;

  try {
    return await extractTrimmedLogo(buffer, options);
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
  extractTrimmedLogo,
  cleanBannerLogoPixels,
};
