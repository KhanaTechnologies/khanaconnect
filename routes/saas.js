const express = require('express');
const { tenantResolver, adminOnly, requireRoles } = require('../middleware/saasTenant');
const { idempotencyGuard } = require('../middleware/saasIdempotency');
const { verifyMetaWebhookSignature, handleMetaWebhookChallenge } = require('../middleware/saasWebhookVerifier');
const { encrypt } = require('../helpers/encryption');
const { wrapRoute } = require('../helpers/failureEmail');
const WhatsAppService = require('../services/saas/WhatsAppService');
const AdsService = require('../services/saas/AdsService');
const BillingService = require('../services/saas/BillingService');
const PayFastCreditsService = require('../services/saas/PayFastCreditsService');
const SaasWhatsAppAccount = require('../models/SaasWhatsAppAccount');
const SaasBillingAccount = require('../models/SaasBillingAccount');
const SaasTransaction = require('../models/SaasTransaction');
const SaasPricingRule = require('../models/SaasPricingRule');
const Client = require('../models/client');

const router = express.Router();

// Public Meta webhook challenge + signed event callbacks (reusable verifier middleware).
router.get('/webhooks/whatsapp', handleMetaWebhookChallenge('WHATSAPP_WEBHOOK_VERIFY_TOKEN'));
router.get('/webhooks/meta-ads', handleMetaWebhookChallenge('META_WEBHOOK_VERIFY_TOKEN'));
router.post('/webhooks/whatsapp', verifyMetaWebhookSignature('WHATSAPP_APP_SECRET'), wrapRoute(async (req, res) => {
  // TODO: fan-out per tenant using phone_number_id/waba_id map if needed.
  res.status(200).json({ ok: true, received: true });
}));
router.post('/webhooks/meta-ads', verifyMetaWebhookSignature('META_APP_SECRET'), wrapRoute(async (req, res) => {
  res.status(200).json({ ok: true, received: true });
}));

// Public PayFast ITN endpoint (signature-verified) for credit topups.
router.post('/billing/payfast/itn', wrapRoute(async (req, res) => {
  const result = await PayFastCreditsService.handleTopupItn(req.body || {});
  res.json({ ok: true, data: result });
}));

router.use(tenantResolver);

router.post('/whatsapp/accounts', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const { waba_id, phone_number_id, access_token, mode = 'embedded' } = req.body;
  if (!waba_id || !phone_number_id || !access_token) {
    return res.status(400).json({ ok: false, message: 'waba_id, phone_number_id and access_token are required' });
  }
  const doc = await SaasWhatsAppAccount.findOneAndUpdate(
    { client_id: req.tenant.clientId, phone_number_id },
    {
      $set: {
        client_id: req.tenant.clientId,
        waba_id,
        phone_number_id,
        mode,
        access_token_encrypted: encrypt(access_token),
        status: 'active',
      },
    },
    { upsert: true, new: true }
  );
  res.status(201).json({ ok: true, data: doc });
}));

router.post('/whatsapp/messages/template', requireRoles('owner', 'manager', 'operator'), idempotencyGuard('saas.whatsapp.template.send'), wrapRoute(async (req, res) => {
  const { to, templateName, languageCode, components } = req.body;
  const data = await WhatsAppService.sendTemplateMessage({
    clientId: req.tenant.clientId,
    to,
    templateName,
    languageCode,
    components,
  });
  res.status(202).json({ ok: true, data });
}));

router.post('/ads/accounts', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const { ad_account_id, ownership_type, meta_business_id } = req.body;
  if (!ad_account_id) return res.status(400).json({ ok: false, message: 'ad_account_id is required' });
  const account = await AdsService.attachAdAccount({
    clientId: req.tenant.clientId,
    adAccountId: ad_account_id,
    ownershipType: ownership_type,
    metaBusinessId: meta_business_id,
  });
  res.status(201).json({ ok: true, data: account });
}));

