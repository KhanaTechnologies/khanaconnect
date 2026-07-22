const express = require('express');
const { tenantResolver, adminOnly, requireRoles } = require('../middleware/saasTenant');
const { idempotencyGuard } = require('../middleware/saasIdempotency');
const { verifyMetaWebhookSignature, handleMetaWebhookChallenge } = require('../middleware/saasWebhookVerifier');
const { encrypt } = require('../helpers/encryption');
const { wrapRoute } = require('../helpers/failureEmail');
const WhatsAppService = require('../services/saas/WhatsAppService');
const WhatsAppInboxService = require('../services/saas/WhatsAppInboxService');
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
  try {
    const body = req.body || {};
    const entries = Array.isArray(body.entry) ? body.entry : [];
    console.log(
      `[whatsapp webhook] POST received object=${body.object || '(none)'} entries=${entries.length}`
    );
    let statusCount = 0;
    let inboundCount = 0;
    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change.value || {};
        const phoneNumberId = value.metadata?.phone_number_id || '';
        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const st of statuses) {
          statusCount += 1;
          const level =
            st.status === 'failed' || st.errors?.length ? 'error' : 'log';
          const msg = `[whatsapp webhook] phone_number_id=${phoneNumberId} id=${st.id} status=${st.status} recipient=${st.recipient_id || ''}`;
          if (level === 'error') {
            console.error(msg, st.errors || st);
          } else {
            console.log(msg);
          }
        }
        const messages = Array.isArray(value.messages) ? value.messages : [];
        inboundCount += messages.length;
        if (messages.length) {
          console.log(
            `[whatsapp webhook] inbound ${messages.length} message(s) for phone_number_id=${phoneNumberId}`
          );
        }
        try {
          const result = await WhatsAppInboxService.ingestWebhookValue(value);
          if (result.ingested || result.statusUpdates) {
            console.log(
              `[whatsapp inbox] client=${result.clientId} ingested=${result.ingested} statusUpdates=${result.statusUpdates}`
            );
          }
        } catch (inboxErr) {
          console.error('[whatsapp inbox] ingest error:', inboxErr.message);
        }
      }
    }
    if (entries.length && statusCount === 0 && inboundCount === 0) {
      console.log('[whatsapp webhook] no status/message payloads in this POST (test ping or empty change)');
    }
  } catch (e) {
    console.error('[whatsapp webhook] parse error:', e.message);
  }
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
  res.status(201).json({
    ok: true,
    data: {
      client_id: doc.client_id,
      waba_id: doc.waba_id,
      phone_number_id: doc.phone_number_id,
      mode: doc.mode,
      status: doc.status,
      has_token: true,
    },
  });
}));

router.get('/whatsapp/setup', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (_req, res) => {
  const apiBase = (process.env.PUBLIC_API_BASE || process.env.PUBLIC_API_URL || process.env.API_PUBLIC_URL || 'https://khanaconnect.onrender.com').replace(
    /\/$/,
    ''
  );
  const apiPath = (process.env.API_URL || '/api/v1').replace(/\/$/, '');
  res.json({
    ok: true,
    data: {
      callbackUrl: `${apiBase}${apiPath}/saas/webhooks/whatsapp`,
      verifyToken: String(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || ''),
      requiredTemplates: [
        'order_confirmation',
        'order_status_update',
        'booking_confirmation',
        'booking_reminder',
        'account_verification',
      ],
      templateLanguage: String(process.env.WHATSAPP_TEMPLATE_LANG || 'en_US'),
    },
  });
}));

router.get('/whatsapp/account', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const doc = await SaasWhatsAppAccount.findOne({
    client_id: req.tenant.clientId,
    status: 'active',
  }).sort({ updated_at: -1 });

  if (!doc) {
    return res.json({ ok: true, data: null });
  }

  res.json({
    ok: true,
    data: {
      client_id: doc.client_id,
      waba_id: doc.waba_id,
      phone_number_id: doc.phone_number_id,
      mode: doc.mode,
      status: doc.status,
      has_token: !!doc.access_token_encrypted,
      updated_at: doc.updated_at,
    },
  });
}));

