// failureEmail.js
// Email sender, capture middleware, route wrapper, and global error handler.

const crypto = require('crypto');
const { decrypt } = require('./encryption');
const {
  createSystemSmtpTransport,
  getSystemSmtpConfig,
  isSystemSmtpConfigured,
} = require('./systemSmtpTransport');

const CONFIG = {
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: Number(process.env.SMTP_PORT || 587),
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  ERROR_EMAIL_TO: process.env.ERROR_EMAIL_TO,
  ERROR_EMAIL_FROM: process.env.ERROR_EMAIL_FROM,
};

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  transporter = createSystemSmtpTransport();
  return transporter;
}

function resetTransporter() {
  if (transporter && typeof transporter.close === 'function') {
    Promise.resolve(transporter.close()).catch(() => {});
  }
  transporter = null;
}

// --- Simple in-memory dedupe ---
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const dedupeStore = new Map();

function dedupeShouldSend(signature) {
  const now = Date.now();
  const last = dedupeStore.get(signature) || 0;
  if (now - last < DEDUPE_WINDOW_MS) return false;
  dedupeStore.set(signature, now);

  if (dedupeStore.size > 1000) {
    for (const [k, ts] of dedupeStore.entries()) {
      if (now - ts > DEDUPE_WINDOW_MS * 5) dedupeStore.delete(k);
    }
  }

  return true;
}

function safeStringify(obj, fallback = '') {
  try {
    return JSON.stringify(obj, null, 2);
  } catch {
    return String(obj) || fallback;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Never email credentials: request headers / bodies of login, reset and payment routes carry them.
const SENSITIVE_HEADER_RE = /^(authorization|cookie|set-cookie|x-admin-api-key|x-webhook-secret|x-order-webhook-secret|x-booking-webhook-secret|x-hub-signature(-256)?)$/i;
const SENSITIVE_FIELD_RE = /pass(word|phrase)?|secret|token|api[_-]?key|merchant_key|card|cvv|signature|otp|code$/i;

function redact(value, depth = 0) {
  if (depth > 6 || value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_FIELD_RE.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = SENSITIVE_HEADER_RE.test(k) ? '[redacted]' : v;
  }
  return out;
}

/** Hide internal 500 details from browsers once deployed; developers still see them locally. */
const HIDE_INTERNAL_ERRORS = process.env.NODE_ENV === 'production' || !!process.env.RENDER;

function formatErrorHtml({ req, resBody, err }) {
  const now = new Date();
  const options = {
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long',
  };

  const dateFormatter = new Intl.DateTimeFormat('en-ZA', options);
  const dateParts = dateFormatter.formatToParts(now);

  const year = dateParts.find((part) => part.type === 'year').value;
  const month = dateParts.find((part) => part.type === 'month').value;
  const day = dateParts.find((part) => part.type === 'day').value;
  const weekday = dateParts.find((part) => part.type === 'weekday').value;

  const timeFormatter = new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    fractionalSecondDigits: 3,
  });

  const timeParts = timeFormatter.formatToParts(now);
  const hour = timeParts.find((part) => part.type === 'hour').value;
  const minute = timeParts.find((part) => part.type === 'minute').value;
  const second = timeParts.find((part) => part.type === 'second').value;
  const fractionalSecond = timeParts.find((part) => part.type === 'fractionalSecond')?.value || '000';

  const formattedDate = `${year}-${month}-${day}(${weekday})T${hour}:${minute}:${second}.${fractionalSecond}Z`;

  const url = req ? `${req.method} ${req.originalUrl}` : '(no req)';
  const headers = req ? safeStringify(redactHeaders(req.headers)) : '(no headers)';
  const reqBody = req && typeof req.body !== 'undefined' ? safeStringify(redact(req.body)) : '(no body)';
  const resBodyStr = typeof resBody === 'undefined' ? '(no captured response)' : safeStringify(redact(resBody));
  const stack = err && err.stack ? err.stack : err ? safeStringify(err) : '(no error stack)';
  const reference = req?.errorReference ? `<p><strong>Reference:</strong> ${escapeHtml(req.errorReference)}</p>` : '';

  return `
    <h2>API Error — ${formattedDate}</h2>
    ${reference}
    <h3>Endpoint</h3><pre>${escapeHtml(url)}</pre>
    <h3>Request</h3><pre>Headers:\n${escapeHtml(headers)}\n\nBody:\n${escapeHtml(reqBody)}</pre>
    <h3>Response (captured)</h3><pre>${escapeHtml(resBodyStr)}</pre>
    <h3>Error</h3><pre>${escapeHtml(stack)}</pre>
  `;
}

/**
 * @param {string} [dedupeKey] what makes two alerts "the same" (defaults to subject + body).
 *   Route errors pass endpoint + message: their body has a timestamp, so it never repeats.
 */
async function sendErrorEmail({ subject, html, text, dedupe = true, dedupeKey }) {
  try {
    if (!isSystemSmtpConfigured()) {
      console.warn('[failureEmail] SMTP not configured — skipping error email.');
      return { skipped: true, reason: 'no_smtp' };
    }

    const signature = crypto
      .createHash('sha1')
      .update(dedupeKey || (subject || '') + '\n' + (html || ''))
      .digest('hex');
    if (dedupe && !dedupeShouldSend(signature)) {
      console.warn('[failureEmail] Duplicate error — skipping email (dedupe).');
      return { skipped: true };
    }

    const transport = getTransporter();
    if (!transport) {
      console.warn('[failureEmail] Could not create SMTP transport — skipping error email.');
      return { skipped: true, reason: 'no_transport' };
    }

    const smtpCfg = getSystemSmtpConfig();
    const mailOptions = {
      from: decrypt(CONFIG.ERROR_EMAIL_FROM || smtpCfg.user),
      to: decrypt(CONFIG.ERROR_EMAIL_TO || smtpCfg.user),
      subject: subject || 'API Error Notification',
      html,
      text,
    };

    const result = await transport.sendMail(mailOptions);
    return { ok: true, result };
  } catch (e) {
    const smtpCfg = getSystemSmtpConfig();
    console.error(
      '[failureEmail] sendErrorEmail failed:',
      e.message || e,
      `(host=${smtpCfg.host} port=${smtpCfg.port} secure=${smtpCfg.secure})`
    );
    resetTransporter();
    return { ok: false, error: e };
  }
}

