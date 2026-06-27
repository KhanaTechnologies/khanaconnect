const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const {
  EMAIL_TOKENS,
  darkenHex,
  resolveKhanaEmailLogoUrl,
  sanitizeHexColor,
} = require('./emailDesignTokens');
const { extractTrimmedLogo } = require('./prepareEmailBannerLogo');
const {
  resolveLocalEmailBannerFileFromImgSrc,
  isHostedEmailBannerLogoUrl,
} = require('./inlineEmailBannerLogo');

const KHANA_LOGO_PATH = path.join(__dirname, '../public/email/khana-logo-white.png');

/** Render width (2× for retina). Stretches to 100% in email HTML. */
const BANNER_RENDER_WIDTH = 1200;
const PADDING_TOP = 80;
const PADDING_BOTTOM = 56;
const LOGO_RENDER_WIDTH = 400;
const TEXT_BANNER_HEIGHT = 160;

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeXml(s) {
  return escapeHtml(s);
}

function buildFullBannerGradientSvg(width, height, primaryColor) {
  const primary = sanitizeHexColor(primaryColor, EMAIL_TOKENS.brand.primary);
  const dark = darkenHex(primary);
  const deep = EMAIL_TOKENS.brand.primaryDeep;

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="kcBannerGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="${deep}"/>
          <stop offset="45%" stop-color="${dark}"/>
          <stop offset="100%" stop-color="${primary}"/>
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#kcBannerGrad)"/>
    </svg>`
  );
}

function buildTextBannerSvg(width, height, primaryColor, brandName) {
  const primary = sanitizeHexColor(primaryColor, EMAIL_TOKENS.brand.primary);
  const dark = darkenHex(primary);
  const deep = EMAIL_TOKENS.brand.primaryDeep;
  const label = escapeXml(String(brandName || EMAIL_TOKENS.brand.name).toUpperCase());

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="kcBannerGrad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="${deep}"/>
          <stop offset="45%" stop-color="${dark}"/>
          <stop offset="100%" stop-color="${primary}"/>
        </linearGradient>
      </defs>
      <rect width="${width}" height="${height}" fill="url(#kcBannerGrad)"/>
      <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle"
        fill="rgba(255,255,255,0.88)" font-family="Arial,Helvetica,sans-serif"
        font-size="26" font-weight="700" letter-spacing="0.16em">${label}</text>
    </svg>`
  );
}

