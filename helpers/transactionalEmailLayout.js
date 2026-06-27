/**
 * Howler-inspired transactional email shell: full-width gradient banner with logo,
 * white headline card overlapping the banner, and a separate body card below.
 */

const { resolvePublicBaseUrl } = require('./publicBaseUrl');
const {
  EMAIL_TOKENS,
  resolveKhanaEmailLogoUrl: resolveLogoFromTokens,
  buildBrandGradient,
  buildBrandGradientFallback,
  sanitizeHexColor,
} = require('./emailDesignTokens');

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

function renderBannerBrand({ brandName, logoUrl, showKhanaLogo }) {
  const brand = escapeHtml(brandName || EMAIL_TOKENS.brand.name);
  const logo = logoUrl || (showKhanaLogo === true ? resolveKhanaEmailLogoUrl() : '');

  if (logo) {
    return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" align="center" style="margin:0 auto;border:0;border-collapse:collapse;border-spacing:0;mso-table-lspace:0pt;mso-table-rspace:0pt;">
      <tr>
        <td align="center" style="padding:0;margin:0;background:none;background-color:transparent;border:0;line-height:0;font-size:0;mso-line-height-rule:exactly;">
          <img alt="${brand}" src="${escapeHtml(logo)}" width="200" style="width:200px;max-width:78%;height:auto;display:block;margin:0 auto;padding:0;border:0;outline:none;text-decoration:none;background:none;background-color:transparent;-ms-interpolation-mode:bicubic;" />
        </td>
      </tr>
    </table>`;
  }

  return `<p style="margin:0;font-size:13px;letter-spacing:0.16em;text-transform:uppercase;color:rgba(255,255,255,0.88);font-weight:700;">${brand}</p>`;
}

/**
 * @param {object} opts
 * @param {string} opts.headline - Large title in the white headline card (Howler "You've got tickets!")
 * @param {string} opts.bodyHtml - Main content HTML (inside body card)
 * @param {string} [opts.title] - HTML <title> tag
 * @param {string} [opts.preheader] - Hidden preview text
 * @param {string} [opts.brandName] - Shown as logo alt / text fallback in banner
 * @param {string} [opts.logoUrl] - Optional client logo URL
 * @param {boolean} [opts.showKhanaLogo] - Show Khana white logo in banner (Khana-branded emails only)
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
  maxWidth = 560,
  primaryColor,
}) {
  const accent = sanitizeHexColor(primaryColor, EMAIL_TOKENS.brand.primary);
  const gradientCss = buildBrandGradient(accent);
  const gradientFallback = buildBrandGradientFallback(accent);

  const pageTitle = escapeHtml(title || headline || 'Notification');
  const headlineText = escapeHtml(headline || title || 'Notification');
  const bannerBrand = renderBannerBrand({ brandName, logoUrl, showKhanaLogo });
  const defaultFooter = `Copyright © ${new Date().getFullYear()} ${escapeHtml(brandName || EMAIL_TOKENS.brand.name)}`;
  const footer = footerHtml || defaultFooter;
  const resolvedLogo = logoUrl || (showKhanaLogo === true ? resolveKhanaEmailLogoUrl() : '');
  const bannerBrandName = escapeHtml(brandName || EMAIL_TOKENS.brand.name);
  const bannerDataAttrs = [
    'data-kc-transactional-banner="1"',
    `data-kc-primary-color="${escapeHtml(accent)}"`,
    `data-kc-logo-url="${escapeHtml(resolvedLogo)}"`,
    `data-kc-show-khana-logo="${showKhanaLogo === true ? '1' : '0'}"`,
    `data-kc-brand-name="${bannerBrandName}"`,
  ].join(' ');

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${pageTitle}</title>
  <!--[if (mso)|(mso 16)]><style type="text/css">a { text-decoration: none; }</style><![endif]-->
</head>
<body style="margin:0;padding:0;-webkit-font-smoothing:antialiased;background:${EMAIL_TOKENS.color.pageBg};" bgcolor="${EMAIL_TOKENS.color.pageBg}">
  <span style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preheader)}</span>
  <center>
    <table role="presentation" border="0" align="center" cellpadding="0" cellspacing="0" width="100%" style="width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#404d57;font-size:16px;border-spacing:0;mso-table-lspace:0pt;mso-table-rspace:0pt;">
      <tbody>
        <tr ${bannerDataAttrs}>
          <td align="center" style="color:#ffffff;background:${gradientCss};padding:40px 24px 28px;" bgcolor="${gradientFallback}">
            ${bannerBrand}
          </td>
        </tr>
        <tr data-kc-headline-shell="1">
          <td align="center" style="background:${gradientCss};padding:0 0 0;" bgcolor="${gradientFallback}">
            <!--[if (gte mso 9)|(IE)]><table align="center" border="0" cellspacing="0" cellpadding="0" width="${maxWidth}"><tr><td align="center" valign="top" width="${maxWidth}"><![endif]-->
            <table role="presentation" border="0" align="center" cellpadding="0" cellspacing="0" width="100%" style="width:95% !important;max-width:${maxWidth}px;border-radius:8px 8px 0 0;mso-table-lspace:0pt;mso-table-rspace:0pt;border:1px solid #e6e6e6;border-bottom:none;" bgcolor="#ffffff">
              <tbody>
                <tr>
                  <td style="width:24px;"></td>
                  <td style="padding:28px 0 0;">
                    <h1 style="margin:0;font-family:inherit;font-size:24px;font-weight:300;line-height:32px;color:#404d57;text-align:left;">${headlineText}</h1>
                  </td>
                  <td style="width:24px;"></td>
                </tr>
                <tr>
                  <td></td>
                  <td style="padding:16px 0 0;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100% !important;mso-table-lspace:0pt;mso-table-rspace:0pt;">
                      <tr>
                        <td height="1" style="line-height:1px;font-size:1px;background:#e6e6e6;border-collapse:collapse;">&nbsp;</td>
                      </tr>
                    </table>
                  </td>
                  <td></td>
                </tr>
              </tbody>
            </table>
            <!--[if (gte mso 9)|(IE)]></td></tr></table><![endif]-->
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:0;">
            <!--[if (gte mso 9)|(IE)]><table align="center" border="0" cellspacing="0" cellpadding="0" width="${maxWidth}"><tr><td align="center" valign="top" width="${maxWidth}"><![endif]-->
            <table role="presentation" border="0" align="center" cellpadding="0" cellspacing="0" width="100%" style="width:95% !important;max-width:${maxWidth}px;border-radius:0 0 8px 8px;box-shadow:0 1px 0 rgba(0,0,0,0.04);mso-table-lspace:0pt;mso-table-rspace:0pt;border:1px solid #e6e6e6;border-top:none;" bgcolor="#ffffff">
              <tbody>
                <tr>
                  <td style="padding:24px 24px 32px;font-size:15px;line-height:24px;color:#404d57;text-align:left;">
                    ${bodyHtml}
                  </td>
                </tr>
              </tbody>
            </table>
            <!--[if (gte mso 9)|(IE)]></td></tr></table><![endif]-->
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px 16px 32px;">
            <p style="margin:0;font-size:12px;line-height:18px;font-weight:400;color:#818a91;text-align:center;">${footer}</p>
          </td>
        </tr>
      </tbody>
    </table>
  </center>
</body>
</html>`;
}

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
  paragraph,
  infoPanel,
  neutralPanel,
  warnPanel,
  ctaButton,
  signOff,
};
