/**
 * Read-only bandwidth report from the bandwidth_usage collection (written by middleware/bandwidthMeter.js).
 * Prints the tracked window, a daily trend and the top consumers per dimension.
 *
 * Usage: node scripts/bandwidthReport.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const fmt = (b) => (b >= GB ? `${(b / GB).toFixed(2)} GB` : `${(b / MB).toFixed(1)} MB`);

async function main() {
  await mongoose.connect(process.env.CONNECTION_STRING, {
    dbName: 'KhanaConnect_ProdDB',
    serverSelectionTimeoutMS: 15000,
  });
  const col = mongoose.connection.db.collection('bandwidth_usage');

  const [span] = await col
    .aggregate([{ $group: { _id: null, first: { $min: '$bucket' }, last: { $max: '$bucket' } } }])
    .toArray();
  console.log('Tracking window:', span?.first, '->', span?.last);

  const daily = await col
    .aggregate([
      { $match: { dim: { $in: ['total', 'wire'] } } },
      {
        $group: {
          _id: { d: { $dateToString: { format: '%Y-%m-%d', date: '$bucket' } }, dim: '$dim' },
          b: { $sum: '$bytesOut' },
          r: { $sum: '$requests' },
        },
      },
      { $sort: { '_id.d': 1 } },
    ])
    .toArray();

  const byDay = {};
  for (const x of daily) {
    byDay[x._id.d] = byDay[x._id.d] || {};
    byDay[x._id.d][x._id.dim] = x;
  }
  let total = 0;
  console.log('\nDAILY  (http responses | raw socket | requests)');
  for (const [day, v] of Object.entries(byDay)) {
    total += v.total?.b || 0;
    console.log(day, fmt(v.total?.b || 0).padStart(10), fmt(v.wire?.b || 0).padStart(10), String(v.total?.r || 0).padStart(8));
  }
  console.log('TOTAL', fmt(total));

  for (const dim of ['route', 'file', 'origin', 'agent', 'client', 'status', 'apitoken']) {
    const rows = await col
      .aggregate([
        { $match: { dim } },
        { $group: { _id: '$key', b: { $sum: '$bytesOut' }, r: { $sum: '$requests' } } },
        { $sort: { b: -1 } },
        { $limit: 15 },
      ])
      .toArray();
    if (!rows.length) continue;
    console.log(`\nTOP ${dim.toUpperCase()}`);
    for (const x of rows) {
      const share = `${((x.b / (total || 1)) * 100).toFixed(1)}%`;
      const avg = fmt(x.b / Math.max(x.r, 1));
      console.log(fmt(x.b).padStart(10), share.padStart(6), `${x.r} req`.padStart(11), `avg ${avg}`.padStart(14), ' ', String(x._id).slice(0, 110));
    }
  }

  const hours = await col
    .aggregate([
      { $match: { dim: 'total' } },
      {
        $group: {
          _id: { $hour: { date: '$bucket', timezone: 'Africa/Johannesburg' } },
          b: { $sum: '$bytesOut' },
        },
      },
      { $sort: { _id: 1 } },
    ])
    .toArray();
  console.log('\nBY HOUR OF DAY (SAST)');
  console.log(hours.map((h) => `${String(h._id).padStart(2, '0')}h ${fmt(h.b)}`).join(' | '));

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('Report failed:', err.message);
  process.exit(1);
});
