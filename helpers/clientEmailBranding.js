const { resolveEmailBrand } = require('./emailDesignTokens');

function resolveClientEmailLogoUrl(client) {
  if (!client) return '';
  const url = client.emailLogoUrl ?? client.emailLogo ?? '';
  return String(url || '').trim();
}

function resolveClientEmailPrimaryColor(client) {
  if (!client) return '';
  return resolveEmailBrand(client).primaryColor;
}

/** Branding payload for email send helpers (logo + accent color). */
function brandingForTransactionalEmail(client, formattedClientName) {
  const brand = resolveEmailBrand(client || {});
  const logoUrl = brand.logoUrl || undefined;
  return {
    formattedClientName,
    emailLogoUrl: logoUrl,
    logoUrl,
    emailPrimaryColor: brand.primaryColor,
    primaryColor: brand.primaryColor,
  };
}

/** Client doc → branding object for send* email helpers. */
function clientEmailBrandingPayload(client) {
  if (!client) return '';
  return {
    emailLogoUrl: resolveClientEmailLogoUrl(client),
    emailPrimaryColor: client.emailPrimaryColor || '',
    dashboardThemeColor: client.dashboardThemeColor || '',
  };
}

/**
 * Normalize legacy string logo URL or branding object for wrapBranding().
 * @param {string|object} branding
 */
function normalizeEmailBranding(branding) {
  if (typeof branding === 'string') {
    return { emailLogoUrl: branding.trim() };
  }
  if (!branding || typeof branding !== 'object') return {};
  return {
    emailLogoUrl: String(branding.emailLogoUrl || branding.logoUrl || '').trim(),
    emailPrimaryColor: String(
      branding.emailPrimaryColor || branding.primaryColor || ''
    ).trim(),
    dashboardThemeColor: String(branding.dashboardThemeColor || '').trim(),
  };
}

module.exports = {
  resolveClientEmailLogoUrl,
  resolveClientEmailPrimaryColor,
  brandingForTransactionalEmail,
  clientEmailBrandingPayload,
  normalizeEmailBranding,
};
