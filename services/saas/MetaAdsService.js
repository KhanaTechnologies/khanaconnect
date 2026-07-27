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
      if (pixels[0]?.id) {
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
  }));
}

async function listPagePosts(clientId, { limit = 20 } = {}) {
  const client = await loadClientWithMeta(clientId);
  const pageId = client.metaAds?.pageId;
  if (!pageId) throw new Error('Select a Facebook Page first');

  const cap = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const fields = 'id,message,created_time,full_picture,permalink_url,shares';
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

async function searchTargeting(clientId, { q, type = 'adinterest', limit = 15, locationTypes } = {}) {
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
    params.location_types = JSON.stringify(
      Array.isArray(locationTypes) && locationTypes.length
        ? locationTypes
        : ['city', 'region']
    );
  }

  if (searchType === 'adTargetingCategory') {
    params.class = 'behaviors';
  }

  try {
    const res = await graphGet('/search', token, params);
    const rows = Array.isArray(res?.data) ? res.data : [];
    return {
      results: rows.map((r) => ({
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
        typeName: r.type ? String(r.type) : undefined,
      })).filter((r) => r.id || r.key),
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
      fields: 'id,name,approximate_count,subtype,delivery_status',
      limit: 50,
    });
    const rows = Array.isArray(res?.data) ? res.data : [];
    return {
      audiences: rows.map((a) => ({
        id: String(a.id),
        name: String(a.name || a.id),
        approximateCount: Number(a.approximate_count) || null,
        subtype: a.subtype ? String(a.subtype) : '',
      })),
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
  }
) {
  const client = await loadClientWithMeta(clientId);
  const token = String(client.metaAds.accessToken);
  const pageId = client.metaAds?.pageId;
  const adAccountId = normalizeAdAccountId(client.metaAds?.adAccountId);

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

  const durationDays = Math.min(Math.max(Number(days) || 7, 1), 30);
  const adStatus = String(status).toUpperCase() === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';
  const objectStoryId = String(postId).includes('_') ? String(postId) : `${pageId}_${postId}`;
  const stamp = new Date().toISOString().slice(0, 10);

  const targeting = buildTargetingSpec({
    country,
    ...targetingInput,
    countries: targetingInput.countries || (country ? [country] : undefined),
  });

  let campaignId;
  let adSetId;
  let adId;

  try {
    const campaign = await graphPost(`/act_${adAccountId}/campaigns`, token, {
      name: `Khana Boost ${stamp}`,
      objective: 'OUTCOME_ENGAGEMENT',
      status: adStatus,
      special_ad_categories: JSON.stringify([]),
    });
    campaignId = campaign.id;

    const startTime = Math.floor(Date.now() / 1000);
    const endTime = startTime + durationDays * 86400;

    const adSet = await graphPost(`/act_${adAccountId}/adsets`, token, {
      name: `Boost ${objectStoryId}`,
      campaign_id: campaignId,
      daily_budget: dailyBudgetCents,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'POST_ENGAGEMENT',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: JSON.stringify(targeting),
      promoted_object: JSON.stringify({ page_id: pageId }),
      start_time: startTime,
      end_time: endTime,
      status: adStatus,
    });
    adSetId = adSet.id;

    const creative = await graphPost(`/act_${adAccountId}/adcreatives`, token, {
      name: `Creative ${objectStoryId}`,
      object_story_id: objectStoryId,
    });

    const ad = await graphPost(`/act_${adAccountId}/ads`, token, {
      name: `Boost ${objectStoryId}`,
      adset_id: adSetId,
      creative: JSON.stringify({ creative_id: creative.id }),
      status: adStatus,
    });
    adId = ad.id;
  } catch (err) {
    throw new Error(formatGraphError(err));
  }

  const campaignDoc = {
    name: `Boost ${objectStoryId}`,
    objective: 'OUTCOME_ENGAGEMENT',
    budget: dailyBudgetNum,
    status: adStatus === 'ACTIVE' ? 'active' : 'paused',
    meta_campaign_id: String(campaignId),
    campaign_type: 'boost',
    boostPostId: objectStoryId,
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
    await SaasUsageEvent.create({
      client_id: clientId,
      service: 'ads_service_fee',
      message_type: 'boost',
      units: 1,
      source_ref: String(saved._id),
      status: 'queued',
      metadata: { metaCampaignSubdocId: String(saved._id), postId: objectStoryId },
    });

    await usageBillingQueue.add('bill-ads-boost', {
      clientId,
      service: 'ads_service_fee',
      messageType: 'boost',
      units: 1,
      sourceRef: String(saved._id),
      metadata: { metaCampaignSubdocId: String(saved._id), postId: objectStoryId },
    });
  }

  return {
    campaignId: String(campaignId),
    adSetId: String(adSetId),
    adId: String(adId),
    objectStoryId,
    status: adStatus,
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

module.exports = {
  loadClientWithMeta,
  refreshTokenIfNeeded,
  forceRefreshToken,
  listPages,
  listAdAccounts,
  updateSelection,
  listPagePosts,
  getInsights,
  boostPost,
  buildTargetingSpec,
  searchTargeting,
  listCustomAudiences,
  normalizeAdAccountId,
};
