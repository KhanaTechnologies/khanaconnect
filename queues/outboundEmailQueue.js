const { Queue } = require('bullmq');
const redis = require('../config/redis');

const QUEUE_NAME = 'outbound-email';

const outboundEmailQueue = new Queue(QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: Number(process.env.EMAIL_OUTBOX_JOB_ATTEMPTS || 8),
    backoff: {
      type: 'exponential',
      delay: Number(process.env.EMAIL_OUTBOX_BACKOFF_MS || 60000),
    },
    removeOnComplete: 200,
    removeOnFail: 300,
  },
});

outboundEmailQueue.on('error', (err) => {
  console.error('outbound-email queue error:', err.message);
});

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
  if (!payload || !payload.clientID || !payload.mailOptions) {
    throw new Error('enqueueOutboundEmail: clientID and mailOptions are required');
  }
  const delay = getInitialDelayMs();
  const job = await outboundEmailQueue.add(
    'send',
    {
      clientID: String(payload.clientID),
      mailOptions: payload.mailOptions,
      label: payload.label || '',
      lastError: payload.lastError || '',
      enqueuedAt: new Date().toISOString(),
    },
    { delay }
  );
  console.log(
    `📬 Outbound email queued (job ${job.id}, delay ${Math.round(delay / 1000)}s) for client ${payload.clientID}` +
      (payload.label ? ` [${payload.label}]` : '')
  );
  return job;
}

module.exports = {
  QUEUE_NAME,
  outboundEmailQueue,
  enqueueOutboundEmail,
  getInitialDelayMs,
};
