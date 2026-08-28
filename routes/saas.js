const express = require('express');
const multer = require('multer');
const { tenantResolver, adminOnly, requireRoles } = require('../middleware/saasTenant');
const { idempotencyGuard } = require('../middleware/saasIdempotency');
const { verifyMetaWebhookSignature, handleMetaWebhookChallenge } = require('../middleware/saasWebhookVerifier');
const { encrypt } = require('../helpers/encryption');
const { wrapRoute } = require('../helpers/failureEmail');
const WhatsAppService = require('../services/saas/WhatsAppService');
const WhatsAppInboxService = require('../services/saas/WhatsAppInboxService');
const AdsService = require('../services/saas/AdsService');
const MetaOAuthService = require('../services/saas/MetaOAuthService');
const MetaAdsService = require('../services/saas/MetaAdsService');
const MetaAdsAdvancedService = require('../services/saas/MetaAdsAdvancedService');
const CrmWorkspaceService = require('../services/saas/CrmWorkspaceService');
const BillingService = require('../services/saas/BillingService');
const PricingService = require('../services/saas/PricingService');
const PayFastCreditsService = require('../services/saas/PayFastCreditsService');
const SaasWhatsAppAccount = require('../models/SaasWhatsAppAccount');
const SaasWhatsAppWebhookEvent = require('../models/SaasWhatsAppWebhookEvent');
const SaasBillingAccount = require('../models/SaasBillingAccount');
const SaasTransaction = require('../models/SaasTransaction');
const SaasPricingRule = require('../models/SaasPricingRule');
const Client = require('../models/client');

const router = express.Router();
const inboxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 },
});
const instagramMediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
});

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
        // Archive first so Meta's 200 ack cannot leave us with no recoverable copy on ingest bugs.
        const archived = await WhatsAppInboxService.archiveWebhookValue(value);
        try {
          const result = await WhatsAppInboxService.ingestWebhookValue(value, {
            archiveId: archived?._id || null,
          });
          if (result.ingested || result.statusUpdates) {
            console.log(
              `[whatsapp inbox] client=${result.clientId} ingested=${result.ingested} statusUpdates=${result.statusUpdates}`
            );
          }
        } catch (inboxErr) {
          console.error('[whatsapp inbox] ingest error:', inboxErr.message);
          if (archived?._id) {
            try {
              await SaasWhatsAppWebhookEvent.updateOne(
                { _id: archived._id },
                { $set: { process_error: inboxErr.message } }
              );
            } catch {
              /* ignore */
            }
          }
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
  try {
    const result = await PayFastCreditsService.handleTopupItn(req.body || {});
    res.status(200).json({ ok: true, data: result });
  } catch (err) {
    console.warn('[payfast credits itn]', err.message);
    res.status(200).json({ ok: false, message: 'ITN rejected' });
  }
}));

// Meta (Facebook) OAuth callback — public; secured via signed state JWT.
router.get('/meta/oauth/callback', wrapRoute(async (req, res) => {
  const ApiMonitorService = require('../services/saas/ApiMonitorService');
  const { code, state, error, error_description: errorDescription } = req.query || {};
  let clientId = '';
  if (state) {
    try {
      clientId = MetaOAuthService.verifyState(state);
    } catch {
      clientId = '';
    }
  }
  if (error) {
    const raw = String(errorDescription || error);
    ApiMonitorService.recordEventSafe({
      clientId,
      integration: 'meta_oauth',
      operation: 'callback_denied',
      outcome: 'error',
      message: raw,
      meta: { error, errorDescription: errorDescription || '' },
    });
    const msg = encodeURIComponent(
      MetaOAuthService.isMetaBusinessAdminError(raw)
        ? MetaOAuthService.formatMetaBusinessAdminError(raw)
        : raw
    );
    return res.redirect(MetaOAuthService.dashboardReturnUrl(`meta=error&message=${msg}`));
  }
  try {
    await MetaOAuthService.completeOAuth({ code, state });
    return res.redirect(MetaOAuthService.dashboardReturnUrl('meta=connected'));
  } catch (err) {
    console.error('[meta oauth] callback failed:', err.message);
    const raw = err.message || 'Facebook connection failed';
    const msg = encodeURIComponent(
      MetaOAuthService.isMetaBusinessAdminError(raw)
        ? MetaOAuthService.formatMetaBusinessAdminError(raw)
        : raw
    );
    return res.redirect(MetaOAuthService.dashboardReturnUrl(`meta=error&message=${msg}`));
  }
}));

// Same exchange as GET callback, for dashboard-hosted redirect_uri (App Domains friendly).
router.post('/meta/oauth/complete', wrapRoute(async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.body || {};
  if (error) {
    const raw = String(errorDescription || error || 'Facebook connection failed');
    return res.status(400).json({
      ok: false,
      message: MetaOAuthService.isMetaBusinessAdminError(raw)
        ? MetaOAuthService.formatMetaBusinessAdminError(raw)
        : raw,
    });
  }
  try {
    const data = await MetaOAuthService.completeOAuth({ code, state });
    res.json({ ok: true, data });
  } catch (err) {
    const raw = err.message || 'Facebook connection failed';
    res.status(400).json({
      ok: false,
      message: MetaOAuthService.isMetaBusinessAdminError(raw)
        ? MetaOAuthService.formatMetaBusinessAdminError(raw)
        : raw,
    });
  }
}));

router.use(tenantResolver);
router.use(require('../helpers/readOnlyAccess').enforceReadOnlyWrites);

