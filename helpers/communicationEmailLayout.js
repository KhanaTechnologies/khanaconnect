/**
 * Branded shell for human-written communication: Email Center compose/replies,
 * plan-builder follow-ups, and outreach.
 */

const { buildEmailShell } = require('./emailShell');
const { EMAIL_TOKENS, escapeHtml, resolveEmailBrand } = require('./emailDesignTokens');

function isFullEmailDocument(html) {
  return /^\s*<!DOCTYPE/i.test(String(html || ''));
}

function plainTextToHtmlFragment(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  return `<div style="font-size:15px;line-height:24px;color:${EMAIL_TOKENS.color.text};">${escapeHtml(raw).replace(/\r\n/g, '\n').replace(/\n/g, '<br>')}</div>`;
}

function buildDefaultCommunicationFooter(brandName) {
  const name = escapeHtml(brandName || EMAIL_TOKENS.brand.name);
  return `${name} · You can reply to this email directly`;
}

function buildCommunicationFooterForClient(client = {}) {
  const brand = resolveEmailBrand(client);
  const name = brand.companyName || EMAIL_TOKENS.brand.name;
  let websiteLink = '';
  const returnUrl = String(client.return_url || '').trim();
  if (returnUrl) {
    try {
      const host = new URL(returnUrl).hostname.replace(/^www\./i, '');
      if (host) {
        websiteLink = ` · <a href="${escapeHtml(returnUrl)}" style="color:#2563eb;text-decoration:none;">${escapeHtml(host)}</a>`;
      }
    } catch {
      /* ignore invalid return_url */
    }
  }
  if (!websiteLink && !brand.logoUrl) {
    websiteLink = ` · <a href="https://${EMAIL_TOKENS.brand.website}" style="color:#2563eb;text-decoration:none;">${escapeHtml(EMAIL_TOKENS.brand.website)}</a>`;
  }
  return `${escapeHtml(name)} · Reply to this email${websiteLink}`;
}

/**
 * Same visual shell as transactional emails, tuned for conversational outreach.
 */
function buildKhanaCommunicationEmail({
  subject,
  headline,
  bodyHtml,
  title,
  preheader,
  brandName,
  logoUrl,
  showKhanaLogo,
  footerHtml,
  primaryColor,
  maxWidth = EMAIL_TOKENS.layout.communicationMaxWidth,
}) {
  const displayHeadline = headline || subject || 'Message';
  const resolvedBrand = brandName || EMAIL_TOKENS.brand.name;
  const footer = footerHtml || buildDefaultCommunicationFooter(resolvedBrand);

  return buildEmailShell({
    headline: displayHeadline,
    bodyHtml,
    title: title || displayHeadline,
    preheader: preheader || displayHeadline,
    brandName: resolvedBrand,
    logoUrl,
    showKhanaLogo,
    footerHtml: footer,
    maxWidth,
    primaryColor,
    headlineFontWeight: 400,
  });
}

/**
 * Wrap a compose fragment (after signature merge) in the communication shell.
 * Skips wrapping when the body is already a full HTML document.
 */
function wrapCommunicationEmailBody({ subject, bodyHtml, client, preheader, headline, footerHtml }) {
  if (isFullEmailDocument(bodyHtml)) return bodyHtml;

  const brand = resolveEmailBrand(client || {});
  const companyName = brand.companyName || EMAIL_TOKENS.brand.name;

  return buildKhanaCommunicationEmail({
    subject,
    headline: headline || subject,
    bodyHtml: bodyHtml || '',
    preheader: preheader || subject,
    brandName: companyName,
    logoUrl: brand.logoUrl || undefined,
    showKhanaLogo: !brand.logoUrl,
    footerHtml: footerHtml || buildCommunicationFooterForClient(client || {}),
    primaryColor: brand.primaryColor,
  });
}

function communicationLayoutEnabledForRequest(req) {
  if (process.env.EMAIL_COMPOSE_BRANDED === 'false') return false;
  if (req && req.body && req.body.useBrandedLayout === false) return false;
  return true;
}

module.exports = {
  isFullEmailDocument,
  plainTextToHtmlFragment,
  buildKhanaCommunicationEmail,
  wrapCommunicationEmailBody,
  buildCommunicationFooterForClient,
  communicationLayoutEnabledForRequest,
};