router.post('/ads/campaigns', requireRoles('owner', 'manager'), idempotencyGuard('saas.ads.campaign.create'), wrapRoute(async (req, res) => {
  const { name, objective, budget, access_token } = req.body;
  if (!name || !objective) {
    return res.status(400).json({ ok: false, message: 'name and objective are required' });
  }
  const campaign = await AdsService.createCampaign({
    clientId: req.tenant.clientId,
    name,
    objective,
    budget,
    accessToken: access_token,
  });
  res.status(201).json({ ok: true, data: campaign });
}));

router.get('/billing', requireRoles('owner', 'manager', 'billing_admin', 'viewer', 'operator'), wrapRoute(async (req, res) => {
  const account = await BillingService.ensureAccount(req.tenant.clientId);
  const recent = await SaasTransaction.find({ client_id: req.tenant.clientId }).sort({ created_at: -1 }).limit(30);
  res.json({ ok: true, data: { account, recentTransactions: recent } });
}));

router.post('/billing/topup/manual', requireRoles('billing_admin', 'owner', 'manager'), wrapRoute(async (req, res) => {
  const { client_id, credits, amount, reference } = req.body;
  const targetClient = String(client_id || req.tenant.clientId);
  const result = await BillingService.topUpCredits({
    clientId: targetClient,
    credits: Number(credits || 0),
    amount: Number(amount || credits || 0),
    method: 'manual',
    reference: reference || `manual-${Date.now()}`,
    metadata: { adminBy: req.tenant.userId || 'admin' },
  });
  res.json({ ok: true, data: result });
}));

router.get('/admin/pricing', adminOnly, wrapRoute(async (_req, res) => {
  const rules = await SaasPricingRule.find({}).sort({ service: 1, message_type: 1, updated_at: -1 });
  res.json({ ok: true, data: rules });
}));

router.post('/admin/pricing', adminOnly, wrapRoute(async (req, res) => {
  const { service, message_type, tier, cost_per_unit, markup_percentage, active = true, notes = '' } = req.body;
  if (!service) return res.status(400).json({ ok: false, message: 'service is required' });
  const tierVal = tier && ['all', 'bronze', 'silver', 'gold'].includes(tier) ? tier : 'all';
  const rule = await SaasPricingRule.create({
    service,
    message_type: message_type || 'service',
    tier: tierVal,
    cost_per_unit: Number(cost_per_unit || 0),
    markup_percentage: Number(markup_percentage || 0),
    active: !!active,
    notes,
    updated_by: req.tenant.userId || req.tenant.clientId,
  });
  res.status(201).json({ ok: true, data: rule });
}));

router.get('/overview', requireRoles('owner', 'manager', 'billing_admin', 'viewer', 'operator'), wrapRoute(async (req, res) => {
  const clientId = req.tenant.clientId;
  const [billing, waAccounts, clientSnap] = await Promise.all([
    SaasBillingAccount.findOne({ client_id: clientId }).lean(),
    SaasWhatsAppAccount.countDocuments({ client_id: clientId, status: 'active' }),
    Client.findOne({ clientID: clientId }).select('metaAds.adAccountId metaAds.campaigns tier').lean(),
  ]);
  const ad_accounts = clientSnap?.metaAds?.adAccountId ? 1 : 0;
  const campaigns = Array.isArray(clientSnap?.metaAds?.campaigns) ? clientSnap.metaAds.campaigns.length : 0;
  res.json({
    ok: true,
    data: {
      client_id: clientId,
      billing: billing || { credit_balance: 0, total_spent: 0 },
      whatsapp_accounts: waAccounts,
      ad_accounts,
      campaigns,
      tier: clientSnap?.tier || 'bronze',
      model_defaults: {
        ad_ownership: process.env.DEFAULT_AD_OWNERSHIP_TYPE === 'client' ? 'client' : 'agency',
      },
    },
  });
}));

module.exports = router;
