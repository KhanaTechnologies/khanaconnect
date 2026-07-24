const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const SaasWhatsAppMessage = require('../../models/SaasWhatsAppMessage');
const SaasWhatsAppAccount = require('../../models/SaasWhatsAppAccount');
const SaasWhatsAppWebhookEvent = require('../../models/SaasWhatsAppWebhookEvent');
const SaasWhatsAppCannedReply = require('../../models/SaasWhatsAppCannedReply');
const SaasWhatsAppThread = require('../../models/SaasWhatsAppThread');
const Customer = require('../../models/customer');
const { Order } = require('../../models/order');
const Booking = require('../../models/booking');
const TeamMember = require('../../models/teamMember');
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

function phoneLookupKeys(raw) {
  const e164 = normalizePhoneE164(raw) || String(raw || '').replace(/\D/g, '');
  if (!e164) return [];
  const keys = [e164];
  if (e164.length >= 9) keys.push(e164.slice(-9));
  return keys;
}

/** Derive a simple CRM level from order history (aligned with high_value ~ R500). */
function customerLevelFromStats(totalOrders, totalSpent) {
  const orders = Number(totalOrders) || 0;
  const spent = Number(totalSpent) || 0;
  if (spent >= 2000 || orders >= 15) {
    return { id: 'vip', label: 'VIP', tone: 'violet' };
  }
  if (spent >= 500 || orders >= 5) {
    return { id: 'valued', label: 'Valued', tone: 'amber' };
  }
  if (orders >= 1) {
    return { id: 'regular', label: 'Regular', tone: 'sky' };
  }
  return { id: 'new', label: 'New', tone: 'slate' };
}

function customerProfileFromDoc(c) {
  if (!c) return null;
  const first = String(c.customerFirstName || '').trim();
  const last = String(c.customerLastName || '').trim();
  const name = [first, last].filter(Boolean).join(' ').trim();
  const level = customerLevelFromStats(c.totalOrders, c.totalSpent);
  return {
    id: String(c._id),
    name: name || 'Customer',
    first_name: first,
    last_name: last,
    total_orders: Number(c.totalOrders) || 0,
    total_spent: Number(c.totalSpent) || 0,
    level,
  };
}

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT_CANNED = [
  { title: 'Thanks', body: 'Thank you for your message — we will get back to you shortly.', shortcut: 'thanks', sort_order: 1 },
  { title: 'Order received', body: 'We have received your order and will update you once it is being prepared.', shortcut: 'order', sort_order: 2 },
  { title: 'Booking confirmed', body: 'Your booking is confirmed. Please reply if you need to reschedule.', shortcut: 'booking', sort_order: 3 },
  { title: 'More info', body: 'Could you please share a bit more detail so we can help you better?', shortcut: 'info', sort_order: 4 },
];

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
  if (type === 'audio') {
    const voice = msg.audio?.voice === true;
    return { type, body: voice ? '[Voice note]' : '[Audio]' };
  }
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

function extractMediaIdFromRaw(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const type = String(msg.type || '');
  const node = type && msg[type] && typeof msg[type] === 'object' ? msg[type] : null;
  return String(node?.id || '').trim();
}

