/**
 * Howler-inspired transactional email shell: full-width gradient banner,
 * white headline card overlapping the banner, and a separate body card below.
 * Client logos sit on the white card (not the gradient) to avoid transparency issues.
 */

const { resolvePublicBaseUrl } = require('./publicBaseUrl');
const {
  EMAIL_TOKENS,
  resolveKhanaEmailLogoUrl: resolveLogoFromTokens,
} = require('./emailDesignTokens');
const { buildEmailShell } = require('./emailShell');

const KHANA_EMAIL_LOGO_PATH = EMAIL_TOKENS.brand.logoPath;

function resolveKhanaEmailLogoUrl() {
  return resolveLogoFromTokens();
}

const GRADIENT_CSS = EMAIL_TOKENS.brand.gradientCss;
const GRADIENT_FALLBACK = EMAIL_TOKENS.brand.gradientFallback;

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {object} opts
 * @param {string} opts.headline - Large title in the white headline card
 * @param {string} opts.bodyHtml - Main content HTML (inside body card)
 * @param {string} [opts.title] - HTML <title> tag
 * @param {string} [opts.preheader] - Hidden preview text
 * @param {string} [opts.brandName] - Shown in banner + logo alt text
 * @param {string} [opts.logoUrl] - Client logo (white card header)
 * @param {boolean} [opts.showKhanaLogo] - Khana-branded emails (banner text only)
 * @param {string} [opts.footerHtml] - Footer below cards
 * @param {number} [opts.maxWidth] - Card max width in px
 */
function buildKhanaEmail({
  headline,
  bodyHtml,
  title,
  preheader = '',
  brandName,
  logoUrl,
  showKhanaLogo,
  footerHtml,
  maxWidth = EMAIL_TOKENS.layout.transactionalMaxWidth,
  primaryColor,
}) {
  const defaultFooter = `Copyright © ${new Date().getFullYear()} ${escapeHtml(brandName || EMAIL_TOKENS.brand.name)}`;

  return buildEmailShell({
    headline,
    bodyHtml,
    title,
    preheader,
    brandName,
    logoUrl,
    showKhanaLogo,
    footerHtml: footerHtml || defaultFooter,
    maxWidth,
    primaryColor,
    headlineFontWeight: 300,
  });
}

/** Alias for clarity when distinguishing from communication emails. */
const buildKhanaTransactionalEmail = buildKhanaEmail;

function paragraph(html) {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#404d57;">${html}</p>`;
}

function infoPanel({ title, rows, html }) {
  const inner = html
    ? html
    : (rows || [])
        .map(
          ([label, value]) =>
            `<p style="margin:0 0 8px;font-size:14px;line-height:22px;color:#404d57;"><strong style="color:#111827;">${escapeHtml(label)}:</strong> ${value}</p>`
        )
        .join('');

  const titleBlock = title
    ? `<p style="margin:0 0 12px;font-size:12px;text-transform:uppercase;letter-spacing:0.08em;color:#2563eb;font-weight:700;">${escapeHtml(title)}</p>`
    : '';

  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <tr>
      <td style="padding:16px 18px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;">
        ${titleBlock}${inner}
      </td>
    </tr>
  </table>`;
}

function neutralPanel({ title, html }) {
  const titleBlock = title
    ? `<p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#111827;">${escapeHtml(title)}</p>`
    : '';
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <tr>
      <td style="padding:16px 18px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;">
        ${titleBlock}${html}
      </td>
    </tr>
  </table>`;
}

function warnPanel({ title, html }) {
  const titleBlock = title
    ? `<p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#92400e;">${escapeHtml(title)}</p>`
    : '';
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:0 0 20px;mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <tr>
      <td style="padding:16px 18px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:14px;line-height:22px;color:#92400e;">
        ${titleBlock}${html}
      </td>
    </tr>
  </table>`;
}

function ctaButton({ href, label, fullWidth = true }) {
  const widthStyle = fullWidth ? 'width:100%;' : '';
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:8px 0 20px;${widthStyle}mso-table-lspace:0pt;mso-table-rspace:0pt;">
    <tr>
      <td align="center" bgcolor="${GRADIENT_FALLBACK}" style="border-radius:6px;background:${GRADIENT_CSS};">
        <a href="${escapeHtml(href)}" style="display:block;padding:14px 22px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:6px;text-align:center;line-height:1.2;box-shadow:0 4px 12px rgba(37,99,235,0.25);">${escapeHtml(label)}</a>
      </td>
    </tr>
  </table>`;
}

function signOff(name) {
  return paragraph(`Warm regards,<br /><strong>${escapeHtml(name)}</strong>`);
}

module.exports = {
  KHANA_EMAIL_LOGO_PATH,
  resolveKhanaEmailLogoUrl,
  escapeHtml,
  buildKhanaEmail,
  buildKhanaTransactionalEmail,
  paragraph,
  infoPanel,
  neutralPanel,
  warnPanel,
  ctaButton,
  signOff,
};
