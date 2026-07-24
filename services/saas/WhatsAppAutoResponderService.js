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

class WhatsAppAutoResponderService {
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
      if (String(type || 'text') !== 'text') return { scheduled: false, reason: 'not_text' };

      const match = matchAutoReplyRule(body);
      if (!match) return { scheduled: false, reason: 'no_match' };

      const contact = String(contactWaId || '').replace(/\D/g, '');
      if (!contact || !wamid) return { scheduled: false, reason: 'invalid' };

      // One auto-reply per contact within cooldown (avoid spamming).
      const since = new Date(Date.now() - cooldownMs());
      const recentAuto = await SaasWhatsAppMessage.findOne({
        client_id: clientId,
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

    const trigger = triggerWamid
      ? await SaasWhatsAppMessage.findOne({
          wamid: triggerWamid,
          client_id: clientId,
          deleted_at: null,
        }).lean()
      : null;

    const triggerAt = trigger?.timestamp ? new Date(trigger.timestamp) : new Date(0);

    // Human (or any non-auto) outbound after the trigger → cancel auto-reply.
    const outsAfter = await SaasWhatsAppMessage.find({
      client_id: clientId,
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
    });

    // Tag the outbound row as auto-reply for cooldown / skip logic.
    if (result?.message?.wamid) {
      await SaasWhatsAppMessage.updateOne(
        { wamid: result.message.wamid },
        {
          $set: {
            raw: {
              ...(result.meta || {}),
              auto_reply: true,
              auto_reply_rule: ruleId,
              trigger_wamid: triggerWamid,
            },
          },
        }
      );
    }

    console.log(
      `[whatsapp auto-reply] sent rule=${ruleId || 'unknown'} contact=${contactWaId} client=${clientId}`
    );
    return { sent: true, ruleId, wamid: result?.message?.wamid || null };
  }
}

module.exports = WhatsAppAutoResponderService;
