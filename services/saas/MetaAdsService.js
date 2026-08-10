const axios = require('axios');
const Client = require('../../models/client');
const SaasUsageEvent = require('../../models/SaasUsageEvent');
const { usageBillingQueue } = require('../../queues/saasQueues');
const META_GRAPH_BASE = process.env.META_GRAPH_BASE || 'https://graph.facebook.com/v21.0';
const META_APP_ID = process.env.META_APP_ID || process.env.FACEBOOK_APP_ID || '';
const META_APP_SECRET = process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || '';

const TOKEN_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function normalizeAdAccountId(raw) {
  if (!raw) return '';
  return String(raw).trim().replace(/^act_/i, '');
}

async function graphGet(path, accessToken, params = {}) {
  const { data } = await axios.get(`${META_GRAPH_BASE}${path}`, {
    params: { access_token: accessToken, ...params },
    timeout: 25000,
  });
  return data;
}

async function graphPost(path, accessToken, params = {}) {
  const { data } = await axios.post(`${META_GRAPH_BASE}${path}`, null, {
    params: { access_token: accessToken, ...params },
    timeout: 30000,
  });
  return data;
}

function formatGraphError(err) {
  const fb = err?.response?.data?.error;
  if (fb?.error_user_msg) {
    return fb.error_user_title ? `${fb.error_user_title}: ${fb.error_user_msg}` : fb.error_user_msg;
  }
  if (fb?.message) {
    return fb.message;
  }
  return err?.message || 'Meta API request failed';
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

async function loadClientWithMeta(clientId, { refreshToken = true } = {}) {
  const client = await Client.findOne({ clientID: clientId });
  if (!client) throw new Error('Client not found');

  const token = client.metaAds?.accessToken ? String(client.metaAds.accessToken) : '';
  if (!token) {
    throw new Error('Facebook is not connected. Connect your account in Account settings.');
  }

  if (refreshToken) {
    await refreshTokenIfNeeded(client);
  }

  return client;
}

async function refreshTokenIfNeeded(client) {
  if (!META_APP_ID || !META_APP_SECRET) return false;

  const expiresAt = client.metaAds?.tokenExpiresAt
    ? new Date(client.metaAds.tokenExpiresAt).getTime()
    : null;
  const shouldRefresh = !expiresAt || expiresAt - Date.now() < TOKEN_REFRESH_WINDOW_MS;
  if (!shouldRefresh) return false;

  const current = String(client.metaAds.accessToken || '');
  if (!current) return false;

  try {
    const { accessToken, expiresIn } = await exchangeLongLivedToken(current);
    client.metaAds.accessToken = accessToken;
    client.metaAds.tokenExpiresAt = expiresIn
      ? new Date(Date.now() + expiresIn * 1000)
      : null;
    client.metaAds.lastSync = new Date();
    client.metaAds.errorMessage = '';
    client.markModified('metaAds');
    await client.save();
    return true;
  } catch (err) {
    console.warn('[meta ads] token refresh failed:', err.message);
    client.metaAds.errorMessage = `Token refresh failed: ${formatGraphError(err)}`;
    client.markModified('metaAds');
    await client.save();
    return false;
  }
}

async function listPages(clientId) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const pagesRes = await graphGet('/me/accounts', token, {
    fields: 'id,name,category',
    limit: 50,
  });
  const pages = Array.isArray(pagesRes?.data) ? pagesRes.data : [];
  return {
    pages: pages.map((p) => ({
      id: String(p.id),
      name: String(p.name || ''),
      category: String(p.category || ''),
      selected: String(p.id) === String(client.metaAds.pageId || ''),
    })),
    selectedPageId: client.metaAds.pageId || '',
  };
}

async function listAdAccounts(clientId) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const adRes = await graphGet('/me/adaccounts', token, {
    fields: 'id,name,account_id,account_status,currency',
    limit: 50,
  });
  const accounts = Array.isArray(adRes?.data) ? adRes.data : [];
  const selectedId = normalizeAdAccountId(client.metaAds.adAccountId);
  return {
    adAccounts: accounts.map((a) => {
      const id = normalizeAdAccountId(a.account_id || a.id);
      return {
        id,
        name: String(a.name || ''),
        accountStatus: Number(a.account_status) || 0,
        currency: String(a.currency || 'ZAR'),
        selected: id === selectedId,
      };
    }),
    selectedAdAccountId: selectedId,
  };
}

async function resolveInstagramFromPage(pageId, pageToken) {
  if (!pageId || !pageToken) {
    return { instagramUserId: '', instagramUsername: '' };
  }
  try {
    const page = await graphGet(`/${pageId}`, pageToken, {
      fields: 'instagram_business_account{id,username}',
    });
    const ig = page?.instagram_business_account;
    return {
      instagramUserId: ig?.id ? String(ig.id) : '',
      instagramUsername: ig?.username ? String(ig.username) : '',
    };
  } catch (err) {
    console.warn('[meta ads] instagram_business_account resolve failed:', formatGraphError(err));
    return { instagramUserId: '', instagramUsername: '' };
  }
}

async function updateSelection(clientId, { pageId, adAccountId }) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);

  if (pageId) {
    const pagesRes = await graphGet('/me/accounts', token, {
      fields: 'id,name,access_token',
      limit: 50,
    });
    const pages = Array.isArray(pagesRes?.data) ? pagesRes.data : [];
    const page = pages.find((p) => String(p.id) === String(pageId));
    if (!page) throw new Error('Facebook Page not found on your connected account');
    client.metaAds.pageId = String(page.id);
    client.metaAds.pageName = String(page.name || '');
    client.metaAds.pageAccessToken = page.access_token ? String(page.access_token) : '';

    const pageToken = client.metaAds.pageAccessToken
      ? String(client.metaAds.pageAccessToken)
      : token;
    const ig = await resolveInstagramFromPage(client.metaAds.pageId, pageToken);
    client.metaAds.instagramUserId = ig.instagramUserId;
    client.metaAds.instagramUsername = ig.instagramUsername;
  }

  if (adAccountId) {
    const normId = normalizeAdAccountId(adAccountId);
    const adRes = await graphGet('/me/adaccounts', token, {
      fields: 'id,name,account_id',
      limit: 50,
    });
    const accounts = Array.isArray(adRes?.data) ? adRes.data : [];
    const account = accounts.find(
      (a) => normalizeAdAccountId(a.account_id || a.id) === normId
    );
    if (!account) throw new Error('Ad account not found on your connected account');
    client.metaAds.adAccountId = normId;
    client.metaAds.adAccountName = String(account.name || '');

    try {
      const pixRes = await graphGet(`/act_${normId}/adspixels`, token, {
        fields: 'id,name',
        limit: 5,
      });
      const pixels = Array.isArray(pixRes?.data) ? pixRes.data : [];
      // Only seed a pixel when none is set — a deliberately chosen dataset must
      // survive later ad account re-selection.
      if (pixels[0]?.id && !client.metaAds.pixelId) {
        client.metaAds.pixelId = String(pixels[0].id);
      }
    } catch (err) {
      console.warn('[meta ads] pixel fetch on selection failed:', err.message);
    }
  }

  client.metaAds.lastSync = new Date();
  client.metaAds.errorMessage = '';
  client.markModified('metaAds');
  await client.save();

  return {
    pageId: client.metaAds.pageId || '',
    pageName: client.metaAds.pageName || '',
    adAccountId: client.metaAds.adAccountId || '',
    adAccountName: client.metaAds.adAccountName || '',
    pixelConfigured: !!client.metaAds.pixelId,
    instagramUserId: client.metaAds.instagramUserId || '',
    instagramUsername: client.metaAds.instagramUsername || '',
    instagramConnected: !!client.metaAds.instagramUserId,
  };
}

