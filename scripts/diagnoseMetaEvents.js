/**
 * Read-only diagnostic: shows where tracking events are being sent (Pixel/dataset),
 * whether Meta delivery is configured, and recent delivery outcomes.
 *
 * Usage: node scripts/diagnoseMetaEvents.js [clientID]
 */
require('dotenv').config();
const mongoose = require('mongoose');

async function main() {
  let uri = process.env.CONNECTION_STRING || '';
  if (!uri) {
    console.error('CONNECTION_STRING is required');
    process.exit(1);
  }
  if (!/KhanaConnect_ProdDB/.test(uri)) {
    uri = uri.replace(
      '@khanaconnect.mvygpxm.mongodb.net/',
      '@khanaconnect.mvygpxm.mongodb.net/KhanaConnect_ProdDB'
    );
  }

  await mongoose.connect(uri);
  console.log(`Connected to DB: ${mongoose.connection.name}`);

  const Client = require('../models/client');
  const TrackingEvent = require('../models/TrackingEvent');

  const filter = process.argv[2] ? { clientID: process.argv[2] } : {};
  const clients = await Client.find(filter).select(
    'clientID companyName metaAds trackingSettings trackingStats'
  );

  console.log(`\n=== Meta event delivery config (${clients.length} client(s)) ===`);
  for (const doc of clients) {
    const c = doc.toObject({ getters: true });
    const meta = c.metaAds || {};
    const pixel = String(meta.pixelId || '');
    const hasToken = !!String(meta.accessToken || '');
    const sendable = meta.enabled === true && !!pixel && hasToken;

    console.log(`\n- ${c.clientID} (${c.companyName || 'no name'})`);
    console.log(`    metaAds.enabled : ${meta.enabled === true}`);
    console.log(`    pixelId         : ${pixel || '(none)'}`);
    console.log(`    accessToken     : ${hasToken ? 'present' : '(none)'}`);
    console.log(`    testEventCode   : ${meta.testEventCode || '(none)'}`);
    console.log(`    adAccountId     : ${meta.adAccountId || '(none)'}`);
    console.log(`    connectionMethod: ${meta.connectionMethod || '(none)'}`);
    console.log(`    status          : ${meta.status || '(none)'}  error: ${meta.errorMessage || '-'}`);
    console.log(`    lastSync        : ${meta.lastSync || '(never)'}`);
    console.log(`    eventsSent stat : ${c.trackingStats?.eventsSent || 0}`);
    console.log(`    >> WILL SEND TO META: ${sendable ? 'YES -> pixel ' + pixel : 'NO'}`);
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const match = process.argv[2] ? { clientID: process.argv[2] } : {};

  const byStatus = await TrackingEvent.aggregate([
    { $match: { ...match, timestamp: { $gte: since } } },
    { $group: { _id: { client: '$clientID', status: '$deliveryStatus' }, count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  console.log(`\n=== TrackingEvent delivery status (last 7 days) ===`);
  if (!byStatus.length) {
    console.log('  No tracking events stored in the last 7 days.');
    console.log('  -> The website/storefront is not calling POST /api/v1/events/batch.');
  } else {
    byStatus.forEach((r) =>
      console.log(`  ${r._id.client}: ${r._id.status || 'pending'} = ${r.count}`)
    );
  }

  const latest = await TrackingEvent.find(match)
    .sort({ timestamp: -1 })
    .limit(5)
    .select('clientID eventType timestamp processed deliveryStatus metadata.metaResponse')
    .lean();

  console.log(`\n=== Latest 5 events ===`);
  latest.forEach((e) => {
    console.log(
      `  ${e.timestamp?.toISOString?.() || e.timestamp} ${e.clientID} ${e.eventType} processed=${e.processed} status=${e.deliveryStatus || 'pending'}`
    );
    if (e.metadata?.metaResponse) {
      console.log(`      metaResponse: ${JSON.stringify(e.metadata.metaResponse)}`);
    }
  });

  console.log(`\n=== Scheduler ===`);
  console.log(`  JOB_SCHEDULER_DISABLED = ${process.env.JOB_SCHEDULER_DISABLED || '(unset -> enabled)'}`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Diagnostic failed:', err.message);
  try {
    await mongoose.disconnect();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
