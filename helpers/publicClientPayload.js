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
 * Strip credentials that must never leave the API.
 * PayFast merchant_key/passphrase stay for the owner's account UI.
 * Ad tokens / mailbox password are masked (use dedicated update endpoints to set).
 */
function stripClientSecrets(clientObj) {
  if (!clientObj || typeof clientObj !== 'object') return clientObj;
  const out = { ...clientObj };
  delete out.password;
  delete out.token;
  delete out.sessionToken;
  delete out.businessEmailPassword;

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

module.exports = { publicClientPayload, stripClientSecrets };
