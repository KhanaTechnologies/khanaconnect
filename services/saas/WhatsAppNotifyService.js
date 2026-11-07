/**
 * Reliability and follow-ups around the automatic order/booking WhatsApp messages:
 *  - retry sends that failed for a temporary reason, then tell the owner when they keep failing;
 *  - refund credits for messages Meta reports as not delivered;
 *  - no credit charge for utility messages sent while the customer's 24-hour window is open
 *    (Meta does not bill those either);
 *  - Confirm / Reschedule buttons on booking reminders;
 *  - a WhatsApp to the owner's own phone for each new booking, order and reschedule request.
 */
const mongoose = require('mongoose');
const Client = require('../../models/client');
const SaasWhatsAppAccount = require('../../models/SaasWhatsAppAccount');
const SaasWhatsAppMessage = require('../../models/SaasWhatsAppMessage');
const { normalizePhoneE164 } = require('../../helpers/whatsappLink');

const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://khanatechnologies.co.za';
const TZ = process.env.BUSINESS_TIMEZONE || 'Africa/Johannesburg';
const MAX_ATTEMPTS = 3;
/** Retry delays after attempt 1 and 2. */
const RETRY_DELAYS_MS = [60 * 1000, 10 * 60 * 1000];
/** Slightly under 24h so a send near the edge is never treated as free when Meta would bill it. */
const FREE_WINDOW_MS = 23.5 * 60 * 60 * 1000;
const FAILURE_EMAIL_EVERY_MS = 24 * 60 * 60 * 1000;

const REMINDER_ACTIONS_TEMPLATE = 'booking_reminder_actions';
const OWNER_ALERT_TEMPLATE = 'owner_new_activity';

/** Meta error codes that mean "try again later", not "this will never work". */
const TRANSIENT_META_CODES = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131048]);
/** Codes about one recipient (not on WhatsApp, opted out…): refund, but don't alarm the owner. */
const RECIPIENT_META_CODES = new Set([131026, 131047, 131049, 131050, 130472, 131021]);

const ORDER_STATUS_WORDS = {
  pending: 'received',
  received: 'received',
  paid: 'paid',
  processing: 'being prepared',
  preparing: 'being prepared',
  packed: 'packed',
  shipped: 'on its way',
  dispatched: 'on its way',
  in_transit: 'on its way',
  out_for_delivery: 'out for delivery',
  ready: 'ready for collection',
  ready_for_collection: 'ready for collection',
  ready_for_pickup: 'ready for collection',
  delivered: 'delivered',
  collected: 'collected',
  completed: 'complete',
  complete: 'complete',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  refunded: 'refunded',
  failed: 'not successful',
};

function metaCode(err) {
  const n = Number(err?.meta?.code ?? err?.response?.data?.error?.code);
  return Number.isFinite(n) ? n : null;
}

function isTransientError(err) {
  const code = metaCode(err);
  if (code != null && TRANSIENT_META_CODES.has(code)) return true;
  if (code != null) return false;
  const status = Number(err?.status || err?.response?.status || 0);
  if (status === 429 || status >= 500) return true;
  // Network trouble before Meta answered.
  return /timeout|ECONNRESET|ETIMEDOUT|ECONNABORTED|EAI_AGAIN|socket hang up/i.test(String(err?.message || ''));
}

function isObjectId(v) {
  return /^[a-f0-9]{24}$/i.test(String(v || ''));
}

/** Short, readable reference for customers instead of a 24-character database id. */
function displayRef(ref) {
  const s = String(ref || '').trim();
  if (isObjectId(s)) return `#${s.slice(-6).toUpperCase()}`;
  return s || '—';
}