router.post('/whatsapp/accounts', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const { waba_id, phone_number_id, access_token, mode = 'embedded' } = req.body;
  if (!waba_id || !phone_number_id || !access_token) {
    return res.status(400).json({ ok: false, message: 'waba_id, phone_number_id and access_token are required' });
  }

  const prev = await SaasWhatsAppAccount.findOne({
    client_id: req.tenant.clientId,
    phone_number_id,
  }).select('waba_id dataset_id');

  const wabaChanged = prev && String(prev.waba_id) !== String(waba_id);

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
        // New or changed WABA → drop any prior dataset so we bind to this WABA only
        ...(wabaChanged || !prev
          ? {
              dataset_id: '',
              dataset_source: 'cleared',
              dataset_linked_at: null,
            }
          : {}),
      },
    },
    { upsert: true, new: true }
  );

  const subscribe = await WhatsAppService.subscribeWabaApp({
    wabaId: waba_id,
    accessToken: access_token,
  });

  let dataset = null;
  try {
    const WhatsAppConversionsService = require('../services/saas/WhatsAppConversionsService');
    dataset = await WhatsAppConversionsService.ensureDataset(req.tenant.clientId, { force: true });
  } catch (e) {
    console.warn('[whatsapp] dataset link on account save:', e.message);
  }

  res.status(201).json({
    ok: true,
    data: {
      client_id: doc.client_id,
      waba_id: doc.waba_id,
      phone_number_id: doc.phone_number_id,
      mode: doc.mode,
      status: doc.status,
      has_token: true,
      webhook_subscribed: subscribe?.ok === true,
      dataset_id: dataset?.datasetId || '',
      dataset_source: dataset?.source || doc.dataset_source || '',
    },
  });
}));

router.post('/whatsapp/accounts/disconnect', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const WhatsAppConversionsService = require('../services/saas/WhatsAppConversionsService');
  const data = await WhatsAppConversionsService.disconnectCloudAccount(req.tenant.clientId);
  res.json({ ok: true, data });
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
      dataset_id: doc.dataset_id || '',
      dataset_linked_at: doc.dataset_linked_at || null,
      last_conversion_at: doc.last_conversion_at || null,
      last_conversion_event_name: doc.last_conversion_event_name || '',
      updated_at: doc.updated_at,
    },
  });
}));

/** WhatsApp Conversions API (Events Manager) — dataset + test events. */
router.get('/whatsapp/conversions/status', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const WhatsAppConversionsService = require('../services/saas/WhatsAppConversionsService');
  const data = await WhatsAppConversionsService.getConversionsStatus(req.tenant.clientId);
  res.json({ ok: true, data });
}));

router.post('/whatsapp/conversions/dataset', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const WhatsAppConversionsService = require('../services/saas/WhatsAppConversionsService');
  try {
    const force = req.body?.force !== false; // default true: always bind to this client's WABA dataset
    const data = await WhatsAppConversionsService.ensureDataset(req.tenant.clientId, { force });
    res.json({ ok: true, data });
  } catch (err) {
    const status = err.status || 500;
    res.status(status).json({ ok: false, message: err.message, meta: err.meta || null });
  }
}));

router.post('/whatsapp/conversions/decommission', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const WhatsAppConversionsService = require('../services/saas/WhatsAppConversionsService');
  const data = await WhatsAppConversionsService.decommissionDataset(req.tenant.clientId);
  res.json({ ok: true, data });
}));

router.post('/whatsapp/conversions/test-event', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const WhatsAppConversionsService = require('../services/saas/WhatsAppConversionsService');
  try {
    const data = await WhatsAppConversionsService.sendConversionEvent(req.tenant.clientId, {
      eventName: req.body?.eventName || req.body?.event_name || 'LeadSubmitted',
      ctwaClid: req.body?.ctwaClid || req.body?.ctwa_clid || '',
      contactWaId: req.body?.contactWaId || req.body?.contact_wa_id || '',
      currency: req.body?.currency || 'ZAR',
      value: req.body?.value,
    });
    res.json({ ok: true, data });
  } catch (err) {
    try {
      const SaasWhatsAppAccount = require('../models/SaasWhatsAppAccount');
      await SaasWhatsAppAccount.updateOne(
        { client_id: req.tenant.clientId, status: 'active' },
        { $set: { last_conversion_error: String(err.message || '').slice(0, 500) } }
      );
    } catch {
      /* ignore */
    }
    const status = err.status || 500;
    res.status(status).json({ ok: false, message: err.message, meta: err.meta || null });
  }
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
  const q = String(req.query.q || req.query.search || '').trim();
  const stage = String(req.query.stage || '').trim();
  const label = String(req.query.label || '').trim();
  const assignee = String(req.query.assignee || '').trim();
  const unreadOnly =
    req.query.unread === '1' ||
    req.query.unread === 'true' ||
    String(req.query.unread_only || '').toLowerCase() === 'true';
  const assigneeMemberId =
    String(req.tenant?.userId || req.teamSession?.member?._id || '').trim();
  const threads = await WhatsAppInboxService.listThreads(req.tenant.clientId, {
    limit,
    q,
    stage,
    label,
    assignee,
    assigneeMemberId,
    unreadOnly,
  });
  res.json({ ok: true, data: { threads } });
}));

router.patch(
  '/whatsapp/inbox/threads/:contactWaId',
  requireRoles('owner', 'manager', 'operator'),
  wrapRoute(async (req, res) => {
    const data = await WhatsAppInboxService.updateThreadMeta(
      req.tenant.clientId,
      req.params.contactWaId,
      req.body || {}
    );
    res.json({ ok: true, data });
  })
);

router.get(
  '/whatsapp/inbox/threads/:contactWaId/notes',
  requireRoles('owner', 'manager', 'operator', 'viewer'),
  wrapRoute(async (req, res) => {
    const notes = await WhatsAppInboxService.listThreadNotes(
      req.tenant.clientId,
      req.params.contactWaId
    );
    res.json({ ok: true, data: { notes } });
  })
);

router.post(
  '/whatsapp/inbox/threads/:contactWaId/notes',
  requireRoles('owner', 'manager', 'operator'),
  wrapRoute(async (req, res) => {
    const memberId = String(req.tenant?.userId || req.teamSession?.member?._id || '').trim();
    const name = String(
      req.teamSession?.member?.displayName ||
        [req.teamSession?.member?.firstName, req.teamSession?.member?.lastName].filter(Boolean).join(' ') ||
        req.tenant?.role ||
        'Team'
    ).trim();
    const note = await WhatsAppInboxService.createThreadNote(
      req.tenant.clientId,
      req.params.contactWaId,
      req.body || {},
      { memberId, name }
    );
    res.status(201).json({ ok: true, data: note });
  })
);

