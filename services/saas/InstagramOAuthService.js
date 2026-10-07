const axios = require('axios');
const jwt = require('jsonwebtoken');
const Client = require('../../models/client');
const { getJwtSecret } = require('../../helpers/jwtSecret');
const { recordEventSafe } = require('./ApiMonitorService');

/**
 * Business Login for Instagram (Instagram API with Instagram Login).
 * No Facebook Page required — Professional IG accounts only.
 * @see https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login
 */

const IG_APP_ID = (
  process.env.META_INSTAGRAM_APP_ID ||
  process.env.INSTAGRAM_APP_ID ||
  process.env.META_APP_ID ||
  process.env.FACEBOOK_APP_ID ||
  ''
).trim();

const IG_APP_SECRET = (
  process.env.META_INSTAGRAM_APP_SECRET ||
  process.env.INSTAGRAM_APP_SECRET ||
  process.env.META_APP_SECRET ||
  process.env.FACEBOOK_APP_SECRET ||
  ''
).trim();

const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://khanatechnologies.co.za').replace(/\/$/, '');
const IG_GRAPH_BASE = process.env.META_INSTAGRAM_GRAPH_BASE || 'https://graph.instagram.com';
const IG_GRAPH_VERSION = process.env.META_INSTAGRAM_GRAPH_VERSION || 'v25.0';

const IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
].join(',');

function resolveInstagramOAuthRedirectUri() {
  // Must match App Dashboard → Instagram → API setup with Instagram login →
  // Business login settings → OAuth redirect URIs EXACTLY (incl. trailing slash).
  if (process.env.META_INSTAGRAM_OAUTH_REDIRECT_URI) {
    return String(process.env.META_INSTAGRAM_OAUTH_REDIRECT_URI).trim();
  }
  const base = (
    process.env.API_PUBLIC_URL ||
    process.env.PUBLIC_API_URL ||
    process.env.BASE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    'https://khanaconnect.onrender.com'
  ).replace(/\/$/, '');
  const api = (process.env.API_URL || '/api/v1').replace(/\/$/, '');
  // Meta often appends a trailing slash when you save the URI — default with slash.
  return `${base}${api}/saas/meta/instagram/oauth/callback/`;
}

const IG_OAUTH_REDIRECT_URI = resolveInstagramOAuthRedirectUri();

function isConfigured() {
  return Boolean(IG_APP_ID && IG_APP_SECRET && IG_OAUTH_REDIRECT_URI);
}

function dashboardReturnUrl(query = '') {
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : '';
  return `${DASHBOARD_URL}/dashboard/meta-ads${q}`;
}

function signState(clientId) {
  return jwt.sign(
    { purpose: 'instagram_oauth', clientId: String(clientId) },
    getJwtSecret(),
    { expiresIn: '15m' }
  );
}

function verifyState(state) {
  const decoded = jwt.verify(String(state || ''), getJwtSecret());
  if (decoded.purpose !== 'instagram_oauth' || !decoded.clientId) {
    throw new Error('Invalid Instagram OAuth state');
  }
  return String(decoded.clientId);
}

function buildAuthorizeUrl(clientId) {
  if (!isConfigured()) {
    throw new Error(
      'Instagram Login is not configured (META_INSTAGRAM_APP_ID / META_APP_ID, secret, redirect URI)'
    );
  }
  const params = new URLSearchParams({
    client_id: IG_APP_ID,
    redirect_uri: IG_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: IG_SCOPES,
    state: signState(clientId),
  });
  return `https://www.instagram.com/oauth/authorize?${params.toString()}`;
}

function getAuthorizeDebug() {
  return {
    configured: isConfigured(),
    appId: IG_APP_ID || null,
    redirectUri: IG_OAUTH_REDIRECT_URI,
    scopes: IG_SCOPES.split(','),
    graphBase: `${IG_GRAPH_BASE}/${IG_GRAPH_VERSION}`,
  };
}

async function exchangeCodeForShortToken(code) {
  const cleaned = String(code || '').replace(/#_+$/, '').trim();
  const body = new URLSearchParams({
    client_id: IG_APP_ID,
    client_secret: IG_APP_SECRET,
    grant_type: 'authorization_code',
    redirect_uri: IG_OAUTH_REDIRECT_URI,
    code: cleaned,
  });
  const { data } = await axios.post('https://api.instagram.com/oauth/access_token', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 25000,
  });
  const accessToken = data?.access_token;
  const userId = data?.user_id != null ? String(data.user_id) : '';
  const permissions = data?.permissions
    ? Array.isArray(data.permissions)
      ? data.permissions.map(String)
      : String(data.permissions)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
    : [];
  if (!accessToken) throw new Error('Instagram did not return an access token');
  return { accessToken, userId, permissions };
}

