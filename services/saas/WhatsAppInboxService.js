const axios = require('axios');
const SaasWhatsAppMessage = require('../../models/SaasWhatsAppMessage');
const SaasWhatsAppAccount = require('../../models/SaasWhatsAppAccount');
const SaasWhatsAppWebhookEvent = require('../../models/SaasWhatsAppWebhookEvent');
const { decrypt } = require('../../helpers/encryption');
const { normalizePhoneE164 } = require('../../helpers/whatsappLink');

const WA_API_BASE = process.env.WHATSAPP_GRAPH_BASE || 'https://graph.facebook.com/v25.0';
const SESSION_HOURS = 24;

function httpError(message, status = 400, extra = {}) {
  const err = new Error(message);
  err.status = status;
  Object.assign(err, extra);
  return err;
}

function extractInboundBody(msg) {
  if (!msg || typeof msg !== 'object') return { type: 'unknown', body: '' };
  const type = String(msg.type || 'unknown');
  if (type === 'text') return { type, body: String(msg.text?.body || '') };
  if (type === 'button') return { type: 'interactive', body: String(msg.button?.text || msg.button?.payload || '') };
  if (type === 'interactive') {
    const title =
      msg.interactive?.button_reply?.title ||
      msg.interactive?.list_reply?.title ||
      msg.interactive?.nfm_reply?.response_json ||
      '';
    return { type: 'interactive', body: String(title) };
  }
  if (type === 'image') return { type, body: String(msg.image?.caption || '[Image]') };
  if (type === 'audio') return { type, body: '[Audio]' };
  if (type === 'video') return { type, body: String(msg.video?.caption || '[Video]') };
  if (type === 'document') return { type, body: String(msg.document?.filename || msg.document?.caption || '[Document]') };
  if (type === 'sticker') return { type, body: '[Sticker]' };
  if (type === 'location') {
    const lat = msg.location?.latitude;
    const lng = msg.location?.longitude;
    return { type, body: lat != null && lng != null ? `Location: ${lat}, ${lng}` : '[Location]' };
  }
  if (type === 'reaction') return { type, body: String(msg.reaction?.emoji || '[Reaction]') };
  return { type: 'unknown', body: `[${type}]` };
}

class WhatsAppInboxService {
  static async resolveClientIdForPhoneNumberId(phoneNumberId) {
    const id = String(phoneNumberId || '').trim();
    if (!id) return 'Khana';
    const account = await SaasWhatsAppAccount.findOne({ phone_number_id: id, status: 'active' })
      .sort({ updated_at: -1 })
      .select('client_id')
      .lean();
    return account?.client_id || 'Khana';
  }

  /** Persist raw webhook value before ingest (survives processing failures). */
  static async archiveWebhookValue(value) {
    if (!value || typeof value !== 'object') return null;
    try {
      return await SaasWhatsAppWebhookEvent.create({
        phone_number_id: String(value.metadata?.phone_number_id || ''),
        inbound_count: Array.isArray(value.messages) ? value.messages.length : 0,
        status_count: Array.isArray(value.statuses) ? value.statuses.length : 0,
        processed: false,
        payload: value,
      });
    } catch (e) {
      console.error('[whatsapp inbox] archive webhook failed:', e.message);
      return null;
    }
  }