router.delete(
  '/whatsapp/inbox/threads/:contactWaId/notes/:noteId',
  requireRoles('owner', 'manager', 'operator'),
  wrapRoute(async (req, res) => {
    const data = await WhatsAppInboxService.deleteThreadNote(
      req.tenant.clientId,
      req.params.contactWaId,
      req.params.noteId,
      {
        memberId: String(req.tenant?.userId || req.teamSession?.member?._id || '').trim(),
        role: req.tenant?.role,
      }
    );
    res.json({ ok: true, data });
  })
);

router.get('/whatsapp/templates', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const status = String(req.query.status || '').trim();
  const templates = await WhatsAppInboxService.listMessageTemplates(req.tenant.clientId, { status });
  res.json({ ok: true, data: { templates } });
}));

router.post('/whatsapp/templates/sync', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const data = await WhatsAppInboxService.syncMessageTemplates(req.tenant.clientId);
  res.json({ ok: true, data });
}));

router.get('/whatsapp/inbox/auto-rules', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const rules = await WhatsAppInboxService.listAutoRules(req.tenant.clientId);
  res.json({ ok: true, data: { rules } });
}));

router.post('/whatsapp/inbox/auto-rules', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const rule = await WhatsAppInboxService.createAutoRule(req.tenant.clientId, req.body || {});
  res.status(201).json({ ok: true, data: rule });
}));

router.patch('/whatsapp/inbox/auto-rules/:id', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const rule = await WhatsAppInboxService.updateAutoRule(req.tenant.clientId, req.params.id, req.body || {});
  res.json({ ok: true, data: rule });
}));

router.delete('/whatsapp/inbox/auto-rules/:id', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const data = await WhatsAppInboxService.deleteAutoRule(req.tenant.clientId, req.params.id);
  res.json({ ok: true, data });
}));

router.get('/whatsapp/inbox/broadcasts', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const broadcasts = await WhatsAppInboxService.listBroadcasts(req.tenant.clientId);
  res.json({ ok: true, data: { broadcasts } });
}));

router.get('/whatsapp/inbox/broadcasts/:id', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const broadcast = await WhatsAppInboxService.getBroadcast(req.tenant.clientId, req.params.id);
  res.json({ ok: true, data: broadcast });
}));

router.post('/whatsapp/inbox/broadcasts', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const data = await WhatsAppInboxService.createBroadcast(
    req.tenant.clientId,
    req.body || {},
    {
      memberId: String(req.tenant?.userId || '').trim(),
      userId: String(req.tenant?.userId || '').trim(),
      role: req.tenant?.role,
    }
  );
  res.status(202).json({ ok: true, data });
}));

router.get('/whatsapp/inbox/unread', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await WhatsAppInboxService.getUnreadSummary(req.tenant.clientId);
  res.json({ ok: true, data });
}));

router.get('/whatsapp/inbox/window-alerts', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const { processWindowCloseAlertsForClient } = require('../helpers/whatsappWindowCloseAlerts');
  const data = await processWindowCloseAlertsForClient(req.tenant.clientId, { dryRun: true });
  res.json({ ok: true, data });
}));

router.post('/whatsapp/inbox/window-alerts/run', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const { processWindowCloseAlertsForClient } = require('../helpers/whatsappWindowCloseAlerts');
  const data = await processWindowCloseAlertsForClient(req.tenant.clientId, { dryRun: false });
  res.json({ ok: true, data });
}));

router.get('/whatsapp/inbox/assignees', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const assignees = await WhatsAppInboxService.listAssignees(req.tenant.clientId);
  res.json({ ok: true, data: { assignees } });
}));

router.get('/whatsapp/inbox/canned', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const replies = await WhatsAppInboxService.listCannedReplies(req.tenant.clientId);
  res.json({ ok: true, data: { replies } });
}));

router.post('/whatsapp/inbox/canned', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const reply = await WhatsAppInboxService.createCannedReply(req.tenant.clientId, req.body || {});
  res.status(201).json({ ok: true, data: reply });
}));

router.delete('/whatsapp/inbox/canned/:id', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const data = await WhatsAppInboxService.deleteCannedReply(req.tenant.clientId, req.params.id);
  res.json({ ok: true, data });
}));

router.get('/whatsapp/inbox/contact-context/:contactWaId', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await WhatsAppInboxService.getContactContext(req.tenant.clientId, req.params.contactWaId);
  res.json({ ok: true, data });
}));

router.put(
  '/whatsapp/inbox/customers/:customerId',
  requireRoles('owner', 'manager', 'operator'),
  wrapRoute(async (req, res) => {
    const data = await WhatsAppInboxService.updateCustomer(
      req.tenant.clientId,
      req.params.customerId,
      req.body || {}
    );
    res.json({ ok: true, data });
  })
);

router.get('/whatsapp/inbox/customers/:customerId', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await WhatsAppInboxService.getCustomerSummary(req.tenant.clientId, req.params.customerId);
  res.json({ ok: true, data });
}));

router.put('/whatsapp/inbox/threads/:contactWaId/assign', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const memberId = req.body?.member_id ?? req.body?.memberId ?? '';
  const data = await WhatsAppInboxService.assignThread({
    clientId: req.tenant.clientId,
    contactWaId: req.params.contactWaId,
    memberId,
  });
  res.json({ ok: true, data });
}));

router.post(
  '/whatsapp/inbox/contacts/:contactWaId/customer',
  requireRoles('owner', 'manager', 'operator'),
  wrapRoute(async (req, res) => {
    const data = await WhatsAppInboxService.createCustomerFromContact(
      req.tenant.clientId,
      req.params.contactWaId,
      req.body || {}
    );
    res.status(201).json({ ok: true, data });
  })
);

router.get('/whatsapp/inbox/threads/:contactWaId', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const limit = Number(req.query.limit) || 100;
  const thread = await WhatsAppInboxService.getThread(req.tenant.clientId, req.params.contactWaId, { limit });
  res.json({ ok: true, data: thread });
}));

