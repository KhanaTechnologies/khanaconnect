const TrackingEvent = require('../models/TrackingEvent');

const GRANULARITIES = new Set(['hour', 'day', 'week', 'month', 'quarter', 'year']);

function parseISODate(value, fieldName) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${fieldName} is required (ISO 8601 date string)`);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${fieldName} must be a valid ISO date`);
  }
  return d;
}

function buildMatch({ clientID, start, end, eventTypes, excludeTempClients }) {
  const match = {
    timestamp: { $gte: start, $lte: end },
  };
  if (clientID) {
    match.clientID = String(clientID).trim();
  } else if (excludeTempClients) {
    match.clientID = { $regex: /^(?!temp_)/i };
  }
  if (eventTypes && Array.isArray(eventTypes) && eventTypes.length > 0) {
    match.eventType = { $in: eventTypes };
  }
  return match;
}

function dateTruncStage(granularity, timezone) {
  const unit = GRANULARITIES.has(granularity) ? granularity : 'day';
  const tz = timezone && typeof timezone === 'string' ? timezone : 'UTC';
  return {
    $dateTrunc: {
      date: '$timestamp',
      unit,
      timezone: tz,
    },
  };
}

/**
 * Time series + totals from TrackingEvent.
 */
async function getSiteActivityOverview(options) {
  const {
    start,
    end,
    clientID,
    granularity = 'day',
    timezone = 'UTC',
    eventTypes,
    excludeTempClients = true,
  } = options;

  const match = buildMatch({ clientID, start, end, eventTypes, excludeTempClients });
  const trunc = dateTruncStage(granularity, timezone);

  const [totalsAgg, byTypeAgg, seriesAgg, sessionsAgg] = await Promise.all([
    TrackingEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          totalEvents: { $sum: 1 },
          pageViews: {
            $sum: { $cond: [{ $eq: ['$eventType', 'PAGE_VIEW'] }, 1, 0] },
          },
        },
      },
    ]),
    TrackingEvent.aggregate([
      { $match: match },
      { $group: { _id: '$eventType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
    TrackingEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: { period: trunc, eventType: '$eventType' },
          count: { $sum: 1 },
        },
      },
      {
        $group: {
          _id: '$_id.period',
          byEventType: { $push: { eventType: '$_id.eventType', count: '$count' } },
          totalEvents: { $sum: '$count' },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    TrackingEvent.aggregate([
      { $match: match },
      {
        $group: {
          _id: { period: trunc, sessionId: '$sessionId' },
        },
      },
      {
        $group: {
          _id: '$_id.period',
          uniqueSessions: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const totals = totalsAgg[0] || { totalEvents: 0, pageViews: 0 };
  const sessionByPeriod = new Map(
    sessionsAgg.map((r) => [r._id ? r._id.toISOString() : '', r.uniqueSessions])
  );

  const series = seriesAgg.map((row) => {
    const key = row._id ? row._id.toISOString() : '';
    const byType = {};
    (row.byEventType || []).forEach((x) => {
      byType[x.eventType] = x.count;
    });
    return {
      period: row._id,
      periodIso: key,
      totalEvents: row.totalEvents,
      pageViews: byType.PAGE_VIEW || 0,
      uniqueSessions: sessionByPeriod.get(key) || 0,
      byEventType: byType,
    };
  });

  return {
    range: { start, end },
    granularity,
    timezone,
    clientID: clientID || null,
    totals: {
      totalEvents: totals.totalEvents,
      pageViews: totals.pageViews,
    },
    byEventType: byTypeAgg.map((r) => ({ eventType: r._id, count: r.count })),
    series,
  };
}

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(overview) {
  const lines = [];
  lines.push(
    [
      'period_iso',
      'total_events',
      'page_views',
      'unique_sessions',
      'event_type',
      'count',
    ].join(',')
  );
  for (const row of overview.series || []) {
    const periodIso = row.periodIso || '';
    const base = [
      csvEscape(periodIso),
      row.totalEvents,
      row.pageViews,
      row.uniqueSessions,
    ];
    const types = row.byEventType || {};
    const keys = Object.keys(types);
    if (keys.length === 0) {
      lines.push([...base, '', ''].join(','));
    } else {
      keys.forEach((k) => {
        lines.push([...base, csvEscape(k), types[k]].join(','));
      });
    }
  }
  return lines.join('\r\n');
}

module.exports = {
  GRANULARITIES,
  parseISODate,
  buildMatch,
  getSiteActivityOverview,
  toCsv,
};