function orderStatusWords(status) {
  const key = String(status || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (ORDER_STATUS_WORDS[key]) return ORDER_STATUS_WORDS[key];
  return key ? key.replace(/_/g, ' ') : 'updated';
}

function staffName(assignedTo) {
  if (!assignedTo || typeof assignedTo !== 'object' || assignedTo instanceof mongoose.Types.ObjectId) return '';
  return String(
    assignedTo.name || [assignedTo.firstName, assignedTo.lastName].filter(Boolean).join(' ') || ''
  ).trim();
}

/** "Thu, 6 Nov 2026 at 10:00 (Gel overlay with Thandi)" — WhatsApp params allow no line breaks. */
function formatBookingWhen(booking) {
  if (!booking) return '—';
  let when;
  const d = new Date(booking.date);
  if (Number.isNaN(d.getTime())) {
    when = String(booking.date || '—');
  } else {
    when = d.toLocaleDateString('en-ZA', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: TZ,
    });
  }
  if (booking.time) when += ` at ${booking.time}`;

  const services = (Array.isArray(booking.services) ? booking.services : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .join(', ');
  const who = staffName(booking.assignedTo);
  const what = [services, who ? `with ${who}` : ''].filter(Boolean).join(' ');
  return (what ? `${when} (${what})` : when).replace(/\s+/g, ' ').slice(0, 300);
}

async function loadBooking(bookingId) {
  if (!isObjectId(bookingId)) return null;
  const Booking = require('../../models/booking');
  const booking = await Booking.findById(bookingId);
  if (!booking) return null;
  if (booking.assignedTo && !staffName(booking.assignedTo)) {
    try {
      const Staff = require('../../models/staff');
      const staff = await Staff.findById(booking.assignedTo).select('name').lean();
      if (staff) booking.assignedTo = staff;
    } catch {
      /* staff name is optional */
    }
  }
  return booking;
}

function firstNameAndInitial(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A customer';
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

class WhatsAppNotifyService {
  static displayRef = displayRef;
  static formatBookingWhen = formatBookingWhen;
  static orderStatusWords = orderStatusWords;
  static isTransientError = isTransientError;
  static REMINDER_ACTIONS_TEMPLATE = REMINDER_ACTIONS_TEMPLATE;
  static OWNER_ALERT_TEMPLATE = OWNER_ALERT_TEMPLATE;

  static async hasApprovedTemplate(clientId, name) {
    const SaasWhatsAppTemplate = require('../../models/SaasWhatsAppTemplate');
    const row = await SaasWhatsAppTemplate.findOne({
      client_id: clientId,
      name,
      status: { $regex: /^APPROVED$/i },
    })
      .select('_id')
      .lean();
    return !!row;
  }

  /** True when this customer messaged the business number recently enough that Meta does not bill utility templates. */
  static async isServiceWindowOpen(clientId, e164, phoneNumberId = '') {
    const contact = String(e164 || '').replace(/\D/g, '');
    if (!clientId || !contact) return false;
    const since = new Date(Date.now() - FREE_WINDOW_MS);
    const q = {
      client_id: clientId,
      contact_wa_id: contact,
      direction: 'inbound',
      timestamp: { $gte: since },
    };
    if (phoneNumberId) q.phone_number_id = phoneNumberId;
    const hit = await SaasWhatsAppMessage.findOne(q).select('_id').lean();
    return !!hit;
  }

  // ---------------------------------------------------------------- failures

  /** Called after an automatic send throws. Retries temporary failures; records the rest. */
  static async handleSendFailure(kind, opts, err, attempt = 1) {
    const clientId = opts?.clientId;
    // A login code that arrives minutes late is useless; everything else is worth another try.
    if (kind !== 'verification' && isTransientError(err) && attempt < MAX_ATTEMPTS) {
      const scheduled = await this.scheduleRetry(kind, opts, attempt).catch((e) => {
        console.warn('[whatsapp notify] could not schedule retry:', e.message);
        return false;
      });
      if (scheduled) return { ok: false, retrying: true, attempt, error: err.message };
    }
    await this.recordFailure(clientId, { kind, error: err?.message || 'send failed' });
    return { ok: false, error: err?.message || 'send failed' };
  }

  static async scheduleRetry(kind, opts, attempt) {
    const { getAgenda, isAgendaReady, isSchedulerDisabled, JOB_NAMES } = require('../../config/agenda');
    if (isSchedulerDisabled() || !isAgendaReady()) return false;
    const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
    const job = getAgenda().create(JOB_NAMES.WHATSAPP_NOTIFY_RETRY, {
      kind,
      opts,
      attempt: attempt + 1,
      clientId: opts?.clientId || '',
    });
    job.schedule(new Date(Date.now() + delay));
    await job.save();
    console.warn(`[whatsapp notify] ${kind} retry ${attempt + 1}/${MAX_ATTEMPTS} in ${Math.round(delay / 1000)}s`);
    return true;
  }

  static async recordSuccess(clientId) {
    if (!clientId) return;
    await SaasWhatsAppAccount.updateOne(
      { client_id: clientId, status: 'active', notify_failure_count: { $gt: 0 } },
      { $set: { notify_failure_count: 0, last_notify_ok_at: new Date() } }
    );
  }

  /** Store the failure on the account (shown on the dashboard) and email the owner at most once a day. */
  static async recordFailure(clientId, { kind = '', error = '' } = {}) {
    if (!clientId) return;
    const now = new Date();
    const account = await SaasWhatsAppAccount.findOneAndUpdate(
      { client_id: clientId, status: 'active' },
      {
        $inc: { notify_failure_count: 1 },
        $set: {
          last_notify_error: String(error).slice(0, 500),
          last_notify_error_kind: String(kind).slice(0, 60),
          last_notify_error_at: now,
        },
      },
      { new: true, sort: { updated_at: -1 } }
    );
    // No connected number: nothing the owner can fix from an alert, and the dashboard already says so.
    if (!account) return;

    const cutoff = new Date(now.getTime() - FAILURE_EMAIL_EVERY_MS);
    const claim = await SaasWhatsAppAccount.updateOne(
      {
        _id: account._id,
        $or: [{ notify_failure_email_at: null }, { notify_failure_email_at: { $lt: cutoff } }],
      },
      { $set: { notify_failure_email_at: now } }
    );
    if (!claim.modifiedCount) return;
    try {
      await this.emailOwnerAboutFailures(clientId, { kind, error });
    } catch (e) {
      console.warn('[whatsapp notify] failure email not sent:', e.message);
    }
  }

  static async emailOwnerAboutFailures(clientId, { kind, error }) {
    const { isSystemSmtpConfigured, createSystemSmtpTransport, getSystemSmtpConfig } = require('../../helpers/systemSmtpTransport');
    const { resolveBusinessEmail } = require('../../helpers/mailHost');
    const { decrypt } = require('../../helpers/encryption');
    if (!isSystemSmtpConfigured()) return;
    // Full document: businessEmail is decrypted by a getter.
    const client = await Client.findOne({ clientID: clientId }).select('companyName businessEmail');
    const to = client ? resolveBusinessEmail(client) : '';
    if (!to) return;
    const fromAddress = decrypt(process.env.REPORT_EMAIL_FROM || process.env.ERROR_EMAIL_FROM || getSystemSmtpConfig().user);
    const what = {
      order_confirmation: 'order confirmations',
      order_status: 'order updates',
      booking_confirmation: 'booking confirmations',
      booking_reminder: 'booking reminders',
      owner_alert: 'your new-booking/order alerts',
    }[kind] || 'automatic WhatsApp messages';
    const text = [
      `Hi ${client.companyName || ''},`.trim(),
      '',
      `WhatsApp ${what} to your customers are not going through.`,
      '',
      `What WhatsApp said: ${error}`,
      '',
      'Your customers still get the email confirmation; only the WhatsApp message is affected.',
      `Open your dashboard to see what needs fixing: ${DASHBOARD_URL}/dashboard`,
      '',
      'If you are not sure what to do, reply to this email and we will sort it out.',
      '',
      'Khana Technologies',
    ].join('\n');
    await createSystemSmtpTransport().sendMail({
      from: `Khana Technologies <${fromAddress}>`,
      to,
      subject: 'Your WhatsApp messages to customers are failing',
      text,
    });
  }

  /** Meta reported an outbound message as failed (webhook). Refund it; flag account-level problems. */
  static async onDeliveryFailed({ wamid, error = '', code = null }) {
    const msg = await SaasWhatsAppMessage.findOne({ wamid, direction: 'outbound' })
      .select('client_id template_name')
      .lean();
    if (!msg?.client_id) return;
    try {
      const BillingService = require('./BillingService');
      await BillingService.refundUsage({
        clientId: msg.client_id,
        sourceRef: wamid,
        reason: `WhatsApp not delivered${error ? `: ${error}` : ''}`,
      });
    } catch (e) {
      console.warn('[whatsapp notify] refund failed:', e.message);
    }
    const n = Number(code);
    if (Number.isFinite(n) && RECIPIENT_META_CODES.has(n)) return;
    if (msg.template_name) {
      await this.recordFailure(msg.client_id, { kind: msg.template_name, error: error || 'not delivered' });
    }
  }

  // ---------------------------------------------------------------- owner alerts

  /**
   * WhatsApp the owner's own phone. Deduplicated per key, so the same booking/order alerts once.
   * Never throws.
   */
  static async sendOwnerAlert(clientId, { key, headline, details }) {
    try {
      const client = await Client.findOne({ clientID: clientId })
        .select('whatsapp companyName clientName')
        .lean();
      const wa = client?.whatsapp || {};
      const to = normalizePhoneE164(wa.ownerAlertPhone || '');
      if (!wa.ownerAlertsEnabled || !to) return { ok: false, skipped: 'off' };
      if (!(await this.hasApprovedTemplate(clientId, OWNER_ALERT_TEMPLATE))) {
        return { ok: false, skipped: 'template_not_approved' };
      }
      const WhatsAppOwnerAlert = require('../../models/WhatsAppOwnerAlert');
      try {
        await WhatsAppOwnerAlert.create({ client_id: clientId, key: String(key).slice(0, 200) });
      } catch (e) {
        if (e?.code === 11000) return { ok: false, skipped: 'duplicate' };
        throw e;
      }
      const WhatsAppService = require('./WhatsAppService');
      const data = await WhatsAppService.sendTemplateMessage({
        clientId,
        to,
        templateName: OWNER_ALERT_TEMPLATE,
        messageType: 'utility',
        components: [
          {
            type: 'body',
            parameters: [headline, client.companyName || client.clientName || 'your business', details].map((t) => ({
              type: 'text',
              text: String(t || '—').replace(/\s+/g, ' ').slice(0, 600),
            })),
          },
        ],
      });
      return { ok: true, data };
    } catch (e) {
      console.warn('[whatsapp notify] owner alert failed:', e.message);
      return { ok: false, error: e.message };
    }
  }

  /** Hook for every automatic customer message: alert the owner about new bookings/orders. */
  static async afterCustomerNotify(kind, opts) {
    const clientId = opts?.clientId;
    if (!clientId) return;
    if (kind === 'booking_confirmation' && isObjectId(opts.bookingRef)) {
      const booking = await loadBooking(opts.bookingRef);
      if (!booking) return;
      await this.sendOwnerAlert(clientId, {
        key: `booking:${booking._id}`,
        headline: 'New booking',
        details: `${firstNameAndInitial(booking.customerName)} · ${formatBookingWhen(booking)} · ${displayRef(booking._id)}`,
      });
    } else if (kind === 'order_confirmation' && opts.orderRef) {
      await this.sendOwnerAlert(clientId, {
        key: `order:${opts.orderRef}`,
        headline: 'New order',
        details: [`Order ${displayRef(opts.orderRef)}`, opts.total ? `Total ${opts.total}` : '']
          .filter(Boolean)
          .join(' · '),
      });
    }
  }

  // ---------------------------------------------------------------- reminder buttons

  /** Quick-reply payloads for booking_reminder_actions (index 0 = Confirm, 1 = Reschedule). */
  static reminderButtons(bookingId) {
    return ['BKC', 'BKR'].map((prefix, index) => ({
      type: 'button',
      sub_type: 'quick_reply',
      index: String(index),
      parameters: [{ type: 'payload', payload: `${prefix}:${bookingId}` }],
    }));
  }

  /**
   * Customer tapped Confirm / Reschedule on a reminder. Returns true when handled, so the
   * auto-responder does not also answer the tap.
   */
  static async handleBookingButtonReply({ clientId, contactWaId, rawMsg }) {
    const payload = String(rawMsg?.button?.payload || rawMsg?.interactive?.button_reply?.id || '').trim();
    const m = payload.match(/^BK([CR]):([a-f0-9]{24})$/i);
    if (!m) return false;
    const action = m[1].toUpperCase() === 'C' ? 'confirm' : 'reschedule';

    const booking = await loadBooking(m[2]);
    if (!booking) return false;
    // The tap must come from the customer on the booking, for this business.
    const bookingPhone = String(normalizePhoneE164(booking.customerPhone) || '').replace(/\D/g, '');
    const from = String(contactWaId || '').replace(/\D/g, '');
    if (!bookingPhone || bookingPhone !== from) return false;
    const tenant = booking.clientID || clientId;

    const client = await Client.findOne({ clientID: tenant }).select('companyName clientName').lean();
    const business = client?.companyName || client?.clientName || 'us';
    const first = String(booking.customerName || '').trim().split(/\s+/)[0] || 'there';
    const when = formatBookingWhen(booking);
    const WhatsAppInboxService = require('./WhatsAppInboxService');

    let reply;
    if (['cancelled', 'no-show', 'completed', 'checked-out'].includes(booking.status)) {
      reply = `Hi ${first}, this booking is no longer active. Reply here if you would like a new time and ${business} will help.`;
    } else if (action === 'confirm') {
      if (['pending', 'scheduled'].includes(booking.status)) {
        const Booking = require('../../models/booking');
        await Booking.updateOne({ _id: booking._id }, { $set: { status: 'confirmed' } });
      }
      reply = `Thanks ${first}, you're confirmed for ${when}. See you then!`;
    } else {
      reply = `No problem, ${first}. ${business} will message you here to find a new time. Your current booking (${when}) stays in place until then.`;
      try {
        await WhatsAppInboxService.createThreadNote(
          tenant,
          from,
          { body: `Customer asked to reschedule booking ${displayRef(booking._id)} (${when}).` },
          { name: 'Khana' }
        );
      } catch (e) {
        console.warn('[whatsapp notify] reschedule note failed:', e.message);
      }
      await this.sendOwnerAlert(tenant, {
        key: `reschedule:${booking._id}:${new Date().toISOString().slice(0, 13)}`,
        headline: 'Reschedule request',
        details: `${firstNameAndInitial(booking.customerName)} · ${when} · reply in your WhatsApp inbox`,
      });
    }

    try {
      await WhatsAppInboxService.sendTextReply({ clientId: tenant, to: from, text: reply });
    } catch (e) {
      console.warn('[whatsapp notify] button reply not sent:', e.message);
    }
    return true;
  }
}

module.exports = WhatsAppNotifyService;
