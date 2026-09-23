const axios = require('axios');
const { decrypt } = require('../../helpers/encryption');
const SaasWhatsAppAccount = require('../../models/SaasWhatsAppAccount');
const SaasWhatsAppFlow = require('../../models/SaasWhatsAppFlow');
const Client = require('../../models/client');
const { normalizePhoneE164 } = require('../../helpers/whatsappLink');
const { listFlowStarters, getFlowStarter } = require('../../helpers/whatsappFlowStarters');
const WhatsAppService = require('./WhatsAppService');

const WA_API_BASE = process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com/v25.0';

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function formatMetaError(err) {
  const data = err?.response?.data;
  const metaMsg =
    data?.error?.error_user_msg ||
    data?.error?.message ||
    data?.message ||
    err?.message ||
    'WhatsApp Flows request failed';
  const status = err?.response?.status && err.response.status >= 400 ? err.response.status : 502;
  return httpError(metaMsg, status);
}

async function getAccount(clientId) {
  const account = await SaasWhatsAppAccount.findOne({ client_id: clientId, status: 'active' }).sort({
    updated_at: -1,
  });
  if (!account) {
    throw httpError(
      'No active WhatsApp Cloud API account. Connect WhatsApp first.',
      400
    );
  }
  return account;
}

class WhatsAppFlowsService {
  static listStarters(businessName = 'Business') {
    return listFlowStarters(businessName).map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category,
      description: s.description,
      cta: s.cta,
      body: s.body,
    }));
  }

  static async listFlows(clientId) {
    const rows = await SaasWhatsAppFlow.find({ client_id: clientId }).sort({ updated_at: -1 }).lean();
    return rows.map((r) => ({
      id: String(r._id),
      flow_id: r.flow_id,
      name: r.name,
      status: r.status,
      categories: r.categories || [],
      starter_id: r.starter_id || '',
      cta_default: r.cta_default || 'Open',
      body_default: r.body_default || '',
      published_at: r.published_at,
      synced_at: r.synced_at,
      last_error: r.last_error || '',
    }));
  }

  static async syncFlows(clientId) {
    const account = await getAccount(clientId);
    const wabaId = String(account.waba_id || '').trim();
    const token = decrypt(account.access_token_encrypted);
    const syncedAt = new Date();
    let after = null;
    let fetched = 0;
    const upserted = [];

    do {
      const params = { fields: 'id,name,status,categories', limit: 50 };
      if (after) params.after = after;
      let response;
      try {
        response = await axios.get(`${WA_API_BASE}/${wabaId}/flows`, {
          timeout: 30000,
          headers: { Authorization: `Bearer ${token}` },
          params,
        });
      } catch (err) {
        throw formatMetaError(err);
      }
      const rows = Array.isArray(response.data?.data) ? response.data.data : [];
      for (const row of rows) {
        const flowId = String(row.id || '').trim();
        if (!flowId) continue;
        fetched += 1;
        const doc = await SaasWhatsAppFlow.findOneAndUpdate(
          { client_id: clientId, flow_id: flowId },
          {
            $set: {
              waba_id: wabaId,
              name: String(row.name || flowId).trim(),
              status: String(row.status || '').trim(),
              categories: Array.isArray(row.categories) ? row.categories : [],
              synced_at: syncedAt,
              last_error: '',
            },
          },
          { upsert: true, new: true }
        );
        upserted.push({
          flow_id: doc.flow_id,
          name: doc.name,
          status: doc.status,
        });
      }
      after = response.data?.paging?.cursors?.after || null;
      if (!response.data?.paging?.next) after = null;
    } while (after);

    return { fetched, upserted: upserted.length, flows: upserted, synced_at: syncedAt };
  }

  /**
   * Create (+ optionally publish) a Flow from a Khana starter.
   */
  static async createFromStarter(clientId, { starterId, publish = true, name = '' } = {}) {
    const account = await getAccount(clientId);
    const wabaId = String(account.waba_id || '').trim();
    const token = decrypt(account.access_token_encrypted);
    const client = await Client.findOne({ clientID: clientId }).select('companyName').lean();
    const brand = client?.companyName || clientId;
    const starter = getFlowStarter(starterId, brand);
    if (!starter) {
      throw httpError(
        `Unknown flow starter. Use: ${listFlowStarters().map((s) => s.id).join(', ')}`,
        400
      );
    }

    const flowName = String(name || starter.name).trim().slice(0, 80);
    const payload = {
      name: flowName,
      categories: [starter.category],
      flow_json: JSON.stringify(starter.flow_json),
      publish: publish !== false,
    };

    let response;
    try {
      response = await axios.post(`${WA_API_BASE}/${wabaId}/flows`, payload, {
        timeout: 45000,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      throw formatMetaError(err);
    }

    const flowId = String(response.data?.id || '').trim();
    if (!flowId) throw httpError('Meta did not return a flow id', 502);

    const validationErrors = Array.isArray(response.data?.validation_errors)
      ? response.data.validation_errors
      : [];
    const validationMsg = validationErrors
      .map((e) => e?.message || e?.error || JSON.stringify(e))
      .filter(Boolean)
      .join('; ')
      .slice(0, 500);

    let status = 'DRAFT';
    if (publish !== false && !validationMsg) {
      status = 'PUBLISHED';
    } else if (validationMsg) {
      status = 'DRAFT';
    }

    // Confirm status from Meta when possible.
    try {
      const check = await axios.get(`${WA_API_BASE}/${flowId}`, {
        timeout: 15000,
        headers: { Authorization: `Bearer ${token}` },
        params: { fields: 'id,name,status' },
      });
      if (check.data?.status) status = String(check.data.status).trim() || status;
    } catch {
      /* keep inferred status */
    }

    const now = new Date();
    const doc = await SaasWhatsAppFlow.findOneAndUpdate(
      { client_id: clientId, flow_id: flowId },
      {
        $set: {
          waba_id: wabaId,
          name: flowName,
          status,
          categories: [starter.category],
          starter_id: starter.id,
          cta_default: starter.cta,
          body_default: starter.body,
          synced_at: now,
          published_at: /^PUBLISHED$/i.test(status) ? now : null,
          last_error: validationMsg,
        },
      },
      { upsert: true, new: true }
    );

    if (validationMsg) {
      throw httpError(
        `Flow created as ${status} but Meta reported validation issues: ${validationMsg}`,
        400
      );
    }

    try {
      await WhatsAppService.writeAudit(clientId, {
        action: 'flow_create',
        templateName: flowName,
        detail: `flow_id=${flowId} starter=${starter.id} status=${status}`,
      });
    } catch {
      /* optional */
    }

    return {
      id: String(doc._id),
      flow_id: doc.flow_id,
      name: doc.name,
      status: doc.status,
      starter_id: doc.starter_id,
      cta_default: doc.cta_default,
      body_default: doc.body_default,
      meta: response.data,
    };
  }

  static async publishFlow(clientId, flowId) {
    const account = await getAccount(clientId);
    const token = decrypt(account.access_token_encrypted);
    const id = String(flowId || '').trim();
    if (!id) throw httpError('flow_id is required', 400);

    try {
      await axios.post(
        `${WA_API_BASE}/${id}/publish`,
        {},
        {
          timeout: 30000,
          headers: { Authorization: `Bearer ${token}` },
        }
      );
    } catch (err) {
      throw formatMetaError(err);
    }

    const doc = await SaasWhatsAppFlow.findOneAndUpdate(
      { client_id: clientId, flow_id: id },
      { $set: { status: 'PUBLISHED', published_at: new Date(), last_error: '' } },
      { new: true }
    );

    return {
      flow_id: id,
      status: 'PUBLISHED',
      name: doc?.name || '',
    };
  }

  /**
   * Send an interactive Flow message (requires open customer-service window).
   */
  static async sendFlowMessage(clientId, {
    to,
    flowId = '',
    flowName = '',
    body = '',
    header = '',
    footer = '',
    cta = '',
  } = {}) {
    const e164 = normalizePhoneE164(to);
    if (!e164) throw httpError('Invalid recipient phone number', 400);

    await WhatsAppService.assertCreditsAvailable(clientId, 'utility');
    const WhatsAppInboxService = require('./WhatsAppInboxService');
    await WhatsAppInboxService.assertFreeformWindow(clientId, e164);

    const account = await getAccount(clientId);
    const token = decrypt(account.access_token_encrypted);

    let resolvedFlowId = String(flowId || '').trim();
    let resolvedName = String(flowName || '').trim();
    let resolvedCta = String(cta || '').trim();
    let resolvedBody = String(body || '').trim();

    const local = resolvedFlowId
      ? await SaasWhatsAppFlow.findOne({ client_id: clientId, flow_id: resolvedFlowId }).lean()
      : resolvedName
        ? await SaasWhatsAppFlow.findOne({ client_id: clientId, name: resolvedName }).lean()
        : null;

    if (local) {
      resolvedFlowId = local.flow_id;
      if (!resolvedCta) resolvedCta = local.cta_default || 'Open';
      if (!resolvedBody) resolvedBody = local.body_default || 'Tap the button to continue.';
      if (!/^PUBLISHED$/i.test(local.status || '')) {
        throw httpError('Flow must be PUBLISHED before sending. Publish it first.', 400);
      }
    }

    if (!resolvedFlowId && !resolvedName) {
      throw httpError('flow_id or flow_name is required', 400);
    }
    if (!resolvedCta) resolvedCta = 'Open';
    if (!resolvedBody) resolvedBody = 'Tap the button to continue.';

    const parameters = {
      flow_message_version: '3',
      flow_cta: resolvedCta.slice(0, 30),
    };
    if (resolvedFlowId) parameters.flow_id = resolvedFlowId;
    else parameters.flow_name = resolvedName;

    const interactive = {
      type: 'flow',
      body: { text: resolvedBody.slice(0, 1024) },
      action: {
        name: 'flow',
        parameters,
      },
    };
    if (header) interactive.header = { type: 'text', text: String(header).slice(0, 60) };
    if (footer) interactive.footer = { text: String(footer).slice(0, 60) };

    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: e164,
      type: 'interactive',
      interactive,
    };

    let response;
    try {
      response = await axios.post(`${WA_API_BASE}/${account.phone_number_id}/messages`, payload, {
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      throw formatMetaError(err);
    }

    const messageId = response.data?.messages?.[0]?.id || `wa-flow-${Date.now()}`;
    try {
      const WhatsAppInboxService = require('./WhatsAppInboxService');
      await WhatsAppInboxService.recordOutbound({
        clientId,
        phoneNumberId: account.phone_number_id,
        to: e164,
        wamid: messageId,
        type: 'interactive',
        body: `Flow: ${resolvedName || resolvedFlowId}`,
        status: 'sent',
        raw: response.data,
      });
    } catch (e) {
      console.warn('[whatsapp flows] inbox record failed:', e.message);
    }

    await WhatsAppService.recordWhatsAppUsage({
      clientId,
      messageType: 'utility',
      sourceRef: messageId,
      metadata: { to: e164, channel: 'flow', flow_id: resolvedFlowId, flow_name: resolvedName },
    });

    try {
      await WhatsAppService.writeAudit(clientId, {
        action: 'flow_send',
        templateName: resolvedName || resolvedFlowId,
        detail: `to=${e164}`,
      });
    } catch {
      /* optional */
    }

    return {
      to: e164,
      flow_id: resolvedFlowId,
      flow_name: resolvedName,
      meta: response.data,
    };
  }
}

module.exports = WhatsAppFlowsService;
