const SaasApiMonitorEvent = require('../../models/SaasApiMonitorEvent');
const { isMetaBusinessAdminError } = require('../../helpers/metaAppPermissions');

const CAUSE_LABELS = {
  success: 'Completed successfully',
  permission_denied: 'Meta permission denied or not approved in App Review',
  business_admin_required: 'Facebook user must be Business Portfolio Admin',
  auth_expired: 'Access token expired or invalid',
  config_missing: 'Integration not configured on server or tenant',
  rate_limit: 'Rate limited by upstream API',
  validation: 'Invalid request or missing required fields',
  upstream_error: 'Upstream API error',
  unknown: 'Unknown cause',
};

function classifyCause({ message = '', meta = {}, httpStatus = null, integration = '' } = {}) {
  const msg = String(message || '').toLowerCase();
  const code = meta?.code ?? meta?.error?.code ?? null;
  const sub = meta?.error_subcode ?? meta?.error?.error_subcode ?? null;

  if (/not configured|missing.*(token|id|secret)|env/i.test(msg)) return 'config_missing';
  if (isMetaBusinessAdminError(msg) || /owner|admin|business manager|not authorized/i.test(msg)) {
    return 'business_admin_required';
  }
  if (
    /permission|manage_events|ads_management|ads_read|instagram_basic|instagram_content_publish|(#10)|(#200)/i.test(
      msg
    ) ||
    code === 10 ||
    code === 200
  ) {
    return 'permission_denied';
  }
  if (/expired|invalid.*token|session has expired|oauth|(#190)/i.test(msg) || code === 190) {
    return 'auth_expired';
  }
  if (/rate limit|too many|(#4)|(#32)|(#613)/i.test(msg) || code === 4 || code === 32) {
    return 'rate_limit';
  }
  if (/required|missing|invalid|(#100)/i.test(msg) || code === 100) {
    return 'validation';
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return integration.startsWith('meta') ? 'permission_denied' : 'auth_expired';
  }
  if (httpStatus && httpStatus >= 500) return 'upstream_error';
  if (msg) return 'upstream_error';
  return 'unknown';
}

function sanitizeMeta(meta = {}) {
  if (!meta || typeof meta !== 'object') return {};
  const out = { ...meta };
  for (const key of Object.keys(out)) {
    if (/token|secret|password|authorization/i.test(key)) {
      out[key] = '[redacted]';
    }
  }
  if (out.error && typeof out.error === 'object') {
    const e = { ...out.error };
    if (e.fbtrace_id) out.fbtrace_id = e.fbtrace_id;
    out.error = {
      message: e.message || e.error_user_msg || '',
      type: e.type || '',
      code: e.code ?? null,
      error_subcode: e.error_subcode ?? null,
    };
  }
  return out;
}

/**
 * Fire-and-forget API monitor event (never throws).
 */
async function recordEvent(input = {}) {
  try {
    const message = String(input.message || '').slice(0, 2000);
    const meta = sanitizeMeta(input.meta || {});
    const httpStatus = input.httpStatus ?? input.http_status ?? null;
    const cause =
      input.cause ||
      classifyCause({
        message,
        meta,
        httpStatus,
        integration: input.integration || 'system',
      });

    await SaasApiMonitorEvent.create({
      client_id: String(input.clientId || input.client_id || '').trim(),
      integration: input.integration || 'system',
      operation: String(input.operation || 'unknown').slice(0, 120),
      outcome: input.outcome || 'error',
      message: message || CAUSE_LABELS[cause] || CAUSE_LABELS.unknown,
      cause,
      http_status: httpStatus,
      duration_ms: input.durationMs ?? input.duration_ms ?? null,
      meta,
    });
  } catch (err) {
    console.warn('[api-monitor] record failed:', err.message);
  }
}

function recordEventSafe(input) {
  recordEvent(input).catch(() => {});
}

async function listEvents({
  clientId = '',
  integration = '',
  outcome = '',
  cause = '',
  limit = 50,
  since = null,
} = {}) {
  const q = {};
  if (clientId) q.client_id = String(clientId);
  if (integration) q.integration = String(integration);
  if (outcome) q.outcome = String(outcome);
  if (cause) q.cause = String(cause);
  if (since) q.created_at = { $gte: since };

  const cap = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const rows = await SaasApiMonitorEvent.find(q).sort({ created_at: -1 }).limit(cap).lean();
  return rows.map((row) => ({
    ...row,
    causeLabel: CAUSE_LABELS[row.cause] || row.cause,
  }));
}

async function getSummary({ clientId = '', days = 7 } = {}) {
  const dayNum = Math.min(Math.max(Number(days) || 7, 1), 90);
  const since = new Date(Date.now() - dayNum * 24 * 60 * 60 * 1000);
  const match = { created_at: { $gte: since } };
  if (clientId) match.client_id = String(clientId);

  const [byOutcome, byIntegration, byCause, recentErrors, lastSuccess] = await Promise.all([
    SaasApiMonitorEvent.aggregate([
      { $match: match },
      { $group: { _id: '$outcome', count: { $sum: 1 } } },
    ]),
    SaasApiMonitorEvent.aggregate([
      { $match: match },
      { $group: { _id: '$integration', count: { $sum: 1 }, errors: { $sum: { $cond: [{ $eq: ['$outcome', 'error'] }, 1, 0] } } } },
      { $sort: { errors: -1, count: -1 } },
    ]),
    SaasApiMonitorEvent.aggregate([
      { $match: { ...match, outcome: 'error' } },
      { $group: { _id: '$cause', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 20 },
    ]),
    SaasApiMonitorEvent.find({ ...match, outcome: 'error' })
      .sort({ created_at: -1 })
      .limit(15)
      .lean(),
    SaasApiMonitorEvent.findOne({ ...match, outcome: 'success' })
      .sort({ created_at: -1 })
      .lean(),
  ]);

  const outcomes = { success: 0, warning: 0, error: 0 };
  for (const row of byOutcome) {
    if (row._id && outcomes[row._id] !== undefined) outcomes[row._id] = row.count;
  }

  const topCauses = byCause.map((row) => ({
    cause: row._id,
    count: row.count,
    label: CAUSE_LABELS[row._id] || row._id,
  }));

  const likelyIssue =
    topCauses[0]?.cause === 'permission_denied'
      ? 'Meta App Review permissions are missing — remove denied scopes from Login for Business or resubmit App Review.'
      : topCauses[0]?.cause === 'business_admin_required'
        ? 'Connect Facebook with a profile that is Admin on the Meta Business Portfolio.'
        : topCauses[0]?.cause === 'auth_expired'
          ? 'Meta access token expired — disconnect and reconnect Facebook in Khana.'
          : topCauses[0]
            ? `${topCauses[0].label} (${topCauses[0].count} events)`
            : 'No errors recorded in this period.';

  return {
    days: dayNum,
    since,
    outcomes,
    total: outcomes.success + outcomes.warning + outcomes.error,
    byIntegration: byIntegration.map((row) => ({
      integration: row._id,
      count: row.count,
      errors: row.errors,
    })),
    topCauses,
    likelyIssue,
    recentErrors: recentErrors.map((row) => ({
      ...row,
      causeLabel: CAUSE_LABELS[row.cause] || row.cause,
    })),
    lastSuccessAt: lastSuccess?.created_at || null,
    causeLabels: CAUSE_LABELS,
  };
}

module.exports = {
  recordEvent,
  recordEventSafe,
  listEvents,
  getSummary,
  classifyCause,
  CAUSE_LABELS,
};
