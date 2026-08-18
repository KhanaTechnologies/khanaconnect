const SaasWhatsAppAccount = require('../models/SaasWhatsAppAccount');
const SaasWhatsAppMessage = require('../models/SaasWhatsAppMessage');
const SaasWhatsAppThread = require('../models/SaasWhatsAppThread');
const Client = require('../models/client');
const TeamMember = require('../models/teamMember');
const { decrypt } = require('./encryption');
const { sendWhatsAppWindowCloseAlertEmail } = require('../utils/sendWhatsAppWindowCloseAlert');

const SESSION_HOURS = Number(process.env.WHATSAPP_SESSION_HOURS || 24);
const WARN_HOURS = Number(process.env.WHATSAPP_WINDOW_ALERT_HOURS || 4);
const MAX_THREADS_PER_EMAIL = 20;

function isAlertsDisabled() {
  const flag = process.env.WHATSAPP_WINDOW_ALERTS_DISABLED;
  return flag === '1' || flag === 'true';
}

function dashboardInboxUrl() {
  const base = (process.env.DASHBOARD_URL || 'https://khanatechnologies.co.za').replace(/\/$/, '');
  return `${base}/dashboard/whatsapp-inbox`;
}

function sameTime(a, b) {
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

function addUniqueEmail(list, email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value || !value.includes('@')) return;
  if (!list.includes(value)) list.push(value);
}

async function findUnansweredClosingThreads(clientId, { now = new Date() } = {}) {
  const sessionMs = SESSION_HOURS * 60 * 60 * 1000;
  const warnMs = WARN_HOURS * 60 * 60 * 1000;
  const inboundAfter = new Date(now.getTime() - sessionMs);
  const inboundBefore = new Date(now.getTime() - (sessionMs - warnMs));

  const grouped = await SaasWhatsAppMessage.aggregate([
    {
      $match: {
        client_id: clientId,
        direction: 'inbound',
        deleted_at: null,
        timestamp: { $gt: inboundAfter },
      },
    },
    { $sort: { timestamp: -1 } },
    {
      $group: {
        _id: '$contact_wa_id',
        lastInboundAt: { $first: '$timestamp' },
        contact_name: { $first: '$contact_name' },
        body: { $first: '$body' },
      },
    },
    { $match: { lastInboundAt: { $lte: inboundBefore } } },
  ]);

  if (!grouped.length) return [];

  const contactIds = grouped.map((g) => g._id);
  const [outbounds, metas] = await Promise.all([
    SaasWhatsAppMessage.aggregate([
      {
        $match: {
          client_id: clientId,
          contact_wa_id: { $in: contactIds },
          direction: 'outbound',
          deleted_at: null,
        },
      },
      { $group: { _id: '$contact_wa_id', lastOutboundAt: { $max: '$timestamp' } } },
    ]),
    SaasWhatsAppThread.find({
      client_id: clientId,
      contact_wa_id: { $in: contactIds },
    })
      .select('contact_wa_id stage assigned_member_id window_close_alert_inbound_at')
      .lean(),
  ]);

  const lastOutboundByContact = Object.fromEntries(
    outbounds.map((o) => [o._id, o.lastOutboundAt])
  );
  const metaByContact = Object.fromEntries(metas.map((m) => [m.contact_wa_id, m]));

  const threads = [];
  for (const row of grouped) {
    const lastInboundAt = new Date(row.lastInboundAt);
    const lastOutboundAt = lastOutboundByContact[row._id]
      ? new Date(lastOutboundByContact[row._id])
      : null;
    if (lastOutboundAt && lastOutboundAt >= lastInboundAt) continue;

    const meta = metaByContact[row._id];
    if (meta?.stage === 'closed') continue;
    if (sameTime(meta?.window_close_alert_inbound_at, lastInboundAt)) continue;

    const windowOpenUntil = new Date(lastInboundAt.getTime() + sessionMs);
    const remainingMs = windowOpenUntil.getTime() - now.getTime();
    if (remainingMs <= 0) continue;

    threads.push({
      contactWaId: row._id,
      contactName: String(row.contact_name || '').trim(),
      body: row.body || '',
      lastInboundAt,
      windowOpenUntil,
      remainingMs,
      assignedMemberId: meta?.assigned_member_id || '',
    });
  }

  threads.sort((a, b) => a.remainingMs - b.remainingMs);
  return threads;
}