async function exchangeLongLivedToken(shortToken) {
  const { data } = await axios.get(`${IG_GRAPH_BASE}/access_token`, {
    params: {
      grant_type: 'ig_exchange_token',
      client_secret: IG_APP_SECRET,
      access_token: shortToken,
    },
    timeout: 25000,
  });
  return {
    accessToken: data?.access_token || shortToken,
    expiresIn: Number(data?.expires_in) || 60 * 24 * 60 * 60,
  };
}

async function refreshLongLivedToken(token) {
  const { data } = await axios.get(`${IG_GRAPH_BASE}/refresh_access_token`, {
    params: {
      grant_type: 'ig_refresh_token',
      access_token: token,
    },
    timeout: 25000,
  });
  return {
    accessToken: data?.access_token || token,
    expiresIn: Number(data?.expires_in) || 60 * 24 * 60 * 60,
  };
}

async function igGraphGet(path, accessToken, params = {}) {
  const url = path.startsWith('http')
    ? path
    : `${IG_GRAPH_BASE}/${IG_GRAPH_VERSION}${path.startsWith('/') ? path : `/${path}`}`;
  const { data } = await axios.get(url, {
    params: { access_token: accessToken, ...params },
    timeout: 25000,
  });
  return data;
}

async function fetchIgProfile(accessToken) {
  try {
    return await igGraphGet('/me', accessToken, {
      fields: 'user_id,username,name,account_type,profile_picture_url',
    });
  } catch (err) {
    // Older field set
    return igGraphGet('/me', accessToken, {
      fields: 'id,username,name,account_type',
    });
  }
}

async function completeOAuth({ code, state }) {
  const started = Date.now();
  let clientId = '';
  try {
    if (!code) throw new Error('Missing authorization code');
    clientId = verifyState(state);
    const short = await exchangeCodeForShortToken(code);
    const { accessToken, expiresIn } = await exchangeLongLivedToken(short.accessToken);
    const profile = await fetchIgProfile(accessToken);
    const igUserId =
      String(profile?.user_id || profile?.id || short.userId || '').trim();
    const igUsername = String(profile?.username || '').trim();

    if (!igUserId) {
      throw new Error('Instagram did not return a professional account id');
    }

    const client = await Client.findOne({ clientID: clientId });
    if (!client) throw new Error('Client not found');
    if (!client.metaAds || typeof client.metaAds !== 'object') {
      client.metaAds = {};
    }

    client.metaAds.instagramLoginAccessToken = accessToken;
    client.metaAds.instagramLoginTokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    client.metaAds.instagramLoginConnectedAt = new Date();
    client.metaAds.instagramLoginScopes = short.permissions.length
      ? short.permissions
      : IG_SCOPES.split(',');
    client.metaAds.instagramUserId = igUserId;
    client.metaAds.instagramUsername = igUsername;
    client.metaAds.instagramAuthMethod = 'instagram_login';
    client.metaAds.lastSync = new Date();
    client.metaAds.errorMessage = '';
    // IG-only clients can use publish without Facebook — mark meta surface active lightly.
    if (!client.metaAds.accessToken) {
      client.metaAds.enabled = true;
      client.metaAds.status = 'active';
      client.metaAds.connectionMethod = client.metaAds.connectionMethod || '';
    }

    client.markModified('metaAds');
    await client.save();

    recordEventSafe({
      clientId,
      integration: 'meta_oauth',
      operation: 'instagram_oauth_complete',
      outcome: 'success',
      message: `Connected @${igUsername || igUserId}`,
      durationMs: Date.now() - started,
      meta: { igUserId, scopes: client.metaAds.instagramLoginScopes },
    });

    return {
      connected: true,
      instagramUserId: igUserId,
      instagramUsername: igUsername,
      tokenExpiresAt: client.metaAds.instagramLoginTokenExpiresAt,
      authMethod: 'instagram_login',
    };
  } catch (err) {
    const msg = err?.response?.data?.error_message
      || err?.response?.data?.error?.message
      || err.message
      || 'Instagram connection failed';
    recordEventSafe({
      clientId,
      integration: 'meta_oauth',
      operation: 'instagram_oauth_complete',
      outcome: 'error',
      message: msg,
      durationMs: Date.now() - started,
      meta: err?.response?.data || {},
    });
    throw new Error(msg);
  }
}