async function ensurePageAccessToken(client, pageId) {
  let pageToken = client.metaAds?.pageAccessToken
    ? String(client.metaAds.pageAccessToken)
    : '';
  if (pageToken) return pageToken;

  const userToken = String(client.metaAds.accessToken || '');
  if (!userToken) throw new Error('Facebook is not connected');

  try {
    const pagesRes = await graphGet('/me/accounts', userToken, {
      fields: 'id,name,access_token',
      limit: 50,
    });
    const pages = Array.isArray(pagesRes?.data) ? pagesRes.data : [];
    const match = pages.find((p) => String(p.id) === String(pageId)) || pages[0];
    if (match?.access_token) {
      pageToken = String(match.access_token);
      client.metaAds.pageAccessToken = pageToken;
      if (match.id) client.metaAds.pageId = String(match.id);
      if (match.name) client.metaAds.pageName = String(match.name);
      client.markModified('metaAds');
      await client.save();
    }
  } catch (err) {
    console.warn('[meta ads] page token refresh failed:', formatGraphError(err));
  }

  return pageToken || userToken;
}

function mapPagePosts(posts) {
  return (Array.isArray(posts) ? posts : []).map((p) => ({
    id: String(p.id),
    postId: String(p.id).includes('_') ? String(p.id).split('_').pop() : String(p.id),
    message: String(p.message || '').slice(0, 500),
    createdTime: p.created_time || null,
    picture: p.full_picture || '',
    permalink: p.permalink_url || '',
    shares: Number(p.shares?.count) || 0,
    likes: Number(p.reactions?.summary?.total_count) || Number(p.likes?.summary?.total_count) || 0,
    comments: Number(p.comments?.summary?.total_count) || 0,
    platform: 'facebook',
  }));
}

