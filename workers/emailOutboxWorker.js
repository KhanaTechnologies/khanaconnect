const { Worker } = require('bullmq');
const redis = require('../config/redis');
const { QUEUE_NAME } = require('../queues/outboundEmailQueue');
const Client = require('../models/client');
const { deliverQueuedOutboundEmail } = require('../utils/email');

const emailOutboxWorker = new Worker(
  QUEUE_NAME,
  async (job) => {
    const { clientID, mailOptions, label } = job.data || {};
    if (!clientID || !mailOptions) throw new Error('Invalid outbound email job payload');

    const client = await Client.findOne({ clientID }).select('businessEmail businessEmailPassword');
    if (!client?.businessEmail) throw new Error(`No client or business email for ${clientID}`);

    await deliverQueuedOutboundEmail(client.businessEmail, client.businessEmailPassword, mailOptions);
    return { ok: true, clientID, label: label || '' };
  },
  {
    connection: redis,
    concurrency: Number(process.env.EMAIL_OUTBOX_WORKER_CONCURRENCY || 3),
    limiter: { max: 20, duration: 60000 },
  }
);

emailOutboxWorker.on('completed', (job) => {
  console.log(`✅ Outbound email job ${job.id} sent`);
});

emailOutboxWorker.on('failed', (job, err) => {
  console.error(`❌ Outbound email job ${job?.id || '?'} failed:`, err.message);
});

module.exports = emailOutboxWorker;