function hasInstagramLogin(clientOrMeta) {
  const m = clientOrMeta?.metaAds || clientOrMeta || {};
  return Boolean(m.instagramLoginAccessToken && m.instagramUserId);
}

async function refreshTokenIfNeeded(client) {
  const token = String(client?.metaAds?.instagramLoginAccessToken || '');
  if (!token) return false;
  const expiresAt = client.metaAds.instagramLoginTokenExpiresAt
    ? new Date(client.metaAds.instagramLoginTokenExpiresAt).getTime()
    : null;
  // Refresh when within 7 days of expiry (IG long-lived = 60 days).
  const windowMs = 7 * 24 * 60 * 60 * 1000;
  if (expiresAt && expiresAt - Date.now() > windowMs) return false;
  try {
    const { accessToken, expiresIn } = await refreshLongLivedToken(token);
    client.metaAds.instagramLoginAccessToken = accessToken;
    client.metaAds.instagramLoginTokenExpiresAt = new Date(Date.now() + expiresIn * 1000);
    client.markModified('metaAds');
    await client.save();
    return true;
  } catch (err) {
    console.warn('[instagram oauth] refresh failed:', err.message);
    return false;
  }
}

async function getConnectionStatus(clientId) {
  const client = await Client.findOne({ clientID: clientId }).select('metaAds').lean({ getters: true });
  const m = client?.metaAds || {};
  const connected = hasInstagramLogin(m);
  if (connected) {
    try {
      const full = await Client.findOne({ clientID: clientId });
      if (full) await refreshTokenIfNeeded(full);
    } catch (err) {
      console.warn('[instagram oauth] status refresh skipped:', err.message);
    }
  }
  const fresh = connected
    ? (await Client.findOne({ clientID: clientId }).select('metaAds').lean({ getters: true }))?.metaAds || m
    : m;
  return {
    connected: hasInstagramLogin(fresh),
    configured: isConfigured(),
    instagramUserId: fresh.instagramUserId || '',
    instagramUsername: fresh.instagramUsername || '',
    authMethod: fresh.instagramAuthMethod || (hasInstagramLogin(fresh) ? 'instagram_login' : ''),
    connectedAt: fresh.instagramLoginConnectedAt || null,
    tokenExpiresAt: fresh.instagramLoginTokenExpiresAt || null,
    scopes: Array.isArray(fresh.instagramLoginScopes) ? fresh.instagramLoginScopes : [],
    canPublish: hasInstagramLogin(fresh) || Boolean(fresh.instagramUserId && fresh.pageId),
    boostRequiresFacebook: true,
  };
}

async function disconnect(clientId) {
  const client = await Client.findOne({ clientID: clientId });
  if (!client) throw new Error('Client not found');
  if (!client.metaAds || typeof client.metaAds !== 'object') {
    client.metaAds = {};
  }

  const hadIgLogin = Boolean(client.metaAds.instagramLoginAccessToken);
  client.metaAds.instagramLoginAccessToken = '';
  client.metaAds.instagramLoginTokenExpiresAt = null;
  client.metaAds.instagramLoginConnectedAt = null;
  client.metaAds.instagramLoginScopes = [];
  if (client.metaAds.instagramAuthMethod === 'instagram_login' || hadIgLogin) {
    // Keep Page-linked IG ids if Facebook is still connected.
    if (!client.metaAds.accessToken) {
      client.metaAds.instagramUserId = '';
      client.metaAds.instagramUsername = '';
      client.metaAds.instagramAuthMethod = '';
      if (!client.metaAds.accessToken) {
        client.metaAds.enabled = false;
        client.metaAds.status = 'inactive';
      }
    } else {
      client.metaAds.instagramAuthMethod = 'facebook_page';
    }
  }
  client.metaAds.lastSync = new Date();
  client.markModified('metaAds');
  await client.save();
  return { disconnected: true };
}

module.exports = {
  isConfigured,
  buildAuthorizeUrl,
  getAuthorizeDebug,
  completeOAuth,
  getConnectionStatus,
  disconnect,
  dashboardReturnUrl,
  verifyState,
  hasInstagramLogin,
  refreshTokenIfNeeded,
  igGraphGet,
  IG_GRAPH_BASE,
  IG_GRAPH_VERSION,
  IG_SCOPES,
};
