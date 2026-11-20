/**
 * Owner alerts: tell a business owner about a new booking, order, reschedule request or WhatsApp chat.
 *
 * Order of channels:
 *   1. WhatsApp from Khana's own number (works even if the client hasn't connected WhatsApp,
 *      and can reach the client's business number, which can't message itself);
 *   2. WhatsApp from the client's own connected number (not to that same number);
 *   3. email to the business email and the owner, if WhatsApp isn't possible, or later when
 *      Meta reports the WhatsApp as not delivered.
 *
 * The owner picks the number (their own phone, or the WhatsApp business number) and which
 * updates they want, under client.whatsapp.ownerAlert*.
 *
 * Env:
 *   OWNER_ALERTS_SENDER_CLIENT_ID   account whose number sends alerts (default "Khana"; empty = client's own only)
 */
const Client = require('../../models/client');
const SaasWhatsAppAccount = require('../../models/SaasWhatsAppAccount');
const TeamMember = require('../../models/teamMember');
const { normalizePhoneE164 } = require('../../helpers/whatsappLink');

const TEMPLATE = 'owner_new_activity';
const EVENTS = ['booking', 'order', 'reschedule', 'message'];
const DASHBOARD_URL = (process.env.DASHBOARD_URL || 'https://khanatechnologies.co.za').replace(/\/$/, '');

function senderClientId() {
  const raw = process.env.OWNER_ALERTS_SENDER_CLIENT_ID;
  return raw == null ? 'Khana' : String(raw).trim();
}

function digits(v) {
  return String(v || '').replace(/\D/g, '');
}

function eventEnabled(wa, event) {
  if (!event) return true;
  const events = wa?.ownerAlertEvents || {};
  return events[event] !== false;
}

function clean(text, max = 600) {
  return String(text || '—').replace(/\s+/g, ' ').trim().slice(0, max) || '—';
}

function addUniqueEmail(list, email) {
  const value = String(email || '').trim().toLowerCase();
  if (value && value.includes('@') && !list.includes(value)) list.push(value);
}

class OwnerAlertService {
  static TEMPLATE = TEMPLATE;
  static EVENTS = EVENTS;

  static async activeAccount(clientId) {
    if (!clientId) return null;
    return SaasWhatsAppAccount.findOne({ client_id: clientId, status: 'active' })
      .sort({ updated_at: -1 })
      .select('phone_number_id display_phone_number')
      .lean();
  }

  /** Digits of the number alerts are sent from (Khana's), or '' when none. */
  static async senderNumber() {
    const id = senderClientId();
    if (!id) return '';
    const account = await this.activeAccount(id);
    return digits(normalizePhoneE164(account?.display_phone_number || ''));
  }

  /** True when Khana's number can send owner alerts (connected, template approved). */
  static async khanaSenderReady() {
    const id = senderClientId();
    if (!id || !(await this.activeAccount(id))) return false;
    const NotifyService = require('./WhatsAppNotifyService');
    return NotifyService.hasApprovedTemplate(id, TEMPLATE);
  }

  /** Owner alert settings in the snake_case shape the WhatsApp health endpoint uses. */
  static healthFields(client) {
    const wa = client?.whatsapp || {};
    const events = wa.ownerAlertEvents || {};
    return {
      owner_alerts_enabled: !!wa.ownerAlertsEnabled,
      owner_alert_phone: wa.ownerAlertPhone || '',
      owner_alert_target: wa.ownerAlertTarget === 'business' ? 'business' : 'personal',
      owner_alert_events: {
        booking: events.booking !== false,
        order: events.order !== false,
        reschedule: events.reschedule !== false,
        message: events.message !== false,
      },
      owner_alert_email_fallback: wa.ownerAlertEmailFallback !== false,
    };
  }

