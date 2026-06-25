const nodemailer = require('nodemailer');
const { decrypt } = require('./encryption');
const { sanitizeHostInput } = require('./mailHost');

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  const v = String(value).trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes';
}

function resolveSystemSmtpPort() {
  const port = Number(process.env.SMTP_PORT);
  if (Number.isFinite(port) && port > 0) return port;
  return 587;
}

function resolveSystemSmtpSecure(port) {
  if (process.env.SMTP_SECURE != null && String(process.env.SMTP_SECURE).trim() !== '') {
    return parseBool(process.env.SMTP_SECURE, false);
  }
  return Number(port) === 465;
}

function getSystemSmtpConfig() {
  const port = resolveSystemSmtpPort();
  const secure = resolveSystemSmtpSecure(port);
  const host = sanitizeHostInput(process.env.SMTP_HOST);

  return {
    host,
    port,
    secure,
    requireTLS: !secure && port === 587,
    user: decrypt(process.env.SMTP_USER || ''),
    pass: decrypt(process.env.SMTP_PASS || ''),
  };
}

function isSystemSmtpConfigured() {
  const cfg = getSystemSmtpConfig();
  return Boolean(cfg.host && cfg.user && cfg.pass);
}

function createSystemSmtpTransport() {
  const cfg = getSystemSmtpConfig();
  if (!cfg.host || !cfg.user || !cfg.pass) {
    return null;
  }

  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
    tls: {
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
    },
    pool: false,
    connectionTimeout: 30000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
  });
}

module.exports = {
  getSystemSmtpConfig,
  isSystemSmtpConfigured,
  createSystemSmtpTransport,
};
