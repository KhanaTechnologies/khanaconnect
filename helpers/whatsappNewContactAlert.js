/**
 * Email the business when someone starts a WhatsApp conversation.
 *
 * One email per conversation, not per message: a message counts as a new conversation when
 * the same person hasn't messaged in the last WHATSAPP_NEW_CONTACT_QUIET_HOURS (default 12).
 *
 * Env:
 *   WHATSAPP_NEW_CONTACT_ALERT_CLIENT_IDS  which accounts get these emails (default "Khana"; "*" = all)
 *   WHATSAPP_NEW_CONTACT_ALERT_EMAILS      comma-separated recipients; when empty, the business email
 *                                          plus active owner/admin team members
 *   WHATSAPP_NEW_CONTACT_ALERTS_DISABLED   "true" turns them off
 */
const SaasWhatsAppMessage = require('../models/SaasWhatsAppMessage');
const Client = require('../models/client');
const TeamMember = require('../models/teamMember');
const { decrypt } = require('./encryption');

const DEFAULT_QUIET_HOURS = 12;

function isDisabled() {
  const flag = String(process.env.WHATSAPP_NEW_CONTACT_ALERTS_DISABLED || '').toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes';
}

function enabledClientIds() {
  return String(process.env.WHATSAPP_NEW_CONTACT_ALERT_CLIENT_IDS || 'Khana')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isEnabledForClient(clientId) {
  if (isDisabled()) return false;
  const id = String(clientId || '').trim();
  if (!id) return false;
  const allowed = enabledClientIds();
  return allowed.includes('*') || allowed.includes(id);
}

function quietMs() {
  const h = Number(process.env.WHATSAPP_NEW_CONTACT_QUIET_HOURS);
  return (Number.isFinite(h) && h >= 0 ? h : DEFAULT_QUIET_HOURS) * 60 * 60 * 1000;
}

function addUniqueEmail(list, email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value || !value.includes('@')) return;
  if (!list.includes(value)) list.push(value);
}

async function resolveRecipients(client) {
  const recipients = [];
  for (const e of String(process.env.WHATSAPP_NEW_CONTACT_ALERT_EMAILS || '').split(',')) {
    addUniqueEmail(recipients, e);
  }
  if (recipients.length) return recipients;

  try {
    addUniqueEmail(recipients, decrypt(client.businessEmail));
  } catch {
    // no business email
  }
  const owners = await TeamMember.find({
    clientID: client.clientID,
    status: 'active',
    orgRole: { $in: ['owner', 'admin'] },
  })
    .select('email')
    .lean();
  for (const m of owners) addUniqueEmail(recipients, m.email);
  return recipients;
}

/**
 * Is this message the start of a conversation? Looks across accounts (shared number).
 * @returns {Promise<{ isNew: boolean, firstEver: boolean }>}
 */
async function classifyInbound({ contactWaId, wamid, timestamp }) {
  const at = timestamp ? new Date(timestamp) : new Date();
  const earlier = await SaasWhatsAppMessage.findOne({
    contact_wa_id: contactWaId,
    direction: 'inbound',
    deleted_at: null,
    wamid: { $ne: wamid },
    timestamp: { $lt: at },
  })
    .sort({ timestamp: -1 })
    .select('timestamp')
    .lean();

  if (!earlier) return { isNew: true, firstEver: true };
  const gap = at.getTime() - new Date(earlier.timestamp).getTime();
  return { isNew: gap >= quietMs(), firstEver: false };
}

/**
 * Call after a new inbound message is saved. Never throws.
 * @returns {Promise<{ sent: number, reason?: string }>}
 */
async function maybeAlertNewContact({ clientId, contactWaId, contactName = '', wamid, body = '', type = 'text', timestamp }) {
  try {
    if (!isEnabledForClient(clientId)) return { sent: 0, reason: 'disabled' };
    if (!contactWaId || !wamid) return { sent: 0, reason: 'invalid' };

    const { isNew, firstEver } = await classifyInbound({ contactWaId, wamid, timestamp });
    if (!isNew) return { sent: 0, reason: 'ongoing_conversation' };

    const client = await Client.findOne({ clientID: clientId });
    if (!client) return { sent: 0, reason: 'no_client' };

    const recipients = await resolveRecipients(client);
    if (!recipients.length) return { sent: 0, reason: 'no_recipients' };

    let autoReplyActive = false;
    try {
      const WhatsAppAutoResponderService = require('../services/saas/WhatsAppAutoResponderService');
      autoReplyActive = await WhatsAppAutoResponderService.isActiveForClient(clientId);
    } catch {
      autoReplyActive = false;
    }

    const { sendWhatsAppNewContactAlertEmail } = require('../utils/sendWhatsAppNewContactAlert');
    const result = await sendWhatsAppNewContactAlertEmail({
      client,
      recipients,
      contact: {
        contactWaId,
        contactName,
        body,
        type,
        timestamp: timestamp ? new Date(timestamp) : new Date(),
        firstEver,
      },
      autoReplyActive,
    });
    console.log(`[whatsapp new-contact] emailed ${result.sent} for ${contactWaId} (${clientId})`);
    return result;
  } catch (e) {
    console.warn('[whatsapp new-contact] alert failed:', e.message);
    return { sent: 0, reason: 'error', error: e.message };
  }
}

/**
 * For businesses on the platform (not Khana's own lead inbox, which gets the email above):
 * send the owner an alert when someone starts a WhatsApp chat with them, if they switched
 * owner alerts on. Goes out through OwnerAlertService (Khana's number → own number → email).
 * Never throws.
 */
async function maybeAlertOwnerOfNewChat({ clientId, contactWaId, contactName = '', wamid, body = '', type = 'text', timestamp }) {
  try {
    if (isEnabledForClient(clientId)) return { ok: false, skipped: 'khana_email' };
    const contact = String(contactWaId || '').replace(/\D/g, '');
    if (!clientId || !contact || !wamid) return { ok: false, skipped: 'invalid' };

    const client = await Client.findOne({ clientID: clientId }).select('whatsapp').lean();
    const wa = client?.whatsapp || {};
    if (!wa.ownerAlertsEnabled || wa.ownerAlertEvents?.message === false) return { ok: false, skipped: 'off' };

    // Never alert about the owner's own phone or the alert sender's number (no alert loops).
    if (String(wa.ownerAlertPhone || '').replace(/\D/g, '') === contact) return { ok: false, skipped: 'own_number' };
    const OwnerAlertService = require('../services/saas/OwnerAlertService');
    if ((await OwnerAlertService.senderNumber()) === contact) return { ok: false, skipped: 'alert_sender' };

    const { isNew } = await classifyInbound({ contactWaId: contact, wamid, timestamp });
    if (!isNew) return { ok: false, skipped: 'ongoing_conversation' };

    const text = String(body || '').replace(/\s+/g, ' ').trim();
    const preview = text ? `"${text.length > 120 ? `${text.slice(0, 117)}…` : text}"` : `(${type || 'message'})`;
    const who = contactName ? `${contactName} (+${contact})` : `+${contact}`;
    return await OwnerAlertService.send(clientId, {
      key: `message:${contact}:${wamid}`,
      event: 'message',
      headline: 'New WhatsApp message',
      details: `${who}: ${preview} · reply in your WhatsApp inbox`,
    });
  } catch (e) {
    console.warn('[whatsapp new-chat alert] failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = {
  maybeAlertNewContact,
  maybeAlertOwnerOfNewChat,
  classifyInbound,
  isEnabledForClient,
  resolveRecipients,
};
