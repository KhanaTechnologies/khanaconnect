/**
 * Khana Technologies — unified email design tokens.
 * Transactional shell + newsletter builder share typography, colors, and layout rhythm.
 */

const { resolvePublicBaseUrl } = require('./publicBaseUrl');

const KHANA_EMAIL_LOGO_PATH = '/public/email/khana-logo-white.png';
const KHANA_EMAIL_LOGO_VERSION = '5';

const EMAIL_TOKENS = {
  brand: {
    name: 'Khana Technologies',
    productName: 'Khana Connect',
    primary: '#2563eb',
    primaryDark: '#1e3a5f',
    primaryDeep: '#0f172a',
    gradientCss: 'linear-gradient(to right, #0f172a 0%, #1e3a5f 45%, #2563eb 100%)',
    gradientFallback: '#1e3a5f',
    logoPath: KHANA_EMAIL_LOGO_PATH,
    website: 'khanatechnologies.co.za',
  },
  color: {
    pageBg: '#fafafa',
    outerBg: '#f3f4f6',
    cardBg: '#ffffff',
    text: '#404d57',
    textStrong: '#111827',
    textBody: '#374151',
    textMuted: '#6b7280',
    textSubtle: '#9ca3af',
    border: '#e5e7eb',
    borderLight: '#e6e6e6',
    infoBg: '#eff6ff',
    infoBorder: '#bfdbfe',
    panelBg: '#f9fafb',
    warnBg: '#fffbeb',
    warnBorder: '#fde68a',
    warnText: '#92400e',
    buttonText: '#ffffff',
    unsubscribeBtnBg: '#f3f4f6',
    unsubscribeBtnText: '#374151',
    unsubscribeBtnBorder: '#d1d5db',
  },
  font: {
    sans: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
    emailSans: 'Arial,Helvetica,sans-serif',
    serif: 'Georgia,serif',
  },
  layout: {
    transactionalMaxWidth: 560,
    newsletterMaxWidth: 600,
    radius: '8px',
    buttonRadius: '6px',
    headerAccentHeight: '4px',
  },
};

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function resolveKhanaEmailLogoUrl() {
  const override = process.env.KHANA_EMAIL_LOGO_URL;
  if (override && String(override).trim()) return String(override).trim();
  return `${resolvePublicBaseUrl()}${KHANA_EMAIL_LOGO_PATH}?v=${KHANA_EMAIL_LOGO_VERSION}`;
}

function sanitizeHexColor(value, fallback) {
  const v = String(value || '').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return v;
  return fallback;
}