router.post(
  '/whatsapp/inbox/threads/:contactWaId/template',
  requireRoles('owner', 'manager', 'operator'),
  idempotencyGuard('saas.whatsapp.inbox.template'),
  wrapRoute(async (req, res) => {
    const templateName = req.body?.templateName || req.body?.template_name || 'hello_world';
    const language = req.body?.language || req.body?.template_language || '';
    const components = req.body?.components;
    const data = await WhatsAppInboxService.sendInboxTemplate({
      clientId: req.tenant.clientId,
      contactWaId: req.params.contactWaId,
      templateName,
      language,
      components,
    });
    res.status(202).json({ ok: true, data });
  })
);

router.get('/whatsapp/inbox/messages/:wamid/media', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const media = await WhatsAppInboxService.downloadMessageMedia(req.tenant.clientId, req.params.wamid);
  res.setHeader('Content-Type', media.mimeType);
  res.setHeader('Content-Length', media.buffer.length);
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (media.filename) {
    res.setHeader('Content-Disposition', `inline; filename="${String(media.filename).replace(/"/g, '')}"`);
  }
  res.send(media.buffer);
}));

router.delete('/whatsapp/inbox/messages/:wamid', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const deletedBy =
    req.tenant?.userId ||
    req.teamSession?.member?.email ||
    req.tenant?.role ||
    '';
  const data = await WhatsAppInboxService.deleteMessage(req.tenant.clientId, req.params.wamid, {
    deletedBy: String(deletedBy),
  });
  res.json({ ok: true, data });
}));

router.delete(
  '/whatsapp/inbox/threads/:contactWaId',
  requireRoles('owner', 'manager', 'operator'),
  wrapRoute(async (req, res) => {
    const deletedBy =
      req.tenant?.userId ||
      req.teamSession?.member?.email ||
      req.tenant?.role ||
      '';
    const data = await WhatsAppInboxService.deleteThread(req.tenant.clientId, req.params.contactWaId, {
      deletedBy: String(deletedBy),
    });
    res.json({ ok: true, data });
  })
);

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

router.post('/whatsapp/inbox/product', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const to = req.body?.to || req.body?.contact_wa_id || req.body?.contactWaId;
  const productId = req.body?.productId || req.body?.product_id;
  const data = await WhatsAppInboxService.sendProductShare({
    clientId: req.tenant.clientId,
    to,
    productId,
  });
  res.status(202).json({ ok: true, data });
}));

router.get('/whatsapp/inbox/stats', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const days = req.query.days || 30;
  const data = await WhatsAppInboxService.getInboxStats({
    clientId: req.tenant.clientId,
    days,
  });
  res.json({ ok: true, data });
}));

router.post(
  '/whatsapp/inbox/media',
  requireRoles('owner', 'manager', 'operator'),
  inboxUpload.single('file'),
  wrapRoute(async (req, res) => {
    const to = req.body?.to || req.body?.contact_wa_id || req.body?.contactWaId;
    if (!req.file) {
      return res.status(400).json({ ok: false, message: 'file is required' });
    }
    const data = await WhatsAppInboxService.sendMediaReply({
      clientId: req.tenant.clientId,
      to,
      fileBuffer: req.file.buffer,
      mimeType: req.file.mimetype,
      filename: req.file.originalname,
      caption: req.body?.caption || req.body?.text || '',
    });
    res.status(202).json({ ok: true, data });
  })
);

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

router.get('/crm/board', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await CrmWorkspaceService.getBoard(req.tenant.clientId);
  res.json({ ok: true, data });
}));

router.put('/crm/stages', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const { stages } = req.body || {};
  const data = await CrmWorkspaceService.upsertStages(req.tenant.clientId, stages);
  res.json({ ok: true, data });
}));

router.post('/crm/opportunities', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.title) {
    return res.status(400).json({ ok: false, message: 'title is required' });
  }
  const data = await CrmWorkspaceService.createOpportunity(req.tenant.clientId, body, {
    userId: req.tenant.userId,
    name: String(body.owner_name || ''),
  });
  res.status(201).json({ ok: true, data });
}));

router.patch('/crm/opportunities/:id', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const data = await CrmWorkspaceService.updateOpportunity(req.tenant.clientId, req.params.id, req.body || {});
  res.json({ ok: true, data });
}));

router.get('/crm/tasks', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await CrmWorkspaceService.listTasks(req.tenant.clientId, {
    status: req.query.status,
    due: req.query.due,
  });
  res.json({ ok: true, data });
}));

router.post('/crm/tasks', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const body = req.body || {};
  if (!body.title) {
    return res.status(400).json({ ok: false, message: 'title is required' });
  }
  const data = await CrmWorkspaceService.createTask(req.tenant.clientId, body, {
    userId: req.tenant.userId,
    name: String(body.assignee_name || ''),
  });
  res.status(201).json({ ok: true, data });
}));

router.patch('/crm/tasks/:id', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  const data = await CrmWorkspaceService.updateTask(req.tenant.clientId, req.params.id, req.body || {});
  res.json({ ok: true, data });
}));

router.get('/crm/templates', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (_req, res) => {
  const data = await CrmWorkspaceService.getVerticalTemplates();
  res.json({ ok: true, data });
}));

router.post('/crm/templates/apply', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const { vertical } = req.body || {};
  if (!vertical) {
    return res.status(400).json({ ok: false, message: 'vertical is required' });
  }
  const data = await CrmWorkspaceService.applyVerticalTemplate(req.tenant.clientId, vertical, {
    actorName: String(req.body?.assignee_name || ''),
  });
  res.json({ ok: true, data });
}));

