const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const { getJwtSecret } = require('./jwtSecret');
const { defaultPaidUntilForNewClient, applyGracePeriod, DEFAULT_GRACE_DAYS } = require('./clientSubscription');

function generateToken(client) {
  const secret = getJwtSecret();
  const payload = {
    clientID: client.clientID,
    companyName: client.companyName,
    merchant_id: client.merchant_id,
    merchant_key: client.merchant_key,
    passphrase: client.passphrase,
  };
  return jwt.sign(payload, secret, { expiresIn: '1y' });
}

function defaultPermissions(overrides = {}) {
  return {
    bookings: false,
    orders: false,
    staff: false,
    categories: false,
    preorder: false,
    voting: false,
    sales: false,
    services: false,
    products: false,
    dashboard: false,
    ...overrides,
  };
}

function buildClientDefaults(body = {}) {
  const ga4PropertyId = body.ga4PropertyId || '';
  return {
    deliveryOptions: body.deliveryOptions || [],
    emailSignature: body.emailSignature || '',
    imapHost: body.imapHost || '',
    imapPort: body.imapPort != null && body.imapPort !== '' ? Number(body.imapPort) : 993,
    smtpHost: body.smtpHost || '',
    smtpPort: body.smtpPort != null && body.smtpPort !== '' ? Number(body.smtpPort) : 587,
    ga4PropertyId,
    analyticsConfig: {
      googleAnalytics: {
        measurementId: '',
        apiSecret: '',
        propertyId: ga4PropertyId,
        isEnabled: false,
      },
    },
    metaAds: {
      pixelId: '',
      accessToken: '',
      testEventCode: '',
      apiVersion: 'v18.0',
      enabled: false,
      status: 'inactive',
      errorMessage: '',
    },
    googleAds: {
      conversionId: '',
      apiKey: '',
      developerToken: '',
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      customerId: '',
      conversionActionId: '',
      enabled: false,
      status: 'inactive',
      errorMessage: '',
    },
    tiktokAds: {
      pixelId: '',
      accessToken: '',
      enabled: false,
    },
    pinterestAds: {
      adAccountId: '',
      accessToken: '',
      enabled: false,
    },
    trackingSettings: body.trackingSettings || {
      batchSize: 50,
      retryAttempts: 3,
      retryDelayMs: 5000,
      sendAnonymousEvents: true,
      sendAuthenticatedEvents: true,
      eventTypes: ['PAGE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART', 'INITIATE_CHECKOUT', 'PURCHASE', 'LEAD'],
    },
    trackingStats: {
      eventsSent: 0,
      eventsFailed: 0,
      dailyQuota: 10000,
      monthlyQuota: 300000,
    },
    subscription: (() => {
      const paidUntil = body.paidUntil ? new Date(body.paidUntil) : defaultPaidUntilForNewClient();
      return {
        status: body.subscriptionStatus || 'active',
        plan: body.subscriptionPlan || body.plan || 'partnership',
        billingCycle: body.billingCycle || 'monthly',
        paidUntil,
        graceUntil: applyGracePeriod(paidUntil, DEFAULT_GRACE_DAYS),
        lastPaymentAt: new Date(),
        notes: body.subscriptionNotes || '',
      };
    })(),
  };
}

async function generateUniqueMerchantId() {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const merchant_id = Math.floor(10000000 + Math.random() * 90000000);
    const exists = await Client.exists({ merchant_id });
    if (!exists) return merchant_id;
  }
  throw new Error('Could not generate a unique merchant ID');
}

async function generateUniqueField(fieldName) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const value = crypto.randomBytes(16).toString('hex');
    const exists = await Client.exists({ [fieldName]: value });
    if (!exists) return value;
  }
  throw new Error(`Could not generate a unique ${fieldName}`);
}

function defaultReturnUrl(clientID, return_url) {
  if (return_url) return return_url.replace(/\/$/, '');
  const slug = String(clientID).replace(/[^a-zA-Z0-9-]/g, '').toLowerCase();
  return `https://${slug || 'client'}.example.com`;
}

async function createClientRecord(body) {
  const {
    clientID,
    companyName,
    businessEmail,
    businessEmailPassword,
    password,
    role,
    tier,
    return_url,
    cancel_url,
    notify_url,
    merchant_id,
    merchant_key,
    passphrase,
    permissions,
  } = body;

  if (!clientID || !companyName || !businessEmail) {
    const err = new Error('clientID, companyName, and businessEmail are required');
    err.status = 400;
    throw err;
  }

  const loginPassword = password || businessEmailPassword;
  if (!loginPassword || String(loginPassword).length < 6) {
    const err = new Error('Password must be at least 6 characters');
    err.status = 400;
    throw err;
  }

  const existing = await Client.findOne({ clientID });
  if (existing) {
    const err = new Error('Client ID already exists');
    err.status = 409;
    throw err;
  }

  const mid =
    merchant_id != null && merchant_id !== ''
      ? Number(merchant_id)
      : await generateUniqueMerchantId();
  const mkey = merchant_key || (await generateUniqueField('merchant_key'));
  const pass = passphrase || (await generateUniqueField('passphrase'));

  const retUrl = defaultReturnUrl(clientID, return_url);
  const canUrl = (cancel_url || retUrl).replace(/\/$/, '');
  const notUrl = (notify_url || retUrl).replace(/\/$/, '');

  const hashedPassword = bcrypt.hashSync(loginPassword, 10);
  const apiToken = generateToken({
    clientID,
    companyName,
    merchant_id: mid,
    merchant_key: mkey,
    passphrase: pass,
  });

  const newClient = new Client({
    clientID,
    companyName,
    password: hashedPassword,
    merchant_id: mid,
    merchant_key: mkey,
    passphrase: pass,
    token: apiToken,
    return_url: retUrl,
    cancel_url: canUrl,
    notify_url: notUrl,
    businessEmail,
    businessEmailPassword: businessEmailPassword || loginPassword,
    tier: tier || 'bronze',
    role: role || 'client',
    permissions: permissions ? defaultPermissions(permissions) : defaultPermissions(),
    ...buildClientDefaults(body),
  });

  const savedClient = await newClient.save();
  const clientResponse = savedClient.toObject();
  delete clientResponse.password;

  return { client: clientResponse, token: apiToken };
}

module.exports = {
  createClientRecord,
  generateToken,
  defaultPermissions,
  buildClientDefaults,
};
