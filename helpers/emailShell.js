/**
 * Shared Khana email HTML shell — gradient banner, headline card, body card, footer.
 * Used by transactional and communication email layouts.
 */

const {
  EMAIL_TOKENS,
  escapeHtml,
  buildBrandGradient,
  buildBrandGradientFallback,
  sanitizeHexColor,
} = require('./emailDesignTokens');

/** Brand name on the gradient strip — no images (avoids transparency issues). */
function renderBannerLabel({ brandName }) {
  const brand = escapeHtml(brandName || EMAIL_TOKENS.brand.name);
  return `<p style="margin:0;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;color:rgba(255,255,255,0.92);font-weight:700;">${brand}</p>`;
}

/** Client logo in the white card header — renders reliably on a solid background. */
function renderCardLogo({ brandName, logoUrl }) {
  const logo = String(logoUrl || '').trim();
  if (!logo) return '';
  const brand = escapeHtml(brandName || 'Logo');
  return `<table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 4px;border:0;border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;">
      <tr>
        <td align="left" style="padding:0 0 16px;line-height:0;font-size:0;mso-line-height-rule:exactly;">
          <img alt="${brand}" src="${escapeHtml(logo)}" width="160" style="display:block;max-width:160px;width:100%;height:auto;margin:0;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" data-kc-email-logo="1" />
        </td>
      </tr>
    </table>`;
}

/**
 * @param {object} opts
 * @param {string} opts.headline - Large title in the white headline card
 * @param {string} opts.bodyHtml - Main content HTML (inside body card)
 * @param {string} [opts.title] - HTML <title> tag
 * @param {string} [opts.preheader] - Hidden preview text
 * @param {string} [opts.brandName] - Shown in banner + logo alt text
 * @param {string} [opts.logoUrl] - Client logo (white card header)
 * @param {boolean} [opts.showKhanaLogo] - Khana-branded emails (banner text when no client logo)
 * @param {string} [opts.footerHtml] - Footer below cards
 * @param {number} [opts.maxWidth] - Card max width in px
 * @param {number} [opts.headlineFontWeight] - Headline font weight (300 transactional, 400 communication)
 */
function buildEmailShell({
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
  headlineFontWeight = 300,
}) {
  const accent = sanitizeHexColor(primaryColor, EMAIL_TOKENS.brand.primary);
  const gradientCss = buildBrandGradient(accent);
  const gradientFallback = buildBrandGradientFallback(accent);

  const pageTitle = escapeHtml(title || headline || 'Notification');
  const headlineText = escapeHtml(headline || title || 'Notification');
  const displayBrand = brandName || (showKhanaLogo === true ? EMAIL_TOKENS.brand.name : '');
  const bannerLabel = renderBannerLabel({ brandName: displayBrand });
  const cardLogo = renderCardLogo({ brandName: displayBrand, logoUrl });
  const footer = footerHtml || '';

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
    <table role="presentation" border="0" align="center" cellpadding="0" cellspacing="0" width="100%" style="width:100%;font-family:${EMAIL_TOKENS.font.sans};color:${EMAIL_TOKENS.color.text};font-size:16px;border-spacing:0;mso-table-lspace:0pt;mso-table-rspace:0pt;">
      <tbody>
        <tr>
          <td align="center" style="color:#ffffff;background:${gradientCss};padding:28px 24px 24px;" bgcolor="${gradientFallback}">
            ${bannerLabel}
          </td>
        </tr>
        <tr>
          <td align="center" style="background:${gradientCss};padding:0 0 0;" bgcolor="${gradientFallback}">
            <!--[if (gte mso 9)|(IE)]><table align="center" border="0" cellspacing="0" cellpadding="0" width="${maxWidth}"><tr><td align="center" valign="top" width="${maxWidth}"><![endif]-->
            <table role="presentation" border="0" align="center" cellpadding="0" cellspacing="0" width="100%" style="width:95% !important;max-width:${maxWidth}px;border-radius:8px 8px 0 0;mso-table-lspace:0pt;mso-table-rspace:0pt;border:1px solid ${EMAIL_TOKENS.color.borderLight};border-bottom:none;" bgcolor="#ffffff">
              <tbody>
                <tr>
                  <td style="width:24px;"></td>
                  <td style="padding:28px 0 0;">
                    ${cardLogo}
                    <h1 style="margin:0;font-family:inherit;font-size:24px;font-weight:${headlineFontWeight};line-height:32px;color:${EMAIL_TOKENS.color.text};text-align:left;">${headlineText}</h1>
                  </td>
                  <td style="width:24px;"></td>
                </tr>
                <tr>
                  <td></td>
                  <td style="padding:16px 0 0;">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100% !important;mso-table-lspace:0pt;mso-table-rspace:0pt;">
                      <tr>
                        <td height="1" style="line-height:1px;font-size:1px;background:${EMAIL_TOKENS.color.borderLight};border-collapse:collapse;">&nbsp;</td>
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
            <table role="presentation" border="0" align="center" cellpadding="0" cellspacing="0" width="100%" style="width:95% !important;max-width:${maxWidth}px;border-radius:0 0 8px 8px;box-shadow:0 1px 0 rgba(0,0,0,0.04);mso-table-lspace:0pt;mso-table-rspace:0pt;border:1px solid ${EMAIL_TOKENS.color.borderLight};border-top:none;" bgcolor="#ffffff">
              <tbody>
                <tr>
                  <td style="padding:24px 24px 32px;font-size:15px;line-height:24px;color:${EMAIL_TOKENS.color.text};text-align:left;">
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

module.exports = {
  buildEmailShell,
  renderBannerLabel,
  renderCardLogo,
};
