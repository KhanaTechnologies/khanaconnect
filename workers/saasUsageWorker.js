const { Worker } = require('bullmq');
const redis = require('../config/redis');
const BillingService = require('../services/saas/BillingService');
const SaasUsageEvent = require('../models/SaasUsageEvent');

const usageWorker = new Worker(
  'saas-usage-billing',
  async (job) => {
    const { clientId, service, messageType, units, sourceRef, metadata } = job.data || {};
    if (!clientId || !service || !sourceRef) throw new Error('Invalid billing job payload');

    const result = await BillingService.chargeUsage({
      clientId,
      service,
      messageType,
      units,
      sourceRef,
      metadata,
    });

    await SaasUsageEvent.updateOne(
      { client_id: clientId, source_ref: sourceRef },
      { $set: { status: 'processed', metadata: { ...(metadata || {}), billedCredits: result.deductedCredits } } }
    );

    return { billedCredits: result.deductedCredits };
  },
  {
    connection: redis,
    concurrency: Number(process.env.SAAS_USAGE_WORKER_CONCURRENCY || 5),
  }
);

usageWorker.on('completed', (job) => {
  console.log(`✅ SaaS usage job ${job.id} completed`);
});

usageWorker.on('failed', async (job, err) => {
  console.error(`❌ SaaS usage job ${job?.id || 'unknown'} failed:`, err.message);
  const data = job?.data || {};
  if (data.clientId && data.sourceRef) {
    await SaasUsageEvent.updateOne(
      { client_id: data.clientId, source_ref: data.sourceRef },
      { $set: { status: 'failed', metadata: { ...(data.metadata || {}), billingError: err.message } } }
    );
  }
});

module.exports = usageWorker;