/** Readiness for client WhatsApp Cloud API notifications (toggle + credits + sender). */
router.get('/whatsapp/status', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const clientId = req.tenant.clientId;
  const client = await Client.findOne({ clientID: clientId }).select('whatsapp companyName');
  const notificationsEnabled = client?.whatsapp?.notificationsEnabled === true;

  const ownAccount = await SaasWhatsAppAccount.findOne({
    client_id: clientId,
    status: 'active',
  })
    .sort({ updated_at: -1 })
    .lean();

  const khanaAccount =
    clientId === 'Khana'
      ? ownAccount
      : await SaasWhatsAppAccount.findOne({ client_id: 'Khana', status: 'active' })
          .sort({ updated_at: -1 })
          .lean();

  const usingOwnAccount = !!ownAccount;
  const usingKhanaFallback = !usingOwnAccount && !!khanaAccount;
  const hasSender = usingOwnAccount || usingKhanaFallback;

  const billing = await BillingService.ensureAccount(clientId);
  const creditBalance = Number(billing.credit_balance || 0);
  const creditsOk = clientId === 'Khana' || creditBalance > 0;

  const ready = notificationsEnabled && hasSender && creditsOk;

  res.json({
    ok: true,
    data: {
      notificationsEnabled,
      hasSender,
      usingOwnAccount,
      usingKhanaFallback,
      creditBalance,
      creditsOk,
      ready,
      sender: usingOwnAccount
        ? {
            source: 'client',
            phone_number_id: ownAccount.phone_number_id,
            waba_id: ownAccount.waba_id,
          }
        : usingKhanaFallback
          ? {
              source: 'khana',
              phone_number_id: khanaAccount.phone_number_id,
              waba_id: khanaAccount.waba_id,
            }
          : null,
      checklist: [
        {
          id: 'notifications',
          label: 'Automated alerts enabled',
          ok: notificationsEnabled,
        },
        {
          id: 'sender',
          label: usingKhanaFallback
            ? 'Sender ready (Khana platform WhatsApp)'
            : usingOwnAccount
              ? 'Sender ready (your Cloud API number)'
              : 'Cloud API sender configured',
          ok: hasSender,
        },
        {
          id: 'credits',
          label: 'WhatsApp credits available',
          ok: creditsOk,
        },
      ],
    },
  });
}));

/** Persist notifications toggle without saving the whole Account Management form. */
router.put('/whatsapp/notifications', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const enabled = req.body?.enabled === true || req.body?.notificationsEnabled === true;
  const clientId = req.tenant.clientId;

  const client = await Client.findOneAndUpdate(
    { clientID: clientId },
    { $set: { 'whatsapp.notificationsEnabled': enabled } },
    { new: true }
  ).select('whatsapp companyName clientID');

  if (!client) {
    return res.status(404).json({ ok: false, message: 'Client not found' });
  }

  res.json({
    ok: true,
    data: {
      clientID: client.clientID,
      notificationsEnabled: client.whatsapp?.notificationsEnabled === true,
    },
  });
}));

router.get('/whatsapp/inbox/threads', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const limit = Number(req.query.limit) || 40;
  const threads = await WhatsAppInboxService.listThreads(req.tenant.clientId, { limit });
  res.json({ ok: true, data: { threads } });
}));

router.get('/whatsapp/inbox/threads/:contactWaId', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const thread = await WhatsAppInboxService.getThread(req.tenant.clientId, req.params.contactWaId, { limit });
  res.json({ ok: true, data: thread });
}));

router.post('/whatsapp/inbox/reply', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const to = req.body?.to || req.body?.contact_wa_id || req.body?.contactWaId;
  const text = req.body?.text || req.body?.message || req.body?.body;
  const data = await WhatsAppInboxService.sendTextReply({
    clientId: req.tenant.clientId,
    to,
    text,
  });
  res.status(202).json({ ok: true, data });
}));

router.post('/whatsapp/messages/template', requireRoles('owner', 'manager', 'operator'), idempotencyGuard('saas.whatsapp.template.send'), wrapRoute(async (req, res) => {
  const { to, templateName, languageCode, components, messageType } = req.body;
  const data = await WhatsAppService.sendTemplateMessage({
    clientId: req.tenant.clientId,
    to,
    templateName,
    languageCode,
    components,
    messageType: messageType || 'utility',
  });
  res.status(202).json({ ok: true, data });
}));

