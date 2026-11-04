const express = require('express');
const router = express.Router();
const { wrapRoute } = require('../helpers/failureEmail');
const { requireAdmin } = require('../middleware/requireAdmin');
const BandwidthUsage = require('../models/BandwidthUsage');
const Client = require('../models/client');
const { flush, liveStats } = require('../middleware/bandwidthMeter');

const GB = 1024 ** 3;
const INCLUDED_GB = Number(process.env.RENDER_BANDWIDTH_INCLUDED_GB) || 5;
const OVERAGE_PER_GB = Number(process.env.RENDER_BANDWIDTH_OVERAGE_PER_GB) || 0.15;
const TOP_DIMS = ['route', 'file', 'origin', 'client', 'agent', 'status', 'apitoken', 'failed', 'outbound'];

function startOfUtcDay(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

async function topKeys(dim, since, limit) {
  return BandwidthUsage.aggregate([
    { $match: { dim, bucket: { $gte: since } } },
    { $group: { _id: '$key', requests: { $sum: '$requests' }, bytesOut: { $sum: '$bytesOut' } } },
    { $sort: { bytesOut: -1 } },
    { $limit: limit },
    { $project: { _id: 0, key: '$_id', requests: 1, bytesOut: 1 } },
  ]);
}

async function seriesFor(dims, since, unit) {
  return BandwidthUsage.aggregate([
    { $match: { dim: { $in: dims }, key: 'all', bucket: { $gte: since } } },
    {
      $group: {
        _id: {
          t: {
            $dateToString: {
              format: unit === 'hour' ? '%Y-%m-%dT%H:00:00.000Z' : '%Y-%m-%dT00:00:00.000Z',
              date: '$bucket',
            },
          },
          dim: '$dim',
        },
        requests: { $sum: '$requests' },
        bytesOut: { $sum: '$bytesOut' },
      },
    },
    { $sort: { '_id.t': 1 } },
  ]);
}

/** Merge per-dim rows into [{ t, bytesOut, wireBytesOut, requests }]. */
function mergeSeries(rows) {
  const byT = new Map();
  for (const r of rows) {
    const t = new Date(r._id.t).toISOString();
    const point = byT.get(t) || { t, bytesOut: 0, wireBytesOut: 0, requests: 0 };
    if (r._id.dim === 'wire') {
      point.wireBytesOut += r.bytesOut;
    } else {
      point.bytesOut += r.bytesOut;
      point.requests += r.requests;
    }
    byT.set(t, point);
  }
  return [...byT.values()];
}

async function sumSince(dim, since) {
  const [row] = await BandwidthUsage.aggregate([
    { $match: { dim, key: 'all', bucket: { $gte: since } } },
    { $group: { _id: null, requests: { $sum: '$requests' }, bytesOut: { $sum: '$bytesOut' } } },
  ]);
  return { requests: row?.requests || 0, bytesOut: row?.bytesOut || 0 };
}

/**
 * GET /admin/bandwidth?days=30 — what is using Render outbound bandwidth.
 */
router.get('/', requireAdmin, wrapRoute(async (req, res) => {
  await flush(); // include the last minute of traffic

  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 120);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 5), 100);
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  // days=1 means a rolling 24 hours (matches the hourly chart); otherwise whole UTC days.
  const since = days === 1
    ? last24h
    : startOfUtcDay(new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000));

  const [firstRow, monthTotal, monthWire, daily, hourly, ...tops] = await Promise.all([
    BandwidthUsage.findOne({ dim: 'total' }).sort({ bucket: 1 }).select('bucket').lean(),
    sumSince('total', monthStart),
    sumSince('wire', monthStart),
    seriesFor(['total', 'wire'], since, 'day'),
    seriesFor(['total', 'wire'], last24h, 'hour'),
    ...TOP_DIMS.map((dim) => topKeys(dim, since, limit)),
  ]);

  const top = Object.fromEntries(TOP_DIMS.map((dim, i) => [dim, tops[i]]));

  // Label client IDs with company names.
  const clientIds = top.client.map((r) => r.key).filter((k) => !k.startsWith('('));
  if (clientIds.length) {
    const clients = await Client.find({ clientID: { $in: clientIds } }).select('clientID companyName').lean();
    const names = new Map(clients.map((c) => [c.clientID, c.companyName]));
    top.client = top.client.map((r) => ({ ...r, label: names.get(r.key) || '' }));
  }

  // Month-to-date projection uses the larger of app-level and socket-level counts.
  const trackingStart = firstRow?.bucket && firstRow.bucket > monthStart ? firstRow.bucket : monthStart;
  const monthBytes = Math.max(monthTotal.bytesOut, monthWire.bytesOut);
  const elapsedMs = Math.max(now - trackingStart, 60 * 60 * 1000);
  const remainingMs = nextMonthStart - now;
  const projectedBytes = monthBytes + (monthBytes / elapsedMs) * remainingMs;
  const overageGb = Math.max(projectedBytes / GB - INCLUDED_GB, 0);

  res.json({
    generatedAt: now.toISOString(),
    windowDays: days,
    trackingSince: firstRow?.bucket || null,
    plan: { includedGb: INCLUDED_GB, overagePerGb: OVERAGE_PER_GB },
    month: {
      start: monthStart.toISOString(),
      requests: monthTotal.requests,
      bytesOut: monthTotal.bytesOut,
      wireBytesOut: monthWire.bytesOut,
      projectedBytesOut: Math.round(projectedBytes),
      projectedOverageUsd: Math.round(overageGb * OVERAGE_PER_GB * 100) / 100,
      partialMonth: trackingStart > monthStart,
    },
    live: liveStats(),
    daily: mergeSeries(daily),
    hourly: mergeSeries(hourly),
    top,
  });
}));

module.exports = router;