async function listInstagramMedia(clientId, { limit = 20 } = {}) {
  const client = await loadClientWithMeta(clientId);
  const pageId = client.metaAds?.pageId;
  if (!pageId) throw new Error('Select a Facebook Page first');

  const pageToken = await ensurePageAccessToken(client, pageId);
  let igUserId = client.metaAds.instagramUserId ? String(client.metaAds.instagramUserId) : '';
  let igUsername = client.metaAds.instagramUsername ? String(client.metaAds.instagramUsername) : '';

  if (!igUserId) {
    const ig = await resolveInstagramFromPage(pageId, pageToken);
    igUserId = ig.instagramUserId;
    igUsername = ig.instagramUsername;
    if (igUserId) {
      client.metaAds.instagramUserId = igUserId;
      client.metaAds.instagramUsername = igUsername;
      client.markModified('metaAds');
      await client.save();
    }
  }

  if (!igUserId) {
    return {
      connected: false,
      instagramUserId: '',
      instagramUsername: '',
      pageId: String(pageId),
      pageName: client.metaAds.pageName || '',
      media: [],
      message:
        'This Facebook Page has no linked Instagram professional account. In Meta, link Instagram to the Page, then reconnect Facebook in Khana.',
      helpUrl: 'https://www.facebook.com/business/help/connect-instagram-to-page',
    };
  }

  const cap = Math.min(Math.max(Number(limit) || 20, 1), 50);
  try {
    const res = await graphGet(`/${igUserId}/media`, pageToken, {
      fields:
        'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count,boost_eligibility_info',
      limit: cap,
    });
    const rows = Array.isArray(res?.data) ? res.data : [];
    const media = rows.map((m) => {
      const eligibility = m.boost_eligibility_info || {};
      const eligibleRaw = eligibility.eligible;
      const eligible =
        eligibleRaw === undefined || eligibleRaw === null ? true : Boolean(eligibleRaw);
      return {
        id: String(m.id),
        caption: String(m.caption || '').slice(0, 500),
        mediaType: String(m.media_type || ''),
        mediaUrl: m.media_url || '',
        thumbnailUrl: m.thumbnail_url || m.media_url || '',
        permalink: m.permalink || '',
        timestamp: m.timestamp || null,
        likes: Number(m.like_count) || 0,
        comments: Number(m.comments_count) || 0,
        platform: 'instagram',
        eligible,
        ineligibilityReason: eligible
          ? ''
          : String(eligibility.reason_summary || eligibility.reason || 'Not eligible to boost'),
      };
    });

    return {
      connected: true,
      instagramUserId: igUserId,
      instagramUsername: igUsername,
      pageId: String(pageId),
      pageName: client.metaAds.pageName || '',
      media,
      message: '',
      helpUrl: '',
    };
  } catch (err) {
    const msg = formatGraphError(err);
    const needsReconnect = /permission|(#10)|(#200)|instagram|OAuthException/i.test(msg);
    throw new Error(
      needsReconnect
        ? `${msg} Reconnect Facebook after adding instagram_basic to the Login for Business configuration.`
        : msg
    );
  }
}

async function listPagePosts(clientId, { limit = 20 } = {}) {
  const client = await loadClientWithMeta(clientId);
  const pageId = client.metaAds?.pageId;
  if (!pageId) throw new Error('Select a Facebook Page first');

  const cap = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const fields =
    'id,message,created_time,full_picture,permalink_url,shares,reactions.summary(true),comments.summary(true)';
  const pageToken = await ensurePageAccessToken(client, pageId);

  // Prefer published_posts (Page's own posts). Fall back to posts / feed.
  const edges = ['published_posts', 'posts', 'feed'];
  let lastError = null;

  for (const edge of edges) {
    try {
      const res = await graphGet(`/${pageId}/${edge}`, pageToken, {
        fields,
        limit: cap,
      });
      return {
        pageId: String(pageId),
        pageName: client.metaAds.pageName || '',
        posts: mapPagePosts(res?.data),
      };
    } catch (err) {
      lastError = err;
      console.warn(`[meta ads] ${edge} failed:`, formatGraphError(err));
    }
  }

  const msg = formatGraphError(lastError);
  const needsReconnect =
    /permission|(#200)|(#10)|pages_read|OAuthException/i.test(msg);
  throw new Error(
    needsReconnect
      ? `${msg} Reconnect Facebook and approve Page content permissions (pages_read_engagement, pages_read_user_content).`
      : msg
  );
}

async function getInsights(clientId, { days = 30 } = {}) {
  const client = await loadClientWithMeta(clientId);
  const adAccountId = normalizeAdAccountId(client.metaAds?.adAccountId);
  if (!adAccountId) throw new Error('Select an ad account first');

  const token = String(client.metaAds.accessToken);
  const dayNum = Math.min(Math.max(Number(days) || 30, 1), 90);
  const datePreset = dayNum <= 7 ? 'last_7d' : dayNum <= 14 ? 'last_14d' : 'last_30d';

  let accountInsights = null;
  let campaignRows = [];

  try {
    const accRes = await graphGet(`/act_${adAccountId}/insights`, token, {
      fields: 'spend,impressions,clicks,reach,ctr,cpc,cpm,actions',
      date_preset: datePreset,
      level: 'account',
    });
    const row = Array.isArray(accRes?.data) ? accRes.data[0] : null;
    if (row) {
      accountInsights = {
        spend: Number(row.spend) || 0,
        impressions: Number(row.impressions) || 0,
        clicks: Number(row.clicks) || 0,
        reach: Number(row.reach) || 0,
        ctr: Number(row.ctr) || 0,
        cpc: Number(row.cpc) || 0,
        cpm: Number(row.cpm) || 0,
        dateStart: row.date_start || null,
        dateStop: row.date_stop || null,
      };
    }
  } catch (err) {
    console.warn('[meta ads] account insights failed:', err.message);
  }

  try {
    const campRes = await graphGet(`/act_${adAccountId}/insights`, token, {
      fields: 'campaign_name,spend,impressions,clicks,reach,ctr',
      date_preset: datePreset,
      level: 'campaign',
      limit: 10,
    });
    const rows = Array.isArray(campRes?.data) ? campRes.data : [];
    campaignRows = rows.map((r) => ({
      name: String(r.campaign_name || 'Campaign'),
      spend: Number(r.spend) || 0,
      impressions: Number(r.impressions) || 0,
      clicks: Number(r.clicks) || 0,
      reach: Number(r.reach) || 0,
      ctr: Number(r.ctr) || 0,
    }));
  } catch (err) {
    console.warn('[meta ads] campaign insights failed:', err.message);
  }

  client.metaAds.lastSync = new Date();
  client.markModified('metaAds');
  await client.save();

  return {
    adAccountId,
    adAccountName: client.metaAds.adAccountName || '',
    datePreset,
    days: dayNum,
    account: accountInsights,
    campaigns: campaignRows,
  };
}

function clampAge(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(65, Math.max(13, Math.round(n)));
}

/**
 * Build a Meta Marketing API targeting object from dashboard options.
 * @see https://developers.facebook.com/docs/marketing-api/audiences/reference/basic-targeting
 */
function buildTargetingSpec(input = {}) {
  const countriesRaw = Array.isArray(input.countries)
    ? input.countries
    : input.country
      ? [input.country]
      : ['ZA'];
  const countries = [...new Set(
    countriesRaw
      .map((c) => String(c || '').trim().toUpperCase())
      .filter((c) => /^[A-Z]{2}$/.test(c))
  )];
  if (!countries.length) {
    throw new Error('At least one valid country code is required (e.g. ZA)');
  }

  const geo_locations = { countries };

  const cities = Array.isArray(input.cities) ? input.cities : [];
  const cityEntries = cities
    .map((c) => {
      if (c == null) return null;
      if (typeof c === 'string' || typeof c === 'number') {
        return { key: String(c) };
      }
      if (c.key || c.id) {
        const entry = { key: String(c.key || c.id) };
        if (c.radius != null) entry.radius = Number(c.radius);
        if (c.distance_unit) entry.distance_unit = String(c.distance_unit);
        return entry;
      }
      return null;
    })
    .filter(Boolean);
  if (cityEntries.length) {
    geo_locations.cities = cityEntries;
  }

  const regions = Array.isArray(input.regions) ? input.regions : [];
  const regionEntries = regions
    .map((r) => {
      if (!r) return null;
      const key = typeof r === 'object' ? (r.key || r.id) : r;
      return key ? { key: String(key) } : null;
    })
    .filter(Boolean);
  if (regionEntries.length) {
    geo_locations.regions = regionEntries;
  }

  const customLocationsRaw = Array.isArray(input.custom_locations)
    ? input.custom_locations
    : Array.isArray(input.customLocations)
      ? input.customLocations
      : [];
  const custom_locations = customLocationsRaw
    .map((loc) => {
      if (!loc || typeof loc !== 'object') return null;
      const latitude = Number(loc.latitude ?? loc.lat);
      const longitude = Number(loc.longitude ?? loc.lng ?? loc.lon);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
      const radius = Number(loc.radius);
      const entry = {
        latitude,
        longitude,
        radius: Number.isFinite(radius) && radius > 0 ? radius : 17,
        distance_unit: String(loc.distance_unit || loc.distanceUnit || 'kilometer'),
      };
      if (loc.address_string || loc.addressString || loc.name) {
        entry.address_string = String(loc.address_string || loc.addressString || loc.name);
      }
      return entry;
    })
    .filter(Boolean);
  if (custom_locations.length) {
    geo_locations.custom_locations = custom_locations;
  }

  const age_min = clampAge(input.age_min ?? input.ageMin, 18);
  const age_max = clampAge(input.age_max ?? input.ageMax, 65);
  if (age_min > age_max) {
    throw new Error('age_min cannot be greater than age_max');
  }

  const targeting = {
    geo_locations,
    age_min,
    age_max,
  };

  // Meta: 1 = male, 2 = female. Omit for all genders.
  const genderRaw = input.genders ?? input.gender;
  if (genderRaw != null && genderRaw !== '' && genderRaw !== 'all') {
    const list = Array.isArray(genderRaw) ? genderRaw : [genderRaw];
    const genders = [...new Set(
      list
        .map((g) => {
          const s = String(g).toLowerCase();
          if (s === '1' || s === 'male' || s === 'm') return 1;
          if (s === '2' || s === 'female' || s === 'f') return 2;
          const n = Number(g);
          return n === 1 || n === 2 ? n : null;
        })
        .filter((g) => g != null)
    )];
    if (genders.length) targeting.genders = genders;
  }

  const interests = (Array.isArray(input.interests) ? input.interests : [])
    .map((i) => {
      if (!i) return null;
      if (typeof i === 'string' || typeof i === 'number') return { id: String(i) };
      if (i.id) return { id: String(i.id), ...(i.name ? { name: String(i.name) } : {}) };
      return null;
    })
    .filter(Boolean);

  const behaviors = (Array.isArray(input.behaviors) ? input.behaviors : [])
    .map((b) => {
      if (!b) return null;
      if (typeof b === 'string' || typeof b === 'number') return { id: String(b) };
      if (b.id) return { id: String(b.id), ...(b.name ? { name: String(b.name) } : {}) };
      return null;
    })
    .filter(Boolean);

  if (interests.length || behaviors.length) {
    const flex = {};
    if (interests.length) flex.interests = interests;
    if (behaviors.length) flex.behaviors = behaviors;
    targeting.flexible_spec = [flex];
  }

  const customAudiences = (Array.isArray(input.custom_audiences) ? input.custom_audiences : [])
    .map((a) => {
      if (!a) return null;
      const id = typeof a === 'object' ? a.id : a;
      return id ? { id: String(id) } : null;
    })
    .filter(Boolean);
  if (customAudiences.length) targeting.custom_audiences = customAudiences;

  const excludedAudiences = (Array.isArray(input.excluded_custom_audiences)
    ? input.excluded_custom_audiences
    : [])
    .map((a) => {
      if (!a) return null;
      const id = typeof a === 'object' ? a.id : a;
      return id ? { id: String(id) } : null;
    })
    .filter(Boolean);
  if (excludedAudiences.length) targeting.excluded_custom_audiences = excludedAudiences;

  // Placements: automatic (Advantage+) vs manual publisher positions
  const placementMode = String(input.placement_mode || input.placementMode || 'automatic').toLowerCase();
  if (placementMode === 'manual') {
    const platforms = Array.isArray(input.publisher_platforms) && input.publisher_platforms.length
      ? input.publisher_platforms.map((p) => String(p).toLowerCase())
      : ['facebook', 'instagram'];
    targeting.publisher_platforms = platforms;

    if (Array.isArray(input.facebook_positions) && input.facebook_positions.length) {
      targeting.facebook_positions = input.facebook_positions.map((p) => String(p));
    } else if (platforms.includes('facebook')) {
      targeting.facebook_positions = ['feed', 'story', 'facebook_reels', 'marketplace'];
    }

    if (Array.isArray(input.instagram_positions) && input.instagram_positions.length) {
      targeting.instagram_positions = input.instagram_positions.map((p) => String(p));
    } else if (platforms.includes('instagram')) {
      targeting.instagram_positions = ['stream', 'story', 'reels'];
    }

    if (Array.isArray(input.device_platforms) && input.device_platforms.length) {
      targeting.device_platforms = input.device_platforms.map((p) => String(p));
    }
  }

  return targeting;
}

async function searchTargeting(
  clientId,
  { q, type = 'adinterest', limit = 15, locationTypes, countryCode } = {}
) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const query = String(q || '').trim();
  if (query.length < 2) {
    return { results: [] };
  }

  const allowedTypes = new Set([
    'adinterest',
    'adgeolocation',
    'adeducationmajor',
    'adeducationschool',
    'adworkemployer',
    'adworkposition',
    'adTargetingCategory',
  ]);
  const searchType = allowedTypes.has(String(type)) ? String(type) : 'adinterest';

  const params = {
    type: searchType,
    q: query,
    limit: Math.min(Math.max(Number(limit) || 15, 1), 50),
  };

  if (searchType === 'adgeolocation') {
    const allowedLocationTypes = new Set([
      'country',
      'region',
      'city',
      'zip',
      'geo_market',
      'electoral_district',
    ]);
    const types = (Array.isArray(locationTypes) && locationTypes.length
      ? locationTypes
      : ['city', 'region']
    )
      .map((t) => String(t || '').trim().toLowerCase())
      .filter((t) => allowedLocationTypes.has(t));
    params.location_types = JSON.stringify(types.length ? types : ['city', 'region']);

    const cc = String(countryCode || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(cc)) {
      params.country_code = cc;
    }
  }

  if (searchType === 'adTargetingCategory') {
    params.class = 'behaviors';
  }

  try {
    const res = await graphGet('/search', token, params);
    const rows = Array.isArray(res?.data) ? res.data : [];
    return {
      results: rows.map((r) => {
        const lat = Number(r.latitude ?? r.center_lat);
        const lng = Number(r.longitude ?? r.center_lng ?? r.center_lon);
        return {
          id: String(r.id || r.key || ''),
          key: r.key != null ? String(r.key) : undefined,
          name: String(r.name || r.id || ''),
          type: searchType,
          path: Array.isArray(r.path) ? r.path.map(String) : undefined,
          audienceSize: r.audience_size_lower_bound != null
            ? {
                lower: Number(r.audience_size_lower_bound) || 0,
                upper: Number(r.audience_size_upper_bound) || 0,
              }
            : undefined,
          countryCode: r.country_code ? String(r.country_code) : undefined,
          region: r.region ? String(r.region) : undefined,
          regionId: r.region_id != null ? String(r.region_id) : undefined,
          typeName: r.type ? String(r.type) : undefined,
          latitude: Number.isFinite(lat) ? lat : undefined,
          longitude: Number.isFinite(lng) ? lng : undefined,
          supportsCity: r.supports_city != null ? Boolean(r.supports_city) : undefined,
          supportsRegion: r.supports_region != null ? Boolean(r.supports_region) : undefined,
        };
      }).filter((r) => r.id || r.key),
    };
  } catch (err) {
    throw new Error(formatGraphError(err));
  }
}

async function listCustomAudiences(clientId) {
  const client = await loadClientWithMeta(clientId);
  const adAccountId = normalizeAdAccountId(client.metaAds?.adAccountId);
  if (!adAccountId) throw new Error('Select an ad account first');

  const token = String(client.metaAds.accessToken);
  try {
    const res = await graphGet(`/act_${adAccountId}/customaudiences`, token, {
      fields:
        'id,name,approximate_count,approximate_count_lower_bound,approximate_count_upper_bound,subtype,delivery_status,operation_status,time_updated',
      limit: 50,
    });
    const rows = Array.isArray(res?.data) ? res.data : [];
    return {
      audiences: rows.map((a) => {
        const delivery = a.delivery_status || {};
        const operation = a.operation_status || {};
        const lower =
          a.approximate_count_lower_bound != null
            ? Number(a.approximate_count_lower_bound)
            : null;
        const upper =
          a.approximate_count_upper_bound != null
            ? Number(a.approximate_count_upper_bound)
            : null;
        const legacy =
          a.approximate_count != null && Number.isFinite(Number(a.approximate_count))
            ? Number(a.approximate_count)
            : null;
        const approx =
          lower != null && Number.isFinite(lower)
            ? lower
            : upper != null && Number.isFinite(upper)
              ? upper
              : legacy;
        return {
          id: String(a.id),
          name: String(a.name || a.id),
          approximateCount: approx != null && Number.isFinite(approx) ? approx : null,
          approximateCountLower: Number.isFinite(lower) ? lower : null,
          approximateCountUpper: Number.isFinite(upper) ? upper : null,
          subtype: a.subtype ? String(a.subtype) : '',
          deliveryStatus: {
            code: delivery.code != null ? Number(delivery.code) : null,
            description: delivery.description ? String(delivery.description) : null,
          },
          operationStatus: {
            code: operation.code != null ? Number(operation.code) : null,
            description: operation.description ? String(operation.description) : null,
          },
          timeUpdated: a.time_updated ? Number(a.time_updated) : null,
        };
      }),
    };
  } catch (err) {
    // Many accounts have no custom audiences or lack permission — soft-fail.
    console.warn('[meta ads] custom audiences list failed:', err.message);
    return { audiences: [], warning: formatGraphError(err) };
  }
}

async function boostPost(
  clientId,
  {
    postId,
    dailyBudget,
    days = 7,
    country = 'ZA',
    status = 'PAUSED',
    targeting: targetingInput = {},
    source = 'facebook',
  }
) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const pageId = client.metaAds?.pageId;
  const adAccountId = normalizeAdAccountId(client.metaAds?.adAccountId);
  const boostSource = String(source || 'facebook').toLowerCase() === 'instagram'
    ? 'instagram'
    : 'facebook';

  if (!pageId) throw new Error('Select a Facebook Page first');
  if (!adAccountId) throw new Error('Select an ad account first');
  if (!postId) throw new Error('post_id is required');

  const dailyBudgetNum = Number(dailyBudget);
  if (!Number.isFinite(dailyBudgetNum) || dailyBudgetNum <= 0) {
    throw new Error('daily_budget must be a positive number (account currency)');
  }

  const dailyBudgetCents = Math.round(dailyBudgetNum * 100);
  if (dailyBudgetCents < 100) {
    throw new Error('Minimum daily budget is 1.00 in your ad account currency');
  }
  // Meta enforces a higher per-account floor (often ~R15–R20 for ZAR). Prefer at least 20
  // in major currencies so App Review demos do not fail after campaign create.
  if (dailyBudgetNum < 20) {
    throw new Error(
      'Daily budget is below Meta’s typical account minimum. Try at least 20 in your ad account currency (e.g. R20 ZAR).'
    );
  }

  const durationDays = Math.min(Math.max(Number(days) || 7, 1), 30);
  const adStatus = String(status).toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
  const stamp = new Date().toISOString().slice(0, 10);

  let objectStoryId = '';
  let igMediaId = '';
  let igUserId = client.metaAds.instagramUserId ? String(client.metaAds.instagramUserId) : '';

  if (boostSource === 'instagram') {
    igMediaId = String(postId);
    if (!igUserId) {
      const pageToken = await ensurePageAccessToken(client, pageId);
      const ig = await resolveInstagramFromPage(pageId, pageToken);
      igUserId = ig.instagramUserId;
      if (igUserId) {
        client.metaAds.instagramUserId = ig.instagramUserId;
        client.metaAds.instagramUsername = ig.instagramUsername;
        client.markModified('metaAds');
        await client.save();
      }
    }
    if (!igUserId) {
      throw new Error(
        'No Instagram account linked to this Facebook Page. Link Instagram Professional to the Page in Meta, then reconnect.'
      );
    }
  } else {
    objectStoryId = String(postId).includes('_') ? String(postId) : `${pageId}_${postId}`;
  }

  const targeting = buildTargetingSpec({
    country,
    ...targetingInput,
    countries: targetingInput.countries || (country ? [country] : undefined),
  });

  let campaignId;
  let adSetId;
  let adId;
  const boostLabel = boostSource === 'instagram' ? igMediaId : objectStoryId;

  try {
    const campaign = await graphPost(`/act_${adAccountId}/campaigns`, token, {
      name: `Khana Boost ${boostSource === 'instagram' ? 'IG ' : ''}${stamp}`,
      objective: 'OUTCOME_ENGAGEMENT',
      status: adStatus,
      special_ad_categories: JSON.stringify([]),
      // Required when budget is on ad sets (ABO), not campaign budget (CBO). Meta error 4834011.
      is_adset_budget_sharing_enabled: false,
    });
    campaignId = campaign.id;

    const startTime = Math.floor(Date.now() / 1000);
    const endTime = startTime + durationDays * 86400;

    const adSet = await graphPost(`/act_${adAccountId}/adsets`, token, {
      name: `Boost ${boostLabel}`,
      campaign_id: campaignId,
      daily_budget: dailyBudgetCents,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'POST_ENGAGEMENT',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify(targeting),
      promoted_object: JSON.stringify({ page_id: pageId }),
      // Required with OUTCOME_ENGAGEMENT + POST_ENGAGEMENT for organic post boosts.
      destination_type: 'ON_POST',
      start_time: startTime,
      end_time: endTime,
      status: adStatus,
    });
    adSetId = adSet.id;

    let creative;
    if (boostSource === 'instagram') {
      creative = await graphPost(`/act_${adAccountId}/adcreatives`, token, {
        name: `IG Creative ${igMediaId}`,
        object_id: pageId,
        instagram_user_id: igUserId,
        source_instagram_media_id: igMediaId,
      });
    } else {
      creative = await graphPost(`/act_${adAccountId}/adcreatives`, token, {
        name: `Creative ${objectStoryId}`,
        object_story_id: objectStoryId,
      });
    }

    const ad = await graphPost(`/act_${adAccountId}/ads`, token, {
      name: `Boost ${boostLabel}`,
      adset_id: adSetId,
      creative: JSON.stringify({ creative_id: creative.id }),
      status: adStatus,
    });
    adId = ad.id;
  } catch (err) {
    throw new Error(formatGraphError(err));
  }

  const campaignDoc = {
    name: `Boost ${boostLabel}`,
    objective: 'OUTCOME_ENGAGEMENT',
    budget: dailyBudgetNum,
    status: adStatus === 'ACTIVE' ? 'active' : 'paused',
    meta_campaign_id: String(campaignId),
    campaign_type: 'boost',
    boostPostId: boostLabel,
    boostSource,
    meta_adset_id: String(adSetId),
    meta_ad_id: String(adId),
    targeting,
  };

  const updated = await Client.findOneAndUpdate(
    { clientID: clientId },
    { $push: { 'metaAds.campaigns': campaignDoc } },
    { new: true }
  ).select('metaAds.campaigns');

  const saved = updated?.metaAds?.campaigns?.[updated.metaAds.campaigns.length - 1];

  if (saved) {
    try {
      await SaasUsageEvent.create({
        client_id: clientId,
        service: 'ads_service_fee',
        message_type: 'service',
        units: 1,
        source_ref: String(saved._id),
        status: 'queued',
        metadata: {
          metaCampaignSubdocId: String(saved._id),
          postId: boostLabel,
          boostSource,
        },
      });
    } catch (err) {
      console.warn('[meta ads] usage event for boost failed:', err.message);
    }

    try {
      await usageBillingQueue.add('bill-ads-boost', {
        clientId,
        service: 'ads_service_fee',
        messageType: 'boost',
        units: 1,
        sourceRef: String(saved._id),
        metadata: {
          metaCampaignSubdocId: String(saved._id),
          postId: boostLabel,
          boostSource,
        },
      });
    } catch (err) {
      console.warn('[meta ads] boost billing enqueue failed:', err.message);
    }
  }

  return {
    campaignId: String(campaignId),
    adSetId: String(adSetId),
    adId: String(adId),
    status: adStatus,
    boostSource,
    boostPostId: boostLabel,
    objectStoryId: boostSource === 'facebook' ? objectStoryId : undefined,
    dailyBudget: dailyBudgetNum,
    durationDays,
    targeting,
    savedCampaignId: saved?._id ? String(saved._id) : null,
  };
}