function darkenHex(hex, factor = 0.52) {
  const normalized = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return EMAIL_TOKENS.brand.primaryDark;
  const r = Math.max(0, Math.min(255, Math.round(parseInt(normalized.slice(0, 2), 16) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(parseInt(normalized.slice(2, 4), 16) * factor)));
  const b = Math.max(0, Math.min(255, Math.round(parseInt(normalized.slice(4, 6), 16) * factor)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function buildBrandGradient(primaryColor) {
  const primary = sanitizeHexColor(primaryColor, EMAIL_TOKENS.brand.primary);
  const dark = darkenHex(primary);
  return `linear-gradient(to right, ${EMAIL_TOKENS.brand.primaryDeep} 0%, ${dark} 45%, ${primary} 100%)`;
}

function buildBrandGradientFallback(primaryColor) {
  const primary = sanitizeHexColor(primaryColor, EMAIL_TOKENS.brand.primary);
  return darkenHex(primary);
}

function lerpHexColor(fromHex, toHex, amount) {
  const t = Math.max(0, Math.min(1, Number(amount) || 0));
  const from = parseHexRgb(fromHex);
  const to = parseHexRgb(toHex);
  if (!from || !to) return sanitizeHexColor(toHex, fromHex);
  const mix = (a, b) => Math.round(a + (b - a) * t);
  const r = mix(from.r, to.r);
  const g = mix(from.g, to.g);
  const b = mix(from.b, to.b);
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function parseHexRgb(hex) {
  const normalized = String(hex || '').replace('#', '').trim();
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function brandGradientColorAt(position, primaryColor) {
  const primary = sanitizeHexColor(primaryColor, EMAIL_TOKENS.brand.primary);
  const dark = darkenHex(primary);
  const deep = EMAIL_TOKENS.brand.primaryDeep;
  const t = Math.max(0, Math.min(1, Number(position) || 0));
  if (t <= 0.45) {
    return lerpHexColor(deep, dark, t / 0.45);
  }
  return lerpHexColor(dark, primary, (t - 0.45) / 0.55);
}

/** Horizontal slice of the banner gradient behind a centered logo image. */
function bannerLogoGradientSlice(primaryColor, bannerWidth, logoDisplayWidth) {
  const width = Number(bannerWidth) || EMAIL_TOKENS.layout.transactionalMaxWidth;
  const logoWidth = Number(logoDisplayWidth) || 200;
  const start = (width - logoWidth) / (2 * width);
  const end = (width + logoWidth) / (2 * width);
  return { start, end };
}

/**
 * Resolve client email brand — Khana layout with client logo + accent color.
 * @param {object} client - Client doc or subset
 */
function resolveEmailBrand(client = {}) {
  const companyName = String(client.companyName || '').trim();
  const logoUrl = String(client.emailLogoUrl || client.logoUrl || '').trim();
  const accent =
    sanitizeHexColor(client.emailPrimaryColor, '') ||
    sanitizeHexColor(client.dashboardThemeColor, '') ||
    EMAIL_TOKENS.brand.primary;

  return {
    companyName,
    logoUrl,
    primaryColor: accent,
    khanaName: EMAIL_TOKENS.brand.name,
    khanaProduct: EMAIL_TOKENS.brand.productName,
    khanaLogoUrl: resolveKhanaEmailLogoUrl(),
  };
}

/**
 * Khana accent strip + client logo row for newsletters.
 */
function buildNewsletterBrandHeaderHtml(brand = {}) {
  const company = escapeHtml(brand.companyName || '');
  const logo = String(brand.logoUrl || '').trim();
  const primary = sanitizeHexColor(brand.primaryColor, EMAIL_TOKENS.brand.primary);
  const gradient = EMAIL_TOKENS.brand.gradientCss;
  const font = EMAIL_TOKENS.font.emailSans;

  const logoInner = logo
    ? `<img src="${escapeHtml(logo)}" alt="${company || 'Logo'}" width="180" style="display:block;max-width:180px;height:auto;border:0;margin:0 auto" />`
    : company
      ? `<p style="margin:0;font-family:${font};font-size:15px;font-weight:700;letter-spacing:0.04em;color:${EMAIL_TOKENS.color.textStrong}">${company}</p>`
      : '';

  const clientRow = logoInner
    ? `<tr><td style="padding:20px 24px 12px;text-align:center;background:${EMAIL_TOKENS.color.cardBg}">${logoInner}</td></tr>`
    : '';

  return `<tr data-khana-brand-header="true">
  <td style="padding:0;background:${EMAIL_TOKENS.color.cardBg}">
    <div style="height:${EMAIL_TOKENS.layout.headerAccentHeight};line-height:${EMAIL_TOKENS.layout.headerAccentHeight};background:${gradient};background-color:${EMAIL_TOKENS.brand.gradientFallback};font-size:1px">&nbsp;</div>
  </td>
</tr>
<tr data-khana-brand-header="true">
  <td style="padding:10px 24px 6px;text-align:center;background:${EMAIL_TOKENS.color.cardBg};border-bottom:1px solid ${EMAIL_TOKENS.color.border}">
    <p style="margin:0;font-family:${font};font-size:10px;letter-spacing:0.14em;text-transform:uppercase;color:${primary};font-weight:600">
      ${escapeHtml(EMAIL_TOKENS.brand.productName)}
    </p>
  </td>
</tr>
${clientRow}`;
}

/**
 * Small Khana attribution row above unsubscribe.
 */
function buildNewsletterKhanaAttributionHtml() {
  const font = EMAIL_TOKENS.font.emailSans;
  return `<tr data-khana-attribution="true"><td style="padding:12px 24px 0;text-align:center;font-family:${font};font-size:11px;line-height:1.5;color:${EMAIL_TOKENS.color.textSubtle}">
    Sent via <strong style="color:${EMAIL_TOKENS.color.textMuted}">${escapeHtml(EMAIL_TOKENS.brand.productName)}</strong> · ${escapeHtml(EMAIL_TOKENS.brand.name)}
  </td></tr>`;
}

function buildUnsubscribeFooterRowHtml(link) {
  const font = EMAIL_TOKENS.font.emailSans;
  const { color, layout } = EMAIL_TOKENS;
  return `<tr data-khana-unsubscribe="true"><td style="padding:20px 24px 28px;text-align:center;border-top:1px solid ${color.border}">
    <p style="margin:0 0 12px;font-family:${font};font-size:12px;line-height:1.5;color:${color.textSubtle}">
      You received this email because you are subscribed to our newsletter.
    </p>
    <a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:10px 20px;background:${color.unsubscribeBtnBg};color:${color.unsubscribeBtnText};text-decoration:none;font-family:${font};font-size:13px;font-weight:600;border-radius:${layout.buttonRadius};border:1px solid ${color.unsubscribeBtnBorder}">
      Unsubscribe
    </a>
  </td></tr>`;
}

function buildUnsubscribeFooterTableHtml(link) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" data-khana-unsubscribe="true">
  <tbody>
    ${buildNewsletterKhanaAttributionHtml().replace(/^<tr|<\/tr>$/g, '').trim()}
    ${buildUnsubscribeFooterRowHtml(link).replace(/^<tr|<\/tr>$/g, '').trim()}
  </tbody>
</table>`;
}

module.exports = {
  EMAIL_TOKENS,
  escapeHtml,
  sanitizeHexColor,
  darkenHex,
  buildBrandGradient,
  buildBrandGradientFallback,
  brandGradientColorAt,
  bannerLogoGradientSlice,
  lerpHexColor,
  resolveKhanaEmailLogoUrl,
  resolveEmailBrand,
  buildNewsletterBrandHeaderHtml,
  buildNewsletterKhanaAttributionHtml,
  buildUnsubscribeFooterRowHtml,
  buildUnsubscribeFooterTableHtml,
};
