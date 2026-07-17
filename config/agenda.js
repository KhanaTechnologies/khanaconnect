const mongoose = require('mongoose');
const Agenda = require('agenda');

const JOB_NAMES = {
  OUTBOUND_EMAIL: 'outbound-email:send',
  EVENT_BATCH: 'event-processing:batch',
  EVENT_SINGLE: 'event-processing:single',
  SAAS_USAGE: 'saas-usage-billing',
  B2B_WAREHOUSE_LOW_STOCK: 'b2b-warehouse:low-stock-check',
};

let agendaInstance = null;

function isSchedulerDisabled() {
  const flag = process.env.JOB_SCHEDULER_DISABLED;
  return flag === '1' || flag === 'true';
}

function getAgenda() {
  if (!agendaInstance) {
    throw new Error('Agenda is not initialized. Call startJobScheduler() after MongoDB connects.');
  }
  return agendaInstance;
}

function isAgendaReady() {
  return agendaInstance != null;
}

async function scheduleRetry(agenda, jobName, data, attempt, options = {}) {
  const maxAttempts = options.maxAttempts ?? 3;
  if (attempt >= maxAttempts) {
    throw new Error(`Max attempts (${maxAttempts}) exceeded for ${jobName}`);
  }

  const baseDelay = options.baseDelayMs ?? 5000;
  const delay = Math.min(baseDelay * Math.pow(2, Math.max(0, attempt - 1)), options.maxDelayMs ?? 600000);

  const job = agenda.create(jobName, { ...data, _attempt: attempt + 1 });
  job.schedule(new Date(Date.now() + delay));
  await job.save();
  return job;
}

async function getJobStats(jobName) {
  if (!agendaInstance || !agendaInstance._collection) {
    return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  }

  const col = agendaInstance._collection;
  const now = new Date();

  const [waiting, active, failed, delayed, completed] = await Promise.all([
    col.countDocuments({
      name: jobName,
      disabled: { $ne: true },
      lockedAt: null,
      failedAt: null,
      lastFinishedAt: null,
      nextRunAt: { $lte: now },
    }),
    col.countDocuments({ name: jobName, lockedAt: { $ne: null } }),
    col.countDocuments({ name: jobName, failedAt: { $ne: null }, lastFinishedAt: null }),
    col.countDocuments({
      name: jobName,
      failedAt: null,
      lastFinishedAt: null,
      nextRunAt: { $gt: now },
    }),
    col.countDocuments({ name: jobName, lastFinishedAt: { $ne: null } }),
  ]);

  return { waiting, active, completed, failed, delayed };
}

async function getRecentJobs(jobName, limit = 10) {
  if (!agendaInstance || !agendaInstance._collection) return [];

  const docs = await agendaInstance._collection
    .find({ name: jobName })
    .sort({ lastModifiedAt: -1, _id: -1 })
    .limit(limit)
    .toArray();

  return docs.map((doc) => ({
    id: String(doc._id),
    name: doc.name,
    data: {
      clientId: doc.data?.clientId || doc.data?.clientID,
      eventCount: doc.data?.events?.length || (doc.data?.event ? 1 : 0),
    },
    attempts: doc.failCount || doc.data?._attempt || 0,
    timestamp: (doc.lastModifiedAt || doc.nextRunAt || new Date()).toISOString(),
    failedReason: doc.failReason || null,
  }));
}

