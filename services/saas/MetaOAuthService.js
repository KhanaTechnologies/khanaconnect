const axios = require('axios');
const jwt = require('jsonwebtoken');
const Client = require('../../models/client');
const { getJwtSecret } = require('../../helpers/jwtSecret');

const META_GRAPH_BASE = process.env.META_GRAPH_BASE || 'https://graph.facebook.com/v21.0';
const META_APP_ID = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '';
const META_APP_SECRET = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '';

function resolveOAuthRedirectUri() {
  if (process.env.META_OAUTH_REDIRECT_URI) {
    return String(process.env.META_OAUTH_REDIRECT_URI).trim();
  }
  const base = (process.env.API_PUBLIC_URL || process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || '')
    .replace(/\/$/, '');
  if (!base) return '';
  const api = (process.env.API_URL || '/api/v1').replace(/\/$/, '');
  return `${base}${api}/saas/meta/oauth/callback`;
}

const META_OAUTH_REDIRECT_URI = resolveOAuthRedirectUri();
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://khanatechnologies.co.za').replace(/\/$/, '');

const OAUTH_SCOPES = [
  'public_profile',
  'email',
  'pages_show_list',
  'pages_read_engagement',
  'business_management',
  'ads_read',
  'ads_management',
].join(',');

function isConfigured() {
  return Boolean(META_APP_ID && META_APP_SECRET && META_OAUTH_REDIRECT_URI);
}

function dashboardReturnUrl(query = '') {
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return `${DASHBOARD_URL}/dashboard/meta-ads${q}`;
}

function signState(clientId) {
  return jwt.sign(
    { purpose: 'meta_oauth', clientId: String(clientId) },
    getJwtSecret(),
    { expiresIn: '15m' }
  );
}

function verifyState(state) {
  const decoded = jwt.verify(String(state || ''), getJwtSecret());
  if (decoded.purpose !== 'meta_oauth' || !decoded.clientId) {
    throw new Error('Invalid OAuth state');
  }
  return String(decoded.clientId);
}

function buildAuthorizeUrl(clientId) {
  if (!isConfigured()) {
    throw new Error(
      'Meta OAuth is not configured on the server (META_APP_ID, META_APP_SECRET, META_OAUTH_REDIRECT_URI)'
    );
  }
  const params = new URLSearchParams({
    client_id: META_APP_ID,
    redirect_uri: META_OAUTH_REDIRECT_URI,
    state: signState(clientId),
    scope: OAUTH_SCOPES,
    response_type: 'code',
  });
  return `https://www.facebook.com/v21.0/dialog/oauth?${params.toString()}`;
}

async function graphGet(path, accessToken, params = {}) {
  const { data } = await axios.get(`${META_GRAPH_BASE}${path}`, {
    params: { access_token: accessToken, ...params },
    timeout: 20000,
  });
  return data;
}

async function exchangeCodeForToken(code) {
  const { data } = await axios.get(`${META_GRAPH_BASE}/oauth/access_token`, {
    params: {
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      redirect_uri: META_OAUTH_REDIRECT_URI,
      code: String(code),
    },
    timeout: 20000,
  });
  if (!data?.access_token) {
    throw new Error('Meta did not return an access token');
  }
  return data.access_token;
}

async function exchangeLongLivedToken(shortToken) {
  const { data } = await axios.get(`${META_GRAPH_BASE}/oauth/access_token`, {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: META_APP_ID,
      client_secret: META_APP_SECRET,
      fb_exchange_token: shortToken,
    },
    timeout: 20000,
  });
  return {
    accessToken: data?.access_token || shortToken,
    expiresIn: Number(data?.expires_in) || null,
  };
}