router.post('/whatsapp/messages/test', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const { to, templateName = 'order_confirmation' } = req.body || {};
  if (!to) {
    return res.status(400).json({ ok: false, message: 'to (phone number) is required' });
  }

  const client = await Client.findOne({ clientID: req.tenant.clientId }).select('companyName');
  const companyName = client?.companyName || req.tenant.clientId;

  const data = await sendWhatsAppTestTemplate({
    clientId: req.tenant.clientId,
    to,
    templateName,
    companyName,
  });

  res.status(202).json({ ok: true, data });
}));

async function sendWhatsAppTestTemplate({ clientId, to, templateName, companyName }) {
  const name = templateName || 'order_confirmation';
  if (name === 'order_status_update') {
    return WhatsAppService.notifyOrderStatus({
      clientId,
      to,
      companyName,
      orderRef: 'TEST-001',
      status: 'processing',
    });
  }
  if (name === 'booking_confirmation') {
    return WhatsAppService.notifyBookingConfirmation({
      clientId,
      to,
      companyName,
      bookingRef: 'TEST-BK',
      when: 'Tomorrow 10:00',
    });
  }
  if (name === 'booking_reminder') {
    return WhatsAppService.notifyBookingReminder({
      clientId,
      to,
      companyName,
      bookingRef: 'TEST-BK',
      when: 'Tomorrow 10:00',
    });
  }
  if (name === 'account_verification') {
    return WhatsAppService.notifyVerificationCode({
      clientId,
      to,
      companyName,
      code: '123456',
    });
  }
  return WhatsAppService.notifyOrderConfirmation({
    clientId,
    to,
    companyName,
    orderRef: 'TEST-001',
    total: 'R0.00',
  });
}

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
  const clientId = req.tenant.clientId;
  const account = await BillingService.ensureAccount(clientId);
  const recent = await SaasTransaction.find({ client_id: clientId }).sort({ created_at: -1 }).limit(30);
  const whatsappDeductions = recent.filter(
    (t) => t.type === 'deduction' && (t.metadata?.service === 'whatsapp' || String(t.reference || '').startsWith('wamid.'))
  );
  const SaasUsageEvent = require('../models/SaasUsageEvent');
  const usageAgg = await SaasUsageEvent.aggregate([
    { $match: { client_id: clientId, service: 'whatsapp' } },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
      },
    },
  ]);
  const whatsappUsage = { queued: 0, processed: 0, failed: 0 };
  for (const row of usageAgg) {
    if (row._id && whatsappUsage[row._id] !== undefined) whatsappUsage[row._id] = row.count;
  }
  const utilityRule = await SaasPricingRule.findOne({
    service: 'whatsapp',
    message_type: 'utility',
    active: true,
  })
    .sort({ updated_at: -1 })
    .lean();

  res.json({
    ok: true,
    data: {
      account,
      recentTransactions: recent,
      whatsapp: {
        usage: whatsappUsage,
        recentDeductions: whatsappDeductions.slice(0, 10),
        utilityCreditsPerMessage: utilityRule
          ? Number(
              (
                Number(utilityRule.cost_per_unit || 0) *
                (1 + Number(utilityRule.markup_percentage || 0) / 100)
              ).toFixed(4)
            )
          : null,
      },
    },
  });
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

router.post('/admin/whatsapp/messages/sandbox-phones', adminOnly, wrapRoute(async (req, res) => {
  const body = req.body || {};
  const wabaId = String(body.waba_id || body.wabaId || '').trim();
  const accessToken = String(body.access_token || body.accessToken || '').trim();

  const data = await WhatsAppService.listSandboxPhoneNumbers({
    wabaId,
    accessToken,
  });

  res.json({ ok: true, data });
}));

router.post('/admin/whatsapp/messages/sandbox-validate', adminOnly, wrapRoute(async (req, res) => {
  const body = req.body || {};
  const phoneNumberId = String(body.phone_number_id || body.phoneNumberId || '').trim();
  const accessToken = String(body.access_token || body.accessToken || '').trim();

  const data = await WhatsAppService.validateSandboxCredentials({
    phoneNumberId,
    accessToken,
  });

  res.json({ ok: true, data });
}));

