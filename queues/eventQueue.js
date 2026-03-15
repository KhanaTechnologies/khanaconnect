// queues/eventQueue.js
const { Queue } = require('bullmq');
const redis = require('../config/redis');

// Create queue for event processing
const eventQueue = new Queue('event-processing', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000
    },
    removeOnComplete: 100, // Keep last 100 completed jobs
    removeOnFail: 200 // Keep last 200 failed jobs
  }
});

/**
 * Queue a batch of events for processing
 */
async function queueBatchEvents(events, clientId) {
  if (!events || events.length === 0) {
    return [];
  }

  console.log(`📦 Queueing ${events.length} events for client ${clientId}`);

  // Split into batches of 1000 (Meta's limit)
  const batches = [];
  for (let i = 0; i < events.length; i += 1000) {
    batches.push(events.slice(i, i + 1000));
  }

  const jobs = [];
  for (let i = 0; i < batches.length; i++) {
    const job = await eventQueue.add('event-batch', {
      events: batches[i],
      clientId,
      batchIndex: i,
      totalBatches: batches.length
    }, {
      jobId: `${clientId}-${Date.now()}-${i}`,
      priority: i === 0 ? 1 : 2 // First batch higher priority
    });
    jobs.push(job);
    console.log(`  ✅ Queued batch ${i + 1}/${batches.length} for client ${clientId} (${batches[i].length} events)`);
  }

  return jobs;
}

/**
 * Queue a single event (backward compatibility)
 */
async function queueEvent(event, clientId) {
  return await eventQueue.add('event-single', {
    event,
    clientId
  }, {
    jobId: `${event._id || event.eventHash}`
  });
}

// Queue events for logging
eventQueue.on('error', (error) => {
  console.error('Queue error:', error);
});

eventQueue.on('waiting', (jobId) => {
  console.log(`Job ${jobId} is waiting`);
});

eventQueue.on('active', (job) => {
  console.log(`Job ${job.id} is now active`);
});

eventQueue.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

eventQueue.on('failed', (job, err) => {
  console.error(`Job ${job.id} failed:`, err.message);
});

eventQueue.on('progress', (job, progress) => {
  console.log(`Job ${job.id} progress: ${progress}`);
});

module.exports = {
  eventQueue,
  queueBatchEvents,
  queueEvent
};