  static async ingestWebhookValue(value, { archiveId = null } = {}) {
    if (!value || typeof value !== 'object') return { ingested: 0, statusUpdates: 0 };

    const phoneNumberId = String(value.metadata?.phone_number_id || '').trim();
    const clientId = await this.resolveClientIdForPhoneNumberId(phoneNumberId);
    let ingested = 0;
    let statusUpdates = 0;

    const contactNameByWaId = {};
    for (const c of value.contacts || []) {
      const waId = normalizePhoneE164(c.wa_id || c.waId || '') || String(c.wa_id || '').replace(/\D/g, '');
      if (waId) contactNameByWaId[waId] = String(c.profile?.name || '').trim();
    }

    const messages = Array.isArray(value.messages) ? value.messages : [];
    for (const msg of messages) {
      const wamid = String(msg.id || '').trim();
      const from = normalizePhoneE164(msg.from || '') || String(msg.from || '').replace(/\D/g, '');
      if (!wamid || !from) continue;

      // Shared Khana number: attribute reply to the client who last messaged this contact.
      let threadClientId = clientId;
      try {
        const recentOut = await SaasWhatsAppMessage.findOne({
          contact_wa_id: from,
          direction: 'outbound',
        })
          .sort({ timestamp: -1 })
          .select('client_id')
          .lean();
        if (recentOut?.client_id) threadClientId = recentOut.client_id;
      } catch {
        /* keep phone-number mapping */
      }

      const { type, body } = extractInboundBody(msg);
      const tsSec = Number(msg.timestamp);
      const timestamp = Number.isFinite(tsSec) && tsSec > 0 ? new Date(tsSec * 1000) : new Date();
      const contactName = contactNameByWaId[from] || '';

      try {
        // Do not mix contact_name in both $set and $setOnInsert — Mongo rejects that conflict.
        await SaasWhatsAppMessage.updateOne(
          { wamid },
          {
            $setOnInsert: {
              client_id: threadClientId,
              phone_number_id: phoneNumberId,
              contact_wa_id: from,
              contact_name: contactName,
              direction: 'inbound',
              wamid,
              type,
              body,
              status: 'received',
              timestamp,
              raw: msg,
            },
          },
          { upsert: true }
        );
        if (contactName) {
          await SaasWhatsAppMessage.updateMany(
            { client_id: threadClientId, contact_wa_id: from },
            { $set: { contact_name: contactName } }
          );
        }
        ingested += 1;
      } catch (e) {
        if (e?.code !== 11000) {
          console.error('[whatsapp inbox] ingest inbound failed:', e.message);
        }
      }
    }

    const statuses = Array.isArray(value.statuses) ? value.statuses : [];
    for (const st of statuses) {
      const wamid = String(st.id || '').trim();
      if (!wamid) continue;
      const status = String(st.status || '').toLowerCase();
      const allowed = ['sent', 'delivered', 'read', 'failed'];
      if (!allowed.includes(status)) continue;

      const errMsg =
        Array.isArray(st.errors) && st.errors[0]
          ? String(st.errors[0].message || st.errors[0].title || 'failed')
          : '';

      const updated = await SaasWhatsAppMessage.updateOne(
        { wamid },
        {
          $set: {
            status,
            ...(errMsg ? { error: errMsg } : {}),
            ...(status === 'read' ? { read_at: new Date() } : {}),
          },
        }
      );
      if (updated.modifiedCount) statusUpdates += 1;
    }

    if (archiveId) {
      try {
        await SaasWhatsAppWebhookEvent.updateOne(
          { _id: archiveId },
          { $set: { processed: true, process_error: '' } }
        );
      } catch {
        /* non-fatal */
      }
    }

    return { ingested, statusUpdates, clientId, phoneNumberId };
  }

  /** Re-run inbox ingest for archived webhook payloads that failed or were never marked processed. */
  static async reprocessArchivedWebhooks({ limit = 50, onlyUnprocessed = true } = {}) {
    const q = onlyUnprocessed ? { processed: false, inbound_count: { $gt: 0 } } : { inbound_count: { $gt: 0 } };
    const rows = await SaasWhatsAppWebhookEvent.find(q).sort({ created_at: 1 }).limit(Math.min(limit, 200));
    let ok = 0;
    let failed = 0;
    let ingestedTotal = 0;
    for (const row of rows) {
      try {
        const result = await this.ingestWebhookValue(row.payload, { archiveId: row._id });
        ingestedTotal += result.ingested || 0;
        row.processed = true;
        row.process_error = '';
        await row.save();
        ok += 1;
      } catch (e) {
        row.process_error = e.message || 'reprocess failed';
        await row.save();
        failed += 1;
      }
    }
    return { scanned: rows.length, ok, failed, ingestedTotal };
  }