async function forceRefreshToken(clientId) {
  const client = await Client.findOne({ clientID: clientId });
  if (!client?.metaAds?.accessToken) {
    throw new Error('Facebook is not connected');
  }
  const refreshed = await refreshTokenIfNeeded(client);
  return {
    refreshed,
    tokenExpiresAt: client.metaAds.tokenExpiresAt || null,
  };
}

async function resolveIgPublishContext(clientId) {
  const client = await loadClientWithMeta(clientId);
  const pageId = client.metaAds?.pageId;
  if (!pageId) throw new Error('Select a Facebook Page first');

  const pageToken = await ensurePageAccessToken(client, pageId);
  let igUserId = String(client.metaAds.instagramUserId || '').trim();
  let igUsername = String(client.metaAds.instagramUsername || '').trim();

  if (!igUserId) {
    const ig = await resolveInstagramFromPage(pageId, pageToken);
    igUserId = ig.instagramUserId;
    igUsername = ig.instagramUsername;
    if (igUserId) {
      client.metaAds.instagramUserId = igUserId;
      client.metaAds.instagramUsername = igUsername;
      client.markModified('metaAds');
      await client.save();
    }
  }

  if (!igUserId) {
    throw new Error(
      'This Facebook Page has no linked Instagram professional account. Link Instagram to the Page in Meta, then reconnect Facebook.'
    );
  }

  return { client, pageId, pageToken, igUserId, igUsername };
}

