/**
 * Production-safe one-time backfill:
 * Mark legacy orders as stockDeducted=true when the field is missing.
 *
 * Why: before catalog gap-close, stock was always deducted on order create.
 * PayFast fulfill must not deduct again. Runtime code already treats null as
 * legacy, but setting the flag makes data explicit.
 *
 * Usage:
 *   node scripts/backfillOrderStockFlags.js --dry-run
 *   node scripts/backfillOrderStockFlags.js
 *
 * Never run against prod without --dry-run first.
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  let connectUri = process.env.CONNECTION_STRING || '';
  if (!connectUri) {
    console.error('CONNECTION_STRING required');
    process.exit(1);
  }
  if (!/KhanaConnect_ProdDB/.test(connectUri) && process.env.FORCE_DB !== '1') {
    // Prefer prod DB name when URI points at cluster without db — keep same pattern as other scripts
    connectUri = connectUri.replace(
      '@khanaconnect.mvygpxm.mongodb.net/',
      '@khanaconnect.mvygpxm.mongodb.net/KhanaConnect_ProdDB'
    );
  }

  await mongoose.connect(connectUri);
  const col = mongoose.connection.db.collection('orders');

  const filter = {
    $or: [{ stockDeducted: { $exists: false } }, { stockDeducted: null }],
  };
  const count = await col.countDocuments(filter);
  console.log(`Orders needing stockDeducted backfill: ${count}${dryRun ? ' (dry-run)' : ''}`);

  if (!dryRun && count > 0) {
    const result = await col.updateMany(filter, {
      $set: { stockDeducted: true },
    });
    console.log(`Updated: matched=${result.matchedCount} modified=${result.modifiedCount}`);
  }

  await mongoose.disconnect();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
