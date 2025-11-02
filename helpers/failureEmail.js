// failureEmail.js
// Single-file helper: email sender, capture middleware, route wrapper, and global error handler.
// Install dependency: npm install nodemailer

const nodemailer = require('nodemailer');
const crypto = require('crypto');

/**
 * ============================
 * CONFIGURE SMTP CREDENTIALS
 * ============================
 * You can keep them in environment variables:
 *   process.env.SMTP_HOST
 *   process.env.SMTP_PORT
 *   process.env.SMTP_SECURE
 *   process.env.SMTP_USER
 *   process.env.SMTP_PASS
 *   process.env.ERROR_EMAIL_TO
 *   process.env.ERROR_EMAIL_FROM
 */
const CONFIG = {
  SMTP_HOST: process.env.SMTP_HOST, // cPanel / GoDaddy SMTP host
  SMTP_PORT: Number(process.env.SMTP_PORT || 465),
  SMTP_SECURE: (process.env.SMTP_SECURE === 'true') || true,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  ERROR_EMAIL_TO: process.env.ERROR_EMAIL_TO,
  ERROR_EMAIL_FROM: process.env.ERROR_EMAIL_FROM
};

/**
 * Nodemailer transporter
 * Includes a fallback for GoDaddy blocking too many login attempts
 */
let transporter = nodemailer.createTransport({
  host: CONFIG.SMTP_HOST,
  port: CONFIG.SMTP_PORT,
  secure: CONFIG.SMTP_SECURE,
  auth: {
    user: CONFIG.SMTP_USER,
    pass: CONFIG.SMTP_PASS
  },
  // tls: { rejectUnauthorized: false } // uncomment if you run into cert issues (dev only)
});

/**
 * Simple in-memory dedupe to avoid flooding emails for the same error signature
 */
const DEDUPE_WINDOW_MS = 60 * 1000; // 60 seconds
const dedupeStore = new Map(); // signature -> timestamp

function dedupeShouldSend(signature) {
  const now = Date.now();
  const last = dedupeStore.get(signature) || 0;
  if (now - last < DEDUPE_WINDOW_MS) return false;
  dedupeStore.set(signature, now);
  // cleanup occasionally
  if (dedupeStore.size > 1000) {
    for (const [k, ts] of dedupeStore.entries()) {
      if (now - ts > DEDUPE_WINDOW_MS * 5) dedupeStore.delete(k);
    }
  }
  return true;
}

/**
 * Safe stringify
 */
function safeStringify(obj, fallback = '') {
  try {
    return JSON.stringify(obj, null, 2);
  } catch (e) {
    try { return String(obj); } catch (e2) { return fallback; }
  }
}

/**
 * Format the HTML body for the error email
 */
function formatErrorHtml({ req, resBody, err }) {
  const now = new Date().toISOString();
  const url = req ? `${req.method} ${req.originalUrl}` : '(no req)';
  const headers = req ? safeStringify(req.headers) : '(no headers)';
  const reqBody = req && typeof req.body !== 'undefined' ? safeStringify(req.body) : '(no body)';
  const resBodyStr = typeof resBody === 'undefined' ? '(no captured response)' : safeStringify(resBody);
  const stack = err && err.stack ? err.stack : (err ? safeStringify(err) : '(no error stack)');

  return `
    <h2>API Error — ${now}</h2>
    <h3>Endpoint</h3>
    <pre>${url}</pre>

    <h3>Request</h3>
    <pre>Headers:\n${headers}\n\nBody:\n${reqBody}</pre>

    <h3>Response (captured)</h3>
    <pre>${resBodyStr}</pre>

    <h3>Error</h3>
    <pre>${stack}</pre>
  `;
}

/**
 * Send error email (best-effort)
 */
async function sendErrorEmail({ subject, html, text, dedupe = true }) {
  try {
    const signature = crypto.createHash('sha1').update((subject || '') + '\n' + (html || '')).digest('hex');
    if (dedupe && !dedupeShouldSend(signature)) {
      console.warn('[failureEmail] Duplicate error — skipping email (dedupe).');
      return { skipped: true };
    }

    const mailOptions = {
      from: CONFIG.ERROR_EMAIL_FROM || CONFIG.SMTP_USER,
      to: CONFIG.ERROR_EMAIL_TO || CONFIG.SMTP_USER,
      subject: subject || 'API Error Notification',
      html: html || undefined,
      text: text || undefined
    };

    const result = await transporter.sendMail(mailOptions);
    return { ok: true, result };
  } catch (e) {
    console.error('[failureEmail] sendErrorEmail failed:', e);
    return { ok: false, error: e };
  }
}

/**
 * Middleware: captureResponse
 * Mount before routers to capture response payloads
 */
function captureResponseMiddleware(req, res, next) {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  let sentBody;

  res.json = function (body) {
    sentBody = body;
    return originalJson(body);
  };

  res.send = function (body) {
    try {
      if (Buffer.isBuffer(body)) sentBody = body.toString('utf8');
      else if (typeof body === 'string') sentBody = body;
      else sentBody = JSON.parse(JSON.stringify(body));
    } catch (e) {
      sentBody = String(body);
    }
    return originalSend(body);
  };

  res.__getCapturedBody = () => sentBody;
  next();
}

/**
 * wrapRoute(handler)
 * Wrap async route handlers to catch errors and send emails
 */
function wrapRoute(handler) {
  return async function (req, res, next) {
    try {
      await handler(req, res, next);
    } catch (err) {
      try {
        const resBody = (typeof res.__getCapturedBody === 'function') ? res.__getCapturedBody() : undefined;
        const subject = `API Error — ${req.method} ${req.originalUrl}`;
        const html = formatErrorHtml({ req, resBody, err });
        sendErrorEmail({ subject, html }).catch(e => {
          console.error('[failureEmail] sendErrorEmail error (wrapRoute):', e);
        });
      } catch (mailerErr) {
        console.error('[failureEmail] error while trying to send error email:', mailerErr);
      }
      next(err);
    }
  };
}

/**
 * globalErrorHandler
 * Mount after all routers
 */
async function globalErrorHandler(err, req, res, next) {
  try {
    if (!req) {
      console.error('[failureEmail] globalErrorHandler called without req');
      return next(err);
    }

    if (res.headersSent) return next(err);

    const resBody = (typeof res.__getCapturedBody === 'function') ? res.__getCapturedBody() : undefined;
    const subject = `Uncaught Exception — ${req.method} ${req.originalUrl}`;
    const html = formatErrorHtml({ req, resBody, err });

    sendErrorEmail({ subject, html }).catch(e => {
      console.error('[failureEmail] sendErrorEmail failed (global handler):', e);
    });

    const status = err && err.status && Number(err.status) >= 400 ? err.status : 500;
    res.status(status).json({
      success: false,
      message: status === 500 ? 'Internal Server Error' : (err.message || 'Error')
    });
  } catch (e) {
    console.error('[failureEmail] error inside globalErrorHandler:', e);
    if (!res.headersSent) {
      try { res.status(500).json({ success: false, message: 'Internal Server Error' }); } catch {}
    }
  }
}

module.exports = {
  CONFIG,
  captureResponse: captureResponseMiddleware,
  globalErrorHandler,
  wrapRoute,
  sendErrorEmail,
  formatErrorHtml
};
