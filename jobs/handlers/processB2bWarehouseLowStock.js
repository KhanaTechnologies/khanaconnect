const Client = require('../models/client');
const { processAllWarehouseLowStockAlerts } = require('../helpers/b2bWarehouseAlerts');

async function processB2bWarehouseLowStock() {
  const results = await processAllWarehouseLowStockAlerts();
  const sent = results.filter((r) => r.emailsSent > 0).length;
  const notified = results.reduce((sum, r) => sum + (r.notified || 0), 0);
  console.log(`📦 B2B warehouse low-stock check: ${results.length} clients, ${sent} emails, ${notified} SKUs notified`);
  return { results, sent, notified };
}

module.exports = { processB2bWarehouseLowStock };
