const express = require('express');
const router = express.Router();
const { wrapRoute } = require('../helpers/failureEmail');
const { requireAdmin } = require('../middleware/requireAdmin');
const Client = require('../models/client');
const AdvertisingPeriod = require('../models/AdvertisingPeriod');
const {
  parseISODate,
  getSiteActivityOverview,
  toCsv,
  GRANULARITIES,
} = require('../services/siteAnalyticsService');

function parseQueryBool(v, defaultValue = true) {
  if (v === undefined || v === null || v === '') return defaultValue;
  if (v === '0' || v === 'false' || v === 'no') return false;
  return true;
}

function parseEventTypes(query) {
  const raw = query.eventTypes || query.types;
  if (!raw || typeof raw !== 'string') return undefined;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
}

/**
 * GET /clients — lightweight directory for admin dashboards (no passwords).
 */
router.get(
  '/clients',
  requireAdmin,
  wrapRoute(async (req, res) => {
    const clients = await Client.find({})
      .select(
        'clientID companyName role tier trackingStats createdAt permissions.dashboard'
      )
      .sort({ companyName: 1 })
      .lean();

    res.json({
      success: true,
      count: clients.length,
      data: clients,
    });
  })
);

/**
 * GET /site-activity — aggregated site events (views, funnel, sessions) by time bucket.
 * Query: start, end (ISO), granularity=day|week|month|year|hour|quarter, timezone, clientID?, eventTypes?, excludeTemp?
 */
router.get(
  '/site-activity',
  requireAdmin,
  wrapRoute(async (req, res) => {
    const start = parseISODate(req.query.start, 'start');
    const end = parseISODate(req.query.end, 'end');
    if (start > end) {
      return res.status(400).json({ success: false, error: 'start must be before end' });
    }

    const granularity = GRANULARITIES.has(req.query.granularity)
      ? req.query.granularity
      : 'day';

    const overview = await getSiteActivityOverview({
      start,
      end,
      clientID: req.query.clientID || req.query.clientId || null,
      granularity,
      timezone: req.query.timezone || 'UTC',
      eventTypes: parseEventTypes(req.query),
      excludeTempClients: parseQueryBool(req.query.excludeTemp, true),
    });

    res.json({ success: true, data: overview });
  })
);

/**
 * GET /site-activity/compare — same as site-activity plus saved ad periods overlapping the range.
 */
router.get(
  '/site-activity/compare',
  requireAdmin,
  wrapRoute(async (req, res) => {
    const start = parseISODate(req.query.start, 'start');
    const end = parseISODate(req.query.end, 'end');
    if (start > end) {
      return res.status(400).json({ success: false, error: 'start must be before end' });
    }

    const clientID = req.query.clientID || req.query.clientId || null;
    if (!clientID) {
      return res.status(400).json({
        success: false,
        error: 'clientID is required for compare (ad periods are per tenant)',
      });
    }

    const granularity = GRANULARITIES.has(req.query.granularity)
      ? req.query.granularity
      : 'day';

    const [overview, periods] = await Promise.all([
      getSiteActivityOverview({
        start,
        end,
        clientID,
        granularity,
        timezone: req.query.timezone || 'UTC',
        eventTypes: parseEventTypes(req.query),
        excludeTempClients: parseQueryBool(req.query.excludeTemp, true),
      }),
      AdvertisingPeriod.find({
        clientID: String(clientID).trim(),
        isDeleted: false,
        startAt: { $lte: end },
        endAt: { $gte: start },
      })
        .sort({ startAt: 1 })
        .lean(),
    ]);

    res.json({
      success: true,
      data: {
        ...overview,
        advertisingPeriods: periods,
      },
    });
  })
);

/**
 * GET /site-activity/export — download JSON or CSV (same filters as /site-activity).
 */
router.get(
  '/site-activity/export',
  requireAdmin,
  wrapRoute(async (req, res) => {
    const start = parseISODate(req.query.start, 'start');
    const end = parseISODate(req.query.end, 'end');
    if (start > end) {
      return res.status(400).json({ success: false, error: 'start must be before end' });
    }

    const format = (req.query.format || 'json').toLowerCase();
    const granularity = GRANULARITIES.has(req.query.granularity)
      ? req.query.granularity
      : 'day';

    const overview = await getSiteActivityOverview({
      start,
      end,
      clientID: req.query.clientID || req.query.clientId || null,
      granularity,
      timezone: req.query.timezone || 'UTC',
      eventTypes: parseEventTypes(req.query),
      excludeTempClients: parseQueryBool(req.query.excludeTemp, true),
    });

    const filenameBase = `site-activity_${start.toISOString().slice(0, 10)}_${end.toISOString().slice(0, 10)}`;

    if (format === 'csv') {
      const csv = toCsv(overview);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.csv"`);
      return res.send('\uFEFF' + csv);
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameBase}.json"`);
    return res.send(JSON.stringify({ success: true, data: overview }, null, 2));
  })
);

// --- Advertising periods (for comparing traffic while ads were on vs off) ---

router.get(
  '/ad-periods',
  requireAdmin,
  wrapRoute(async (req, res) => {
    const filter = { isDeleted: false };
    if (req.query.clientID || req.query.clientId) {
      filter.clientID = String(req.query.clientID || req.query.clientId).trim();
    }
    const periods = await AdvertisingPeriod.find(filter).sort({ startAt: -1 }).lean();
    res.json({ success: true, data: periods });
  })
);

router.post(
  '/ad-periods',
  requireAdmin,
  wrapRoute(async (req, res) => {
    const { label, clientID, platform, startAt, endAt, notes } = req.body || {};
    if (!label || !clientID || !startAt || !endAt) {
      return res.status(400).json({
        success: false,
        error: 'label, clientID, startAt, and endAt are required',
      });
    }
    const s = new Date(startAt);
    const e = new Date(endAt);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || s >= e) {
      return res.status(400).json({ success: false, error: 'Invalid startAt / endAt' });
    }

    const doc = await AdvertisingPeriod.create({
      label: String(label).trim(),
      clientID: String(clientID).trim(),
      platform: platform || 'multi',
      startAt: s,
      endAt: e,
      notes: notes ? String(notes) : '',
      createdByClientID: req.adminClient?.clientID || '',
    });

    res.status(201).json({ success: true, data: doc });
  })
);

router.put(
  '/ad-periods/:id',
  requireAdmin,
  wrapRoute(async (req, res) => {
    const { label, platform, startAt, endAt, notes } = req.body || {};
    const update = {};
    if (label != null) update.label = String(label).trim();
    if (platform != null) update.platform = platform;
    if (notes != null) update.notes = String(notes);
    if (startAt != null) update.startAt = new Date(startAt);
    if (endAt != null) update.endAt = new Date(endAt);

    const doc = await AdvertisingPeriod.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { $set: update },
      { new: true, runValidators: true }
    );

    if (!doc) {
      return res.status(404).json({ success: false, error: 'Period not found' });
    }
    res.json({ success: true, data: doc });
  })
);

router.delete(
  '/ad-periods/:id',
  requireAdmin,
  wrapRoute(async (req, res) => {
    const doc = await AdvertisingPeriod.findOneAndUpdate(
      { _id: req.params.id, isDeleted: false },
      { $set: { isDeleted: true } },
      { new: true }
    );
    if (!doc) {
      return res.status(404).json({ success: false, error: 'Period not found' });
    }
    res.json({ success: true, message: 'Advertising period removed' });
  })
);

module.exports = router;