function errorReference() {
  return `ERR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

/** First line of an internal error, for the alert and dedupe key. */
function bodyErrorText(body) {
  if (!body || typeof body !== 'object') return String(body || '');
  return String(body.details || body.error || body.message || '').split('\n')[0].slice(0, 300);
}

/**
 * Routes that catch their own errors and answer 500 with err.message used to leak internals
 * to browsers and never alerted anyone. In production: email the real body, send a generic
 * message with a reference the customer can quote. 502/503/504 (upstream / temporary) keep
 * their messages — those explain Meta / payment provider failures to the user.
 */
function handleInternalErrorBody(req, res, body) {
  if (res.statusCode !== 500 || !body || typeof body !== 'object' || Array.isArray(body)) return body;

  req.errorReference = req.errorReference || errorReference();
  if (!req.__errorEmailed) {
    req.__errorEmailed = true;
    const subject = `API Error — ${req.method} ${req.originalUrl.split('?')[0]}`;
    sendErrorEmail({
      subject,
      html: formatErrorHtml({ req, resBody: body, err: null }),
      dedupeKey: `${subject}\n${bodyErrorText(body)}`,
    }).catch(() => {});
  }
  if (!HIDE_INTERNAL_ERRORS) return body;

  const generic = 'Something went wrong on our side. Please try again, or contact support with the reference.';
  const safe = { reference: req.errorReference };
  for (const key of ['success', 'ok', 'code', 'retryable']) {
    if (key in body) safe[key] = body[key];
  }
  if ('error' in body || !('message' in body)) safe.error = generic;
  if ('message' in body) safe.message = generic;
  return safe;
}

function captureResponseMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  let sentBody;

  res.json = function (body) {
    sentBody = body;
    return originalJson(handleInternalErrorBody(req, res, body));
  };

  res.send = function (body) {
    try {
      if (Buffer.isBuffer(body)) sentBody = body.toString('utf8');
      else if (typeof body === 'string') sentBody = body;
      else sentBody = JSON.parse(JSON.stringify(body));
    } catch {
      sentBody = String(body);
    }
    return originalSend(body);
  };

  res.__getCapturedBody = () => sentBody;
  next();
}

function wrapRoute(handler) {
  return async function (req, res, next) {
    try {
      await handler(req, res, next);
    } catch (err) {
      try {
        req.__errorEmailed = true;
        req.errorReference = req.errorReference || errorReference();
        const resBody = typeof res.__getCapturedBody === 'function' ? res.__getCapturedBody() : undefined;
        const subject = `API Error — ${req.method} ${req.originalUrl.split('?')[0]}`;
        const html = formatErrorHtml({ req, resBody, err });
        // Don't hold the response for SMTP.
        sendErrorEmail({ subject, html, dedupeKey: `${subject}\n${err?.message || err}` }).catch(() => {});
      } catch (mailerErr) {
        console.error('[failureEmail] sendErrorEmail error (wrapRoute):', mailerErr.message || mailerErr);
      }

      if (res.headersSent) return; // handler already answered before throwing
      const status = err && err.status && Number(err.status) >= 400 ? err.status : 500;
      res.status(status).json({
        success: false,
        message:
          status === 500
            ? 'Internal Server Error'
            : err.message || 'Error',
        ...(status === 500 ? { reference: req.errorReference } : {}),
        ...(status === 503 ? { retryable: true } : {}),
      });
    }
  };
}

async function globalErrorHandler(err, req, res, next) {
  try {
    if (!req) {
      console.error('[failureEmail] globalErrorHandler called without req');
      return next(err);
    }

    if (res.headersSent) return next(err);

    // express-jwt auth failures — expected client errors, not incidents
    if (err && (err.name === 'UnauthorizedError' || err.status === 401 || err.statusCode === 401)) {
      return res.status(401).json({
        success: false,
        message: err.message || 'The user is not authorized',
      });
    }

    req.__errorEmailed = true;
    req.errorReference = req.errorReference || errorReference();
    const resBody = typeof res.__getCapturedBody === 'function' ? res.__getCapturedBody() : undefined;
    const subject = `Uncaught Exception — ${req.method} ${req.originalUrl.split('?')[0]}`;
    const html = formatErrorHtml({ req, resBody, err });

    sendErrorEmail({ subject, html, dedupeKey: `${subject}\n${err?.message || err}` }).catch((e) => {
      console.error('[failureEmail] sendErrorEmail failed (global handler):', e.message || e);
    });

    const status = err && err.status && Number(err.status) >= 400 ? err.status : 500;
    res.status(status).json({
      success: false,
      message: status === 500 ? 'Internal Server Error' : err.message || 'Error',
      ...(status === 500 ? { reference: req.errorReference } : {}),
    });
  } catch (e) {
    console.error('[failureEmail] error inside globalErrorHandler:', e);
    if (!res.headersSent) {
      try {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = {
  CONFIG,
  captureResponse: captureResponseMiddleware,
  globalErrorHandler,
  wrapRoute,
  sendErrorEmail,
  formatErrorHtml,
};
