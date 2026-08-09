/**
 * Ops helper: clear forbidden shared website Pixel IDs from WhatsApp accounts
 * and re-bind each active account to its own WABA dataset.
 *
 *   node scripts/rebindWhatsAppDatasets.js
 *   node scripts/rebindWhatsAppDatasets.js --client=Khana
 *
 * Requires MONGODB_URI.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const SaasWhatsAppAccount = require('../models/SaasWhatsAppAccount');
const WhatsAppConversionsService = require('../services/saas/WhatsAppConversionsService');

async function main() {
  const clientArg = process.argv.find((a) => a.startsWith('--client='));
  const clientId = clientArg ? clientArg.split('=')[1] : '';

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB_NAME || undefined,
  });

  const filter = {
    status: 'active',
    ...(clientId ? { client_id: clientId } : {}),
  };

  const accounts = await SaasWhatsAppAccount.find(filter).select('client_id waba_id dataset_id dataset_source');
  const results = [];

  for (const acc of accounts) {
    const cid = String(acc.client_id);
    try {
      const data = await WhatsAppConversionsService.ensureDataset(cid, { force: true });
      results.push({ clientId: cid, ok: true, datasetId: data.datasetId, wabaId: data.wabaId });
    } catch (err) {
      results.push({ clientId: cid, ok: false, error: err.message, previousDatasetId: acc.dataset_id });
    }
  }

  console.log(JSON.stringify({ count: results.length, results }, null, 2));
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
