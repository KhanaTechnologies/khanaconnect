const { getAgenda, isSchedulerDisabled, JOB_NAMES } = require('../config/agenda');

const QUEUE_NAME = 'outbound-email';

function getInitialDelayMs() {
  const raw = process.env.EMAIL_RETRY_QUEUE_DELAY_MS;
  if (raw === undefined || raw === '') return 180000;
  const n = parseInt(String(raw), 10);
  return Number.isFinite(n) && n >= 0 ? n : 180000;
}

/**
 * After inline SMTP retries fail, enqueue the same payload for later delivery.
 * @param {{ clientID: string, mailOptions: object, label?: string, lastError?: string }} payload
 */
async function enqueueOutboundEmail(payload) {
  if (process.env.EMAIL_OUTBOX_DISABLED === '1' || process.env.EMAIL_OUTBOX_DISABLED === 'true') {
    throw new Error('Outbound email queue is disabled');
  }
  if (isSchedulerDisabled()) {
    throw new Error('Job scheduler is disabled');
  }
  if (!payload || !payload.clientID || !payload.mailOptions) {
    throw new Error('enqueueOutboundEmail: clientID and mailOptions are required');
  }

  const agenda = getAgenda();
  const delay = getInitialDelayMs();
  const job = agenda.create(JOB_NAMES.OUTBOUND_EMAIL, {
    clientID: String(payload.clientID),
    mailOptions: payload.mailOptions,
    label: payload.label || '',
    lastError: payload.lastError || '',
    enqueuedAt: new Date().toISOString(),
    _attempt: 1,
  });

  job.schedule(new Date(Date.now() + delay));
  await job.save();

  const jobId = String(job.attrs._id);
  console.log(
    `📬 Outbound email queued (job ${jobId}, delay ${Math.round(delay / 1000)}s) for client ${payload.clientID}` +
      (payload.label ? ` [${payload.label}]` : '')
  );

  return { id: jobId };
}

module.exports = {
  QUEUE_NAME,
  enqueueOutboundEmail,
  getInitialDelayMs,
};