async function fetchRemoteLogoBuffer(src) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(src, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('Image too large');
    return buf;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadLogoBuffer(logoUrl, showKhanaLogo) {
  const trimmed = String(logoUrl || '').trim();
  if (trimmed) {
    const local = resolveLocalEmailBannerFileFromImgSrc(trimmed);
    if (local) {
      return fs.readFileSync(local);
    }
    if (isHostedEmailBannerLogoUrl(trimmed) || /^https?:\/\//i.test(trimmed)) {
      return fetchRemoteLogoBuffer(trimmed);
    }
  }

  if (showKhanaLogo === true) {
    if (fs.existsSync(KHANA_LOGO_PATH)) {
      return fs.readFileSync(KHANA_LOGO_PATH);
    }
    try {
      return await fetchRemoteLogoBuffer(resolveKhanaEmailLogoUrl());
    } catch (_) {
      return null;
    }
  }

  return null;
}

/**
 * Render the full transactional email banner (gradient + centered logo or text).
 * Returns a flattened JPEG — no alpha, safe for Gmail/Outlook.
 */
async function generateEmailBannerImage(options = {}) {
  const primaryColor = sanitizeHexColor(options.primaryColor, EMAIL_TOKENS.brand.primary);
  const brandName = String(options.brandName || EMAIL_TOKENS.brand.name).trim();
  const showKhanaLogo = options.showKhanaLogo === true;
  const logoUrl = String(options.logoUrl || '').trim();

  const logoBuffer = await loadLogoBuffer(logoUrl, showKhanaLogo);

  if (logoBuffer && logoBuffer.length) {
    const trimmed = await extractTrimmedLogo(logoBuffer, {
      originalname: path.basename(logoUrl || 'logo.png'),
    });
    const resized = await sharp(trimmed)
      .resize({ width: LOGO_RENDER_WIDTH, withoutEnlargement: true })
      .png()
      .toBuffer();
    const logoMeta = await sharp(resized).metadata();
    const logoWidth = logoMeta.width || LOGO_RENDER_WIDTH;
    const logoHeight = logoMeta.height || LOGO_RENDER_WIDTH;
    const bannerHeight = PADDING_TOP + logoHeight + PADDING_BOTTOM;
    const gradient = await sharp(buildFullBannerGradientSvg(BANNER_RENDER_WIDTH, bannerHeight, primaryColor))
      .png()
      .toBuffer();
    const left = Math.max(0, Math.round((BANNER_RENDER_WIDTH - logoWidth) / 2));

    return sharp(gradient)
      .composite([{ input: resized, left, top: PADDING_TOP }])
      .jpeg({ quality: 92, mozjpeg: true })
      .toBuffer();
  }

  return sharp(buildTextBannerSvg(BANNER_RENDER_WIDTH, TEXT_BANNER_HEIGHT, primaryColor, brandName))
    .jpeg({ quality: 92, mozjpeg: true })
    .toBuffer();
}

function parseBannerOptionsFromHtml(html) {
  if (!html || typeof html !== 'string') return null;
  const match = html.match(/<tr\b[^>]*data-kc-transactional-banner="1"([^>]*)>/i);
  if (!match) return null;

  const attrs = match[1] || '';
  const readAttr = (name) => {
    const re = new RegExp(`data-kc-${name}\\s*=\\s*"([^"]*)"`, 'i');
    const m = attrs.match(re);
    return m ? m[1] : '';
  };

  return {
    primaryColor: readAttr('primary-color') || undefined,
    logoUrl: readAttr('logo-url') || undefined,
    showKhanaLogo: readAttr('show-khana-logo') === '1',
    brandName: readAttr('brand-name') || undefined,
  };
}

function buildGeneratedBannerRowHtml({ bannerSrc, brandName }) {
  const brand = escapeHtml(brandName || EMAIL_TOKENS.brand.name);
  const pageBg = EMAIL_TOKENS.color.pageBg;
  return `<tr data-kc-transactional-banner="1">
          <td align="center" width="100%" style="padding:0;margin:0;line-height:0;font-size:0;mso-line-height-rule:exactly;background-color:${pageBg};" bgcolor="${pageBg}">
            <img alt="${brand}" src="${bannerSrc}" width="${BANNER_RENDER_WIDTH}" style="display:block;width:100%;max-width:100%;height:auto;margin:0;padding:0;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />
          </td>
        </tr>`;
}

function stripHeadlineRowGradient(html) {
  const pageBg = EMAIL_TOKENS.color.pageBg;
  return html.replace(
    /(<tr data-kc-headline-shell="1">\s*<td align="center" style=")background:[^;]+;padding:0 0 0;(" bgcolor=")[^"]+(">)/i,
    `$1padding:0 0 0;background:${pageBg};$2${pageBg}$3`
  );
}

/**
 * Replace the gradient+logo banner row with a single generated banner image.
 * @param {boolean} [options.bannerPreview] — embed as data URL (dashboard preview)
 */
async function applyEmailBannerImageAsync(html, baseAttachments = [], options = {}) {
  const attachments = Array.isArray(baseAttachments) ? [...baseAttachments] : [];
  if (!html || typeof html !== 'string' || !html.includes('data-kc-transactional-banner="1"')) {
    return { html, attachments };
  }

  const parsed = parseBannerOptionsFromHtml(html) || {};
  const bannerOptions = {
    primaryColor: options.primaryColor || parsed.primaryColor,
    logoUrl: options.logoUrl || parsed.logoUrl,
    showKhanaLogo: options.showKhanaLogo === true || parsed.showKhanaLogo,
    brandName: options.brandName || parsed.brandName,
  };

  try {
    const buffer = await generateEmailBannerImage(bannerOptions);
    // Embed in HTML — avoids Gmail listing the banner as a file attachment.
    const bannerSrc = `data:image/jpeg;base64,${buffer.toString('base64')}`;

    const bannerRow = buildGeneratedBannerRowHtml({
      bannerSrc,
      brandName: bannerOptions.brandName,
    });

    const bannerTrRegex = /<tr\b[^>]*data-kc-transactional-banner="1"[^>]*>[\s\S]*?<\/tr>/i;
    let newHtml = html.replace(bannerTrRegex, bannerRow);
    newHtml = stripHeadlineRowGradient(newHtml);
    return { html: newHtml, attachments };
  } catch (err) {
    console.warn('Email banner image generation skipped:', err.message);
    return { html, attachments };
  }
}

module.exports = {
  generateEmailBannerImage,
  applyEmailBannerImageAsync,
  parseBannerOptionsFromHtml,
  buildGeneratedBannerRowHtml,
  BANNER_RENDER_WIDTH,
};
