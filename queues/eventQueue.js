const {
  getAgenda,
  isSchedulerDisabled,
  JOB_NAMES,
  getJobStats,
  getRecentJobs,
} = require('../config/agenda');

const QUEUE_NAME = 'event-processing';

async function queueBatchEvents(events, clientId) {
  if (!events || events.length === 0) {
    return [];
  }
  if (isSchedulerDisabled()) {
    throw new Error('Job scheduler is disabled');
  }

  const agenda = getAgenda();
  console.log(`📦 Queueing ${events.length} events for client ${clientId}`);

  const batches = [];
  for (let i = 0; i < events.length; i += 1000) {
    batches.push(events.slice(i, i + 1000));
  }

  const jobs = [];
  for (let i = 0; i < batches.length; i++) {
    const jobId = `${clientId}-${Date.now()}-${i}`;
    const job = agenda
      .create(JOB_NAMES.EVENT_BATCH, {
        events: batches[i],
        clientId,
        batchIndex: i,
        totalBatches: batches.length,
        jobId,
        _attempt: 1,
      })
      .unique({ 'data.jobId': jobId });

    if (i === 0) {
      job.priority('high');
    }

    job.schedule('now');
    await job.save();

    const id = String(job.attrs._id);
    jobs.push({ id });
    console.log(
      `  ✅ Queued batch ${i + 1}/${batches.length} for client ${clientId} (${batches[i].length} events)`
    );
  }

  return jobs;
}

async function queueEvent(event, clientId) {
  if (isSchedulerDisabled()) {
    throw new Error('Job scheduler is disabled');
  }

  const agenda = getAgenda();
  const dedupeId = `${event._id || event.eventHash}`;

  const job = agenda
    .create(JOB_NAMES.EVENT_SINGLE, { event, clientId })
    .unique({ 'data.eventId': dedupeId });

  job.schedule('now');
  await job.save();

  return { id: String(job.attrs._id) };
}

const eventQueue = {
  name: QUEUE_NAME,
  getWaitingCount: () => getJobStats(JOB_NAMES.EVENT_BATCH).then((s) => s.waiting),
  getActiveCount: () => getJobStats(JOB_NAMES.EVENT_BATCH).then((s) => s.active),
  getCompletedCount: () => getJobStats(JOB_NAMES.EVENT_BATCH).then((s) => s.completed),
  getFailedCount: () => getJobStats(JOB_NAMES.EVENT_BATCH).then((s) => s.failed),
  getDelayedCount: () => getJobStats(JOB_NAMES.EVENT_BATCH).then((s) => s.delayed),
  getJobs: async () => getRecentJobs(JOB_NAMES.EVENT_BATCH, 10),
};

module.exports = {
  QUEUE_NAME,
  eventQueue,
  queueBatchEvents,
  queueEvent,
};