router.post('/admin/whatsapp/messages/sandbox-test', adminOnly, wrapRoute(async (req, res) => {
  const body = req.body || {};
  const to = String(body.to || body.phone || '').trim();
  const phoneNumberId = String(body.phone_number_id || body.phoneNumberId || '').trim();
  const accessToken = String(body.access_token || body.accessToken || '').trim();
  const templateName = String(body.templateName || body.template_name || 'hello_world').trim();
  const languageCode = String(body.languageCode || body.language_code || 'en_US').trim();

  if (!to) {
    return res.status(400).json({
      ok: false,
      message: 'to (recipient phone) is required',
      hint: 'Add your WhatsApp number under Meta → WhatsApp → API Setup → To (allowed list), then send hello_world.',
    });
  }

  console.log(
    `[whatsapp] admin sandbox test to=${to} template=${templateName} phone_number_id=${phoneNumberId || process.env.WHATSAPP_TEST_PHONE_NUMBER_ID || '(env/blank)'} by=${req.tenant.clientId}`
  );

  const data = await WhatsAppService.sendSandboxTemplateMessage({
    to,
    phoneNumberId,
    accessToken,
    templateName,
    languageCode,
  });

  res.status(202).json({ ok: true, data });
}));

router.post('/admin/whatsapp/messages/test', adminOnly, wrapRoute(async (req, res) => {
  const body = req.body || {};
  const to = String(body.to || body.phone || '').trim();
  const templateName = String(body.templateName || body.template_name || 'order_confirmation').trim();
  const bodyClientId = String(body.client_id || body.clientId || '').trim();

  if (!to) {
    return res.status(400).json({
      ok: false,
      message: 'to (phone number) is required',
      hint: 'Send JSON body: { "to": "0766356790", "client_id": "Khana", "templateName": "order_confirmation" }',
      receivedKeys: Object.keys(body),
    });
  }

  const clientId = bodyClientId || String(req.tenant.clientId || 'Khana').trim() || 'Khana';

  const client = await Client.findOne({ clientID: clientId }).select('companyName');
  const companyName = client?.companyName || clientId;

  console.log(
    `[whatsapp] admin test send client=${clientId} to=${to} template=${templateName} by=${req.tenant.clientId}`
  );

  const data = await sendWhatsAppTestTemplate({
    clientId,
    to,
    templateName,
    companyName,
  });

  res.status(202).json({
    ok: true,
    data: {
      clientId,
      templateName,
      to,
      meta: data,
    },
  });
}));

