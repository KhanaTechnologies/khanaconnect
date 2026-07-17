const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const B2BLoginChallenge = require('../models/B2BLoginChallenge');
const B2BAuditLog = require('../models/B2BAuditLog');
const { mergeB2bSettings } = require('./b2bDefaults');

function requestMeta(req) {
  return {
    ipAddress: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '',
    userAgent: String(req.headers['user-agent'] || '').slice(0, 512),
  };
}

async function recordB2BAudit({ clientID, buyerId, teamMemberId, event, summary, req, metadata = {} }) {
  const meta = req ? requestMeta(req) : { ipAddress: '', userAgent: '' };
  await B2BAuditLog.create({
    clientID,
    buyerId: buyerId || null,
    teamMemberId: teamMemberId || null,
    event,
    summary,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata,
  });
}

function generateOtpCode() {
  return String(crypto.randomInt(100000, 999999));
}

function isBuyerLocked(buyer, settings) {
  if (!buyer.lockedUntil) return false;
  if (new Date(buyer.lockedUntil) <= new Date()) return false;
  return (buyer.failedLoginAttempts || 0) >= settings.maxLoginAttempts;
}

async function registerFailedLogin(buyer, settings) {
  buyer.failedLoginAttempts = (buyer.failedLoginAttempts || 0) + 1;
  if (buyer.failedLoginAttempts >= settings.maxLoginAttempts) {
    buyer.lockedUntil = new Date(Date.now() + settings.lockoutMinutes * 60 * 1000);
  }
  await buyer.save();
}

async function clearFailedLogins(buyer) {
  buyer.failedLoginAttempts = 0;
  buyer.lockedUntil = null;
  await buyer.save();
}

async function createLoginChallenge({ buyer, client, req }) {
  const settings = mergeB2bSettings(client);
  const code = generateOtpCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = new Date(Date.now() + settings.otpExpiryMinutes * 60 * 1000);
  const meta = requestMeta(req);

  await B2BLoginChallenge.deleteMany({
    buyerId: buyer._id,
    consumedAt: null,
  });

  const challenge = await B2BLoginChallenge.create({
    clientID: buyer.clientID,
    buyerId: buyer._id,
    codeHash,
    expiresAt,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });

  return { challenge, code, expiresAt, settings };
}

async function verifyLoginChallenge({ challengeId, code, buyerId, clientID }) {
  const challenge = await B2BLoginChallenge.findOne({
    _id: challengeId,
    buyerId,
    clientID,
    consumedAt: null,
  }).select('+codeHash');

  if (!challenge) return { ok: false, error: 'Invalid or expired verification session' };
  if (challenge.expiresAt <= new Date()) {
    return { ok: false, error: 'Verification code expired — please sign in again' };
  }
  if (challenge.attempts >= 5) {
    return { ok: false, error: 'Too many incorrect codes — please sign in again' };
  }

  const match = await bcrypt.compare(String(code).trim(), challenge.codeHash);
  if (!match) {
    challenge.attempts += 1;
    await challenge.save();
    return { ok: false, error: 'Incorrect verification code' };
  }

  challenge.consumedAt = new Date();
  await challenge.save();
  return { ok: true, challenge };
}

module.exports = {
  recordB2BAudit,
  requestMeta,
  generateOtpCode,
  isBuyerLocked,
  registerFailedLogin,
  clearFailedLogins,
  createLoginChallenge,
  verifyLoginChallenge,
  mergeB2bSettings,
};
