const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const SaasWhatsAppMessage = require('../../models/SaasWhatsAppMessage');
const SaasWhatsAppAccount = require('../../models/SaasWhatsAppAccount');
const SaasWhatsAppWebhookEvent = require('../../models/SaasWhatsAppWebhookEvent');
const SaasWhatsAppCannedReply = require('../../models/SaasWhatsAppCannedReply');
const SaasWhatsAppThread = require('../../models/SaasWhatsAppThread');
const SaasWhatsAppThreadNote = require('../../models/SaasWhatsAppThreadNote');
const SaasWhatsAppTemplate = require('../../models/SaasWhatsAppTemplate');
const SaasWhatsAppAutoRule = require('../../models/SaasWhatsAppAutoRule');
const SaasWhatsAppBroadcast = require('../../models/SaasWhatsAppBroadcast');
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

function normalizeLabel(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .slice(0, 40);
}

function serializeThreadMeta(meta) {
  if (!meta) {
    return {
      stage: 'open',
      labels: [],
      marketing_opt_out: false,
      assignment: null,
    };
  }
  return {
    stage: meta.stage || 'open',
    labels: Array.isArray(meta.labels) ? meta.labels : [],
    marketing_opt_out: !!meta.marketing_opt_out,
    assignment: meta.assigned_member_id
      ? {
          member_id: meta.assigned_member_id,
          name: meta.assigned_name || '',
          assigned_at: meta.assigned_at,
        }
      : null,
  };
}