async function completeOAuth({ code, state }) {
  if (!code) throw new Error('Missing authorization code');
  const clientId = verifyState(state);
  const shortToken = await exchangeCodeForToken(code);
  const { accessToken, expiresIn } = await exchangeLongLivedToken(shortToken);

  const me = await graphGet('/me', accessToken, { fields: 'id,name,email' });
  const pagesRes = await graphGet('/me/accounts', accessToken, {
    fields: 'id,name,access_token,category',
    limit: 25,
  });
  const pages = Array.isArray(pagesRes?.data) ? pagesRes.data : [];
  const page = pages[0] || null;

  let adAccountId = '';
  let adAccountName = '';
  try {
    const adRes = await graphGet('/me/adaccounts', accessToken, {
      fields: 'id,name,account_id,account_status',
      limit: 25,
    });
    const accounts = Array.isArray(adRes?.data) ? adRes.data : [];
    const active = accounts.find((a) => Number(a.account_status) === 1) || accounts[0];
    if (active) {
      adAccountId = String(active.account_id || active.id || '').replace(/^act_/i, '');
      adAccountName = active.name || '';
    }
  } catch (err) {
    console.warn('[meta oauth] ad accounts fetch failed:', err.message);
  }

  let pixelId = '';
  if (adAccountId) {
    try {
      const pixRes = await graphGet(`/act_${adAccountId}/adspixels`, accessToken, {
        fields: 'id,name',
        limit: 10,
      });
      const pixels = Array.isArray(pixRes?.data) ? pixRes.data : [];
      if (pixels[0]?.id) pixelId = String(pixels[0].id);
    } catch (err) {
      console.warn('[meta oauth] pixels fetch failed:', err.message);
    }
  }

  const client = await Client.findOne({ clientID: clientId });
  if (!client) throw new Error('Client not found');

  if (!client.metaAds || typeof client.metaAds !== 'object') {
    client.metaAds = {};
  }

  client.metaAds.accessToken = accessToken;
  client.metaAds.connectedAt = new Date();
  client.metaAds.connectedUserId = me?.id ? String(me.id) : '';
  client.metaAds.connectedUserName = me?.name ? String(me.name) : '';
  client.metaAds.connectionMethod = 'oauth';
  client.metaAds.ownershipType = 'client';
  client.metaAds.enabled = true;
  client.metaAds.status = 'active';
  client.metaAds.errorMessage = '';
  client.metaAds.lastSync = new Date();
  client.metaAds.tokenExpiresAt = expiresIn
    ? new Date(Date.now() + expiresIn * 1000)
    : null;

  if (page) {
    client.metaAds.pageId = String(page.id);
    client.metaAds.pageName = String(page.name || '');
    client.metaAds.pageAccessToken = page.access_token ? String(page.access_token) : '';
  }

  if (adAccountId) {
    client.metaAds.adAccountId = adAccountId;
    client.metaAds.adAccountName = adAccountName;
  }

  if (pixelId) {
    client.metaAds.pixelId = pixelId;
  }

  client.markModified('metaAds');
  await client.save();

  return {
    clientId,
    connectedUserName: client.metaAds.connectedUserName,
    pageName: client.metaAds.pageName,
    adAccountName: client.metaAds.adAccountName,
    hasPixel: !!pixelId,
  };
}

async function getConnectionStatus(clientId) {
  const client = await Client.findOne({ clientID: clientId }).select('metaAds').lean();
  if (!client?.metaAds) {
    return { connected: false, configured: isConfigured() };
  }
  const m = client.metaAds;
  const connected = Boolean(m.connectionMethod === 'oauth' && m.connectedUserId && m.accessToken);

  if (connected) {
    try {
      const MetaAdsService = require('./MetaAdsService');
      const fullClient = await Client.findOne({ clientID: clientId });
      if (fullClient) {
        await MetaAdsService.refreshTokenIfNeeded(fullClient);
        const refreshed = await Client.findOne({ clientID: clientId }).select('metaAds').lean();
        if (refreshed?.metaAds) {
          Object.assign(m, refreshed.metaAds);
        }
      }
    } catch (err) {
      console.warn('[meta oauth] status refresh skipped:', err.message);
    }
  }

  return {
    connected,
    configured: isConfigured(),
    connectionMethod: m.connectionMethod || 'manual',
    connectedAt: m.connectedAt || null,
    connectedUserName: m.connectedUserName || '',
    pageId: m.pageId || '',
    pageName: m.pageName || '',
    adAccountId: m.adAccountId || '',
    adAccountName: m.adAccountName || '',
    pixelConfigured: !!m.pixelId,
    enabled: !!m.enabled,
    status: m.status || 'inactive',
    errorMessage: m.errorMessage || '',
    tokenExpiresAt: m.tokenExpiresAt || null,
  };
}

async function disconnect(clientId) {
  const client = await Client.findOne({ clientID: clientId });
  if (!client) throw new Error('Client not found');

  if (!client.metaAds || typeof client.metaAds !== 'object') {
    client.metaAds = {};
  }

  client.metaAds.accessToken = '';
  client.metaAds.pageAccessToken = '';
  client.metaAds.connectedAt = null;
  client.metaAds.connectedUserId = '';
  client.metaAds.connectedUserName = '';
  client.metaAds.pageId = '';
  client.metaAds.pageName = '';
  client.metaAds.adAccountName = '';
  client.metaAds.connectionMethod = '';
  client.metaAds.tokenExpiresAt = null;
  client.metaAds.enabled = false;
  client.metaAds.status = 'inactive';
  client.metaAds.errorMessage = '';
  client.metaAds.lastSync = new Date();

  client.markModified('metaAds');
  await client.save();

  return { disconnected: true };
}

module.exports = {
  isConfigured,
  buildAuthorizeUrl,
  completeOAuth,
  getConnectionStatus,
  disconnect,
  dashboardReturnUrl,
  verifyState,
};
