const sharp = require('sharp');
const {
  EMAIL_TOKENS,
  brandGradientColorAt,
  bannerLogoGradientSlice,
  buildBrandGradientFallback,
  sanitizeHexColor,
} = require('./emailDesignTokens');

const DARK_BG_THRESHOLD = 32;
const WHITE_LOGO_THRESHOLD = 175;
const MATTE_LUMINANCE_MAX = 165;
const LOGO_DISPLAY_WIDTH = 200;
const LOGO_MAX_STORAGE_WIDTH = 400;

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
      } else if (a < 255) {
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

/** Sample pixels to decide whether this is a white mark vs a full-color logo. */
async function analyzeLogoProfile(buffer) {
  const { data } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let blackBg = 0;
  let colorFg = 0;
  let whiteFg = 0;
  let visible = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 16) continue;
    visible += 1;
    const lum = pixelLuminance(r, g, b);
    const sat = pixelSaturation(r, g, b);
    if (r <= DARK_BG_THRESHOLD && g <= DARK_BG_THRESHOLD && b <= DARK_BG_THRESHOLD) {
      blackBg += 1;
      continue;
    }
    if (lum >= WHITE_LOGO_THRESHOLD && sat < 0.25) {
      whiteFg += 1;
      continue;
    }
    if (sat >= 0.1 && lum >= 20) {
      colorFg += 1;
    }
  }

  const isColorLogo = colorFg > Math.max(whiteFg * 0.35, 80);
  const hasDarkBackground = blackBg > visible * 0.12;
  const isWhiteLogo = whiteFg > colorFg * 1.5 && whiteFg > 80;

  return { isColorLogo, hasDarkBackground, isWhiteLogo, visible };
}

/** Remove only solid black/near-black backdrops — keeps gradient fills intact. */
async function keyOutSolidDarkBackground(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let changed = false;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (r <= DARK_BG_THRESHOLD && g <= DARK_BG_THRESHOLD && b <= DARK_BG_THRESHOLD) {
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

async function resizeLogoForStorage(buffer) {
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 0;
  if (!width || width <= LOGO_MAX_STORAGE_WIDTH) return buffer;
  return sharp(buffer)
    .resize({ width: LOGO_MAX_STORAGE_WIDTH, withoutEnlargement: true })
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

function buildGradientPlateSvg(width, height, primaryColor, bannerWidth, logoDisplayWidth) {
  const { start, end } = bannerLogoGradientSlice(primaryColor, bannerWidth, logoDisplayWidth);
  const stops = [];
  const steps = 12;
  for (let i = 0; i <= steps; i += 1) {
    const frac = i / steps;
    const pos = start + frac * (end - start);
    const color = brandGradientColorAt(pos, primaryColor);
    stops.push(`<stop offset="${Math.round(frac * 100)}%" stop-color="${color}"/>`);
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="banner" x1="0%" y1="0%" x2="100%" y2="0%">
          ${stops.join('')}
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#banner)"/>
    </svg>`
  );
}

/** Flatten alpha onto the banner gradient slice so Gmail/Outlook do not paint gray behind PNGs. */
async function compositeLogoOnBannerGradient(buffer, options = {}) {
  const primaryColor = sanitizeHexColor(options.primaryColor, EMAIL_TOKENS.brand.primary);
  const bannerWidth = Number(options.bannerWidth) || EMAIL_TOKENS.layout.transactionalMaxWidth;
  const logoDisplayWidth = Number(options.logoDisplayWidth) || LOGO_DISPLAY_WIDTH;
  const meta = await sharp(buffer).metadata();
  const width = meta.width || 1;
  const height = meta.height || 1;
  const plate = buildGradientPlateSvg(width, height, primaryColor, bannerWidth, logoDisplayWidth);
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

  let working = await sharp(buffer, sharpOpts).ensureAlpha().png().toBuffer();
  const profile = await analyzeLogoProfile(working);

  if (profile.isColorLogo) {
    if (profile.hasDarkBackground) {
      working = await keyOutSolidDarkBackground(working);
    }
  } else if (profile.isWhiteLogo) {
    working = await cleanBannerLogoPixels(working);
  } else if (profile.hasDarkBackground) {
    working = await keyOutSolidDarkBackground(working);
  } else {
    working = await cleanBannerLogoPixels(working);
  }

  working = await trimLogoBounds(working, sharpOpts);
  working = await resizeLogoForStorage(working);
  return working;
}

/**
 * @param {'storage'|'email'} [options.mode]
 *   storage — transparent PNG for Email Center preview / uploads
 *   email   — gradient composite for inbox rendering (no alpha)
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
  return buildBrandGradientFallback(
    sanitizeHexColor(primaryColor, EMAIL_TOKENS.brand.primary)
  );
}

module.exports = {
  prepareEmailBannerLogo,
  emailBannerMatteColor,
  extractTrimmedLogo,
  compositeLogoOnBannerGradient,
  cleanBannerLogoPixels,
  analyzeLogoProfile,
  keyOutSolidDarkBackground,
};