async function waitForIgContainer(containerId, pageToken, { maxAttempts = 30, intervalMs = 3000 } = {}) {
  let statusCode = '';
  for (let i = 0; i < maxAttempts; i += 1) {
    try {
      const status = await graphGet(`/${containerId}`, pageToken, {
        fields: 'status_code,status',
      });
      statusCode = String(status?.status_code || status?.status || '').toUpperCase();
      if (statusCode === 'FINISHED' || statusCode === 'PUBLISHED') {
        return statusCode;
      }
      if (statusCode === 'ERROR' || statusCode === 'EXPIRED') {
        throw new Error(`Instagram media container failed with status ${statusCode}`);
      }
    } catch (err) {
      if (err.message?.includes('container failed')) throw err;
      console.warn('[meta ads] IG container status poll:', formatGraphError(err));
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return statusCode || 'IN_PROGRESS';
}

function mapPublishPermissionError(err) {
  const msg = formatGraphError(err);
  if (/permission|instagram_content_publish|(#10)|(#200)/i.test(msg)) {
    return new Error(
      `${msg} Reconnect Facebook after adding instagram_content_publish (and instagram_basic) to the Login for Business configuration.`
    );
  }
  return new Error(msg);
}

/**
 * Publish image, carousel, video, or Reel to the Page-linked Instagram account.
 * mediaType: 'IMAGE' | 'CAROUSEL' | 'VIDEO' | 'REELS'
 */
async function publishInstagramMedia(
  clientId,
  { mediaType = 'IMAGE', imageUrl = '', videoUrl = '', imageUrls = [], caption = '' } = {}
) {
  const { pageToken, igUserId, igUsername } = await resolveIgPublishContext(clientId);
  const type = String(mediaType || 'IMAGE').toUpperCase();
  const captionText = String(caption || '').slice(0, 2200);

  const urls = Array.isArray(imageUrls)
    ? imageUrls.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u))
    : [];
  const singleImage = String(imageUrl || '').trim();
  if (singleImage && /^https?:\/\//i.test(singleImage) && !urls.includes(singleImage)) {
    urls.unshift(singleImage);
  }
  const video = String(videoUrl || '').trim();

  let containerId;

  try {
    if (type === 'CAROUSEL' || (type === 'IMAGE' && urls.length > 1)) {
      if (urls.length < 2) {
        throw new Error('Carousel posts need at least 2 public image URLs');
      }
      if (urls.length > 10) {
        throw new Error('Instagram carousels support at most 10 images');
      }
      const childIds = [];
      for (const url of urls) {
        const child = await graphPost(`/${igUserId}/media`, pageToken, {
          image_url: url,
          is_carousel_item: true,
        });
        const childId = String(child?.id || '').trim();
        if (!childId) throw new Error('Meta did not return a carousel item container id');
        childIds.push(childId);
      }
      const parent = await graphPost(`/${igUserId}/media`, pageToken, {
        media_type: 'CAROUSEL',
        children: childIds.join(','),
        caption: captionText,
      });
      containerId = String(parent?.id || '').trim();
    } else if (type === 'VIDEO' || type === 'REELS') {
      if (!/^https?:\/\//i.test(video)) {
        throw new Error('videoUrl must be a public http(s) URL Meta can fetch');
      }
      const created = await graphPost(`/${igUserId}/media`, pageToken, {
        media_type: type === 'REELS' ? 'REELS' : 'VIDEO',
        video_url: video,
        caption: captionText,
      });
      containerId = String(created?.id || '').trim();
    } else {
      // IMAGE
      const url = urls[0] || '';
      if (!/^https?:\/\//i.test(url)) {
        throw new Error('Upload an image on Khana or provide a public image URL');
      }
      const created = await graphPost(`/${igUserId}/media`, pageToken, {
        image_url: url,
        caption: captionText,
      });
      containerId = String(created?.id || '').trim();
    }
  } catch (err) {
    if (err.message?.includes('Carousel') || err.message?.includes('Upload an image') || err.message?.includes('videoUrl')) {
      throw err;
    }
    throw mapPublishPermissionError(err);
  }

  if (!containerId) throw new Error('Meta did not return a media container id');

  const pollAttempts = type === 'VIDEO' || type === 'REELS' ? 40 : 15;
  const statusCode = await waitForIgContainer(containerId, pageToken, {
    maxAttempts: pollAttempts,
    intervalMs: type === 'VIDEO' || type === 'REELS' ? 4000 : 2000,
  });

  let publishedId;
  try {
    const published = await graphPost(`/${igUserId}/media_publish`, pageToken, {
      creation_id: containerId,
    });
    publishedId = String(published?.id || '').trim();
  } catch (err) {
    throw new Error(formatGraphError(err));
  }

  if (!publishedId) throw new Error('Meta did not return a published media id');

  return {
    containerId,
    mediaId: publishedId,
    mediaType: type === 'IMAGE' && urls.length > 1 ? 'CAROUSEL' : type,
    instagramUserId: igUserId,
    instagramUsername: igUsername,
    caption: captionText,
    imageUrl: urls[0] || '',
    imageUrls: urls,
    videoUrl: video || '',
    containerStatus: statusCode || 'FINISHED',
  };
}

/**
 * Upload a local video buffer directly to Meta using Instagram's resumable
 * upload protocol, then publish it. This avoids requiring a CDN/Git URL.
 */
async function publishInstagramVideoBuffer(
  clientId,
  { buffer, mediaType = 'REELS', caption = '', contentType = 'video/mp4' } = {}
) {
  if (!buffer?.length) throw new Error('Video file data is required');
  const type = String(mediaType || 'REELS').toUpperCase();
  if (!['VIDEO', 'REELS'].includes(type)) {
    throw new Error('Direct video upload supports VIDEO or REELS');
  }

  const { pageToken, igUserId, igUsername } = await resolveIgPublishContext(clientId);
  const captionText = String(caption || '').slice(0, 2200);

  let containerId;
  try {
    const created = await graphPost(`/${igUserId}/media`, pageToken, {
      media_type: type,
      upload_type: 'resumable',
      caption: captionText,
    });
    containerId = String(created?.id || '').trim();
  } catch (err) {
    throw mapPublishPermissionError(err);
  }
  if (!containerId) throw new Error('Meta did not return a resumable media container id');

  const versionMatch = String(META_GRAPH_BASE).match(/\/(v\d+\.\d+)\/?$/i);
  const apiVersion = versionMatch?.[1] || 'v21.0';
  try {
    await axios.post(
      `https://rupload.facebook.com/ig-api-upload/${apiVersion}/${containerId}`,
      buffer,
      {
        timeout: 5 * 60 * 1000,
        maxContentLength: 250 * 1024 * 1024,
        maxBodyLength: 250 * 1024 * 1024,
        headers: {
          Authorization: `OAuth ${pageToken}`,
          offset: '0',
          file_size: String(buffer.length),
          'Content-Type': contentType || 'application/octet-stream',
        },
      }
    );
  } catch (err) {
    throw new Error(`Meta video upload failed: ${formatGraphError(err)}`);
  }

  const statusCode = await waitForIgContainer(containerId, pageToken, {
    maxAttempts: 60,
    intervalMs: 4000,
  });
  if (!['FINISHED', 'PUBLISHED'].includes(statusCode)) {
    throw new Error(`Instagram video is still processing (${statusCode}). Try again shortly.`);
  }

  let publishedId;
  try {
    const published = await graphPost(`/${igUserId}/media_publish`, pageToken, {
      creation_id: containerId,
    });
    publishedId = String(published?.id || '').trim();
  } catch (err) {
    throw new Error(formatGraphError(err));
  }
  if (!publishedId) throw new Error('Meta did not return a published video id');

  return {
    containerId,
    mediaId: publishedId,
    mediaType: type,
    instagramUserId: igUserId,
    instagramUsername: igUsername,
    caption: captionText,
    uploadMethod: 'meta_resumable',
    containerStatus: statusCode,
  };
}

/** @deprecated Prefer publishInstagramMedia — kept for callers. */
async function publishInstagramImage(clientId, { imageUrl, caption = '' } = {}) {
  return publishInstagramMedia(clientId, { mediaType: 'IMAGE', imageUrl, caption });
}

/**
 * Publish to the selected Facebook Page (feed / photos / video).
 * mediaType: 'IMAGE' | 'CAROUSEL' | 'VIDEO' | 'TEXT'
 * Requires pages_manage_posts on the Page token (add in Login for Business config).
 */
async function publishFacebookPagePost(
  clientId,
  { mediaType = 'IMAGE', imageUrl = '', videoUrl = '', imageUrls = [], caption = '' } = {}
) {
  const client = await loadClientWithMeta(clientId);
  const pageId = client.metaAds?.pageId;
  if (!pageId) throw new Error('Select a Facebook Page first');

  const pageToken = await ensurePageAccessToken(client, pageId);
  const captionText = String(caption || '').slice(0, 63206);
  const type = String(mediaType || 'IMAGE').toUpperCase();

  const urls = Array.isArray(imageUrls)
    ? imageUrls.map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u))
    : [];
  const singleImage = String(imageUrl || '').trim();
  if (singleImage && /^https?:\/\//i.test(singleImage) && !urls.includes(singleImage)) {
    urls.unshift(singleImage);
  }
  const video = String(videoUrl || '').trim();

  const mapFbPermError = (err) => {
    const msg = formatGraphError(err);
    if (/permission|(#200)|(#10)|pages_manage_posts|OAuthException/i.test(msg)) {
      return new Error(
        `${msg} Reconnect Facebook after adding pages_manage_posts to the Login for Business configuration, and grant Page access.`
      );
    }
    return new Error(msg);
  };

  try {
    if (type === 'VIDEO' || type === 'REELS') {
      if (!/^https?:\/\//i.test(video)) {
        throw new Error('videoUrl must be a public http(s) URL Meta can fetch');
      }
      const created = await graphPost(`/${pageId}/videos`, pageToken, {
        file_url: video,
        description: captionText,
        published: true,
      });
      const id = String(created?.id || '').trim();
      if (!id) throw new Error('Meta did not return a Facebook video id');
      return {
        platform: 'facebook',
        postId: id,
        mediaType: 'VIDEO',
        pageId: String(pageId),
        pageName: client.metaAds.pageName || '',
        caption: captionText,
        videoUrl: video,
      };
    }

    if (type === 'CAROUSEL' || (type === 'IMAGE' && urls.length > 1)) {
      if (urls.length < 2) throw new Error('Facebook album posts need at least 2 image URLs');
      const mediaFbids = [];
      for (const url of urls.slice(0, 10)) {
        const photo = await graphPost(`/${pageId}/photos`, pageToken, {
          url,
          published: false,
        });
        const pid = String(photo?.id || '').trim();
        if (!pid) throw new Error('Meta did not return an unpublished photo id');
        mediaFbids.push(pid);
      }
      const attached = mediaFbids.map((id) => ({ media_fbid: id }));
      const feed = await graphPost(`/${pageId}/feed`, pageToken, {
        message: captionText,
        attached_media: JSON.stringify(attached),
        published: true,
      });
      const id = String(feed?.id || '').trim();
      if (!id) throw new Error('Meta did not return a Facebook album post id');
      return {
        platform: 'facebook',
        postId: id,
        mediaType: 'CAROUSEL',
        pageId: String(pageId),
        pageName: client.metaAds.pageName || '',
        caption: captionText,
        imageUrls: urls,
      };
    }

    if (type === 'TEXT' || (!urls.length && !video)) {
      if (!captionText.trim()) throw new Error('Add a caption/message for a text post');
      const feed = await graphPost(`/${pageId}/feed`, pageToken, {
        message: captionText,
        published: true,
      });
      const id = String(feed?.id || '').trim();
      if (!id) throw new Error('Meta did not return a Facebook post id');
      return {
        platform: 'facebook',
        postId: id,
        mediaType: 'TEXT',
        pageId: String(pageId),
        pageName: client.metaAds.pageName || '',
        caption: captionText,
      };
    }

    // Single IMAGE
    const url = urls[0] || '';
    if (!/^https?:\/\//i.test(url)) {
      throw new Error('Upload an image on Khana or provide a public image URL');
    }
    const photo = await graphPost(`/${pageId}/photos`, pageToken, {
      url,
      caption: captionText,
      published: true,
    });
    const id = String(photo?.id || photo?.post_id || '').trim();
    if (!id) throw new Error('Meta did not return a Facebook photo id');
    return {
      platform: 'facebook',
      postId: id,
      mediaType: 'IMAGE',
      pageId: String(pageId),
      pageName: client.metaAds.pageName || '',
      caption: captionText,
      imageUrl: url,
    };
  } catch (err) {
    if (
      err.message?.includes('at least') ||
      err.message?.includes('Upload') ||
      err.message?.includes('videoUrl') ||
      err.message?.includes('caption')
    ) {
      throw err;
    }
    throw mapFbPermError(err);
  }
}

