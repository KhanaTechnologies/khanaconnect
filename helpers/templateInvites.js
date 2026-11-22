const crypto = require('crypto');
const mongoose = require('mongoose');
const TemplateGalleryInvite = require('../models/TemplateGalleryInvite');
const { getKhanaAdminClient } = require('./teamPasswordReset');
const { sendTemplateGalleryInviteEmail } = require('../utils/email');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function marketingSiteUrl() {
  return (
    process.env.MARKETING_SITE_URL ||
    process.env.PUBLIC_SITE_URL ||
    'https://khanatechnologies.co.za'
  ).replace(/\/$/, '');
}

function galleryUrl(token) {
  return `${marketingSiteUrl()}/templates?invite=${encodeURIComponent(token)}`;
}

function clampDays(days) {
  const n = Math.round(Number(days));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_DAYS;
  return Math.min(n, MAX_DAYS);
}

function inviteStatus(invite, now = new Date()) {
  if (invite.revokedAt) return 'revoked';
  if (new Date(invite.expiresAt) <= now) return 'expired';
  return 'active';
}

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

/** What the Khana admin sees, including the link so it can be copied again or shared on WhatsApp. */
function serializeInvite(invite, now = new Date()) {
  return {
    id: String(invite._id),
    name: invite.name || '',
    businessName: invite.businessName || '',
    email: invite.email || '',
    note: invite.note || '',
    link: galleryUrl(invite.token),
    status: inviteStatus(invite, now),
    expiresAt: invite.expiresAt || null,
    revokedAt: invite.revokedAt || null,
    emailSentAt: invite.emailSentAt || null,
    viewCount: invite.viewCount || 0,
    firstViewedAt: invite.firstViewedAt || null,
    lastViewedAt: invite.lastViewedAt || null,
    createdAt: invite.createdAt || null,
  };
}

async function findInvite(id) {
  const invite = mongoose.isValidObjectId(id) ? await TemplateGalleryInvite.findById(id) : null;
  if (!invite) throw httpError(404, 'Invite not found');
  return invite;
}

async function emailInvite(invite) {
  if (!invite.email) throw httpError(400, 'This invite has no email address');
  const admin = await getKhanaAdminClient();
  await sendTemplateGalleryInviteEmail({
    to: invite.email,
    name: invite.name,
    businessName: invite.businessName,
    galleryLink: galleryUrl(invite.token),
    expiresAt: invite.expiresAt,
    adminBusinessEmail: admin.businessEmail,
    adminBusinessEmailPassword: admin.businessEmailPassword,
    adminCompanyName: admin.companyName,
    emailSignature: admin.emailSignature || '',
    adminClientId: admin.clientID,
  });
  invite.emailSentAt = new Date();
  await invite.save();
}

/**
 * Creates an invite. If `sendEmail` is set the invite is emailed from Khana's mailbox;
 * a failed send keeps the invite (the link still works) and is reported as `emailError`.
 */
async function createInvite(input = {}, { createdBy = '' } = {}) {
  const name = clean(input.name, 80);
  const businessName = clean(input.businessName, 80);
  const email = clean(input.email, 200).toLowerCase();
  const note = clean(input.note, 500);
  const sendEmail = Boolean(input.sendEmail);

  if (!name && !businessName) throw httpError(400, 'Add the client’s name or business name');
  if (email && !EMAIL_RE.test(email)) throw httpError(400, 'That email address doesn’t look right');
  if (sendEmail && !email) throw httpError(400, 'Add an email address to send the invite by email');

  const invite = await TemplateGalleryInvite.create({
    token: crypto.randomBytes(24).toString('base64url'),
    name,
    businessName,
    email,
    note,
    expiresAt: new Date(Date.now() + clampDays(input.days) * DAY_MS),
    createdBy,
  });

  let emailError = '';
  if (sendEmail) {
    try {
      await emailInvite(invite);
    } catch (err) {
      console.error('[templateInvites] invite email failed:', err.message);
      emailError = err.message || 'Could not send the email';
    }
  }
  return { invite, emailError };
}

/** (Re)sends the invite email. An expired invite is renewed for another `days` (default 30) first. */
async function resendInvite(id, { days } = {}) {
  const invite = await findInvite(id);
  if (invite.revokedAt) throw httpError(400, 'This invite was revoked. Create a new one instead.');
  if (inviteStatus(invite) === 'expired') {
    invite.expiresAt = new Date(Date.now() + clampDays(days) * DAY_MS);
  }
  await emailInvite(invite);
  return invite;
}

/** Gives an invite more time (from today), e.g. when the client asks for longer. */
async function extendInvite(id, { days } = {}) {
  const invite = await findInvite(id);
  if (invite.revokedAt) throw httpError(400, 'This invite was revoked. Create a new one instead.');
  invite.expiresAt = new Date(Date.now() + clampDays(days) * DAY_MS);
  await invite.save();
  return invite;
}

async function revokeInvite(id) {
  const invite = await findInvite(id);
  if (!invite.revokedAt) {
    invite.revokedAt = new Date();
    await invite.save();
  }
  return invite;
}

async function listInvites({ limit = 100 } = {}) {
  return TemplateGalleryInvite.find({})
    .sort({ createdAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 200));
}

/**
 * Public check used by the gallery on every page load (so a revoke takes effect at once).
 * `countVisit` is set on the first check of a browsing session, which is what "opened" counts.
 * Returns only what the gallery shows: the client's name and business name.
 */
async function checkInvite(token, { countVisit = true } = {}) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return { valid: false, reason: 'not_found' };
  const invite = await TemplateGalleryInvite.findOne({ token });
  if (!invite) return { valid: false, reason: 'not_found' };
  const status = inviteStatus(invite);
  if (status !== 'active') return { valid: false, reason: status };

  const now = new Date();
  if (countVisit) await TemplateGalleryInvite.updateOne(
    { _id: invite._id },
    {
      $inc: { viewCount: 1 },
      $set: { lastViewedAt: now, ...(invite.firstViewedAt ? {} : { firstViewedAt: now }) },
    }
  );
  return {
    valid: true,
    name: invite.name || '',
    businessName: invite.businessName || '',
    expiresAt: invite.expiresAt,
  };
}

module.exports = {
  DEFAULT_DAYS,
  MAX_DAYS,
  galleryUrl,
  inviteStatus,
  serializeInvite,
  createInvite,
  resendInvite,
  extendInvite,
  revokeInvite,
  listInvites,
  checkInvite,
};
