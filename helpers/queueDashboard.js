const {
  JOB_NAMES,
  isAgendaReady,
  isSchedulerDisabled,
  getJobStats,
} = require('../config/agenda');

const QUEUE_DEFINITIONS = [
  {
    key: 'outbound-email',
    jobName: JOB_NAMES.OUTBOUND_EMAIL,
    label: 'Outbound email',
    description: 'Deferred SMTP sends after inline retries fail (newsletters, etc.)',
  },
  {
    key: 'event-processing',
    jobName: JOB_NAMES.EVENT_BATCH,
    label: 'Meta event batches',
    description: 'Tracking events queued for delivery to Meta',
  },
  {
    key: 'event-single',
    jobName: JOB_NAMES.EVENT_SINGLE,
    label: 'Single tracking events',
    description: 'Individual tracking events (legacy path)',
  },
  {
    key: 'saas-usage',
    jobName: JOB_NAMES.SAAS_USAGE,
    label: 'SaaS usage billing',
    description: 'Async billing for ads setup and WhatsApp messages',
  },
];

function deriveJobStatus(doc, now = new Date()) {
  if (doc.lockedAt) return 'active';
  if (doc.failedAt && !doc.lastFinishedAt) return 'failed';
  if (doc.lastFinishedAt) return 'completed';
  if (doc.nextRunAt && new Date(doc.nextRunAt) > now) return 'delayed';
  return 'waiting';
}

function summarizeJob(doc) {
  const data = doc.data || {};
  const name = doc.name || '';

  if (name === JOB_NAMES.OUTBOUND_EMAIL) {
    const parts = [`Client ${data.clientID || '?'}`];
    if (data.label) parts.push(data.label);
    return parts.join(' · ');
  }

  if (name === JOB_NAMES.EVENT_BATCH) {
    const count = Array.isArray(data.events) ? data.events.length : 0;
    return `${count} event(s) for client ${data.clientId || '?'}`;
  }

  if (name === JOB_NAMES.EVENT_SINGLE) {
    return `1 event for client ${data.clientId || '?'}`;
  }

  if (name === JOB_NAMES.SAAS_USAGE) {
    return `${data.service || 'usage'} · ${data.clientId || '?'} · ref ${data.sourceRef || '?'}`;
  }

  return name;
}

function serializeJob(doc) {
  const now = new Date();
  const status = deriveJobStatus(doc, now);

  return {
    id: String(doc._id),
    queue: doc.name,
    status,
    clientId: doc.data?.clientId || doc.data?.clientID || null,
    label: doc.data?.label || doc.data?.bullJobName || null,
    service: doc.data?.service || null,
    eventCount: Array.isArray(doc.data?.events)
      ? doc.data.events.length
      : doc.data?.event
        ? 1
        : 0,
    attempts: doc.failCount || doc.data?._attempt || 0,
    summary: summarizeJob(doc),
    nextRunAt: doc.nextRunAt ? new Date(doc.nextRunAt).toISOString() : null,
    lastRunAt: doc.lastRunAt ? new Date(doc.lastRunAt).toISOString() : null,
    lastFinishedAt: doc.lastFinishedAt ? new Date(doc.lastFinishedAt).toISOString() : null,
    failedAt: doc.failedAt ? new Date(doc.failedAt).toISOString() : null,
    lockedAt: doc.lockedAt ? new Date(doc.lockedAt).toISOString() : null,
    failedReason: doc.failReason || null,
    enqueuedAt: doc.data?.enqueuedAt || null,
  };
}

async function listQueueJobs(jobName, { limit = 20, statusFilter = null } = {}) {
  const { getAgenda } = require('../config/agenda');
  let agenda;

  try {
    agenda = getAgenda();
  } catch {
    return [];
  }

  if (!agenda._collection) return [];

  const fetchLimit = statusFilter ? Math.min(limit * 5, 100) : limit;
  const docs = await agenda._collection
    .find({ name: jobName })
    .sort({ lastModifiedAt: -1, nextRunAt: -1, _id: -1 })
    .limit(fetchLimit)
    .toArray();

  let jobs = docs.map(serializeJob);

  if (statusFilter) {
    jobs = jobs.filter((job) => job.status === statusFilter);
  }

  return jobs.slice(0, limit);
}

async function getQueueDashboard({ limitPerQueue = 20, statusFilter = null } = {}) {
  const scheduler = {
    backend: 'mongodb-agenda',
    collection: process.env.AGENDA_COLLECTION || 'agendaJobs',
    disabled: isSchedulerDisabled(),
    ready: isAgendaReady(),
    status: isSchedulerDisabled() ? 'disabled' : isAgendaReady() ? 'running' : 'not_started',
  };

  const queues = [];
  const summary = {
    waiting: 0,
    active: 0,
    failed: 0,
    delayed: 0,
    completed: 0,
  };

  for (const def of QUEUE_DEFINITIONS) {
    const counts = await getJobStats(def.jobName);
    summary.waiting += counts.waiting;
    summary.active += counts.active;
    summary.failed += counts.failed;
    summary.delayed += counts.delayed;
    summary.completed += counts.completed;

    const jobs = await listQueueJobs(def.jobName, { limit: limitPerQueue, statusFilter });

    queues.push({
      key: def.key,
      name: def.jobName,
      label: def.label,
      description: def.description,
      counts,
      jobs,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    scheduler,
    summary,
    queues,
  };
}

module.exports = {
  QUEUE_DEFINITIONS,
  deriveJobStatus,
  getQueueDashboard,
  listQueueJobs,
  serializeJob,
};