function isMarketingOptOutText(body) {
  const t = String(body || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  return (
    t === 'stop' ||
    t === 'unsubscribe' ||
    t === 'opt out' ||
    t === 'optout' ||
    t.startsWith('stop ') ||
    t.startsWith('unsubscribe')
  );
}

const DEMO_SITE_URL = process.env.PUBLIC_DEMO_URL || 'https://khanatechnologies.co.za/demo';

const DEFAULT_CANNED = [
  { title: 'Thanks', body: 'Thank you for your message — we will get back to you shortly.', shortcut: 'thanks', sort_order: 1 },
  { title: 'Order received', body: 'We have received your order and will update you once it is being prepared.', shortcut: 'order', sort_order: 2 },
  { title: 'Booking confirmed', body: 'Your booking is confirmed. Please reply if you need to reschedule.', shortcut: 'booking', sort_order: 3 },
  { title: 'More info', body: 'Could you please share a bit more detail so we can help you better?', shortcut: 'info', sort_order: 4 },
  {
    title: 'Live demo tour',
    body:
      'We have a live interactive demo you can explore on your own — owner dashboard, website storefront, customer account, and more.\n\n' +
      `Take the tour here: ${DEMO_SITE_URL}\n\n` +
      'No login needed. When you’re ready, reply and we can book a short call.',
    shortcut: 'demo',
    sort_order: 5,
  },
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

const NOT_DELETED = { deleted_at: null };

/** Only reattribute shared-number inbound to another client for recent outbound (ms). */
const REATTRIBUTE_OUTBOUND_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
   * Shared WABA: prefer phone-owner client. Reattribute to another client only when
   * they messaged this contact within the last 7 days (real template/session reply).
   */
  static resolveThreadClientId(ownerClientId, recentOut) {
    const owner = String(ownerClientId || '').trim() || 'Khana';
    if (!recentOut?.client_id) return owner;
    const outClient = String(recentOut.client_id || '').trim();
    if (!outClient || outClient === owner) return owner;
    const outAt = recentOut.timestamp ? new Date(recentOut.timestamp).getTime() : 0;
    if (!Number.isFinite(outAt) || outAt <= 0) return owner;
    if (Date.now() - outAt > REATTRIBUTE_OUTBOUND_MAX_AGE_MS) return owner;
    return outClient;
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

      // Shared WABA: prefer phone owner; reattribute only for recent non-owner outbound.
      let threadClientId = clientId;
      try {
        const recentOut = await SaasWhatsAppMessage.findOne({
          contact_wa_id: from,
          direction: 'outbound',
          deleted_at: null,
        })
          .sort({ timestamp: -1 })
          .select('client_id timestamp')
          .lean();
        threadClientId = this.resolveThreadClientId(clientId, recentOut);
      } catch {
        /* keep phone-number mapping */
      }

      const { type, body } = extractInboundBody(msg);
      const mediaId = extractMediaIdFromRaw(msg);
      const tsSec = Number(msg.timestamp);
      const timestamp = Number.isFinite(tsSec) && tsSec > 0 ? new Date(tsSec * 1000) : new Date();
      const contactName = contactNameByWaId[from] || '';
      let ctwaClid = '';
      try {
        const WhatsAppConversionsService = require('./WhatsAppConversionsService');
        ctwaClid = WhatsAppConversionsService.extractCtwaClidFromRaw(msg) || '';
      } catch {
        /* optional */
      }

      try {
        // Do not mix contact_name in both $set and $setOnInsert — Mongo rejects that conflict.
        const upsert = await SaasWhatsAppMessage.updateOne(
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
              ...(ctwaClid ? { ctwa_clid: ctwaClid } : {}),
            },
          },
          { upsert: true }
        );
        if (ctwaClid) {
          try {
            const WhatsAppConversionsService = require('./WhatsAppConversionsService');
            await WhatsAppConversionsService.captureCtwaFromInbound({
              clientId: threadClientId,
              contactWaId: from,
              rawMsg: msg,
              timestamp,
            });
          } catch (ctwaErr) {
            console.warn('[whatsapp inbox] ctwa capture failed:', ctwaErr.message);
          }
        }
        if (contactName) {
          await SaasWhatsAppMessage.updateMany(
            { client_id: threadClientId, contact_wa_id: from },
            { $set: { contact_name: contactName } }
          );
        }
        if (upsert.upsertedCount > 0 || upsert.upsertedId) {
          ingested += 1;
          if (isMarketingOptOutText(body)) {
            try {
              await SaasWhatsAppThread.findOneAndUpdate(
                { client_id: threadClientId, contact_wa_id: from },
                { $set: { marketing_opt_out: true } },
                { upsert: true }
              );
            } catch (optErr) {
              console.warn('[whatsapp inbox] opt-out update failed:', optErr.message);
            }
          }
          try {
            const WhatsAppAutoResponderService = require('./WhatsAppAutoResponderService');
            // Prefer WABA owner (phone mapping) so shared-number reattribution
            // does not skip Khana ad leads when the last outbound was another client.
            const scheduleClientId = await WhatsAppAutoResponderService.resolveScheduleClientId(
              clientId,
              threadClientId
            );
            if (scheduleClientId) {
              await WhatsAppAutoResponderService.maybeScheduleForInbound({
                clientId: scheduleClientId,
                contactWaId: from,
                wamid,
                body,
                type,
              });
            }
          } catch (autoErr) {
            console.warn('[whatsapp inbox] auto-reply schedule skipped:', autoErr.message);
          }
        }
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

  static async listThreads(
    clientId,
    { limit = 40, q = '', stage = '', label = '', assignee = '', assigneeMemberId = '', unreadOnly = false } = {}
  ) {
    const lim = Math.min(Math.max(Number(limit) || 40, 1), 100);
    const query = String(q || '').trim();
    const match = { client_id: clientId, ...NOT_DELETED };

    let allowedContacts = null;

    if (query) {
      const rx = new RegExp(escapeRegex(query), 'i');
      const contactIds = await SaasWhatsAppMessage.distinct('contact_wa_id', {
        client_id: clientId,
        deleted_at: null,
        $or: [{ contact_wa_id: rx }, { contact_name: rx }, { body: rx }],
      });
      allowedContacts = new Set(contactIds.length ? contactIds : ['__none__']);
    }

    const stageFilter = String(stage || '').trim().toLowerCase();
    const labelFilter = normalizeLabel(label);
    const assigneeFilter = String(assignee || '').trim().toLowerCase();
    const memberForMe = String(assigneeMemberId || '').trim();

    const needsMetaFilter = !!(stageFilter || labelFilter || assigneeFilter);
    if (needsMetaFilter) {
      let metaContacts = null;

      if (assigneeFilter === 'unassigned') {
        const allContacts = await SaasWhatsAppMessage.distinct('contact_wa_id', {
          client_id: clientId,
          deleted_at: null,
        });
        const assigned = await SaasWhatsAppThread.find({
          client_id: clientId,
          assigned_member_id: { $nin: ['', null] },
        })
          .select('contact_wa_id')
          .lean();
        const assignedSet = new Set(assigned.map((r) => r.contact_wa_id));
        metaContacts = allContacts.filter((id) => !assignedSet.has(id));
      } else if (assigneeFilter === 'me' && memberForMe) {
        const rows = await SaasWhatsAppThread.find({
          client_id: clientId,
          assigned_member_id: memberForMe,
        })
          .select('contact_wa_id')
          .lean();
        metaContacts = rows.map((r) => r.contact_wa_id);
      } else if (assigneeFilter && assigneeFilter !== 'me') {
        const rows = await SaasWhatsAppThread.find({
          client_id: clientId,
          assigned_member_id: String(assignee || '').trim(),
        })
          .select('contact_wa_id')
          .lean();
        metaContacts = rows.map((r) => r.contact_wa_id);
      }

      if (labelFilter) {
        const rows = await SaasWhatsAppThread.find({
          client_id: clientId,
          labels: labelFilter,
        })
          .select('contact_wa_id')
          .lean();
        const labelSet = new Set(rows.map((r) => r.contact_wa_id));
        metaContacts = metaContacts
          ? metaContacts.filter((id) => labelSet.has(id))
          : [...labelSet];
      }

      if (stageFilter === 'open') {
        const allContacts = await SaasWhatsAppMessage.distinct('contact_wa_id', {
          client_id: clientId,
          deleted_at: null,
        });
        const nonOpen = await SaasWhatsAppThread.find({
          client_id: clientId,
          stage: { $in: ['waiting', 'closed'] },
        })
          .select('contact_wa_id')
          .lean();
        const nonOpenSet = new Set(nonOpen.map((r) => r.contact_wa_id));
        const openContacts = allContacts.filter((id) => !nonOpenSet.has(id));
        const openSet = new Set(openContacts);
        metaContacts = metaContacts
          ? metaContacts.filter((id) => openSet.has(id))
          : openContacts;
      } else if (stageFilter === 'waiting' || stageFilter === 'closed') {
        const rows = await SaasWhatsAppThread.find({
          client_id: clientId,
          stage: stageFilter,
        })
          .select('contact_wa_id')
          .lean();
        const stageSet = new Set(rows.map((r) => r.contact_wa_id));
        metaContacts = metaContacts
          ? metaContacts.filter((id) => stageSet.has(id))
          : [...stageSet];
      }

      const metaSet = new Set(metaContacts && metaContacts.length ? metaContacts : ['__none__']);
      allowedContacts = allowedContacts
        ? new Set([...allowedContacts].filter((id) => metaSet.has(id)))
        : metaSet;
    }

    if (unreadOnly) {
      const unreadContacts = await SaasWhatsAppMessage.distinct('contact_wa_id', {
        client_id: clientId,
        direction: 'inbound',
        read_at: null,
        deleted_at: null,
      });
      const unreadSet = new Set(unreadContacts.length ? unreadContacts : ['__none__']);
      allowedContacts = allowedContacts
        ? new Set([...allowedContacts].filter((id) => unreadSet.has(id)))
        : unreadSet;
    }

    if (allowedContacts) {
      match.contact_wa_id = { $in: [...allowedContacts] };
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
          deleted_at: null,
        });
        const lastInbound = await SaasWhatsAppMessage.findOne({
          client_id: clientId,
          contact_wa_id: row.contact_wa_id,
          direction: 'inbound',
          deleted_at: null,
        })
          .sort({ timestamp: -1 })
          .select('timestamp')
          .lean();

        // Prefer a non-empty WhatsApp profile name (outbound rows often store blank contact_name).
        const named = await SaasWhatsAppMessage.findOne({
          client_id: clientId,
          contact_wa_id: row.contact_wa_id,
          contact_name: { $exists: true, $nin: [null, ''] },
          deleted_at: null,
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
        const serialized = serializeThreadMeta(meta);

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
          assignment: serialized.assignment,
          stage: serialized.stage,
          labels: serialized.labels,
          marketing_opt_out: serialized.marketing_opt_out,
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
      deleted_at: null,
    });
    const latest = await SaasWhatsAppMessage.findOne({
      client_id: clientId,
      direction: 'inbound',
      read_at: null,
      deleted_at: null,
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
      deleted_at: null,
    })
      .sort({ timestamp: 1 })
      .limit(lim)
      .lean();

    await SaasWhatsAppMessage.updateMany(
      { client_id: clientId, contact_wa_id: contact, direction: 'inbound', read_at: null, deleted_at: null },
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
    const serialized = serializeThreadMeta(meta);

    return {
      contact_wa_id: contact,
      contact_name: waName,
      can_reply_freeform: canReplyFreeform,
      window_open_until: windowOpenUntil,
      customer,
      assignment: serialized.assignment,
      stage: serialized.stage,
      labels: serialized.labels,
      marketing_opt_out: serialized.marketing_opt_out,
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

    const message = await SaasWhatsAppMessage.findOne({ wamid: id, client_id: clientId, deleted_at: null }).lean();
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

  /**
   * Soft-delete a message from the Khana inbox only.
   * Meta Cloud API cannot remove messages from the customer's WhatsApp chat.
   */
  static async deleteMessage(clientId, wamid, { deletedBy = '' } = {}) {
    const id = String(wamid || '').trim();
    if (!id) throw httpError('Message id is required', 400);

    const message = await SaasWhatsAppMessage.findOne({
      wamid: id,
      client_id: clientId,
      deleted_at: null,
    });
    if (!message) throw httpError('Message not found', 404);

    message.deleted_at = new Date();
    message.deleted_by = String(deletedBy || '').slice(0, 120);
    await message.save();

    return {
      wamid: message.wamid,
      contact_wa_id: message.contact_wa_id,
      deleted_at: message.deleted_at,
    };
  }

  /**
   * Soft-delete every message in a conversation (inbox-only).
   * Does not remove anything from the customer's WhatsApp phone.
   */
  static async deleteThread(clientId, contactWaId, { deletedBy = '' } = {}) {
    const contact = normalizePhoneE164(contactWaId) || String(contactWaId || '').replace(/\D/g, '');
    if (!contact) throw httpError('Contact phone is required', 400);

    const now = new Date();
    const by = String(deletedBy || '').slice(0, 120);
    const result = await SaasWhatsAppMessage.updateMany(
      {
        client_id: clientId,
        contact_wa_id: contact,
        deleted_at: null,
      },
      {
        $set: {
          deleted_at: now,
          deleted_by: by,
        },
      }
    );

    return {
      contact_wa_id: contact,
      deleted_count: Number(result.modifiedCount || 0),
      deleted_at: now,
    };
  }

  static async assertFreeformWindow(clientId, e164) {
    // Prefer same-tenant inbound; fall back to any inbound on this contact
    // (shared WABA may store the message under a reattributed client_id).
    let lastInbound = await SaasWhatsAppMessage.findOne({
      client_id: clientId,
      contact_wa_id: e164,
      direction: 'inbound',
      deleted_at: null,
    })
      .sort({ timestamp: -1 })
      .lean();

    if (!lastInbound) {
      lastInbound = await SaasWhatsAppMessage.findOne({
        contact_wa_id: e164,
        direction: 'inbound',
        deleted_at: null,
      })
        .sort({ timestamp: -1 })
        .lean();
    }

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

  static async sendTextReply({ clientId, to, text, autoReplyMeta = null }) {
    const body = String(text || '').trim();
    if (!body) throw httpError('Message text is required', 400);
    if (body.length > 4096) throw httpError('Message too long (max 4096 characters)', 400);

    const e164 = normalizePhoneE164(to);
    if (!e164) throw httpError('Invalid recipient phone number', 400);

    const WhatsAppService = require('./WhatsAppService');
    await WhatsAppService.assertCreditsAvailable(clientId, 'utility');

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
    const raw = autoReplyMeta
      ? {
          ...(response.data && typeof response.data === 'object' ? response.data : {}),
          auto_reply: true,
          auto_reply_rule: String(autoReplyMeta.ruleId || ''),
          trigger_wamid: String(autoReplyMeta.triggerWamid || ''),
        }
      : response.data;
    const doc = await this.recordOutbound({
      clientId,
      phoneNumberId: sendAccount.phone_number_id,
      to: e164,
      wamid,
      type: 'text',
      body,
      status: 'sent',
      raw,
    });

    await WhatsAppService.recordWhatsAppUsage({
      clientId,
      messageType: 'utility',
      sourceRef: wamid,
      metadata: {
        to: e164,
        channel: 'inbox',
        kind: 'text',
        auto_reply: !!autoReplyMeta,
      },
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

    const WhatsAppService = require('./WhatsAppService');
    await WhatsAppService.assertCreditsAvailable(clientId, 'utility');

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

    await WhatsAppService.recordWhatsAppUsage({
      clientId,
      messageType: 'utility',
      sourceRef: wamid,
      metadata: {
        to: e164,
        channel: 'inbox',
        kind: 'media',
        media_type: msgType,
      },
    });

    return { message: doc, meta: response.data, window_open_until: windowOpenUntil, media_id: mediaId };
  }

  /**
   * Share a catalog product into an open inbox chat (24h window).
   * Sends image+caption when product has an image URL; otherwise text card.
   */
  static async sendProductShare({ clientId, to, productId }) {
    const e164 = normalizePhoneE164(to);
    if (!e164) throw httpError('Invalid recipient phone number', 400);
    if (!productId) throw httpError('productId is required', 400);

    const Product = require('../../models/product');
    const product = await Product.findOne({ _id: productId, clientID: clientId }).lean();
    if (!product) throw httpError('Product not found', 404);

    const name = product.productName || 'Product';
    const price = Number(product.price) || 0;
    const sale = Number(product.salePercentage) || 0;
    const effective =
      sale > 0 && sale < 100 ? Math.round(price * (1 - sale / 100) * 100) / 100 : price;
    const sku = product.sku ? `SKU: ${product.sku}` : '';
    const caption = [
      `*${name}*`,
      `R${effective.toFixed(2)}${sale > 0 ? ` (${sale}% off)` : ''}`,
      sku,
      product.description ? String(product.description).slice(0, 280) : '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1024);

    const imageUrl = Array.isArray(product.images) ? product.images.find((u) => /^https?:\/\//i.test(String(u || ''))) : null;

    if (imageUrl) {
      try {
        const imgRes = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 20000,
          maxContentLength: 8 * 1024 * 1024,
        });
        const mime =
          imgRes.headers['content-type'] ||
          (String(imageUrl).toLowerCase().includes('.png') ? 'image/png' : 'image/jpeg');
        const buf = Buffer.from(imgRes.data);
        const result = await this.sendMediaReply({
          clientId,
          to: e164,
          fileBuffer: buf,
          mimeType: mime,
          filename: `${String(name).replace(/[^\w.-]+/g, '_').slice(0, 40)}.jpg`,
          caption,
        });
        // Override usage kind for analytics
        try {
          const WhatsAppService = require('./WhatsAppService');
          await WhatsAppService.recordWhatsAppUsage({
            clientId,
            messageType: 'utility',
            sourceRef: result?.message?.wamid || `product-${Date.now()}`,
            metadata: { to: e164, channel: 'inbox', kind: 'product_share', productId: String(productId) },
          });
        } catch (_) {
          /* ignore duplicate usage best-effort */
        }
        return { ...result, product: { id: product._id, name, price: effective } };
      } catch (err) {
        console.warn('[inbox] product image share failed, falling back to text:', err.message);
      }
    }

    const textResult = await this.sendTextReply({ clientId, to: e164, text: caption });
    return { ...textResult, product: { id: product._id, name, price: effective } };
  }

  /**
   * Inbox analytics for dashboard (thin).
   */
  static async getInboxStats({ clientId, days = 30 }) {
    const windowDays = Math.min(Math.max(Number(days) || 30, 1), 90);
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const [directionCounts, unreadAgg, stageCounts, templateTop, recentInbound] = await Promise.all([
      SaasWhatsAppMessage.aggregate([
        {
          $match: {
            client_id: clientId,
            deleted_at: null,
            timestamp: { $gte: since },
          },
        },
        { $group: { _id: '$direction', count: { $sum: 1 } } },
      ]),
      SaasWhatsAppMessage.aggregate([
        {
          $match: {
            client_id: clientId,
            direction: 'inbound',
            deleted_at: null,
            $or: [{ read_at: null }, { read_at: { $exists: false } }],
          },
        },
        { $group: { _id: '$contact_wa_id' } },
        { $count: 'unreadThreads' },
      ]),
      SaasWhatsAppThread.aggregate([
        { $match: { client_id: clientId } },
        { $group: { _id: '$stage', count: { $sum: 1 } } },
      ]),
      SaasWhatsAppMessage.aggregate([
        {
          $match: {
            client_id: clientId,
            direction: 'outbound',
            deleted_at: null,
            timestamp: { $gte: since },
            template_name: { $exists: true, $nin: [null, ''] },
          },
        },
        { $group: { _id: '$template_name', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
      ]),
      SaasWhatsAppMessage.find({
        client_id: clientId,
        direction: 'inbound',
        deleted_at: null,
        timestamp: { $gte: since },
      })
        .sort({ timestamp: 1 })
        .select('contact_wa_id timestamp')
        .limit(500)
        .lean(),
    ]);

    const inbound = directionCounts.find((d) => d._id === 'inbound')?.count || 0;
    const outbound = directionCounts.find((d) => d._id === 'outbound')?.count || 0;
    const unreadThreads = unreadAgg[0]?.unreadThreads || 0;
    const byStage = {};
    for (const row of stageCounts) {
      byStage[row._id || 'open'] = row.count;
    }

    // Sample first-response: for up to 80 contacts, find first outbound after first inbound in window
    const contactsSample = [...new Set(recentInbound.map((m) => m.contact_wa_id))].slice(0, 80);
    let responseSum = 0;
    let responseN = 0;
    for (const contact of contactsSample) {
      const firstIn = recentInbound.find((m) => m.contact_wa_id === contact);
      if (!firstIn?.timestamp) continue;
      const firstOut = await SaasWhatsAppMessage.findOne({
        client_id: clientId,
        contact_wa_id: contact,
        direction: 'outbound',
        deleted_at: null,
        timestamp: { $gt: firstIn.timestamp },
      })
        .sort({ timestamp: 1 })
        .select('timestamp')
        .lean();
      if (!firstOut?.timestamp) continue;
      const mins = (new Date(firstOut.timestamp) - new Date(firstIn.timestamp)) / 60000;
      if (mins >= 0 && mins < 60 * 48) {
        responseSum += mins;
        responseN += 1;
      }
    }

    return {
      days: windowDays,
      summary: {
        inbound,
        outbound,
        total: inbound + outbound,
        unreadThreads,
        avgFirstResponseMinutes: responseN ? Math.round((responseSum / responseN) * 10) / 10 : null,
        respondedSampleSize: responseN,
      },
      threadsByStage: byStage,
      topTemplates: templateTop.map((t) => ({ name: t._id, count: t.count })),
    };
  }

  static inboxTemplateAllowlist() {
    return ['hello_world', 'order_confirmation', 'booking_confirmation'];
  }

  static async isTemplateAllowedForInbox(clientId, templateName) {
    const name = String(templateName || '').trim();
    if (!name) return false;
    if (this.inboxTemplateAllowlist().includes(name)) return true;
    const approved = await SaasWhatsAppTemplate.findOne({
      client_id: clientId,
      name,
      status: { $regex: /^APPROVED$/i },
    })
      .select('_id')
      .lean();
    return !!approved;
  }

  /**
   * Re-open a closed 24h window by sending an approved template to this contact.
   */
  static async sendInboxTemplate({
    clientId,
    contactWaId,
    templateName = 'hello_world',
    language = '',
    components = [],
    companyName = '',
  }) {
    const e164 = normalizePhoneE164(contactWaId);
    if (!e164) throw httpError('Invalid recipient phone number', 400);

    const name = String(templateName || 'hello_world').trim();
    const allowed = await this.isTemplateAllowedForInbox(clientId, name);
    if (!allowed) {
      throw httpError(
        `Template not allowed from inbox. Sync approved templates or use: ${this.inboxTemplateAllowlist().join(', ')}`,
        400
      );
    }

    const WhatsAppService = require('./WhatsAppService');
    const Client = require('../../models/client');
    let brand = String(companyName || '').trim();
    if (!brand) {
      const client = await Client.findOne({ clientID: clientId }).select('companyName').lean();
      brand = client?.companyName || clientId;
    }

    let data;
    if (name === 'order_confirmation') {
      data = await WhatsAppService.notifyOrderConfirmation({
        clientId,
        to: e164,
        companyName: brand,
        orderRef: 'TEST-001',
        total: '—',
      });
    } else if (name === 'booking_confirmation') {
      data = await WhatsAppService.notifyBookingConfirmation({
        clientId,
        to: e164,
        companyName: brand,
        bookingRef: 'TEST-001',
        when: '—',
      });
    } else {
      let lang = String(language || '').trim();
      if (!lang) {
        const row = await SaasWhatsAppTemplate.findOne({
          client_id: clientId,
          name,
          status: { $regex: /^APPROVED$/i },
        })
          .select('language')
          .lean();
        lang = row?.language || process.env.WHATSAPP_TEMPLATE_LANG || 'en';
      }
      data = await WhatsAppService.sendTemplateMessage({
        clientId,
        to: e164,
        templateName: name,
        languageCode: lang,
        messageType: 'utility',
        components: Array.isArray(components) ? components : [],
      });
    }

    return {
      contact_wa_id: e164,
      template_name: name,
      meta: data,
    };
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
    } else {
      // Ensure newer defaults (e.g. live demo) exist for accounts that already had canned replies.
      const demoDefault = DEFAULT_CANNED.find((r) => r.shortcut === 'demo');
      if (demoDefault && !rows.some((r) => String(r.shortcut || '') === 'demo')) {
        await SaasWhatsAppCannedReply.create({ ...demoDefault, client_id: clientId });
        rows = await SaasWhatsAppCannedReply.find({ client_id: clientId }).sort({ sort_order: 1, title: 1 }).lean();
      }
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
   * Create a CRM customer from a WhatsApp conversation number.
   * Owners/managers/operators can save contacts into their customer list.
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

  static async updateCustomer(clientId, customerId, body = {}) {
    const customer = await Customer.findOne({ _id: customerId, clientID: clientId });
    if (!customer) throw httpError('Customer not found', 404);

    const firstRaw = body.first_name ?? body.firstName;
    const lastRaw = body.last_name ?? body.lastName;
    const emailRaw = body.email ?? body.emailAddress;
    const phoneRaw = body.phone ?? body.phoneNumber;
    const addressRaw = body.address;
    const cityRaw = body.city;

    if (firstRaw !== undefined) {
      const first = String(firstRaw || '').trim();
      if (!first) throw httpError('First name is required', 400);
      customer.customerFirstName = first.slice(0, 80);
    }
    if (lastRaw !== undefined) {
      customer.customerLastName = String(lastRaw || '').trim().slice(0, 80);
    }

    if (emailRaw !== undefined) {
      const email = String(emailRaw || '').trim().toLowerCase();
      if (!email) throw httpError('Email is required', 400);
      const peers = await Customer.find({
        clientID: clientId,
        _id: { $ne: customer._id },
      })
        .select('emailAddress')
        .limit(5000);
      for (const p of peers) {
        if (String(p.emailAddress || '').toLowerCase() === email) {
          throw httpError('A customer with this email already exists', 409);
        }
      }
      customer.emailAddress = email;
    }

    if (phoneRaw !== undefined) {
      const digits = String(phoneRaw || '').replace(/\D/g, '');
      if (!digits) throw httpError('Phone number is required', 400);
      const e164 = normalizePhoneE164(phoneRaw) || digits;
      customer.phoneNumber = e164.startsWith('+') ? e164 : `+${e164}`;
    }

    if (addressRaw !== undefined) {
      customer.address = String(addressRaw || '').trim().slice(0, 200);
    }
    if (cityRaw !== undefined) {
      customer.city = String(cityRaw || '').trim().slice(0, 80);
    }

    customer.lastActivity = new Date();
    await customer.save();

    return this.getCustomerSummary(clientId, customerId);
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

  static async updateThreadMeta(clientId, contactWaId, body = {}) {
    const contact = normalizePhoneE164(contactWaId) || String(contactWaId || '').replace(/\D/g, '');
    if (!contact) throw httpError('Invalid contact WhatsApp number', 400);

    const $set = {};
    const stageRaw = body.stage;
    if (stageRaw !== undefined) {
      const stage = String(stageRaw || '').trim().toLowerCase();
      if (!['open', 'waiting', 'closed'].includes(stage)) {
        throw httpError('stage must be open, waiting, or closed', 400);
      }
      $set.stage = stage;
    }

    if (body.marketing_opt_out !== undefined || body.marketingOptOut !== undefined) {
      $set.marketing_opt_out = !!(body.marketing_opt_out ?? body.marketingOptOut);
    }

    let labels = null;
    if (Array.isArray(body.labels)) {
      labels = [...new Set(body.labels.map(normalizeLabel).filter(Boolean))].slice(0, 20);
      $set.labels = labels;
    }

    const addLabels = body.add_labels || body.addLabels;
    const removeLabels = body.remove_labels || body.removeLabels;

    let doc = await SaasWhatsAppThread.findOne({ client_id: clientId, contact_wa_id: contact });
    if (!doc) {
      doc = new SaasWhatsAppThread({
        client_id: clientId,
        contact_wa_id: contact,
        stage: 'open',
        labels: [],
      });
    }

    if (Object.keys($set).length) {
      Object.assign(doc, $set);
    }

    if (Array.isArray(addLabels) && addLabels.length) {
      const current = new Set(doc.labels || []);
      for (const l of addLabels.map(normalizeLabel).filter(Boolean)) {
        current.add(l);
      }
      doc.labels = [...current].slice(0, 20);
    }
    if (Array.isArray(removeLabels) && removeLabels.length) {
      const remove = new Set(removeLabels.map(normalizeLabel).filter(Boolean));
      doc.labels = (doc.labels || []).filter((l) => !remove.has(l));
    }

    await doc.save();
    const serialized = serializeThreadMeta(doc.toObject ? doc.toObject() : doc);
    return {
      contact_wa_id: contact,
      ...serialized,
    };
  }

  static async listThreadNotes(clientId, contactWaId) {
    const contact = normalizePhoneE164(contactWaId) || String(contactWaId || '').replace(/\D/g, '');
    if (!contact) throw httpError('Invalid contact WhatsApp number', 400);
    const notes = await SaasWhatsAppThreadNote.find({ client_id: clientId, contact_wa_id: contact })
      .sort({ created_at: -1 })
      .limit(100)
      .lean();
    return notes.map((n) => ({
      id: String(n._id),
      body: n.body,
      author_member_id: n.author_member_id || '',
      author_name: n.author_name || '',
      created_at: n.created_at,
    }));
  }

  static async createThreadNote(clientId, contactWaId, body = {}, author = {}) {
    const contact = normalizePhoneE164(contactWaId) || String(contactWaId || '').replace(/\D/g, '');
    if (!contact) throw httpError('Invalid contact WhatsApp number', 400);
    const text = String(body.body || body.note || '').trim();
    if (!text) throw httpError('Note body is required', 400);

    const note = await SaasWhatsAppThreadNote.create({
      client_id: clientId,
      contact_wa_id: contact,
      body: text.slice(0, 2000),
      author_member_id: String(author.memberId || author.member_id || '').trim(),
      author_name: String(author.name || author.author_name || '').trim().slice(0, 120),
    });

    return {
      id: String(note._id),
      body: note.body,
      author_member_id: note.author_member_id,
      author_name: note.author_name,
      created_at: note.created_at,
    };
  }

  static async deleteThreadNote(clientId, contactWaId, noteId, actor = {}) {
    const contact = normalizePhoneE164(contactWaId) || String(contactWaId || '').replace(/\D/g, '');
    if (!contact) throw httpError('Invalid contact WhatsApp number', 400);
    const note = await SaasWhatsAppThreadNote.findOne({
      _id: noteId,
      client_id: clientId,
      contact_wa_id: contact,
    });
    if (!note) throw httpError('Note not found', 404);

    const actorId = String(actor.memberId || actor.member_id || '').trim();
    const role = String(actor.role || '').toLowerCase();
    const isElevated = role === 'owner' || role === 'manager' || role === 'admin';
    if (actorId && note.author_member_id && note.author_member_id !== actorId && !isElevated) {
      throw httpError('You can only delete your own notes', 403);
    }

    await note.deleteOne();
    return { deleted: true, id: String(noteId) };
  }

  static async syncMessageTemplates(clientId) {
    const WhatsAppService = require('./WhatsAppService');
    return WhatsAppService.syncMessageTemplates(clientId);
  }

  static async listMessageTemplates(clientId, { status = '' } = {}) {
    const filter = { client_id: clientId };
    const st = String(status || '').trim();
    if (st) filter.status = { $regex: new RegExp(`^${escapeRegex(st)}$`, 'i') };
    const rows = await SaasWhatsAppTemplate.find(filter).sort({ name: 1, language: 1 }).lean();
    return rows.map((r) => ({
      id: String(r._id),
      name: r.name,
      language: r.language,
      status: r.status,
      category: r.category || '',
      components: r.components || [],
      synced_at: r.synced_at,
    }));
  }

  static async listAutoRules(clientId) {
    const rows = await SaasWhatsAppAutoRule.find({ client_id: clientId })
      .sort({ sort_order: 1, created_at: 1 })
      .lean();
    return rows.map((r) => ({
      id: String(r._id),
      enabled: !!r.enabled,
      name: r.name,
      keywords: r.keywords || [],
      reply: r.reply,
      match_mode: r.match_mode || 'any',
      sort_order: r.sort_order || 0,
      cooldown_ms: r.cooldown_ms,
    }));
  }

  static async createAutoRule(clientId, body = {}) {
    const count = await SaasWhatsAppAutoRule.countDocuments({ client_id: clientId });
    if (count >= 30) throw httpError('Maximum 30 auto-reply rules per account', 400);

    const name = String(body.name || '').trim().slice(0, 80);
    const reply = String(body.reply || '').trim().slice(0, 1000);
    if (!name) throw httpError('Rule name is required', 400);
    if (!reply) throw httpError('Reply text is required', 400);

    const keywords = Array.isArray(body.keywords)
      ? body.keywords.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean).slice(0, 40)
      : String(body.keywords || '')
          .split(',')
          .map((k) => k.trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 40);
    if (!keywords.length) throw httpError('At least one keyword is required', 400);

    const matchMode = String(body.match_mode || body.matchMode || 'any').trim().toLowerCase();
    if (!['any', 'all', 'short_greeting'].includes(matchMode)) {
      throw httpError('match_mode must be any, all, or short_greeting', 400);
    }

    const doc = await SaasWhatsAppAutoRule.create({
      client_id: clientId,
      enabled: body.enabled !== false,
      name,
      keywords,
      reply,
      match_mode: matchMode,
      sort_order: Number(body.sort_order ?? body.sortOrder ?? count) || 0,
      cooldown_ms:
        body.cooldown_ms != null || body.cooldownMs != null
          ? Number(body.cooldown_ms ?? body.cooldownMs)
          : null,
    });

    return {
      id: String(doc._id),
      enabled: doc.enabled,
      name: doc.name,
      keywords: doc.keywords,
      reply: doc.reply,
      match_mode: doc.match_mode,
      sort_order: doc.sort_order,
      cooldown_ms: doc.cooldown_ms,
    };
  }

  static async updateAutoRule(clientId, ruleId, body = {}) {
    const doc = await SaasWhatsAppAutoRule.findOne({ _id: ruleId, client_id: clientId });
    if (!doc) throw httpError('Auto-reply rule not found', 404);

    if (body.name !== undefined) {
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) throw httpError('Rule name is required', 400);
      doc.name = name;
    }
    if (body.reply !== undefined) {
      const reply = String(body.reply || '').trim().slice(0, 1000);
      if (!reply) throw httpError('Reply text is required', 400);
      doc.reply = reply;
    }
    if (body.enabled !== undefined) doc.enabled = !!body.enabled;
    if (body.keywords !== undefined) {
      const keywords = Array.isArray(body.keywords)
        ? body.keywords.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean).slice(0, 40)
        : String(body.keywords || '')
            .split(',')
            .map((k) => k.trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 40);
      if (!keywords.length) throw httpError('At least one keyword is required', 400);
      doc.keywords = keywords;
    }
    if (body.match_mode !== undefined || body.matchMode !== undefined) {
      const matchMode = String(body.match_mode || body.matchMode || 'any').trim().toLowerCase();
      if (!['any', 'all', 'short_greeting'].includes(matchMode)) {
        throw httpError('match_mode must be any, all, or short_greeting', 400);
      }
      doc.match_mode = matchMode;
    }
    if (body.sort_order !== undefined || body.sortOrder !== undefined) {
      doc.sort_order = Number(body.sort_order ?? body.sortOrder) || 0;
    }
    if (body.cooldown_ms !== undefined || body.cooldownMs !== undefined) {
      const n = body.cooldown_ms ?? body.cooldownMs;
      doc.cooldown_ms = n == null || n === '' ? null : Number(n);
    }

    await doc.save();
    return {
      id: String(doc._id),
      enabled: doc.enabled,
      name: doc.name,
      keywords: doc.keywords,
      reply: doc.reply,
      match_mode: doc.match_mode,
      sort_order: doc.sort_order,
      cooldown_ms: doc.cooldown_ms,
    };
  }

  static async deleteAutoRule(clientId, ruleId) {
    const result = await SaasWhatsAppAutoRule.deleteOne({ _id: ruleId, client_id: clientId });
    if (!result.deletedCount) throw httpError('Auto-reply rule not found', 404);
    return { deleted: true, id: String(ruleId) };
  }

  static serializeBroadcast(doc) {
    const b = doc.toObject ? doc.toObject() : doc;
    return {
      id: String(b._id),
      name: b.name || '',
      template_name: b.template_name,
      template_language: b.template_language || 'en',
      status: b.status,
      recipient_wa_ids: b.recipient_wa_ids || [],
      next_index: b.next_index || 0,
      stats: b.stats || { total: 0, sent: 0, failed: 0, skipped: 0 },
      created_by: b.created_by || '',
      error: b.error || '',
      created_at: b.created_at,
      updated_at: b.updated_at,
    };
  }

  static async listBroadcasts(clientId) {
    const rows = await SaasWhatsAppBroadcast.find({ client_id: clientId })
      .sort({ created_at: -1 })
      .limit(50)
      .lean();
    return rows.map((r) => this.serializeBroadcast(r));
  }

  static async getBroadcast(clientId, broadcastId) {
    const doc = await SaasWhatsAppBroadcast.findOne({ _id: broadcastId, client_id: clientId }).lean();
    if (!doc) throw httpError('Broadcast not found', 404);
    return this.serializeBroadcast(doc);
  }

  static async createBroadcast(clientId, body = {}, actor = {}) {
    const templateName = String(body.template_name || body.templateName || '').trim();
    if (!templateName) throw httpError('template_name is required', 400);

    const allowed = await this.isTemplateAllowedForInbox(clientId, templateName);
    if (!allowed) {
      throw httpError('Template must be an approved synced template or a built-in inbox template', 400);
    }

    let language = String(body.language || body.template_language || body.templateLanguage || '').trim();
    if (!language) {
      const row = await SaasWhatsAppTemplate.findOne({
        client_id: clientId,
        name: templateName,
        status: { $regex: /^APPROVED$/i },
      })
        .select('language')
        .lean();
      language = row?.language || process.env.WHATSAPP_TEMPLATE_LANG || 'en';
    }

    const rawIds = Array.isArray(body.contact_wa_ids || body.contactWaIds || body.recipients)
      ? body.contact_wa_ids || body.contactWaIds || body.recipients
      : [];
    const recipients = [
      ...new Set(
        rawIds
          .map((id) => normalizePhoneE164(id) || String(id || '').replace(/\D/g, ''))
          .filter(Boolean)
      ),
    ].slice(0, 200);
    if (!recipients.length) throw httpError('Select at least one recipient', 400);

    const name =
      String(body.name || '').trim().slice(0, 120) ||
      `Broadcast ${templateName} (${recipients.length})`;

    const doc = await SaasWhatsAppBroadcast.create({
      client_id: clientId,
      name,
      template_name: templateName,
      template_language: language,
      status: 'queued',
      recipient_wa_ids: recipients,
      next_index: 0,
      stats: { total: recipients.length, sent: 0, failed: 0, skipped: 0 },
      created_by: String(actor.memberId || actor.userId || actor.name || '').trim(),
    });

    const { isAgendaReady, getAgenda, JOB_NAMES } = require('../../config/agenda');
    if (!isAgendaReady()) {
      doc.status = 'failed';
      doc.error = 'Job scheduler is not ready';
      await doc.save();
      throw httpError('Broadcast scheduler is not available right now', 503);
    }

    const job = getAgenda().create(JOB_NAMES.WHATSAPP_BROADCAST, {
      broadcastId: String(doc._id),
      clientId,
    });
    job.schedule(new Date());
    await job.save();

    return this.serializeBroadcast(doc);
  }

  /**
   * Agenda: send one recipient, then schedule the next with a short stagger.
   */
  static async processBroadcastTick(data = {}) {
    const broadcastId = String(data.broadcastId || '').trim();
    const clientId = String(data.clientId || '').trim();
    if (!broadcastId || !clientId) return { ok: false, reason: 'invalid' };

    const doc = await SaasWhatsAppBroadcast.findOne({ _id: broadcastId, client_id: clientId });
    if (!doc) return { ok: false, reason: 'not_found' };
    if (doc.status === 'cancelled' || doc.status === 'completed' || doc.status === 'failed') {
      return { ok: true, status: doc.status };
    }

    doc.status = 'running';
    const index = Number(doc.next_index) || 0;
    const recipients = doc.recipient_wa_ids || [];

    if (index >= recipients.length) {
      doc.status = 'completed';
      await doc.save();
      return { ok: true, status: 'completed' };
    }

    const to = recipients[index];
    let outcome = 'sent';
    try {
      const meta = await SaasWhatsAppThread.findOne({
        client_id: clientId,
        contact_wa_id: to,
      })
        .select('marketing_opt_out')
        .lean();
      if (meta?.marketing_opt_out) {
        outcome = 'skipped';
        doc.stats.skipped = (doc.stats.skipped || 0) + 1;
      } else {
        await this.sendInboxTemplate({
          clientId,
          contactWaId: to,
          templateName: doc.template_name,
          language: doc.template_language,
        });
        doc.stats.sent = (doc.stats.sent || 0) + 1;
      }
    } catch (err) {
      outcome = 'failed';
      doc.stats.failed = (doc.stats.failed || 0) + 1;
      console.warn(
        `[whatsapp broadcast] ${broadcastId} recipient=${to} failed:`,
        err.message
      );
    }

    doc.next_index = index + 1;
    if (doc.next_index >= recipients.length) {
      doc.status = 'completed';
    }
    await doc.save();

    if (doc.status === 'running') {
      const { isAgendaReady, getAgenda, JOB_NAMES } = require('../../config/agenda');
      if (isAgendaReady()) {
        const stagger = Number(process.env.WHATSAPP_BROADCAST_STAGGER_MS) || 400;
        const job = getAgenda().create(JOB_NAMES.WHATSAPP_BROADCAST, {
          broadcastId,
          clientId,
        });
        job.schedule(new Date(Date.now() + stagger));
        await job.save();
      }
    }

    return { ok: true, outcome, next_index: doc.next_index, status: doc.status };
  }
}

module.exports = WhatsAppInboxService;
