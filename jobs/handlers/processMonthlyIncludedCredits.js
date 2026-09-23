const BillingService = require('../../services/saas/BillingService');

async function processMonthlyIncludedCredits() {
  const summary = await BillingService.ensureMonthlyIncludedCreditsForAll({ limit: 2000 });
  console.log(
    `[billing] monthly included credits: scanned=${summary.scanned} granted=${summary.granted} skipped=${summary.skipped} errors=${summary.errors}`
  );
  return summary;
}

module.exports = { processMonthlyIncludedCredits };
