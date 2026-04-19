const { Queue } = require('bullmq');
const redis = require('../config/redis');

const usageBillingQueue = new Queue('saas-usage-billing', {
  connection: redis,
  defaultJobOptions: {
    attempts: 5,
    removeOnComplete: 2000,
    removeOnFail: 5000,
    backoff: { type: 'exponential', delay: 2000 },
  },
});

const whatsappDispatchQueue = new Queue('saas-whatsapp-dispatch', {
  connection: redis,
  defaultJobOptions: {
    attempts: 4,
    removeOnComplete: 2000,
    removeOnFail: 5000,
    backoff: { type: 'exponential', delay: 1500 },
  },
});

module.exports = {
  usageBillingQueue,
  whatsappDispatchQueue,
};
