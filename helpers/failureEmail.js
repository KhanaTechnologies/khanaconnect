// failureEmail.js
// Single-file helper: email sender, capture middleware, route wrapper, and global error handler.
// Install dependency: npm install nodemailer

const nodemailer = require('nodemailer');
const crypto = require('crypto');
const { config } = require('dotenv');

/**
 * ============================
 * CONFIGURE SMTP CREDENTIALS
 * ============================
 *
 * You said you'll add the email and password in this file.
 * You can either:
 *  - Hardcode values below (not recommended for production), or
 *  - Keep them in environment variables and they'll be used automatically.
 *
 * Example (hardcode) - replace values below:
 */
const CONFIG = {
  SMTP_HOST: process.env.SMTP_HOST || 'mail.yourdomain.com', // cPanel SMTP host
  SMTP_PORT: Number(process.env.SMTP_PORT || 465),          // 465 or 587
  SMTP_SECURE: (process.env.SMTP_SECURE === 'true') || true, // true for 465, false for 587
  SMTP_USER: process.env.SMTP_USER || 'errors@yourdomain.com', // <-- replace or set env
  SMTP_PASS: process.env.SMTP_PASS || 'SuperSecretPassword',   // <-- replace or set env
  ERROR_EMAIL_TO: process.env.ERROR_EMAIL_TO || 'you@yourdomain.com', // where notifications go
  ERROR_EMAIL_FROM: process.env.ERROR_EMAIL_FROM || 'errors@yourdomain.com'
};

/**
 * Nodemailer transporter
 */
const transporter = nodemailer.createTransport({
  host: CONFIG.SMTP_HOST,
  port: CONFIG.SMTP_PORT,
  secure: CONFIG.SMTP_SECURE,
  auth: {
    user: CONFIG.SMTP_USER,
    pass: CONFIG.SMTP_PASS,
  },
  // tls: { rejectUnauthorized: false } // uncomment if you run into cert issues (dev only)
});

/**
 * Simple in-memory dedupe to avoid flooding emails for the same error signature.
 * Keeps signatures for DEDUPE_WINDOW_MS and ignores identical errors during the window.
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
 * Helper: safe JSON stringify
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
 * includes request headers, body, captured response (if any), and error stack
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
 * - Uses a dedupe signature to avoid flood on identical errors
 */
async function sendErrorEmail({ subject, html, text, dedupe = true }) {
  try {
    const signature = crypto.createHash('sha1').update((subject || '') + '\n' + (html || '')).digest('hex');
    if (dedupe && !dedupeShouldSend(signature)) {
      // Skip sending duplicate email within window
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
 * Mount this once in app.js BEFORE your routers.
 * It wraps res.json and res.send to capture outgoing payload into res.__getCapturedBody()
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
      if (Buffer.isBuffer(body)) {
        sentBody = body.toString('utf8');
      } else if (typeof body === 'string') {
        sentBody = body;
      } else {
        sentBody = JSON.parse(JSON.stringify(body));
      }
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
 * Wrap your async route handlers with this to automatically catch thrown errors,
 * send an error email (best-effort), then pass the error to next(err).
 *
 * Usage in a router:
 * const { wrapRoute } = require('./helpers/failureEmail');
 * router.post('/', wrapRoute(async (req, res) => { ... }));
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
        // don't await to avoid blocking request error flow; best-effort
        sendErrorEmail({ subject, html }).catch(e => {
          console.error('[failureEmail] sendErrorEmail error (wrapRoute):', e);
        });
      } catch (mailerErr) {
        console.error('[failureEmail] error while trying to send error email:', mailerErr);
      }
      // forward to express error handler
      next(err);
    }
  };
}

/**
 * globalErrorHandler
 * Mount this AFTER your routers, as the last middleware:
 *
 * const { globalErrorHandler } = require('./helpers/failureEmail');
 * app.use(globalErrorHandler);
 *
 * It will send an email for uncaught errors and respond with a 500 (or err.status).
 */
async function globalErrorHandler(err, req, res, next) {
  try {
    if (!req) {
      console.error('[failureEmail] globalErrorHandler called without req');
      return next(err);
    }

    // if headers already sent, delegate
    if (res.headersSent) return next(err);

    const resBody = (typeof res.__getCapturedBody === 'function') ? res.__getCapturedBody() : undefined;
    const subject = `Uncaught Exception — ${req.method} ${req.originalUrl}`;
    const html = formatErrorHtml({ req, resBody, err });

    // best-effort send
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
      try { res.status(500).json({ success: false, message: 'Internal Server Error' }); }
      catch (e2) { /* ignore */ }
    }
  }
}

/**
 * Exported utilities
 */
module.exports = {
  // config (in case you want to read/modify at runtime)
  CONFIG,

  // express middleware
  captureResponse: captureResponseMiddleware,
  globalErrorHandler,

  // route wrapper
  wrapRoute,

  // direct send (if you want to call manually)
  sendErrorEmail,
  formatErrorHtml
};


/**
 * ============================
 * EXAMPLE USAGE (quick reference)
 * ============================
 *
 * In app.js (or server entry):
 *
 * const express = require('express');
 * const app = express();
 * const failureEmail = require('./helpers/failureEmail'); // adjust path
 *
 * app.use(express.json());
 * app.use(failureEmail.captureResponse); // add BEFORE routers
 *
 * // mount routers (example)
 * // const itemsRouter = require('./routes/items');
 * // app.use('/api/items', itemsRouter);
 *
 * // ... other middleware
 *
 * // mount global error handler AFTER all routers:
 * app.use(failureEmail.globalErrorHandler);
 *
 * In each router file:
 *
 * const express = require('express');
 * const router = express.Router();
 * const { wrapRoute } = require('../helpers/failureEmail'); // adjust path
 *
 * router.post('/', wrapRoute(async (req, res) => {
 *   // if this throws, wrapRoute will email and call next(err)
 *   if (!req.body || !req.body.name) {
 *     const err = new Error('Missing field: name');
 *     err.status = 400;
 *     throw err;
 *   }
 *   // normal response — captured by captureResponse middleware
 *   res.json({ success: true, data: { id: 1, name: req.body.name } });
 * }));
 *
 * module.exports = router;
 *
 * Notes:
 * - You said you'll place credentials in this file; if you prefer env vars, set process.env.SMTP_USER / SMTP_PASS instead.
 * - If your host blocks outbound SMTP, the email will fail; for development use Mailtrap or sendgrid APIs.
 * - The file includes a 60s dedupe window to reduce repeated identical emails.
 *
 * Done — drop this file in your repo, update the SMTP creds (CONFIG block near top),
 * then mount captureResponse and globalErrorHandler in app.js and wrap your routes with wrapRoute.
 */
