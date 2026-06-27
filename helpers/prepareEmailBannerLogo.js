const sharp = require('sharp');
const {
  EMAIL_TOKENS,
  brandGradientColorAt,
  bannerLogoGradientSlice,
  sanitizeHexColor,
} = require('./emailDesignTokens');

const DARK_BG_THRESHOLD = 28;
const LOGO_DISPLAY_WIDTH = 200;

function parseHexRgb(hex) {
  const normalized = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function pixelLuminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * White/light email logos: drop dark or colored matte pixels so only the mark remains.
 */
async function isolateLightLogoForeground(buffer, threshold = DARK_BG_THRESHOLD) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let changed = false;

  for (let i = 0; i < data.length; i += ch) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = pixelLuminance(r, g, b);
    const isDark = r <= threshold && g <= threshold && b <= threshold;

    if (isDark || lum < 120) {
      if (data[i + 3] > 0) changed = true;
      if (lum < 40 || isDark) {
        data[i + 3] = 0;
      } else {
        data[i + 3] = Math.round(data[i + 3] * Math.min(1, (lum - 40) / 80));
        changed = true;
      }
    }
  }

  if (!changed) return buffer;

  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: ch },
  })
    .png()
    .toBuffer();
}

async function trimLogoBounds(buffer, sharpOpts) {
  try {
    return await sharp(buffer, sharpOpts).trim({ threshold: 12 }).png().toBuffer();
  } catch (_) {
    return buffer;
  }
}

function buildGradientPlateSvg(width, height, startColor, endColor) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="banner" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="${startColor}"/>
          <stop offset="100%" stop-color="${endColor}"/>
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#banner)"/>
    </svg>`
  );
}

async function compositeLogoOnBannerGradient(buffer, options = {}) {
  const primaryColor = sanitizeHexColor(options.primaryColor, EMAIL_TOKENS.brand.primary);
  const bannerWidth = Number(options.bannerWidth) || EMAIL_TOKENS.layout.transactionalMaxWidth;
  const logoDisplayWidth = Number(options.logoDisplayWidth) || LOGO_DISPLAY_WIDTH;
  const { start, end } = bannerLogoGradientSlice(primaryColor, bannerWidth, logoDisplayWidth);
  const startColor = brandGradientColorAt(start, primaryColor);
  const endColor = brandGradientColorAt(end, primaryColor);
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 1;
  const height = meta.height || 1;
  const plate = buildGradientPlateSvg(width, height, startColor, endColor);
  const logoPng = await sharp(buffer).png().toBuffer();

  return sharp(plate)
    .composite([{ input: logoPng, blend: 'over' }])
    .flatten()
    .png()
    .toBuffer();
}

async function extractTrimmedLogo(buffer, options = {}) {
  const mimetype = String(options.mimetype || '').toLowerCase();
  const originalname = String(options.originalname || '');
  const isSvg = mimetype === 'image/svg+xml' || /\.svg$/i.test(originalname);
  const sharpOpts = isSvg ? { density: 300 } : undefined;

  let working = buffer;
  const meta = await sharp(buffer, sharpOpts).metadata();

  if (isSvg || meta.hasAlpha) {
    working = await sharp(buffer, sharpOpts).ensureAlpha().png().toBuffer();
  } else {
    working = await isolateLightLogoForeground(buffer);
  }

  return trimLogoBounds(working, sharpOpts);
}

/**
 * @param {'storage'|'email'} [options.mode] storage = transparent PNG for dashboard; email = gradient composite for clients
 */
async function prepareEmailBannerLogo(buffer, options = {}) {
  if (!buffer || !buffer.length) return buffer;

  const mode = options.mode === 'storage' ? 'storage' : 'email';

  try {
    const trimmed = await extractTrimmedLogo(buffer, options);
    if (mode === 'storage') {
      return trimmed;
    }
    return await compositeLogoOnBannerGradient(trimmed, options);
  } catch (err) {
    console.warn('prepareEmailBannerLogo: using original image:', err.message);
    return buffer;
  }
}

function emailBannerMatteColor(primaryColor) {
  const { buildBrandGradientFallback } = require('./emailDesignTokens');
  return buildBrandGradientFallback(
    sanitizeHexColor(primaryColor, EMAIL_TOKENS.brand.primary)
  );
}

module.exports = {
  prepareEmailBannerLogo,
  emailBannerMatteColor,
  extractTrimmedLogo,
  compositeLogoOnBannerGradient,
  isolateLightLogoForeground,
};
