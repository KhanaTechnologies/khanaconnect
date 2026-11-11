const { publicWhatsappPayload } = require('./whatsappLink');

/** Fields safe to expose without authentication. */
function publicClientPayload(client) {
  if (!client) return null;
  const obj = client.toObject ? client.toObject({ getters: true }) : { ...client };
  const whatsapp = publicWhatsappPayload(obj.whatsapp);
  return {
    clientID: obj.clientID,
    companyName: obj.companyName,
    return_url: obj.return_url || '',
    cancel_url: obj.cancel_url || '',
    whatsapp,
    whatsappChatUrl: whatsapp.chatUrl,
  };
}

/**
 * Who may see the PayFast passphrase in a client payload.
 *  - organisation owner (team session) or the platform owner: yes (settings view)
 *  - storefront API token: only while PAYFAST_LEGACY_STOREFRONT_PASSPHRASE is not 'false',
 *    so storefronts that still sign in the browser keep working until they move to
 *    POST /payments/payfast/checkout. Set it to 'false' once every storefront has moved.
 *  - shopper / B2B buyer / purpose tokens, other team roles: never
 * @returns {{ include: boolean, legacy: boolean }}
 */
function payfastPassphraseAccess(session, env = process.env) {
  if (!session) return { include: false, legacy: false };
  if (session.platformAdmin) return { include: true, legacy: false };
  if (session.member && session.orgRole === 'owner') return { include: true, legacy: false };
  if (session.isApiToken && String(env.PAYFAST_LEGACY_STOREFRONT_PASSPHRASE || '').toLowerCase() !== 'false') {
    return { include: true, legacy: true };
  }
  return { include: false, legacy: false };
}

/**
 * Strip credentials that must never leave the API.
 * PayFast merchant_key stays (it is posted to PayFast in the open checkout form anyway).
 * The PayFast passphrase signs checkouts, so it is removed unless the caller passes
 * { includePayfastPassphrase: true } (owner settings view; see payfastPassphraseAccess).
 * Ad tokens / mailbox password are masked (use dedicated update endpoints to set).
 */
function stripClientSecrets(clientObj, options = {}) {
  if (!clientObj || typeof clientObj !== 'object') return clientObj;
  const out = { ...clientObj };
  delete out.password;
  delete out.token;
  delete out.sessionToken;
  delete out.businessEmailPassword;
  if (!options.includePayfastPassphrase) delete out.passphrase;

  if (out.metaAds && typeof out.metaAds === 'object') {
    out.metaAds = { ...out.metaAds, accessToken: out.metaAds.accessToken ? '[set]' : '' };
  }
  if (out.googleAds && typeof out.googleAds === 'object') {
    out.googleAds = {
      ...out.googleAds,
      apiKey: out.googleAds.apiKey ? '[set]' : '',
      developerToken: out.googleAds.developerToken ? '[set]' : '',
      clientSecret: out.googleAds.clientSecret ? '[set]' : '',
      refreshToken: out.googleAds.refreshToken ? '[set]' : '',
    };
  }
  if (out.tiktokAds && typeof out.tiktokAds === 'object') {
    out.tiktokAds = {
      ...out.tiktokAds,
      accessToken: out.tiktokAds.accessToken ? '[set]' : '',
    };
  }
  if (out.pinterestAds && typeof out.pinterestAds === 'object') {
    out.pinterestAds = {
      ...out.pinterestAds,
      accessToken: out.pinterestAds.accessToken ? '[set]' : '',
    };
  }
  if (out.analyticsConfig?.googleAnalytics) {
    const ga = { ...out.analyticsConfig.googleAnalytics };
    if (ga.apiSecret) ga.apiSecret = '[set]';
    out.analyticsConfig = { ...out.analyticsConfig, googleAnalytics: ga };
  }

  return out;
}

module.exports = { publicClientPayload, stripClientSecrets, payfastPassphraseAccess };