router.post('/admin/whatsapp/register', adminOnly, wrapRoute(async (req, res) => {
  const body = req.body || {};
  const clientId = String(body.client_id || body.clientId || 'Khana').trim() || 'Khana';
  const pin = String(body.pin || '').trim();

  const data = await WhatsAppService.registerPhoneNumber({ clientId, pin });
  console.log(`[whatsapp] registered phone_number_id=${data.phone_number_id} for ${clientId}`);
  res.json({ ok: true, data });
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

router.get('/admin/whatsapp-usage', adminOnly, wrapRoute(async (req, res) => {
  const SaasUsageEvent = require('../models/SaasUsageEvent');
  const days = Math.min(Math.max(Number(req.query.days || 30), 1), 365);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [statusAgg, typeAgg, clientAgg, recentFailures, recentEvents, accounts, billingAccounts, pricingRules] =
    await Promise.all([
      SaasUsageEvent.aggregate([
        { $match: { service: 'whatsapp', created_at: { $gte: since } } },
        { $group: { _id: '$status', count: { $sum: 1 }, units: { $sum: '$units' } } },
      ]),
      SaasUsageEvent.aggregate([
        { $match: { service: 'whatsapp', created_at: { $gte: since } } },
        { $group: { _id: '$message_type', count: { $sum: 1 } } },
      ]),
      SaasUsageEvent.aggregate([
        { $match: { service: 'whatsapp', created_at: { $gte: since } } },
        {
          $group: {
            _id: '$client_id',
            total: { $sum: 1 },
            processed: { $sum: { $cond: [{ $eq: ['$status', 'processed'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            queued: { $sum: { $cond: [{ $eq: ['$status', 'queued'] }, 1, 0] } },
            billedCredits: {
              $sum: {
                $cond: [
                  { $eq: ['$status', 'processed'] },
                  { $ifNull: ['$metadata.billedCredits', 0] },
                  0,
                ],
              },
            },
            lastAt: { $max: '$created_at' },
          },
        },
        { $sort: { total: -1 } },
        { $limit: 100 },
      ]),
      SaasUsageEvent.find({ service: 'whatsapp', status: 'failed', created_at: { $gte: since } })
        .sort({ created_at: -1 })
        .limit(25)
        .lean(),
      SaasUsageEvent.find({ service: 'whatsapp', created_at: { $gte: since } })
        .sort({ created_at: -1 })
        .limit(40)
        .lean(),
      SaasWhatsAppAccount.find({ status: 'active' })
        .select('client_id phone_number_id waba_id updated_at mode')
        .lean(),
      SaasBillingAccount.find({}).lean(),
      SaasPricingRule.find({ service: 'whatsapp' }).sort({ message_type: 1, updated_at: -1 }).lean(),
    ]);

  const clientIds = [...new Set(clientAgg.map((r) => r._id).filter(Boolean))];
  const clients = await Client.find({ clientID: { $in: clientIds } })
    .select('clientID companyName whatsapp.notificationsEnabled tier')
    .lean();
  const clientMap = Object.fromEntries(clients.map((c) => [c.clientID, c]));
  const billingMap = Object.fromEntries(billingAccounts.map((b) => [b.client_id, b]));
  const accountClientIds = new Set(accounts.map((a) => a.client_id));

  const byStatus = { queued: 0, processed: 0, failed: 0 };
  let totalEvents = 0;
  for (const row of statusAgg) {
    const key = row._id;
    const count = row.count || 0;
    totalEvents += count;
    if (key && byStatus[key] !== undefined) byStatus[key] = count;
  }

  const byMessageType = {};
  for (const row of typeAgg) {
    if (row._id) byMessageType[row._id] = row.count || 0;
  }

  const byClient = clientAgg.map((row) => {
    const c = clientMap[row._id] || {};
    const bill = billingMap[row._id] || {};
    return {
      clientId: row._id,
      companyName: c.companyName || row._id,
      tier: c.tier || 'bronze',
      notificationsEnabled: c.whatsapp?.notificationsEnabled === true,
      hasCloudAccount: accountClientIds.has(row._id),
      total: row.total,
      processed: row.processed,
      failed: row.failed,
      queued: row.queued,
      billedCredits: Number(Number(row.billedCredits || 0).toFixed(4)),
      creditBalance: Number(bill.credit_balance || 0),
      totalSpent: Number(bill.total_spent || 0),
      lastAt: row.lastAt,
    };
  });

  const totalBilledCredits = byClient.reduce((sum, r) => sum + (r.billedCredits || 0), 0);

  res.json({
    ok: true,
    data: {
      days,
      since: since.toISOString(),
      summary: {
        totalEvents,
        byStatus,
        byMessageType,
        totalBilledCredits: Number(totalBilledCredits.toFixed(4)),
        activeCloudAccounts: accounts.length,
        clientsWithUsage: byClient.length,
      },
      byClient,
      cloudAccounts: accounts,
      recentFailures: recentFailures.map((e) => ({
        clientId: e.client_id,
        messageType: e.message_type,
        sourceRef: e.source_ref,
        error: e.metadata?.billingError || e.metadata?.error || null,
        templateName: e.metadata?.templateName || null,
        createdAt: e.created_at,
      })),
      recentEvents: recentEvents.map((e) => ({
        clientId: e.client_id,
        status: e.status,
        messageType: e.message_type,
        sourceRef: e.source_ref,
        templateName: e.metadata?.templateName || null,
        billedCredits: e.metadata?.billedCredits ?? null,
        createdAt: e.created_at,
      })),
      pricingRules,
    },
  });
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