/**
 * Publish to facebook, instagram, or both. Returns per-destination results.
 * destinations: string[] e.g. ['facebook','instagram']
 */
async function publishSocialPost(clientId, payload = {}) {
  const raw = payload.destinations || payload.destination || ['instagram'];
  const list = (Array.isArray(raw) ? raw : [raw])
    .map((d) => String(d || '').toLowerCase().trim())
    .filter(Boolean);
  const wantsFb = list.includes('facebook') || list.includes('fb') || list.includes('both');
  const wantsIg =
    list.includes('instagram') || list.includes('ig') || list.includes('both') || list.length === 0;

  const results = { facebook: null, instagram: null, errors: [] };

  if (wantsFb) {
    try {
      results.facebook = await publishFacebookPagePost(clientId, payload);
    } catch (err) {
      results.errors.push({ platform: 'facebook', message: err.message });
    }
  }

  if (wantsIg) {
    try {
      const igType =
        String(payload.mediaType || 'IMAGE').toUpperCase() === 'TEXT'
          ? 'IMAGE'
          : payload.mediaType || 'IMAGE';
      if (igType === 'IMAGE' && !(payload.imageUrl || (payload.imageUrls && payload.imageUrls[0]))) {
        throw new Error('Instagram posts need at least one image or video');
      }
      results.instagram = await publishInstagramMedia(clientId, {
        ...payload,
        mediaType: igType === 'TEXT' ? 'IMAGE' : igType,
      });
      if (results.instagram) results.instagram.platform = 'instagram';
    } catch (err) {
      results.errors.push({ platform: 'instagram', message: err.message });
    }
  }

  if (!results.facebook && !results.instagram) {
    throw new Error(
      results.errors.map((e) => `${e.platform}: ${e.message}`).join(' | ') || 'Publish failed'
    );
  }

  return results;
}