  /** The number to alert: the owner's own phone, or the business's WhatsApp number. */
  static async resolveTarget(client) {
    const wa = client?.whatsapp || {};
    if (wa.ownerAlertTarget === 'business') {
      const account = await this.activeAccount(client.clientID);
      const fromAccount = normalizePhoneE164(account?.display_phone_number || '');
      const fromProfile = normalizePhoneE164(wa.phoneE164 || '');
      return digits(fromAccount || fromProfile);
    }
    return digits(normalizePhoneE164(wa.ownerAlertPhone || ''));
  }

  /** Accounts that may send this alert, best first. */
  static async senderCandidates(clientId, to) {
    const NotifyService = require('./WhatsAppNotifyService');
    const out = [];
    const ids = [];
    const khana = senderClientId();
    if (khana && khana !== clientId) ids.push(khana);
    ids.push(clientId);

    for (const id of ids) {
      const account = await this.activeAccount(id);
      if (!account) continue;
      // A number can't WhatsApp itself.
      if (digits(normalizePhoneE164(account.display_phone_number || '')) === to) continue;
      if (!(await NotifyService.hasApprovedTemplate(id, TEMPLATE))) continue;
      out.push(id);
    }
    return out;
  }

  /**
   * Send one alert. Deduplicated by key, never throws.
   * @param {string} clientId business the alert is about
   * @param {{ key: string, event?: 'booking'|'order'|'reschedule'|'message', headline: string, details: string }} alert
   */
  static async send(clientId, { key, event = '', headline, details }) {
    try {
      const client = await Client.findOne({ clientID: clientId })
        .select('clientID whatsapp companyName clientName businessEmail')
        .lean();
      const wa = client?.whatsapp || {};
      if (!client || !wa.ownerAlertsEnabled) return { ok: false, skipped: 'off' };
      if (!eventEnabled(wa, event)) return { ok: false, skipped: 'event_off' };

      const WhatsAppOwnerAlert = require('../../models/WhatsAppOwnerAlert');
      let row;
      try {
        row = await WhatsAppOwnerAlert.create({
          client_id: clientId,
          key: String(key).slice(0, 200),
          event,
          headline: clean(headline, 120),
          details: clean(details),
        });
      } catch (e) {
        if (e?.code === 11000) return { ok: false, skipped: 'duplicate' };
        throw e;
      }

      const business = client.companyName || client.clientName || 'your business';
      const to = await this.resolveTarget(client);
      let lastError = to ? 'no WhatsApp sender with an approved owner_new_activity template' : 'no alert number set';

      if (to) {
        const WhatsAppService = require('./WhatsAppService');
        for (const senderId of await this.senderCandidates(clientId, to)) {
          try {
            const data = await WhatsAppService.sendTemplateMessage({
              clientId: senderId,
              to,
              templateName: TEMPLATE,
              messageType: 'utility',
              components: [
                {
                  type: 'body',
                  parameters: [row.headline, business, row.details].map((t) => ({ type: 'text', text: clean(t) })),
                },
              ],
            });
            const wamid = data?.messages?.[0]?.id || '';
            await WhatsAppOwnerAlert.updateOne(
              { _id: row._id },
              { $set: { channel: 'whatsapp', wamid, sender_client_id: senderId, to } }
            );
            return { ok: true, channel: 'whatsapp', sender: senderId, to, wamid };
          } catch (e) {
            lastError = e?.message || 'send failed';
            console.warn(`[owner alert] WhatsApp from ${senderId} failed:`, lastError);
          }
        }
      }

      return await this.fallbackToEmail(client, row, lastError);
    } catch (e) {
      console.warn('[owner alert] failed:', e.message);
      return { ok: false, error: e.message };
    }
  }