router.get('/crm/export.csv', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const type = String(req.query.type || 'opportunities');
  const csv = await CrmWorkspaceService.exportCsv(req.tenant.clientId, type);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="crm-${type}.csv"`);
  res.status(200).send(csv);
}));

router.post('/crm/reminders/run', requireRoles('owner', 'manager'), wrapRoute(async (_req, res) => {
  const data = await CrmWorkspaceService.processRemindersTick({});
  res.json({ ok: true, data });
}));

router.get('/meta/oauth/start', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const url = MetaOAuthService.buildAuthorizeUrl(req.tenant.clientId);
  const debug = MetaOAuthService.getAuthorizeDebug();
  res.json({ ok: true, data: { url, ...debug } });
}));

router.get('/meta/oauth/status', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await MetaOAuthService.getConnectionStatus(req.tenant.clientId);
  res.json({ ok: true, data });
}));

router.get('/meta/app-permissions', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const { APPROVED_PERMISSIONS, PENDING_PERMISSIONS, META_BUSINESS_ADMIN_HELP } = require('../helpers/metaAppPermissions');
  const ApiMonitorService = require('../services/saas/ApiMonitorService');
  const [status, monitor] = await Promise.all([
    MetaOAuthService.getConnectionStatus(req.tenant.clientId),
    ApiMonitorService.getSummary({ clientId: req.tenant.clientId, days: 7 }),
  ]);
  res.json({
    ok: true,
    data: {
      approved: APPROVED_PERMISSIONS,
      pending: PENDING_PERMISSIONS,
      connection: status,
      metaBusinessAdminHelp: META_BUSINESS_ADMIN_HELP,
      monitor,
    },
  });
}));

router.get('/api-monitor/summary', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const ApiMonitorService = require('../services/saas/ApiMonitorService');
  const days = req.query.days;
  const data = await ApiMonitorService.getSummary({
    clientId: req.tenant.clientId,
    days,
  });
  res.json({ ok: true, data });
}));

router.get('/api-monitor/events', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const ApiMonitorService = require('../services/saas/ApiMonitorService');
  const days = Math.min(Math.max(Number(req.query.days || 7), 1), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const data = await ApiMonitorService.listEvents({
    clientId: req.tenant.clientId,
    integration: req.query.integration,
    outcome: req.query.outcome,
    cause: req.query.cause,
    limit: req.query.limit,
    since,
  });
  res.json({ ok: true, data });
}));

router.post('/meta/oauth/disconnect', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const data = await MetaOAuthService.disconnect(req.tenant.clientId);
  res.json({ ok: true, data });
}));

router.get('/meta/pages', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await MetaAdsService.listPages(req.tenant.clientId);
  res.json({ ok: true, data });
}));

router.get('/meta/ad-accounts', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await MetaAdsService.listAdAccounts(req.tenant.clientId);
  res.json({ ok: true, data });
}));

router.put('/meta/selection', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const { page_id: pageId, ad_account_id: adAccountId } = req.body || {};
  if (!pageId && !adAccountId) {
    return res.status(400).json({ ok: false, message: 'page_id or ad_account_id is required' });
  }
  const data = await MetaAdsService.updateSelection(req.tenant.clientId, { pageId, adAccountId });
  res.json({ ok: true, data });
}));

router.get('/meta/posts', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const limit = req.query.limit;
  try {
    const data = await MetaAdsService.listPagePosts(req.tenant.clientId, { limit });
    // Permission soft-fails return posts: [] + error — still 200 so UI can show the hint.
    res.json({ ok: true, data });
  } catch (err) {
    res.status(400).json({
      ok: false,
      message: err.message || 'Could not load Page posts',
      data: { posts: [], error: err.message || 'Could not load Page posts' },
    });
  }
}));

router.get('/meta/organic-posts', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const limit = req.query.limit;
  const data = await MetaAdsService.listOrganicPosts(req.tenant.clientId, { limit });
  res.json({ ok: true, data });
}));

router.post('/meta/publish', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  try {
    const body = req.body || {};
    const mediaType = String(body.mediaType || body.media_type || 'IMAGE').toUpperCase();
    const imageUrls = Array.isArray(body.imageUrls)
      ? body.imageUrls
      : Array.isArray(body.image_urls)
        ? body.image_urls
        : [];
    const destinations = body.destinations || body.destination || ['instagram'];
    const data = await MetaAdsService.publishSocialPost(req.tenant.clientId, {
      destinations,
      mediaType,
      imageUrl: body.imageUrl || body.image_url || '',
      videoUrl: body.videoUrl || body.video_url || '',
      imageUrls,
      caption: body.caption || '',
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
}));

router.post('/meta/facebook/publish', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  try {
    const body = req.body || {};
    const mediaType = String(body.mediaType || body.media_type || 'IMAGE').toUpperCase();
    const imageUrls = Array.isArray(body.imageUrls)
      ? body.imageUrls
      : Array.isArray(body.image_urls)
        ? body.image_urls
        : [];
    const data = await MetaAdsService.publishFacebookPagePost(req.tenant.clientId, {
      mediaType,
      imageUrl: body.imageUrl || body.image_url || '',
      videoUrl: body.videoUrl || body.video_url || '',
      imageUrls,
      caption: body.caption || '',
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
}));

router.get('/meta/social-posts', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const SaasSocialPost = require('../models/SaasSocialPost');
  const rows = await SaasSocialPost.find({ client_id: req.tenant.clientId })
    .sort({ scheduledFor: -1, createdAt: -1 })
    .limit(50)
    .lean();
  res.json({
    ok: true,
    data: {
      posts: rows.map((p) => ({
        id: String(p._id),
        destinations: p.destinations,
        mediaType: p.mediaType,
        caption: p.caption,
        imageUrls: p.imageUrls,
        videoUrl: p.videoUrl,
        status: p.status,
        scheduledFor: p.scheduledFor,
        publishedAt: p.publishedAt,
        results: p.results,
        lastError: p.lastError,
        createdAt: p.createdAt,
      })),
    },
  });
}));

router.post('/meta/social-posts/schedule', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const SaasSocialPost = require('../models/SaasSocialPost');
  const body = req.body || {};
  const when = body.scheduledFor ? new Date(body.scheduledFor) : null;
  if (!when || Number.isNaN(when.getTime())) {
    return res.status(400).json({ ok: false, message: 'scheduledFor must be a valid date/time' });
  }
  if (when.getTime() < Date.now() + 30 * 1000) {
    return res.status(400).json({
      ok: false,
      message: 'Choose a time at least 30 seconds in the future, or publish now',
    });
  }

  const destinationsRaw = body.destinations || body.destination || ['instagram'];
  const destinations = (Array.isArray(destinationsRaw) ? destinationsRaw : [destinationsRaw])
    .map((d) => String(d || '').toLowerCase())
    .filter((d) => d === 'facebook' || d === 'instagram' || d === 'both');
  const normalized = destinations.includes('both')
    ? ['facebook', 'instagram']
    : [...new Set(destinations.length ? destinations : ['instagram'])];

  const imageUrls = Array.isArray(body.imageUrls)
    ? body.imageUrls.map((u) => String(u || '').trim()).filter(Boolean)
    : body.imageUrl
      ? [String(body.imageUrl).trim()]
      : [];

  const post = await SaasSocialPost.create({
    client_id: req.tenant.clientId,
    destinations: normalized,
    mediaType: String(body.mediaType || 'IMAGE').toUpperCase(),
    caption: String(body.caption || ''),
    imageUrls,
    videoUrl: String(body.videoUrl || ''),
    status: 'scheduled',
    scheduledFor: when,
  });

  try {
    const { getAgenda, isAgendaReady, isSchedulerDisabled, JOB_NAMES } = require('../config/agenda');
    if (isSchedulerDisabled() || !isAgendaReady()) {
      await SaasSocialPost.deleteOne({ _id: post._id });
      return res.status(503).json({
        ok: false,
        message:
          'Job scheduler is not running. Enable it on the server to schedule posts, or publish now.',
      });
    }
    const agenda = getAgenda();
    const job = agenda.create(JOB_NAMES.SOCIAL_POST, {
      clientId: req.tenant.clientId,
      postId: String(post._id),
    });
    job.schedule(when);
    await job.save();
    post.agendaJobId = String(job.attrs._id);
    await post.save();
  } catch (err) {
    await SaasSocialPost.deleteOne({ _id: post._id });
    return res.status(500).json({ ok: false, message: err.message || 'Failed to schedule post' });
  }

  res.status(201).json({
    ok: true,
    message: `Post scheduled for ${when.toISOString()}`,
    data: {
      id: String(post._id),
      status: post.status,
      scheduledFor: post.scheduledFor,
      destinations: post.destinations,
    },
  });
}));

router.delete('/meta/social-posts/:id/schedule', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const SaasSocialPost = require('../models/SaasSocialPost');
  const post = await SaasSocialPost.findOne({
    _id: req.params.id,
    client_id: req.tenant.clientId,
  });
  if (!post) return res.status(404).json({ ok: false, message: 'Scheduled post not found' });

  try {
    const { getAgenda, isAgendaReady, JOB_NAMES } = require('../config/agenda');
    if (isAgendaReady()) {
      await getAgenda().cancel({
        name: JOB_NAMES.SOCIAL_POST,
        'data.postId': String(post._id),
        'data.clientId': req.tenant.clientId,
      });
    }
  } catch (err) {
    console.warn('[meta social] cancel schedule:', err.message);
  }

  post.status = 'cancelled';
  post.agendaJobId = '';
  await post.save();
  res.json({ ok: true, message: 'Schedule cancelled', data: { id: String(post._id) } });
}));

router.get('/meta/instagram/media', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const limit = req.query.limit;
  const data = await MetaAdsService.listInstagramMedia(req.tenant.clientId, { limit });
  res.json({ ok: true, data });
}));

router.post('/meta/instagram/publish', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  try {
    const body = req.body || {};
    const mediaType = String(body.mediaType || body.media_type || 'IMAGE').toUpperCase();
    const imageUrls = Array.isArray(body.imageUrls)
      ? body.imageUrls
      : Array.isArray(body.image_urls)
        ? body.image_urls
        : [];
    const data = await MetaAdsService.publishInstagramMedia(req.tenant.clientId, {
      mediaType,
      imageUrl: body.imageUrl || body.image_url || '',
      videoUrl: body.videoUrl || body.video_url || '',
      imageUrls,
      caption: body.caption || '',
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
}));

router.post(
  '/meta/instagram/upload',
  requireRoles('owner', 'manager'),
  instagramMediaUpload.array('files', 10),
  wrapRoute(async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ ok: false, message: 'At least one image or video file is required' });
    }

    const { uploadPublicAsset } = require('../helpers/publicAssetUpload');
    const crypto = require('crypto');
    const path = require('path');
    const uploaded = [];

    for (const file of files) {
      const mime = String(file.mimetype || '').toLowerCase();
      const isVideo = mime.startsWith('video/');
      const isImage = mime.startsWith('image/');
      if (!isVideo && !isImage) {
        return res.status(400).json({
          ok: false,
          message: `Unsupported file type: ${file.originalname || mime || 'unknown'}`,
        });
      }
      const ext =
        path.extname(file.originalname || '') ||
        (isVideo ? '.mp4' : '.jpg');
      const safeExt = String(ext).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 8) || (isVideo ? '.mp4' : '.jpg');
      const repoPath = `public/uploads/instagram/${req.tenant.clientId}/${Date.now()}-${crypto
        .randomBytes(4)
        .toString('hex')}${safeExt.startsWith('.') ? safeExt : `.${safeExt}`}`;

      const asset = await uploadPublicAsset(file.buffer, repoPath, req, {
        resourceType: isVideo ? 'video' : 'image',
      });
      uploaded.push({
        url: asset.url,
        fileName: asset.fileName || file.originalname || 'upload',
        mediaKind: isVideo ? 'video' : 'image',
        storage: asset.storage,
        mime,
        size: file.size,
      });
    }

    res.status(201).json({
      ok: true,
      data: {
        files: uploaded,
        imageUrls: uploaded.filter((f) => f.mediaKind === 'image').map((f) => f.url),
        videoUrl: uploaded.find((f) => f.mediaKind === 'video')?.url || '',
      },
    });
  })
);

/**
 * Publish files selected in Khana:
 * - images are persisted using the existing Cloudinary → GitHub fallback
 * - videos/Reels are uploaded directly to Meta (resumable upload)
 */
router.post(
  '/meta/instagram/publish-upload',
  requireRoles('owner', 'manager'),
  instagramMediaUpload.array('files', 10),
  wrapRoute(async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ ok: false, message: 'At least one image or video is required' });
    }

    const mediaType = String(req.body?.mediaType || req.body?.media_type || 'IMAGE').toUpperCase();
    const caption = String(req.body?.caption || '');

    try {
      if (mediaType === 'VIDEO' || mediaType === 'REELS') {
        if (files.length !== 1 || !String(files[0].mimetype || '').startsWith('video/')) {
          return res.status(400).json({
            ok: false,
            message: 'Select exactly one video for a feed video or Reel',
          });
        }
        const data = await MetaAdsService.publishInstagramVideoBuffer(req.tenant.clientId, {
          buffer: files[0].buffer,
          mediaType,
          caption,
          contentType: files[0].mimetype,
        });
        return res.json({ ok: true, data });
      }

      const imageFiles = files.filter((file) =>
        String(file.mimetype || '').toLowerCase().startsWith('image/')
      );
      if (imageFiles.length !== files.length) {
        return res.status(400).json({ ok: false, message: 'Photo posts only accept image files' });
      }
      if (mediaType === 'CAROUSEL' && (imageFiles.length < 2 || imageFiles.length > 10)) {
        return res.status(400).json({
          ok: false,
          message: 'Instagram carousels require 2–10 images',
        });
      }

      const { uploadPublicAsset } = require('../helpers/publicAssetUpload');
      const crypto = require('crypto');
      const path = require('path');
      const imageUrls = [];
      for (const file of imageFiles) {
        const ext = path.extname(file.originalname || '') || '.jpg';
        const safeExt = String(ext).replace(/[^.a-zA-Z0-9]/g, '').slice(0, 8) || '.jpg';
        const repoPath = `public/uploads/instagram/${req.tenant.clientId}/${Date.now()}-${crypto
          .randomBytes(4)
          .toString('hex')}${safeExt.startsWith('.') ? safeExt : `.${safeExt}`}`;
        const asset = await uploadPublicAsset(file.buffer, repoPath, req, {
          resourceType: 'image',
        });
        imageUrls.push(asset.url);
      }

      const data = await MetaAdsService.publishInstagramMedia(req.tenant.clientId, {
        mediaType: imageUrls.length > 1 ? 'CAROUSEL' : 'IMAGE',
        imageUrl: imageUrls[0],
        imageUrls,
        caption,
      });
      return res.json({ ok: true, data });
    } catch (err) {
      return res.status(400).json({ ok: false, message: err.message });
    }
  })
);

router.post('/meta/pixel/test-event', requireRoles('owner', 'manager', 'operator'), wrapRoute(async (req, res) => {
  try {
    const data = await MetaAdsService.sendPixelTestEvent(req.tenant.clientId, {
      eventName: req.body?.eventName || req.body?.event_name || 'LeadSubmitted',
      testEventCode: req.body?.testEventCode || req.body?.test_event_code || '',
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(400).json({ ok: false, message: err.message });
  }
}));

router.get('/meta/insights', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const days = req.query.days;
  const data = await MetaAdsService.getInsights(req.tenant.clientId, { days });
  res.json({ ok: true, data });
}));

router.post('/meta/boost', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const {
    post_id: postId,
    daily_budget: dailyBudget,
    days,
    country,
    status,
    targeting,
    source,
  } = req.body || {};
  if (!postId || dailyBudget == null) {
    return res.status(400).json({ ok: false, message: 'post_id and daily_budget are required' });
  }
  const data = await MetaAdsService.boostPost(req.tenant.clientId, {
    postId,
    dailyBudget,
    days,
    country,
    status,
    source,
    targeting: targeting && typeof targeting === 'object' ? targeting : {},
  });
  res.status(201).json({ ok: true, data });
}));

router.get('/meta/targeting/search', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const { q, type, limit, country_code: countryCode } = req.query || {};
  let locationTypes;
  if (req.query.location_types) {
    try {
      locationTypes = JSON.parse(String(req.query.location_types));
    } catch {
      locationTypes = String(req.query.location_types).split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  const data = await MetaAdsService.searchTargeting(req.tenant.clientId, {
    q,
    type,
    limit,
    locationTypes,
    countryCode,
  });
  res.json({ ok: true, data });
}));

router.get('/meta/custom-audiences', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await MetaAdsService.listCustomAudiences(req.tenant.clientId);
  res.json({ ok: true, data });
}));

router.get('/meta/setup', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await MetaAdsAdvancedService.getSetupHub(req.tenant.clientId);
  res.json({ ok: true, data });
}));

router.get('/meta/campaigns', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await MetaAdsAdvancedService.listLocalCampaigns(req.tenant.clientId);
  res.json({ ok: true, data });
}));

router.post('/meta/campaigns/:id/status', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ ok: false, message: 'status is required' });
  const data = await MetaAdsAdvancedService.updateCampaignStatus(req.tenant.clientId, {
    campaignId: req.params.id,
    status,
  });
  res.json({ ok: true, data });
}));

router.post('/meta/campaigns/:id/budget', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const { daily_budget: dailyBudget } = req.body || {};
  if (dailyBudget == null) return res.status(400).json({ ok: false, message: 'daily_budget is required' });
  const data = await MetaAdsAdvancedService.updateCampaignBudget(req.tenant.clientId, {
    campaignId: req.params.id,
    dailyBudget,
  });
  res.json({ ok: true, data });
}));

router.get('/meta/audience-presets', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  res.json({ ok: true, data: { presets: MetaAdsAdvancedService.AUDIENCE_PRESETS } });
}));

router.get('/meta/custom-audiences/preview', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await MetaAdsAdvancedService.previewCustomAudienceFromCustomers(req.tenant.clientId, {
    preset: req.query.preset,
  });
  res.json({ ok: true, data });
}));

router.post('/meta/custom-audiences/from-customers', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const { name, preset, description } = req.body || {};
  const data = await MetaAdsAdvancedService.createCustomAudienceFromCustomers(req.tenant.clientId, {
    name,
    preset,
    description,
  });
  res.status(201).json({ ok: true, data });
}));

router.get('/meta/insights/breakdowns', requireRoles('owner', 'manager', 'operator', 'viewer'), wrapRoute(async (req, res) => {
  const data = await MetaAdsAdvancedService.getInsightBreakdowns(req.tenant.clientId, {
    days: req.query.days,
    breakdown: req.query.breakdown,
  });
  res.json({ ok: true, data });
}));

router.post(
  '/meta/creatives/image',
  requireRoles('owner', 'manager'),
  inboxUpload.single('image'),
  wrapRoute(async (req, res) => {
    if (!req.file?.buffer) {
      return res.status(400).json({ ok: false, message: 'image file is required' });
    }
    const data = await MetaAdsAdvancedService.uploadAdImage(req.tenant.clientId, {
      buffer: req.file.buffer,
      filename: req.file.originalname || 'creative.jpg',
    });
    res.status(201).json({ ok: true, data });
  })
);

router.post('/meta/campaigns/whatsapp', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const body = req.body || {};
  const data = await MetaAdsAdvancedService.createClickToWhatsAppCampaign(req.tenant.clientId, {
    name: body.name,
    dailyBudget: body.daily_budget,
    days: body.days,
    message: body.message,
    country: body.country,
    targeting: body.targeting,
    status: body.status,
    imageHash: body.image_hash,
    imageUrl: body.image_url,
  });
  res.status(201).json({ ok: true, data });
}));

router.post('/meta/campaigns/lead', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const body = req.body || {};
  const data = await MetaAdsAdvancedService.createLeadAd(req.tenant.clientId, {
    name: body.name,
    dailyBudget: body.daily_budget,
    days: body.days,
    country: body.country,
    targeting: body.targeting,
    status: body.status,
    imageHash: body.image_hash,
    headline: body.headline,
    body: body.body,
    privacyPolicyUrl: body.privacy_policy_url,
    thankYouMessage: body.thank_you_message,
  });
  res.status(201).json({ ok: true, data });
}));

router.post('/meta/catalog/sync', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const data = await MetaAdsAdvancedService.syncProductCatalog(req.tenant.clientId, {
    limit: req.body?.limit,
  });
  res.json({ ok: true, data });
}));

router.post('/meta/campaigns/catalog', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const body = req.body || {};
  const data = await MetaAdsAdvancedService.createCatalogSalesCampaign(req.tenant.clientId, {
    name: body.name,
    dailyBudget: body.daily_budget,
    days: body.days,
    country: body.country,
    targeting: body.targeting,
    status: body.status,
  });
  res.status(201).json({ ok: true, data });
}));

router.post('/meta/refresh-token', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const data = await MetaAdsService.forceRefreshToken(req.tenant.clientId);
  res.json({ ok: true, data });
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

  const volumeSchedule = PricingService.getWhatsAppVolumeSchedule();
  let utilityCreditsPerMessage = utilityRule
    ? Number(
        (
          Number(utilityRule.cost_per_unit || 0) *
          (1 + Number(utilityRule.markup_percentage || 0) / 100)
        ).toFixed(4)
      )
    : null;
  try {
    const priced = await PricingService.computeWhatsAppCredits(clientId, 'utility', 1, utilityRule);
    utilityCreditsPerMessage = priced.unitRate;
  } catch {
    /* keep list price */
  }

  res.json({
    ok: true,
    data: {
      account,
      recentTransactions: recent,
      whatsapp: {
        usage: whatsappUsage,
        recentDeductions: whatsappDeductions.slice(0, 10),
        utilityCreditsPerMessage,
        utilityVolumeTiers: volumeSchedule.utility,
        volumeSchedule: volumeSchedule.descriptions,
      },
    },
  });
}));

router.post('/billing/topup/manual', requireRoles('owner', 'manager'), wrapRoute(async (req, res) => {
  const { credits, amount, reference, client_id } = req.body;
  const requested = String(client_id || '').trim();
  if (requested && requested !== String(req.tenant.clientId)) {
    return res.status(403).json({ ok: false, message: 'Cannot credit another workspace' });
  }
  const targetClient = String(req.tenant.clientId);
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

router.post('/admin/whatsapp/inbox/reprocess', adminOnly, wrapRoute(async (req, res) => {
  const limit = Number(req.body?.limit) || 50;
  const onlyUnprocessed = req.body?.onlyUnprocessed !== false;
  const data = await WhatsAppInboxService.reprocessArchivedWebhooks({ limit, onlyUnprocessed });
  res.json({ ok: true, data });
}));

router.post('/admin/whatsapp/inbox/window-alerts/run', adminOnly, wrapRoute(async (req, res) => {
  const { processAllWhatsAppWindowCloseAlerts } = require('../helpers/whatsappWindowCloseAlerts');
  const clientId = String(req.body?.clientId || req.body?.client_id || '').trim();
  const data = await processAllWhatsAppWindowCloseAlerts({ clientId });
  res.json({ ok: true, data });
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
      volumeSchedule: PricingService.getWhatsAppVolumeSchedule(),
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

router.get('/admin/api-monitor/summary', adminOnly, wrapRoute(async (req, res) => {
  const ApiMonitorService = require('../services/saas/ApiMonitorService');
  const data = await ApiMonitorService.getSummary({
    clientId: req.query.client_id || req.query.clientId || '',
    days: req.query.days,
  });
  res.json({ ok: true, data });
}));

router.get('/admin/api-monitor/events', adminOnly, wrapRoute(async (req, res) => {
  const ApiMonitorService = require('../services/saas/ApiMonitorService');
  const days = Math.min(Math.max(Number(req.query.days || 7), 1), 90);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const data = await ApiMonitorService.listEvents({
    clientId: req.query.client_id || req.query.clientId || '',
    integration: req.query.integration,
    outcome: req.query.outcome,
    cause: req.query.cause,
    limit: req.query.limit,
    since,
  });
  res.json({ ok: true, data });
}));

module.exports = router;