async function listOrganicPosts(clientId, { limit = 20 } = {}) {
  const [fb, ig] = await Promise.allSettled([
    listPagePosts(clientId, { limit }),
    listInstagramMedia(clientId, { limit }),
  ]);

  const facebook = fb.status === 'fulfilled' ? fb.value : { posts: [], error: fb.reason?.message };
  const instagram =
    ig.status === 'fulfilled' ? ig.value : { media: [], error: ig.reason?.message, connected: false };

  const items = [
    ...(facebook.posts || []).map((p) => ({
      ...p,
      platform: 'facebook',
      createdAt: p.createdTime,
    })),
    ...(instagram.media || []).map((m) => ({
      id: m.id,
      message: m.caption,
      picture: m.thumbnailUrl || m.mediaUrl,
      permalink: m.permalink,
      likes: m.likes,
      comments: m.comments,
      shares: 0,
      platform: 'instagram',
      createdAt: m.timestamp,
      mediaType: m.mediaType,
    })),
  ].sort((a, b) => {
    const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return tb - ta;
  });

  return {
    items,
    facebookError: facebook.error || null,
    instagramError: instagram.error || null,
    instagramConnected: instagram.connected !== false,
  };
}

/**
 * Send a single Conversions API test event to the client's Meta Pixel (Events Manager).
 */