async function resolveAlertRecipients(client, threads) {
  const recipients = [];
  try {
    addUniqueEmail(recipients, decrypt(client.businessEmail));
  } catch {
    // ignore
  }

  const owners = await TeamMember.find({
    clientID: client.clientID,
    status: 'active',
    orgRole: { $in: ['owner', 'admin'] },
  }).select('email');
  for (const member of owners) {
    addUniqueEmail(recipients, member.email);
  }

  const assignedIds = [
    ...new Set(threads.map((t) => String(t.assignedMemberId || '').trim()).filter(Boolean)),
  ];
  if (assignedIds.length) {
    const assigned = await TeamMember.find({
      _id: { $in: assignedIds },
      clientID: client.clientID,
      status: 'active',
    }).select('email');
    for (const member of assigned) {
      addUniqueEmail(recipients, member.email);
    }
  }

  return recipients;
}

async function markThreadsAlerted(clientId, threads, when = new Date()) {
  await Promise.all(
    threads.map((thread) =>
      SaasWhatsAppThread.findOneAndUpdate(
        { client_id: clientId, contact_wa_id: thread.contactWaId },
        {
          $set: {
            window_close_alert_inbound_at: thread.lastInboundAt,
            window_close_alert_at: when,
          },
          $setOnInsert: {
            client_id: clientId,
            contact_wa_id: thread.contactWaId,
          },
        },
        { upsert: true }
      )
    )
  );
}

async function processWindowCloseAlertsForClient(clientId, { now = new Date(), dryRun = false } = {}) {
  const client = await Client.findOne({ clientID: clientId }).select(
    'clientID companyName businessEmail businessEmailPassword emailSignature smtpHost smtpPort emailLogoUrl emailPrimaryColor dashboardThemeColor'
  );
  if (!client) {
    return { clientId, skipped: true, reason: 'client_not_found' };
  }

  const threads = await findUnansweredClosingThreads(clientId, { now });
  if (!threads.length) {
    return { clientId, threads: 0, emailsSent: 0 };
  }

  const toEmail = threads.slice(0, MAX_THREADS_PER_EMAIL);
  const recipients = await resolveAlertRecipients(client, toEmail);
  if (!recipients.length) {
    return { clientId, skipped: true, reason: 'no_recipients', threads: threads.length };
  }

  if (dryRun) {
    return {
      clientId,
      dryRun: true,
      threads: threads.length,
      preview: toEmail.map((t) => ({
        contactWaId: t.contactWaId,
        contactName: t.contactName,
        remainingMs: t.remainingMs,
        windowOpenUntil: t.windowOpenUntil,
      })),
      recipients,
    };
  }

  const { sent } = await sendWhatsAppWindowCloseAlertEmail({
    client,
    recipients,
    threads: toEmail,
    inboxUrl: dashboardInboxUrl(),
  });
  await markThreadsAlerted(clientId, toEmail, now);
  return { clientId, threads: threads.length, emailed: toEmail.length, emailsSent: sent };
}

async function processAllWhatsAppWindowCloseAlerts({ now = new Date(), clientId = '' } = {}) {
  if (isAlertsDisabled()) {
    return { skipped: true, reason: 'disabled' };
  }

  const filter = { status: 'active' };
  if (clientId) filter.client_id = clientId;
  const accounts = await SaasWhatsAppAccount.find(filter).select('client_id').lean();
  const clientIds = [...new Set(accounts.map((a) => a.client_id).filter(Boolean))];

  const results = [];
  for (const id of clientIds) {
    try {
      results.push(await processWindowCloseAlertsForClient(id, { now }));
    } catch (err) {
      console.warn(`[whatsapp window-alert] client=${id} failed:`, err.message);
      results.push({ clientId: id, error: err.message });
    }
  }
  return { clients: clientIds.length, results };
}

module.exports = {
  SESSION_HOURS,
  WARN_HOURS,
  findUnansweredClosingThreads,
  processWindowCloseAlertsForClient,
  processAllWhatsAppWindowCloseAlerts,
  dashboardInboxUrl,
};
