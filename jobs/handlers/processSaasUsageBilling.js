const BillingService = require('../../services/saas/BillingService');
const SaasUsageEvent = require('../../models/SaasUsageEvent');

async function processSaasUsageBilling({
  clientId,
  service,
  messageType,
  units,
  sourceRef,
  metadata,
}) {
  if (!clientId || !service || !sourceRef) {
    throw new Error('Invalid billing job payload');
  }

  // Voided before billing ran (e.g. Meta reported the WhatsApp message as failed): never charge it.
  const event = await SaasUsageEvent.findOne({ client_id: clientId, source_ref: sourceRef })
    .select('metadata')
    .lean();
  if (event?.metadata?.voided) {
    await SaasUsageEvent.updateOne(
      { client_id: clientId, source_ref: sourceRef },
      { $set: { status: 'processed', 'metadata.billedCredits': 0 } }
    );
    return { billedCredits: 0, voided: true };
  }

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
    {
      $set: {
        status: 'processed',
        metadata: { ...(metadata || {}), billedCredits: result.deductedCredits },
      },
    }
  );

  return { billedCredits: result.deductedCredits };
}

async function markSaasUsageBillingFailed({ clientId, sourceRef, metadata }, errorMessage) {
  if (!clientId || !sourceRef) return;

  await SaasUsageEvent.updateOne(
    { client_id: clientId, source_ref: sourceRef },
    {
      $set: {
        status: 'failed',
        metadata: { ...(metadata || {}), billingError: errorMessage },
      },
    }
  );
}

module.exports = { processSaasUsageBilling, markSaasUsageBillingFailed };