async function sendPixelTestEvent(clientId, { eventName = 'Lead', testEventCode = '' } = {}) {
  const client = await loadClientWithMeta(clientId);
  const pixelId = client.metaAds?.pixelId ? String(client.metaAds.pixelId).trim() : '';
  const accessToken = client.metaAds?.accessToken ? String(client.metaAds.accessToken).trim() : '';
  if (!pixelId || !accessToken) {
    throw new Error(
      'Meta Pixel is not configured. Connect Facebook with an ad account that has a Pixel, or save Pixel ID in Account Management.'
    );
  }

  const name = String(eventName || 'Lead').trim() || 'Lead';
  const allowed = new Set(['PageView', 'Lead', 'ViewContent', 'AddToCart', 'Purchase']);
  if (!allowed.has(name)) {
    throw new Error(`Unsupported test event: ${name}`);
  }

  const code =
    String(testEventCode || '').trim() ||
    (client.metaAds?.testEventCode ? String(client.metaAds.testEventCode).trim() : '');

  const eventTime = Math.floor(Date.now() / 1000);
  const eventId = `kc_test_${clientId}_${eventTime}`;
  const payload = {
    data: [
      {
        event_name: name,
        event_time: eventTime,
        event_id: eventId,
        action_source: 'website',
        event_source_url: process.env.PUBLIC_FRONTEND_URL || 'https://khanatechnologies.co.za',
        user_data: {
          client_user_agent: 'KhanaConnect-TestEvent/1.0',
          external_id: require('crypto').createHash('sha256').update(String(clientId)).digest('hex'),
        },
        custom_data:
          name === 'Purchase' || name === 'AddToCart'
            ? { currency: 'ZAR', value: 1 }
            : undefined,
      },
    ],
    access_token: accessToken,
  };
  if (code) payload.test_event_code = code;

  // Strip undefined custom_data
  if (payload.data[0].custom_data === undefined) {
    delete payload.data[0].custom_data;
  }

  try {
    const { data } = await axios.post(`${META_GRAPH_BASE}/${pixelId}/events`, payload, {
      timeout: 25000,
      headers: { 'Content-Type': 'application/json' },
    });
    return {
      ok: true,
      pixelId,
      eventName: name,
      eventId,
      testEventCode: code || null,
      eventsReceived: data?.events_received,
      fbtraceId: data?.fbtrace_id,
      messages: data?.messages,
      hint: code
        ? 'Open Events Manager → Test Events for this Pixel to see the event within about a minute.'
        : 'Open Events Manager → Overview for this Pixel. For instant visibility, set a Test Event Code first.',
    };
  } catch (err) {
    throw new Error(formatGraphError(err));
  }
}

module.exports = {
  loadClientWithMeta,
  refreshTokenIfNeeded,
  forceRefreshToken,
  listPages,
  listAdAccounts,
  updateSelection,
  listPagePosts,
  listInstagramMedia,
  listOrganicPosts,
  publishInstagramImage,
  publishInstagramMedia,
  publishInstagramVideoBuffer,
  publishFacebookPagePost,
  publishSocialPost,
  sendPixelTestEvent,
  getInsights,
  boostPost,
  buildTargetingSpec,
  searchTargeting,
  listCustomAudiences,
  normalizeAdAccountId,
  resolveInstagramFromPage,
};