  /** Email the alert if the owner allows it. Marks the row so it's never emailed twice. */
  static async fallbackToEmail(client, row, reason = '') {
    const WhatsAppOwnerAlert = require('../../models/WhatsAppOwnerAlert');
    if (client?.whatsapp?.ownerAlertEmailFallback === false) {
      await WhatsAppOwnerAlert.updateOne({ _id: row._id }, { $set: { channel: 'none' } });
      return { ok: false, channel: 'none', reason };
    }
    const claim = await WhatsAppOwnerAlert.updateOne(
      { _id: row._id, email_sent_at: null },
      { $set: { email_sent_at: new Date(), channel: 'email' } }
    );
    if (!claim.modifiedCount) return { ok: false, skipped: 'already_emailed' };

    try {
      const sent = await this.sendAlertEmail(client, row);
      return { ok: sent > 0, channel: 'email', sent, reason };
    } catch (e) {
      // Let a later delivery failure try again.
      await WhatsAppOwnerAlert.updateOne({ _id: row._id }, { $set: { email_sent_at: null } });
      console.warn('[owner alert] email failed:', e.message);
      return { ok: false, channel: 'email', error: e.message, reason };
    }
  }

  static async emailRecipients(client) {
    const { resolveBusinessEmail } = require('../../helpers/mailHost');
    const list = [];
    try {
      addUniqueEmail(list, resolveBusinessEmail(client));
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
    for (const m of owners) addUniqueEmail(list, m.email);
    return list;
  }

  static async sendAlertEmail(client, row) {
    const recipients = await this.emailRecipients(client);
    if (!recipients.length) return 0;

    const { sendMailWithRetry } = require('../../helpers/mailer');
    const { resolveMailbox } = require('../../utils/sendWhatsAppWindowCloseAlert');
    const { getKhanaAdminClient } = require('../../helpers/teamPasswordReset');
    const { escapeHtml, buildKhanaEmail, infoPanel, ctaButton } = require('../../helpers/transactionalEmailLayout');

    const admin = await getKhanaAdminClient();
    const mailbox = await resolveMailbox(admin);
    const business = client.companyName || client.clientName || 'your business';
    const subject = `${row.headline} – ${business}`;
    const html = buildKhanaEmail({
      title: subject,
      headline: row.headline,
      preheader: row.details.slice(0, 100),
      bodyHtml: `
        <p style="margin:0 0 16px;">Heads up: ${escapeHtml(row.headline.toLowerCase())} for ${escapeHtml(business)}.</p>
        ${infoPanel({ title: 'Details', html: `<p style="margin:0;font-size:14px;line-height:22px;color:#404d57;">${escapeHtml(row.details)}</p>` })}
        ${ctaButton({ href: `${DASHBOARD_URL}/dashboard`, label: 'Open your dashboard' })}
        <p style="margin:0;font-size:13px;color:#6b7280;">You're getting this by email because we couldn't reach you on WhatsApp. Check your alert number under WhatsApp settings in your dashboard.</p>
      `,
      brandName: 'Khana Technologies',
    });

    let sent = 0;
    for (const to of recipients) {
      await sendMailWithRetry(
        {
          host: mailbox.host,
          port: mailbox.port,
          secure: mailbox.secure,
          user: mailbox.user,
          pass: mailbox.pass,
          from: `"Khana Technologies" <${mailbox.fromEmail}>`,
          to,
          subject,
          html,
          clientID: admin.clientID,
          saveToSent: false,
        },
        3
      );
      sent += 1;
    }
    return sent;
  }

  /**
   * Meta reported an outbound message as not delivered. If it was an owner alert, email it instead.
   * @returns {Promise<boolean>} true when the message was an owner alert (handled here)
   */
  static async onUndelivered(wamid, error = '') {
    if (!wamid) return false;
    const WhatsAppOwnerAlert = require('../../models/WhatsAppOwnerAlert');
    const row = await WhatsAppOwnerAlert.findOne({ wamid }).lean();
    if (!row) return false;
    const client = await Client.findOne({ clientID: row.client_id })
      .select('clientID whatsapp companyName clientName businessEmail')
      .lean();
    if (client) await this.fallbackToEmail(client, row, error || 'not delivered');
    return true;
  }
}

module.exports = OwnerAlertService;
