// failureEmail.js
// Single-file helper: email sender, capture middleware, route wrapper, and global error handler.
// Install dependency: npm install nodemailer

const nodemailer = require('nodemailer');
const crypto = require('crypto');

/**
 * ============================
 * CONFIGURE SMTP CREDENTIALS
 * ============================
 * Keep them in environment variables:
 *   process.env.SMTP_HOST
 *   process.env.SMTP_PORT
 *   process.env.SMTP_USER
 *   process.env.SMTP_PASS
 *   process.env.ERROR_EMAIL_TO
 *   process.env.ERROR_EMAIL_FROM
 */
const CONFIG = {
  SMTP_HOST: process.env.SMTP_HOST, // mail.khanatechnologies.co.za
  SMTP_PORT: Number(process.env.SMTP_PORT || 465), // working port for SMTP
  SMTP_SECURE: true, // SSL required for port 465
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  ERROR_EMAIL_TO: process.env.ERROR_EMAIL_TO,
  ERROR_EMAIL_FROM: process.env.ERROR_EMAIL_FROM
};


// Updated transporter configuration
// Most SMTP servers work better on port 587
const transporter = nodemailer.createTransport({
  host: CONFIG.SMTP_HOST,
  port: 465, // SSL port
  secure: true, // true for SSL
  auth: {
    user: CONFIG.SMTP_USER,
    pass: CONFIG.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false, // Allow self-signed certificates if needed
    minVersion: 'TLSv1.2' // Force modern TLS
  },
  // Connection pooling to prevent "too many connections"
  pool: true,
  maxConnections: 1,
  maxMessages: 5,
  connectionTimeout: 30000,
  greetingTimeout: 30000
});

// --- Simple in-memory dedupe ---
const DEDUPE_WINDOW_MS = 60 * 1000; // 60 seconds
const dedupeStore = new Map(); // signature -> timestamp
function dedupeShouldSend(signature) {
  const now = Date.now();
  const last = dedupeStore.get(signature) || 0;
  if (now - last < DEDUPE_WINDOW_MS) return false;
  dedupeStore.set(signature, now);

  // occasional cleanup
  if (dedupeStore.size > 1000) {
    for (const [k, ts] of dedupeStore.entries()) {
      if (now - ts > DEDUPE_WINDOW_MS * 5) dedupeStore.delete(k);
    }
  }

  return true;
}

// --- Safe stringify ---
function safeStringify(obj, fallback = '') {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj) || fallback; }
}

// --- Format HTML for error email ---
function formatErrorHtml({ req, resBody, err }) {
  // Get current date in South Africa timezone (UTC+2)
  const now = new Date();
  const options = { 
    timeZone: 'Africa/Johannesburg',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'long'
  };
  
  const dateFormatter = new Intl.DateTimeFormat('en-ZA', options);
  const dateParts = dateFormatter.formatToParts(now);
  
  const year = dateParts.find(part => part.type === 'year').value;
  const month = dateParts.find(part => part.type === 'month').value;
  const day = dateParts.find(part => part.type === 'day').value;
  const weekday = dateParts.find(part => part.type === 'weekday').value;
  
  // Format time with milliseconds
  const timeFormatter = new Intl.DateTimeFormat('en-ZA', {
    timeZone: 'Africa/Johannesburg',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    fractionalSecondDigits: 3
  });
  
  const timeParts = timeFormatter.formatToParts(now);
  const hour = timeParts.find(part => part.type === 'hour').value;
  const minute = timeParts.find(part => part.type === 'minute').value;
  const second = timeParts.find(part => part.type === 'second').value;
  const fractionalSecond = timeParts.find(part => part.type === 'fractionalSecond')?.value || '000';
  
  const formattedDate = `${year}-${month}-${day}(${weekday})T${hour}:${minute}:${second}.${fractionalSecond}Z`;
  
  const url = req ? `${req.method} ${req.originalUrl}` : '(no req)';
  const headers = req ? safeStringify(req.headers) : '(no headers)';
  const reqBody = req && typeof req.body !== 'undefined' ? safeStringify(req.body) : '(no body)';
  const resBodyStr = typeof resBody === 'undefined' ? '(no captured response)' : safeStringify(resBody);
  const stack = err && err.stack ? err.stack : (err ? safeStringify(err) : '(no error stack)');

  return `
    <h2>API Error — ${formattedDate}</h2>
    <h3>Endpoint</h3><pre>${url}</pre>
    <h3>Request</h3><pre>Headers:\n${headers}\n\nBody:\n${reqBody}</pre>
    <h3>Response (captured)</h3><pre>${resBodyStr}</pre>
    <h3>Error</h3><pre>${stack}</pre>
  `;
}

// --- Send error email ---
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
      html,
      text
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
        await sendErrorEmail({ subject, html }); // await here
      } catch (mailerErr) {
        console.error('[failureEmail] sendErrorEmail error (wrapRoute):', mailerErr);
      }
      
      // Send error response here instead of passing to global handler
      const status = err && err.status && Number(err.status) >= 400 ? err.status : 500;
      res.status(status).json({
        success: false,
        message: status === 500 ? 'Internal Server Error' : (err.message || 'Error')
      });
      
      // DON'T call next(err) - this prevents duplicate emails
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
