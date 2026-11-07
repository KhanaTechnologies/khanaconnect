const mongoose = require('mongoose');
const DashboardNotice = require('../models/DashboardNotice');
const DashboardNoticeDismissal = require('../models/DashboardNoticeDismissal');
const { normalizePlanId } = require('./monthlyCreditAllowance');

const TONES = new Set(['info', 'warning', 'price']);
const AUDIENCES = new Set(['all', 'plans', 'clients']);

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 200);
}

function safeLink(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (value.startsWith('/') && !value.startsWith('//')) return value.slice(0, 500);
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.toString().slice(0, 500);
  } catch {
    /* ignore */
  }
  throw httpError('linkUrl must be a site path starting with / or an http(s) URL');
}

function parseDate(value, label, { required = false } = {}) {
  if (value == null || value === '') {
    if (required) throw httpError(`${label} is required`);
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw httpError(`${label} is not a valid date`);
  return date;
}

function noticeInput(body = {}, { partial = false } = {}) {
  const next = {};

  if (!partial || body.title != null) {
    const title = String(body.title || '').trim();
    if (!title) throw httpError('title is required');
    next.title = title.slice(0, 140);
  }
  if (!partial || body.body != null) {
    const text = String(body.body || '').trim();
    if (!text) throw httpError('body is required');
    next.body = text.slice(0, 2000);
  }
  if (!partial || body.tone != null) {
    const tone = String(body.tone || 'info').trim().toLowerCase();
    if (!TONES.has(tone)) throw httpError('tone must be info, warning, or price');
    next.tone = tone;
  }
  if (!partial || body.audienceType != null || body.audience != null) {
    const audienceType = String(body.audienceType || body.audience || 'all').trim().toLowerCase();
    if (!AUDIENCES.has(audienceType)) throw httpError('audienceType must be all, plans, or clients');
    next.audienceType = audienceType;
  }
  if (!partial || body.plans != null) next.plans = cleanList(body.plans).map((plan) => normalizePlanId(plan));
  if (!partial || body.clientIds != null || body.clientIDs != null) {
    next.clientIds = cleanList(body.clientIds || body.clientIDs);
  }
  if (!partial || body.publishAt != null) {
    next.publishAt =
      body.publishAt == null || body.publishAt === ''
        ? new Date()
        : parseDate(body.publishAt, 'publishAt', { required: true });
  }
  if (!partial || body.effectiveAt != null) next.effectiveAt = parseDate(body.effectiveAt, 'effectiveAt');
  if (!partial || body.expiresAt != null) next.expiresAt = parseDate(body.expiresAt, 'expiresAt');
  if (!partial || body.dismissible != null) next.dismissible = body.dismissible !== false;
  if (!partial || body.linkLabel != null) next.linkLabel = String(body.linkLabel || '').trim().slice(0, 80);
  if (!partial || body.linkUrl != null) next.linkUrl = safeLink(body.linkUrl);
  if (!partial || body.active != null) next.active = body.active !== false;

  if (next.audienceType === 'plans' && next.plans && !next.plans.length) {
    throw httpError('plans is required when audienceType is plans');
  }
  if (next.audienceType === 'clients' && next.clientIds && !next.clientIds.length) {
    throw httpError('clientIds is required when audienceType is clients');
  }
  if (next.publishAt && next.expiresAt && next.expiresAt <= next.publishAt) {
    throw httpError('expiresAt must be after publishAt');
  }
  if (next.tone === 'price' && next.effectiveAt == null && !partial) {
    throw httpError('effectiveAt is required for a price notice');
  }

  return next;
}

function matchesAudience(notice, client) {
  if (notice.audienceType === 'clients') {
    return (notice.clientIds || []).includes(String(client.clientID || ''));
  }
  if (notice.audienceType === 'plans') {
    const plan = normalizePlanId(client.subscription?.plan);
    return (notice.plans || []).includes(plan);
  }
  return true;
}

function serializeNotice(notice, { admin = false } = {}) {
  const row = {
    id: String(notice._id),
    title: notice.title,
    body: notice.body,
    tone: notice.tone,
    publishAt: notice.publishAt ? new Date(notice.publishAt).toISOString() : null,
    effectiveAt: notice.effectiveAt ? new Date(notice.effectiveAt).toISOString() : null,
    expiresAt: notice.expiresAt ? new Date(notice.expiresAt).toISOString() : null,
    dismissible: notice.dismissible !== false,
    linkLabel: notice.linkLabel || '',
    linkUrl: notice.linkUrl || '',
  };
  if (admin) {
    row.audienceType = notice.audienceType;
    row.plans = notice.plans || [];
    row.clientIds = notice.clientIds || [];
    row.active = notice.active !== false;
    row.createdBy = notice.createdBy || '';
    row.createdAt = notice.createdAt ? new Date(notice.createdAt).toISOString() : null;
    row.updatedAt = notice.updatedAt ? new Date(notice.updatedAt).toISOString() : null;
  }
  return row;
}

async function listVisibleNotices(client, now = new Date()) {
  const clientID = String(client?.clientID || '');
  if (!clientID) return [];

  const plan = normalizePlanId(client.subscription?.plan);
  const notices = await DashboardNotice.find({
    active: true,
    publishAt: { $lte: now },
    $and: [
      { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
      {
        $or: [
          { audienceType: 'all' },
          { audienceType: 'plans', plans: plan },
          { audienceType: 'clients', clientIds: clientID },
        ],
      },
    ],
  })
    .sort({ publishAt: -1 })
    .limit(50)
    .lean();

  const matching = notices.filter((notice) => matchesAudience(notice, client));
  if (!matching.length) return [];

  const dismissed = await DashboardNoticeDismissal.find({
    clientID,
    noticeId: { $in: matching.map((notice) => notice._id) },
  })
    .select('noticeId')
    .lean();
  const hidden = new Set(dismissed.map((row) => String(row.noticeId)));

  return matching.filter((notice) => !hidden.has(String(notice._id))).map((notice) => serializeNotice(notice));
}

async function dismissNotice(client, noticeId, dismissedBy = '') {
  if (!mongoose.Types.ObjectId.isValid(noticeId)) throw httpError('Notice not found', 404);
  const notice = await DashboardNotice.findById(noticeId);
  if (!notice || !notice.active) throw httpError('Notice not found', 404);
  if (!matchesAudience(notice, client)) throw httpError('Notice not found', 404);
  if (notice.dismissible === false) throw httpError('This notice stays up until it expires', 400);

  await DashboardNoticeDismissal.updateOne(
    { noticeId: notice._id, clientID: String(client.clientID) },
    {
      $set: {
        dismissedBy: String(dismissedBy || '').slice(0, 120),
        dismissedAt: new Date(),
      },
    },
    { upsert: true }
  );
  return { id: String(notice._id), dismissed: true };
}

module.exports = {
  noticeInput,
  serializeNotice,
  listVisibleNotices,
  dismissNotice,
  httpError,
};
