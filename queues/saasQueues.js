const { getAgenda, isSchedulerDisabled, JOB_NAMES } = require('../config/agenda');

async function enqueueUsageBilling(name, data) {
  if (isSchedulerDisabled()) {
    throw new Error('Job scheduler is disabled');
  }

  const agenda = getAgenda();
  const sourceRef = data?.sourceRef ? String(data.sourceRef) : `${Date.now()}`;

  const job = agenda
    .create(JOB_NAMES.SAAS_USAGE, { ...data, bullJobName: name, _attempt: 1 })
    .unique({ 'data.sourceRef': sourceRef, 'data.clientId': data.clientId });

  job.schedule('now');
  await job.save();

  return { id: String(job.attrs._id) };
}

const usageBillingQueue = {
  add: enqueueUsageBilling,
};

module.exports = {
  usageBillingQueue,
};