function registerJobHandlers(agenda) {
  const { processEventBatch } = require('../jobs/handlers/processEventBatch');
  const { deliverOutboundEmail } = require('../jobs/handlers/deliverOutboundEmail');
  const {
    processSaasUsageBilling,
    markSaasUsageBillingFailed,
  } = require('../jobs/handlers/processSaasUsageBilling');
  const { processB2bWarehouseLowStock } = require('../jobs/handlers/processB2bWarehouseLowStock');

  agenda.define(
    JOB_NAMES.EVENT_BATCH,
    {
      concurrency: Number(process.env.EVENT_WORKER_CONCURRENCY || 5),
      lockLifetime: Number(process.env.AGENDA_LOCK_MS || 10 * 60 * 1000),
    },
    async (job) => {
      const data = job.attrs.data || {};
      const attempt = data._attempt || 1;
      try {
        return await processEventBatch(data);
      } catch (err) {
        const maxAttempts = 3;
        if (attempt < maxAttempts) {
          await scheduleRetry(agenda, JOB_NAMES.EVENT_BATCH, data, attempt, {
            maxAttempts,
            baseDelayMs: 5000,
          });
          console.warn(
            `event-processing batch retry scheduled (${attempt}/${maxAttempts}) for client ${data.clientId}`
          );
          return;
        }
        throw err;
      }
    }
  );

  agenda.define(
    JOB_NAMES.EVENT_SINGLE,
    { concurrency: Number(process.env.EVENT_WORKER_CONCURRENCY || 5) },
    async (job) => {
      const { event, clientId } = job.attrs.data || {};
      return processEventBatch({ events: [event], clientId });
    }
  );

  agenda.define(
    JOB_NAMES.OUTBOUND_EMAIL,
    {
      concurrency: Number(process.env.EMAIL_OUTBOX_WORKER_CONCURRENCY || 3),
      lockLifetime: Number(process.env.AGENDA_LOCK_MS || 10 * 60 * 1000),
    },
    async (job) => {
      const data = job.attrs.data || {};
      const attempt = data._attempt || 1;
      try {
        return await deliverOutboundEmail(data);
      } catch (err) {
        const maxAttempts = Number(process.env.EMAIL_OUTBOX_JOB_ATTEMPTS || 8);
        if (attempt < maxAttempts) {
          await scheduleRetry(agenda, JOB_NAMES.OUTBOUND_EMAIL, data, attempt, {
            maxAttempts,
            baseDelayMs: Number(process.env.EMAIL_OUTBOX_BACKOFF_MS || 60000),
          });
          console.warn(
            `outbound-email retry scheduled (${attempt}/${maxAttempts}) for client ${data.clientID}`
          );
          return;
        }
        throw err;
      }
    }
  );

  agenda.define(
    JOB_NAMES.SAAS_USAGE,
    { concurrency: Number(process.env.SAAS_USAGE_WORKER_CONCURRENCY || 5) },
    async (job) => {
      const data = job.attrs.data || {};
      const attempt = data._attempt || 1;
      try {
        return await processSaasUsageBilling(data);
      } catch (err) {
        const maxAttempts = 5;
        if (attempt < maxAttempts) {
          await scheduleRetry(agenda, JOB_NAMES.SAAS_USAGE, data, attempt, {
            maxAttempts,
            baseDelayMs: 2000,
          });
          return;
        }
        await markSaasUsageBillingFailed(data, err.message);
        throw err;
      }
    }
  );

  agenda.define(
    JOB_NAMES.B2B_WAREHOUSE_LOW_STOCK,
    { concurrency: 1, lockLifetime: 15 * 60 * 1000 },
    async () => processB2bWarehouseLowStock()
  );

  agenda.on('start', (job) => {
    if (job.attrs.name === JOB_NAMES.OUTBOUND_EMAIL) {
      console.log(`📤 Outbound email job ${job.attrs._id} started`);
    }
  });

  agenda.on('success', (job) => {
    if (job.attrs.name === JOB_NAMES.OUTBOUND_EMAIL) {
      console.log(`✅ Outbound email job ${job.attrs._id} sent`);
    }
    if (job.attrs.name === JOB_NAMES.EVENT_BATCH) {
      console.log(`✅ Event batch job ${job.attrs._id} completed for client ${job.attrs.data?.clientId}`);
    }
    if (job.attrs.name === JOB_NAMES.SAAS_USAGE) {
      console.log(`✅ SaaS usage job ${job.attrs._id} completed`);
    }
  });

  agenda.on('fail', (err, job) => {
    console.error(`❌ Job ${job.attrs._id} (${job.attrs.name}) failed:`, err.message);
    if (job.attrs.name === JOB_NAMES.SAAS_USAGE) {
      markSaasUsageBillingFailed(job.attrs.data || {}, err.message).catch(() => {});
    }
  });
}

async function startJobScheduler() {
  if (isSchedulerDisabled()) {
    console.log('⏭️ Job scheduler disabled (JOB_SCHEDULER_DISABLED)');
    return null;
  }

  if (!mongoose.connection.readyState) {
    throw new Error('MongoDB must be connected before starting Agenda');
  }

  const connectionString = String(process.env.CONNECTION_STRING || '').replace(/^["']|["']$/g, '');
  if (!connectionString) {
    throw new Error('CONNECTION_STRING is required for Agenda');
  }

  if (agendaInstance) {
    return agendaInstance;
  }

  agendaInstance = new Agenda({
    db: {
      address: connectionString,
      collection: process.env.AGENDA_COLLECTION || 'agendaJobs',
      options: { dbName: process.env.MONGODB_DB_NAME || 'KhanaConnect_ProdDB' },
    },
    processEvery: process.env.AGENDA_PROCESS_EVERY || '5 seconds',
    maxConcurrency: Number(process.env.AGENDA_MAX_CONCURRENCY || 20),
    defaultConcurrency: Number(process.env.AGENDA_DEFAULT_CONCURRENCY || 5),
    defaultLockLifetime: Number(process.env.AGENDA_LOCK_MS || 10 * 60 * 1000),
  });

  registerJobHandlers(agendaInstance);
  await agendaInstance.start();

  const lowStockInterval = process.env.B2B_WAREHOUSE_ALERT_INTERVAL || '6 hours';
  await agendaInstance.every(lowStockInterval, JOB_NAMES.B2B_WAREHOUSE_LOW_STOCK, {});
  console.log(`📦 B2B warehouse low-stock job scheduled every ${lowStockInterval}`);

  console.log('✅ MongoDB job scheduler (Agenda) started');
  return agendaInstance;
}

async function stopJobScheduler() {
  if (!agendaInstance) return;
  await agendaInstance.stop();
  agendaInstance = null;
  console.log('Job scheduler stopped');
}

module.exports = {
  JOB_NAMES,
  getAgenda,
  isAgendaReady,
  isSchedulerDisabled,
  startJobScheduler,
  stopJobScheduler,
  getJobStats,
  getRecentJobs,
};
