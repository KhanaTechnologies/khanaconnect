const SaasWhatsAppMessage = require('../../models/SaasWhatsAppMessage');
const { matchAutoReplyRule } = require('../../helpers/whatsappAutoResponderRules');
const WhatsAppInboxService = require('./WhatsAppInboxService');

const DEFAULT_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function autoReplyEnabled() {
  const flag = String(process.env.WHATSAPP_AUTO_REPLY_ENABLED || 'true').toLowerCase();
  return flag !== '0' && flag !== 'false' && flag !== 'off';
}

function allowedClientIds() {
  return String(process.env.WHATSAPP_AUTO_REPLY_CLIENT_IDS || 'Khana')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isEnabledForClient(clientId) {
  if (!autoReplyEnabled()) return false;
  const allowed = allowedClientIds();
  if (allowed.includes('*')) return true;
  return allowed.includes(String(clientId || '').trim());
}

function delayMs() {
  const n = Number(process.env.WHATSAPP_AUTO_REPLY_DELAY_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DELAY_MS;
}

function cooldownMs() {
  const n = Number(process.env.WHATSAPP_AUTO_REPLY_COOLDOWN_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_MS;
}

/** Types whose extracted body can meaningfully match keyword rules. */
function isMatchableInboundType(type) {
  const t = String(type || 'text').toLowerCase();
  return t === 'text' || t === 'interactive' || t === 'button';
}

class WhatsAppAutoResponderService {
  /**
   * Prefer the WABA phone-owner client when it is allowlisted (Khana ads),
   * otherwise fall back to the thread client from reattribution.
   */
  static resolveScheduleClientId(ownerClientId, threadClientId) {
    if (isEnabledForClient(ownerClientId)) return String(ownerClientId || '').trim();
    if (isEnabledForClient(threadClientId)) return String(threadClientId || '').trim();
    return null;
  }

  /**
   * After a new inbound message is saved, schedule a delayed auto-reply if it matches a rule.
   */
  static async maybeScheduleForInbound({
    clientId,
    contactWaId,
    wamid,
    body,
    type = 'text',
  }) {
    try {
      if (!isEnabledForClient(clientId)) return { scheduled: false, reason: 'disabled' };
      if (!isMatchableInboundType(type)) return { scheduled: false, reason: 'not_text' };

      const match = matchAutoReplyRule(body);
      if (!match) return { scheduled: false, reason: 'no_match' };

      const contact = String(contactWaId || '').replace(/\D/g, '');
      if (!contact || !wamid) return { scheduled: false, reason: 'invalid' };

      // One auto-reply per contact within cooldown (avoid spamming). Shared WABA:
      // look up by contact only so a reattributed thread still counts.
      const since = new Date(Date.now() - cooldownMs());
      const recentAuto = await SaasWhatsAppMessage.findOne({
        contact_wa_id: contact,
        direction: 'outbound',
        deleted_at: null,
        'raw.auto_reply': true,
        timestamp: { $gte: since },
      })
        .select('wamid timestamp')
        .lean();
      if (recentAuto) {
        return { scheduled: false, reason: 'cooldown' };
      }

      const { isAgendaReady, getAgenda, JOB_NAMES } = require('../../config/agenda');
      if (!isAgendaReady()) {
        console.warn('[whatsapp auto-reply] Agenda not ready — skipping schedule');
        return { scheduled: false, reason: 'agenda_not_ready' };
      }

      const runAt = new Date(Date.now() + delayMs());
      const job = getAgenda().create(JOB_NAMES.WHATSAPP_AUTO_REPLY, {
        clientId,
        contactWaId: contact,
        triggerWamid: wamid,
        ruleId: match.id,
        replyText: match.reply,
      });
      job.schedule(runAt);
      await job.save();

      console.log(
        `[whatsapp auto-reply] scheduled rule=${match.id} contact=${contact} at=${runAt.toISOString()}`
      );
      return { scheduled: true, ruleId: match.id, runAt };
    } catch (e) {
      console.error('[whatsapp auto-reply] schedule failed:', e.message);
      return { scheduled: false, reason: 'error', error: e.message };
    }
  }

  /**
   * Agenda job: send the reply only if a human has not already answered.
   */
  static async executeScheduledReply(data = {}) {
    const clientId = String(data.clientId || '').trim();
    const contactWaId = String(data.contactWaId || '').replace(/\D/g, '');
    const triggerWamid = String(data.triggerWamid || '').trim();
    const replyText = String(data.replyText || '').trim();
    const ruleId = String(data.ruleId || '').trim();

    if (!clientId || !contactWaId || !replyText) {
      return { sent: false, reason: 'invalid_payload' };
    }
    if (!isEnabledForClient(clientId)) {
      return { sent: false, reason: 'disabled' };
    }

    // Trigger may be stored under a reattributed client_id — match by wamid only.
    const trigger = triggerWamid
      ? await SaasWhatsAppMessage.findOne({ wamid: triggerWamid }).lean()
      : null;

    if (!trigger || trigger.deleted_at) {
      return { sent: false, reason: 'trigger_missing' };
    }

    const triggerAt = trigger.timestamp ? new Date(trigger.timestamp) : new Date(0);

    // Human (or any non-auto) outbound after the trigger → cancel.
    // Scope by contact across clients (shared number / reattribution).
    const outsAfter = await SaasWhatsAppMessage.find({
      contact_wa_id: contactWaId,
      direction: 'outbound',
      deleted_at: null,
      timestamp: { $gt: triggerAt },
    })
      .select('wamid raw')
      .lean();
    if (outsAfter.some((m) => !m?.raw?.auto_reply)) {
      return { sent: false, reason: 'human_replied' };
    }
    if (outsAfter.some((m) => m?.raw?.auto_reply)) {
      return { sent: false, reason: 'already_auto_replied' };
    }

    const result = await WhatsAppInboxService.sendTextReply({
      clientId,
      to: contactWaId,
      text: replyText,
      autoReplyMeta: { ruleId, triggerWamid },
    });

    console.log(
      `[whatsapp auto-reply] sent rule=${ruleId || 'unknown'} contact=${contactWaId} client=${clientId}`
    );
    return { sent: true, ruleId, wamid: result?.message?.wamid || null };
  }
}

module.exports = WhatsAppAutoResponderService;