  static async recordOutbound({
    clientId,
    phoneNumberId,
    to,
    wamid,
    type = 'text',
    body = '',
    templateName = '',
    status = 'sent',
    raw = null,
  }) {
    const contact = normalizePhoneE164(to);
    const id = String(wamid || '').trim();
    if (!contact || !id) return null;

    try {
      const doc = await SaasWhatsAppMessage.findOneAndUpdate(
        { wamid: id },
        {
          $setOnInsert: {
            client_id: clientId,
            phone_number_id: String(phoneNumberId || ''),
            contact_wa_id: contact,
            contact_name: '',
            direction: 'outbound',
            wamid: id,
            type,
            body: String(body || '').slice(0, 4000),
            template_name: String(templateName || ''),
            status,
            timestamp: new Date(),
            raw,
          },
        },
        { upsert: true, new: true }
      );
      return doc;
    } catch (e) {
      if (e?.code !== 11000) console.error('[whatsapp inbox] record outbound failed:', e.message);
      return null;
    }
  }

  static async listThreads(clientId, { limit = 40 } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 40, 1), 100);
    const rows = await SaasWhatsAppMessage.aggregate([
      { $match: { client_id: clientId } },
      { $sort: { timestamp: -1 } },
      {
        $group: {
          _id: '$contact_wa_id',
          contact_wa_id: { $first: '$contact_wa_id' },
          contact_name: { $first: '$contact_name' },
          phone_number_id: { $first: '$phone_number_id' },
          last_body: { $first: '$body' },
          last_direction: { $first: '$direction' },
          last_type: { $first: '$type' },
          last_at: { $first: '$timestamp' },
          last_status: { $first: '$status' },
        },
      },
      { $sort: { last_at: -1 } },
      { $limit: lim },
    ]);

    const withUnread = await Promise.all(
      rows.map(async (row) => {
        const unread = await SaasWhatsAppMessage.countDocuments({
          client_id: clientId,
          contact_wa_id: row.contact_wa_id,
          direction: 'inbound',
          read_at: null,
        });
        const lastInbound = await SaasWhatsAppMessage.findOne({
          client_id: clientId,
          contact_wa_id: row.contact_wa_id,
          direction: 'inbound',
        })
          .sort({ timestamp: -1 })
          .select('timestamp')
          .lean();

        const windowOpenUntil = lastInbound?.timestamp
          ? new Date(new Date(lastInbound.timestamp).getTime() + SESSION_HOURS * 60 * 60 * 1000)
          : null;
        const canReplyFreeform = !!(windowOpenUntil && windowOpenUntil > new Date());

        return {
          contact_wa_id: row.contact_wa_id,
          contact_name: row.contact_name || '',
          phone_number_id: row.phone_number_id,
          last_body: row.last_body || '',
          last_direction: row.last_direction,
          last_type: row.last_type,
          last_at: row.last_at,
          last_status: row.last_status,
          unread,
          can_reply_freeform: canReplyFreeform,
          window_open_until: windowOpenUntil,
        };
      })
    );

    return withUnread;
  }

  static async getUnreadSummary(clientId) {
    const unread = await SaasWhatsAppMessage.countDocuments({
      client_id: clientId,
      direction: 'inbound',
      read_at: null,
    });
    const latest = await SaasWhatsAppMessage.findOne({
      client_id: clientId,
      direction: 'inbound',
      read_at: null,
    })
      .sort({ timestamp: -1 })
      .select('contact_wa_id contact_name body timestamp')
      .lean();

    return {
      unread,
      latest: latest
        ? {
            contact_wa_id: latest.contact_wa_id,
            contact_name: latest.contact_name || '',
            body: latest.body || '',
            timestamp: latest.timestamp,
          }
        : null,
    };
  }

  static async getThread(clientId, contactWaId, { limit = 100 } = {}) {
    const contact = normalizePhoneE164(contactWaId) || String(contactWaId || '').replace(/\D/g, '');
    if (!contact) throw httpError('Invalid contact WhatsApp number', 400);

    const lim = Math.min(Math.max(Number(limit) || 100, 1), 200);
    const messages = await SaasWhatsAppMessage.find({
      client_id: clientId,
      contact_wa_id: contact,
    })
      .sort({ timestamp: 1 })
      .limit(lim)
      .lean();

    await SaasWhatsAppMessage.updateMany(
      { client_id: clientId, contact_wa_id: contact, direction: 'inbound', read_at: null },
      { $set: { read_at: new Date() } }
    );

    const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
    const windowOpenUntil = lastInbound?.timestamp
      ? new Date(new Date(lastInbound.timestamp).getTime() + SESSION_HOURS * 60 * 60 * 1000)
      : null;
    const canReplyFreeform = !!(windowOpenUntil && windowOpenUntil > new Date());

    return {
      contact_wa_id: contact,
      contact_name: messages.find((m) => m.contact_name)?.contact_name || '',
      can_reply_freeform: canReplyFreeform,
      window_open_until: windowOpenUntil,
      messages,
    };
  }

  static async sendTextReply({ clientId, to, text }) {
    const body = String(text || '').trim();
    if (!body) throw httpError('Message text is required', 400);
    if (body.length > 4096) throw httpError('Message too long (max 4096 characters)', 400);

    const e164 = normalizePhoneE164(to);
    if (!e164) throw httpError('Invalid recipient phone number', 400);

    const lastInbound = await SaasWhatsAppMessage.findOne({
      client_id: clientId,
      contact_wa_id: e164,
      direction: 'inbound',
    })
      .sort({ timestamp: -1 })
      .lean();

    if (!lastInbound) {
      throw httpError(
        'No inbound message from this contact yet. Free-form replies require the customer to message you first (24-hour window).',
        400
      );
    }

    const windowOpenUntil = new Date(
      new Date(lastInbound.timestamp).getTime() + SESSION_HOURS * 60 * 60 * 1000
    );
    if (windowOpenUntil < new Date()) {
      throw httpError(
        'The 24-hour customer service window has closed. Send an approved template message instead.',
        400
      );
    }

    const account = await SaasWhatsAppAccount.findOne({ client_id: clientId, status: 'active' }).sort({
      updated_at: -1,
    });
    let sendAccount = account;
    if (!sendAccount && clientId !== 'Khana') {
      sendAccount = await SaasWhatsAppAccount.findOne({ client_id: 'Khana', status: 'active' }).sort({
        updated_at: -1,
      });
    }
    if (!sendAccount) {
      throw httpError('No active WhatsApp Cloud API account for this client.', 400);
    }

    const token = decrypt(sendAccount.access_token_encrypted);
    const url = `${WA_API_BASE}/${sendAccount.phone_number_id}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      to: e164,
      type: 'text',
      text: { preview_url: false, body },
    };

    let response;
    try {
      response = await axios.post(url, payload, {
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      const data = err?.response?.data;
      const metaMsg = data?.error?.message || err.message || 'WhatsApp reply failed';
      throw httpError(metaMsg, err?.response?.status || 502, { meta: data?.error || data || null });
    }

    const wamid = response.data?.messages?.[0]?.id || `wa-out-${Date.now()}`;
    const doc = await this.recordOutbound({
      clientId,
      phoneNumberId: sendAccount.phone_number_id,
      to: e164,
      wamid,
      type: 'text',
      body,
      status: 'sent',
      raw: response.data,
    });

    return {
      message: doc,
      meta: response.data,
      window_open_until: windowOpenUntil,
    };
  }
}

module.exports = WhatsAppInboxService;