function serializeInboxMessage(m) {
  const mediaId = String(m.media_id || extractMediaIdFromRaw(m.raw) || '').trim();
  const type = String(m.type || 'text');
  const mediaTypes = new Set(['image', 'audio', 'video', 'document', 'sticker']);
  return {
    _id: m._id,
    wamid: m.wamid,
    direction: m.direction,
    type,
    body: m.body || '',
    template_name: m.template_name || '',
    status: m.status,
    error: m.error || '',
    timestamp: m.timestamp,
    contact_name: m.contact_name || '',
    read_at: m.read_at || null,
    media_id: mediaId,
    has_media: !!(mediaId && mediaTypes.has(type)),
  };
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

  /**
   * Build phone→customer map for a tenant. Phones are encrypted at rest, so we decrypt in memory.
   */
  static async buildCustomerPhoneIndex(clientId) {
    const map = new Map();
    if (!clientId) return map;
    try {
      const customers = await Customer.find({ clientID: clientId })
        .select('customerFirstName customerLastName phoneNumber totalOrders totalSpent')
        .limit(3000);
      for (const c of customers) {
        const profile = customerProfileFromDoc(c);
        if (!profile) continue;
        for (const key of phoneLookupKeys(c.phoneNumber)) {
          if (!map.has(key)) map.set(key, profile);
        }
      }
    } catch (e) {
      console.warn('[whatsapp inbox] customer index failed:', e.message);
    }
    return map;
  }

  static lookupCustomerInIndex(index, contactWaId) {
    if (!index || !contactWaId) return null;
    for (const key of phoneLookupKeys(contactWaId)) {
      const hit = index.get(key);
      if (hit) return hit;
    }
    return null;
  }

  static async resolveCustomerForContact(clientId, contactWaId) {
    const index = await this.buildCustomerPhoneIndex(clientId);
    return this.lookupCustomerInIndex(index, contactWaId);
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
      const mediaId = extractMediaIdFromRaw(msg);
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
              media_id: mediaId,
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
    mediaId = '',
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
            media_id: String(mediaId || '').trim(),
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

  static async listThreads(clientId, { limit = 40, q = '' } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 40, 1), 100);
    const query = String(q || '').trim();
    const match = { client_id: clientId };

    if (query) {
      const rx = new RegExp(escapeRegex(query), 'i');
      const contactIds = await SaasWhatsAppMessage.distinct('contact_wa_id', {
        client_id: clientId,
        $or: [{ contact_wa_id: rx }, { contact_name: rx }, { body: rx }],
      });
      match.contact_wa_id = { $in: contactIds.length ? contactIds : ['__none__'] };
    }

    const rows = await SaasWhatsAppMessage.aggregate([
      { $match: match },
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

    const customerIndex = await this.buildCustomerPhoneIndex(clientId);
    const contactIds = rows.map((r) => r.contact_wa_id);
    const threadMetas = await SaasWhatsAppThread.find({
      client_id: clientId,
      contact_wa_id: { $in: contactIds },
    }).lean();
    const metaByContact = Object.fromEntries(threadMetas.map((t) => [t.contact_wa_id, t]));

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

        // Prefer a non-empty WhatsApp profile name (outbound rows often store blank contact_name).
        const named = await SaasWhatsAppMessage.findOne({
          client_id: clientId,
          contact_wa_id: row.contact_wa_id,
          contact_name: { $exists: true, $nin: [null, ''] },
        })
          .sort({ timestamp: -1 })
          .select('contact_name')
          .lean();
        const waName = String(named?.contact_name || row.contact_name || '').trim();

        const windowOpenUntil = lastInbound?.timestamp
          ? new Date(new Date(lastInbound.timestamp).getTime() + SESSION_HOURS * 60 * 60 * 1000)
          : null;
        const canReplyFreeform = !!(windowOpenUntil && windowOpenUntil > new Date());
        const customer = this.lookupCustomerInIndex(customerIndex, row.contact_wa_id);
        const meta = metaByContact[row.contact_wa_id];

        return {
          contact_wa_id: row.contact_wa_id,
          // Always the WhatsApp profile / set name — never overwrite with CRM customer name.
          contact_name: waName,
          phone_number_id: row.phone_number_id,
          last_body: row.last_body || '',
          last_direction: row.last_direction,
          last_type: row.last_type,
          last_at: row.last_at,
          last_status: row.last_status,
          unread,
          can_reply_freeform: canReplyFreeform,
          window_open_until: windowOpenUntil,
          customer,
          assignment: meta?.assigned_member_id
            ? {
                member_id: meta.assigned_member_id,
                name: meta.assigned_name || '',
                assigned_at: meta.assigned_at,
              }
            : null,
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
    const customer = await this.resolveCustomerForContact(clientId, contact);
    const namedMsg = [...messages].reverse().find((m) => String(m.contact_name || '').trim());
    const waName = String(namedMsg?.contact_name || '').trim();
    const meta = await SaasWhatsAppThread.findOne({ client_id: clientId, contact_wa_id: contact }).lean();

    return {
      contact_wa_id: contact,
      contact_name: waName,
      can_reply_freeform: canReplyFreeform,
      window_open_until: windowOpenUntil,
      customer,
      assignment: meta?.assigned_member_id
        ? {
            member_id: meta.assigned_member_id,
            name: meta.assigned_name || '',
            assigned_at: meta.assigned_at,
          }
        : null,
      messages: messages.map(serializeInboxMessage),
    };
  }

  /**
   * Proxy Meta Cloud API media for inbox playback (audio / image / video / docs).
   * Media IDs typically expire ~30 days after receipt.
   */
  static async downloadMessageMedia(clientId, wamid) {
    const id = String(wamid || '').trim();
    if (!id) throw httpError('Message id is required', 400);

    const message = await SaasWhatsAppMessage.findOne({ wamid: id, client_id: clientId }).lean();
    if (!message) throw httpError('Message not found', 404);

    const mediaId = String(message.media_id || extractMediaIdFromRaw(message.raw) || '').trim();
    if (!mediaId) throw httpError('This message has no downloadable media', 404);

    let account = null;
    if (message.phone_number_id) {
      account = await SaasWhatsAppAccount.findOne({
        phone_number_id: message.phone_number_id,
        status: 'active',
      }).sort({ updated_at: -1 });
    }
    if (!account) {
      account = await this.resolveSendAccount(clientId);
    }
    const token = decrypt(account.access_token_encrypted);

    let meta;
    try {
      const metaRes = await axios.get(`${WA_API_BASE}/${mediaId}`, {
        timeout: 20000,
        headers: { Authorization: `Bearer ${token}` },
      });
      meta = metaRes.data;
    } catch (err) {
      const data = err?.response?.data;
      throw httpError(
        data?.error?.message || 'Could not resolve media from Meta (it may have expired)',
        err?.response?.status || 502,
        { meta: data?.error || data || null }
      );
    }

    const downloadUrl = String(meta?.url || '').trim();
    if (!downloadUrl) throw httpError('Meta did not return a media download URL', 502);

    let fileRes;
    try {
      fileRes = await axios.get(downloadUrl, {
        timeout: 60000,
        responseType: 'arraybuffer',
        headers: { Authorization: `Bearer ${token}` },
        maxContentLength: 25 * 1024 * 1024,
      });
    } catch (err) {
      const data = err?.response?.data;
      throw httpError(
        data?.error?.message || 'Failed to download media from Meta',
        err?.response?.status || 502,
        { meta: data?.error || data || null }
      );
    }

    const mimeType =
      String(meta?.mime_type || fileRes.headers?.['content-type'] || 'application/octet-stream').split(';')[0].trim() ||
      'application/octet-stream';

    return {
      buffer: Buffer.from(fileRes.data),
      mimeType,
      mediaId,
      messageType: message.type,
      filename:
        message.type === 'document'
          ? String(message.raw?.document?.filename || `whatsapp-${mediaId}`)
          : `whatsapp-${message.type}-${mediaId}`,
    };
  }

  static async assertFreeformWindow(clientId, e164) {
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
    return windowOpenUntil;
  }

  static async resolveSendAccount(clientId) {
    let sendAccount = await SaasWhatsAppAccount.findOne({ client_id: clientId, status: 'active' }).sort({
      updated_at: -1,
    });
    if (!sendAccount && clientId !== 'Khana') {
      sendAccount = await SaasWhatsAppAccount.findOne({ client_id: 'Khana', status: 'active' }).sort({
        updated_at: -1,
      });
    }
    if (!sendAccount) {
      throw httpError('No active WhatsApp Cloud API account for this client.', 400);
    }
    return sendAccount;
  }

  static async sendTextReply({ clientId, to, text }) {
    const body = String(text || '').trim();
    if (!body) throw httpError('Message text is required', 400);
    if (body.length > 4096) throw httpError('Message too long (max 4096 characters)', 400);

    const e164 = normalizePhoneE164(to);
    if (!e164) throw httpError('Invalid recipient phone number', 400);

    const windowOpenUntil = await this.assertFreeformWindow(clientId, e164);
    const sendAccount = await this.resolveSendAccount(clientId);
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

  static async sendMediaReply({ clientId, to, fileBuffer, mimeType, filename, caption = '' }) {
    const e164 = normalizePhoneE164(to);
    if (!e164) throw httpError('Invalid recipient phone number', 400);
    if (!fileBuffer?.length) throw httpError('File is required', 400);

    const mime = String(mimeType || '').toLowerCase();
    let msgType = 'document';
    if (mime.startsWith('image/')) msgType = 'image';
    else if (mime.startsWith('video/')) msgType = 'video';
    else if (mime.startsWith('audio/')) msgType = 'audio';
    else if (mime === 'application/pdf' || mime.includes('document') || mime.includes('msword') || mime.includes('sheet')) {
      msgType = 'document';
    } else if (!mime) {
      throw httpError('Unsupported file type', 400);
    }

    const windowOpenUntil = await this.assertFreeformWindow(clientId, e164);
    const sendAccount = await this.resolveSendAccount(clientId);
    const token = decrypt(sendAccount.access_token_encrypted);

    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', fileBuffer, {
      filename: filename || `upload.${mime.split('/')[1] || 'bin'}`,
      contentType: mime,
    });

    let mediaId;
    try {
      const upload = await axios.post(`${WA_API_BASE}/${sendAccount.phone_number_id}/media`, form, {
        timeout: 60000,
        headers: {
          Authorization: `Bearer ${token}`,
          ...form.getHeaders(),
        },
        maxContentLength: 20 * 1024 * 1024,
        maxBodyLength: 20 * 1024 * 1024,
      });
      mediaId = upload.data?.id;
    } catch (err) {
      const data = err?.response?.data;
      throw httpError(data?.error?.message || err.message || 'Media upload failed', err?.response?.status || 502, {
        meta: data?.error || data || null,
      });
    }
    if (!mediaId) throw httpError('Meta did not return a media id', 502);

    const mediaPayload = { id: mediaId };
    const cap = String(caption || '').trim().slice(0, 1024);
    if (cap && (msgType === 'image' || msgType === 'video' || msgType === 'document')) {
      mediaPayload.caption = cap;
    }
    if (msgType === 'document' && filename) mediaPayload.filename = String(filename).slice(0, 240);

    const payload = {
      messaging_product: 'whatsapp',
      to: e164,
      type: msgType,
      [msgType]: mediaPayload,
    };

    let response;
    try {
      response = await axios.post(`${WA_API_BASE}/${sendAccount.phone_number_id}/messages`, payload, {
        timeout: 20000,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });
    } catch (err) {
      const data = err?.response?.data;
      throw httpError(data?.error?.message || err.message || 'Media send failed', err?.response?.status || 502, {
        meta: data?.error || data || null,
      });
    }

    const wamid = response.data?.messages?.[0]?.id || `wa-out-${Date.now()}`;
    const preview =
      msgType === 'image'
        ? cap || '[Image]'
        : msgType === 'document'
          ? filename || cap || '[Document]'
          : cap || `[${msgType}]`;

    const doc = await this.recordOutbound({
      clientId,
      phoneNumberId: sendAccount.phone_number_id,
      to: e164,
      wamid,
      type: msgType,
      body: preview,
      status: 'sent',
      raw: response.data,
      mediaId,
    });

    return { message: doc, meta: response.data, window_open_until: windowOpenUntil, media_id: mediaId };
  }

  static async listAssignees(clientId) {
    const members = await TeamMember.find({
      clientID: clientId,
      status: 'active',
    })
      .select('firstName lastName email orgRole status')
      .sort({ orgRole: 1, firstName: 1 })
      .limit(100);

    return members.map((m) => {
      const json = m.toJSON ? m.toJSON() : m;
      return {
        id: String(json._id),
        name: json.displayName || [json.firstName, json.lastName].filter(Boolean).join(' ') || json.email,
        email: json.email,
        org_role: json.orgRole,
      };
    });
  }

  static async assignThread({ clientId, contactWaId, memberId }) {
    const contact = normalizePhoneE164(contactWaId) || String(contactWaId || '').replace(/\D/g, '');
    if (!contact) throw httpError('Invalid contact WhatsApp number', 400);

    const memberIdStr = String(memberId || '').trim();
    if (!memberIdStr) {
      await SaasWhatsAppThread.findOneAndUpdate(
        { client_id: clientId, contact_wa_id: contact },
        {
          $set: {
            assigned_member_id: '',
            assigned_name: '',
            assigned_at: null,
          },
        },
        { upsert: true }
      );
      return { contact_wa_id: contact, assignment: null };
    }

    const member = await TeamMember.findOne({ _id: memberIdStr, clientID: clientId, status: 'active' });
    if (!member) throw httpError('Team member not found', 404);
    const json = member.toJSON ? member.toJSON() : member;
    const name = json.displayName || [json.firstName, json.lastName].filter(Boolean).join(' ') || json.email;

    const doc = await SaasWhatsAppThread.findOneAndUpdate(
      { client_id: clientId, contact_wa_id: contact },
      {
        $set: {
          assigned_member_id: String(json._id),
          assigned_name: name,
          assigned_at: new Date(),
        },
      },
      { upsert: true, new: true }
    );

    return {
      contact_wa_id: contact,
      assignment: {
        member_id: doc.assigned_member_id,
        name: doc.assigned_name,
        assigned_at: doc.assigned_at,
      },
    };
  }

  static async listCannedReplies(clientId) {
    let rows = await SaasWhatsAppCannedReply.find({ client_id: clientId }).sort({ sort_order: 1, title: 1 }).lean();
    if (!rows.length) {
      await SaasWhatsAppCannedReply.insertMany(
        DEFAULT_CANNED.map((r) => ({ ...r, client_id: clientId }))
      );
      rows = await SaasWhatsAppCannedReply.find({ client_id: clientId }).sort({ sort_order: 1, title: 1 }).lean();
    }
    return rows.map((r) => ({
      id: String(r._id),
      title: r.title,
      body: r.body,
      shortcut: r.shortcut || '',
      sort_order: r.sort_order || 0,
    }));
  }

  static async createCannedReply(clientId, { title, body, shortcut = '' }) {
    const t = String(title || '').trim();
    const b = String(body || '').trim();
    if (!t || !b) throw httpError('title and body are required', 400);
    const count = await SaasWhatsAppCannedReply.countDocuments({ client_id: clientId });
    if (count >= 50) throw httpError('Maximum 50 canned replies per account', 400);
    const doc = await SaasWhatsAppCannedReply.create({
      client_id: clientId,
      title: t.slice(0, 80),
      body: b.slice(0, 1000),
      shortcut: String(shortcut || '').trim().slice(0, 40),
      sort_order: count + 1,
    });
    return {
      id: String(doc._id),
      title: doc.title,
      body: doc.body,
      shortcut: doc.shortcut,
      sort_order: doc.sort_order,
    };
  }

  static async deleteCannedReply(clientId, id) {
    const res = await SaasWhatsAppCannedReply.deleteOne({ _id: id, client_id: clientId });
    if (!res.deletedCount) throw httpError('Canned reply not found', 404);
    return { ok: true };
  }

  /**
   * Create a CRM customer from a WhatsApp conversation number (platform admin).
   * Uses WhatsApp profile name as a default until admin edits customer details.
   */
  static async createCustomerFromContact(clientId, contactWaId, body = {}) {
    const contact = normalizePhoneE164(contactWaId) || String(contactWaId || '').replace(/\D/g, '');
    if (!contact) throw httpError('Invalid contact WhatsApp number', 400);

    const existing = await this.resolveCustomerForContact(clientId, contact);
    if (existing) {
      throw httpError('This WhatsApp number is already linked to a customer', 409, {
        customer: existing,
      });
    }

    let first = String(body.first_name || body.firstName || '').trim();
    let last = String(body.last_name || body.lastName || '').trim();
    const waName = String(body.contact_name || body.contactName || '').trim();

    if (!first && !last && waName) {
      const parts = waName.split(/\s+/).filter(Boolean);
      first = parts[0] || '';
      last = parts.slice(1).join(' ');
    }
    if (!first) first = 'WhatsApp';
    if (!last) last = 'Customer';

    let email = String(body.email || body.emailAddress || '').trim().toLowerCase();
    if (!email) {
      email = `wa.${contact}@customers.local`;
    } else {
      // Ensure email is unique for this tenant (emails are encrypted — scan matches).
      const peers = await Customer.find({ clientID: clientId }).select('emailAddress').limit(5000);
      for (const p of peers) {
        if (String(p.emailAddress || '').toLowerCase() === email) {
          throw httpError('A customer with this email already exists', 409);
        }
      }
    }

    const phoneStored = contact.startsWith('+') ? contact : `+${contact}`;
    const passwordHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 10);

    const customer = new Customer({
      clientID: clientId,
      customerFirstName: first.slice(0, 80),
      customerLastName: last.slice(0, 80),
      emailAddress: email,
      phoneNumber: phoneStored,
      passwordHash,
      isVerified: true,
      customerSince: new Date(),
      lastActivity: new Date(),
    });
    await customer.save();

    return {
      customer: customerProfileFromDoc(customer),
      contact_wa_id: contact,
      contact_name: waName,
    };
  }

  static async getContactContext(clientId, contactWaId) {
    const contact = normalizePhoneE164(contactWaId) || String(contactWaId || '').replace(/\D/g, '');
    if (!contact) throw httpError('Invalid contact WhatsApp number', 400);

    const customer = await this.resolveCustomerForContact(clientId, contact);
    let customerDoc = null;
    if (customer?.id) {
      customerDoc = await Customer.findOne({ _id: customer.id, clientID: clientId }).select(
        'customerFirstName customerLastName emailAddress phoneNumber totalOrders totalSpent customerSince lastActivity address city'
      );
    }

    let orders = [];
    if (customer?.id) {
      orders = await Order.find({ clientID: clientId, customer: customer.id })
        .sort({ dateOrdered: -1 })
        .limit(10)
        .select('_id status finalPrice totalPrice dateOrdered orderTrackingCode paid')
        .lean();
    }

    const bookingsRaw = await Booking.find({ clientID: clientId })
      .sort({ date: -1, time: -1 })
      .limit(200)
      .select('_id customerName customerEmail customerPhone date time endTime status services bookingType notes')
      .lean();

    const keys = new Set(phoneLookupKeys(contact));
    if (customerDoc?.phoneNumber) {
      for (const k of phoneLookupKeys(customerDoc.phoneNumber)) keys.add(k);
    }
    const email = customerDoc?.emailAddress ? String(customerDoc.emailAddress).toLowerCase() : '';

    const bookings = bookingsRaw
      .filter((b) => {
        const phoneKeys = phoneLookupKeys(b.customerPhone);
        if (phoneKeys.some((k) => keys.has(k))) return true;
        if (email && String(b.customerEmail || '').toLowerCase() === email) return true;
        return false;
      })
      .slice(0, 10);

    return {
      contact_wa_id: contact,
      customer: customer
        ? {
            ...customer,
            email: customerDoc?.emailAddress || '',
            phone: customerDoc?.phoneNumber || contact,
            address: customerDoc?.address || '',
            city: customerDoc?.city || '',
            customer_since: customerDoc?.customerSince || null,
            last_activity: customerDoc?.lastActivity || null,
          }
        : null,
      orders: orders.map((o) => ({
        id: String(o._id),
        status: o.status,
        total: o.finalPrice ?? o.totalPrice ?? 0,
        date: o.dateOrdered,
        tracking_code: o.orderTrackingCode || '',
        paid: !!o.paid,
      })),
      bookings: bookings.map((b) => ({
        id: String(b._id),
        customer_name: b.customerName || '',
        date: b.date,
        time: b.time || '',
        end_time: b.endTime || '',
        status: b.status,
        booking_type: b.bookingType || '',
        services: b.services || [],
        notes: b.notes || '',
      })),
    };
  }

  static async getCustomerSummary(clientId, customerId) {
    const customerDoc = await Customer.findOne({ _id: customerId, clientID: clientId }).select(
      'customerFirstName customerLastName emailAddress phoneNumber totalOrders totalSpent customerSince lastActivity address city'
    );
    if (!customerDoc) throw httpError('Customer not found', 404);

    const profile = customerProfileFromDoc(customerDoc);
    const phone = customerDoc.phoneNumber || '';
    const e164 = normalizePhoneE164(phone) || String(phone || '').replace(/\D/g, '');
    const context = e164
      ? await this.getContactContext(clientId, e164)
      : {
          contact_wa_id: '',
          customer: {
            ...profile,
            email: customerDoc.emailAddress || '',
            phone,
            address: customerDoc.address || '',
            city: customerDoc.city || '',
            customer_since: customerDoc.customerSince || null,
            last_activity: customerDoc.lastActivity || null,
          },
          orders: [],
          bookings: [],
        };

    if (!context.customer && profile) {
      context.customer = {
        ...profile,
        email: customerDoc.emailAddress || '',
        phone,
        address: customerDoc.address || '',
        city: customerDoc.city || '',
        customer_since: customerDoc.customerSince || null,
        last_activity: customerDoc.lastActivity || null,
      };
    }
    return context;
  }
}

module.exports = WhatsAppInboxService;
