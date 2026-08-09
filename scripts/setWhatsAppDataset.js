/**
 * Set Events Manager dataset / pixel id on WhatsApp Cloud API accounts.
 *
 * Usage:
 *   node scripts/setWhatsAppDataset.js 1063249069528132
 *   node scripts/setWhatsAppDataset.js 1063249069528132 --client=Khana
 *
 * Requires MONGODB_URI (and optional MONGODB_DB_NAME).
 */
require('dotenv').config();
const mongoose = require('mongoose');
const SaasWhatsAppAccount = require('../models/SaasWhatsAppAccount');

async function main() {
  const datasetId = String(process.argv[2] || '').trim();
  const clientArg = process.argv.find((a) => a.startsWith('--client='));
  const clientId = clientArg ? clientArg.split('=')[1] : '';

  if (!/^\d{5,30}$/.test(datasetId)) {
    console.error('Usage: node scripts/setWhatsAppDataset.js <numeric_dataset_id> [--client=Khana]');
    process.exit(1);
  }
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB_NAME || undefined,
  });

  const filter = clientId ? { client_id: clientId } : {};
  const at = new Date();
  const result = await SaasWhatsAppAccount.updateMany(filter, {
    $set: {
      dataset_id: datasetId,
      dataset_linked_at: at,
      last_conversion_error: '',
    },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        datasetId,
        clientId: clientId || '(all)',
        matched: result.matchedCount,
        modified: result.modifiedCount,
        linkedAt: at.toISOString(),
      },
      null,
      2
    )
  );

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
