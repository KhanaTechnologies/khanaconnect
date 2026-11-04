const path = require('path');
var express = require('express');
const app = express();
var cookieParser = require('cookie-parser');
const morgan = require('morgan');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
require('dotenv/config');
const authJwt = require('./helpers/jwt');
const errorHandler = require('./helpers/error-handler');
const { mongoSanitize } = require('./middleware/mongoSanitize');
const bandwidthMeter = require('./middleware/bandwidthMeter');

// Tracking System Imports
const trackingRoutes = require('./routes/trackingEvents');
const eventProcessor = require('./services/eventProcessor');

// Job scheduler imports (started after MongoDB connects)
const { startJobScheduler, stopJobScheduler } = require('./config/agenda');

// failureEmail helper
const failureEmail = require('./helpers/failureEmail');

// Booking Reminder Service
const ReminderService = require('./helpers/reminderService');

// required for IMAP + Socket.IO integration
const http = require('http');
const { Server } = require('socket.io');
const emailRouter = require('./routes/emailRouter');
const { startImap } = require('./helpers/imapService');

/**
 * ========================
 * SECURITY CONFIGURATION
 * ========================
 */

// Website Whitelist
const ALLOWED_ORIGINS = [
  'https://herbeauty.co.za',
  'https://www.herbeauty.co.za',
  'https://khanatechnologies.co.za',
  'https://www.khanatechnologies.co.za',
  'https://www.gratiiam.co.za',
  'https://gratiiam.co.za',
  'https://dentonvisionmining.co.za',
  'https://www.dentonvisionmining.co.za',
  'https://denton-api.onrender.com',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://localhost:8080'
];

// Rate limiting configuration
const _apiPathPrefix = (process.env.API_URL || '/api/v1').replace(/\/$/, '');

/** Dashboard UIs poll these read endpoints; don't burn the global IP quota on them. */
function isDashboardPollGet(req) {
  if (req.method !== 'GET') return false;
  const p = typeof req.path === 'string' ? req.path : '';
  const full = typeof req.originalUrl === 'string' ? req.originalUrl.split('?')[0] : p;
  return (
    p === `${_apiPathPrefix}/email` ||
    p.startsWith(`${_apiPathPrefix}/email/`) ||
    p === '/email' ||
    p.startsWith('/email/') ||
    full.includes('/saas/whatsapp/inbox') ||
    p.includes('/saas/whatsapp/inbox') ||
    p.startsWith('/whatsapp/inbox') ||
    full.includes('/whatsapp/inbox')
  );
}

function skipEmailMailboxReads(req) {
  return isDashboardPollGet(req);
}

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // Dashboard + WhatsApp inbox poll often; 100 was blocking legitimate replies.
  max: 600,
  message: { error: 'Too many requests from this IP, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipEmailMailboxReads,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many authentication attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 800,
  message: { error: 'Too many API requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  // Mailbox + WhatsApp inbox issue frequent parallel GETs — exempt those reads from this cap.
  skip: isDashboardPollGet,
});

// Tracking endpoint specific rate limiter
const trackingLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 1000, // 1000 events per minute
  message: { error: 'Too many tracking events, please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const clientId = req.body.events?.[0]?.clientId || req.headers['x-client-id'];
    return clientId || req.ip;
  }
});

/**
 * ========================
 * SECURITY MIDDLEWARE
 * ========================
 */

// Bandwidth meter — first, so it sees every response (incl. CORS rejections) and,
// being ahead of compression(), counts the compressed bytes actually sent.
app.use(bandwidthMeter.bandwidthMeter);

// Alert at most once per blocked origin per hour (bots can retry thousands of times).
const CORS_ALERT_INTERVAL_MS = 60 * 60 * 1000;
const corsAlertSentAt = new Map();

function alertBlockedOrigin(origin) {
  const last = corsAlertSentAt.get(origin) || 0;
  if (Date.now() - last < CORS_ALERT_INTERVAL_MS) return;
  if (corsAlertSentAt.size > 500) corsAlertSentAt.clear();
  corsAlertSentAt.set(origin, Date.now());

  failureEmail.sendErrorEmail({
    subject: 'CORS Blocked Request',
    html: `<h3>CORS Blocked Request</h3><p><strong>Origin:</strong> ${origin}</p>`
  }).catch(e => console.error('Failed to send CORS alert email:', e));
}

// Enhanced CORS with whitelist
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (ALLOWED_ORIGINS.indexOf(origin) === -1) {
      const msg = `The CORS policy does not allow access from: ${origin}`;
      console.warn(`🚫 Blocked CORS request from: ${origin}`);
      alertBlockedOrigin(origin);
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-Client-ID', 'X-Session-ID', 'X-Anonymous-ID']
};

app.use(cors(corsOptions));

// Preflight uses the same whitelist (bare cors() would answer any origin with *).
app.options('*', cors(corsOptions));

// Enhanced Helmet security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// Compression
app.use(compression());

// Trust proxy settings
app.set('trust proxy', 1);
app.disable('x-powered-by');

/**
 * ========================
 * REQUEST PARSING & LOGGING
 * ========================
 */

// Body parsing with limits
app.use(express.json({
  limit: '10mb',
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString('utf8');
  },
}));
app.use(express.urlencoded({ extended: true, limit: '10mb', parameterLimit: 100 }));

// Strip MongoDB operators ($gt, etc.) from body/query/params — after parsers, before routes
app.use(mongoSanitize);

app.use(cookieParser());
app.use(morgan('combined'));

// Request size limiting
app.use((req, res, next) => {
  if (req.headers['content-length'] > 10 * 1024 * 1024) {
    return res.status(413).json({ error: 'Request entity too large' });
  }
  next();
});

app.use(failureEmail.captureResponse);

// Static Files — shared headers for public assets embedded on external storefronts
function setPublicUploadHeaders(res) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'public, max-age=86400');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
}

// Uploaded files get a unique timestamped name per upload and are never edited in place,
// so browsers / CDNs / email proxies can keep them for 30 days instead of re-downloading daily.
const IMMUTABLE_UPLOAD_CACHE = 'public, max-age=2592000, immutable';

app.use("/public/uploads", express.static(path.join(__dirname, "public/uploads"), {
  setHeaders: (res) => {
    setPublicUploadHeaders(res);
    res.set('Cache-Control', IMMUTABLE_UPLOAD_CACHE);
    res.set('X-Frame-Options', 'DENY');
  }
}));

app.use("/public/email", express.static(path.join(__dirname, "public/email"), {
  setHeaders: (res) => {
    setPublicUploadHeaders(res);
    // Shared email assets (logo) are fetched on every email open — cache for a week.
    res.set('Cache-Control', 'public, max-age=604800');
  },
}));

app.use('/public/admin', express.static(path.join(__dirname, 'public/admin'), {
  setHeaders: (res) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Cache-Control', 'no-cache');
  },
}));

// Legacy local campaign paths + GitHub-backed assets under /public/uploads
app.use("/uploads", express.static(path.join(__dirname, "uploads"), {
  setHeaders: setPublicUploadHeaders,
}));

// OpenAPI / Swagger (export spec at /openapi.json?export=1)
const swaggerUi = require('swagger-ui-express');
const { spec: buildOpenApiSpec } = require('./config/openapi');
const openApiDocument = buildOpenApiSpec();

app.get('/openapi.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.query.export === '1' || req.query.download === '1') {
    res.setHeader('Content-Disposition', 'attachment; filename="khana-connect-openapi.json"');
  }
  res.send(openApiDocument);
});

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openApiDocument, {
  customSiteTitle: 'KhanaConnect API',
  swaggerOptions: { persistAuthorization: true },
}));

/**
 * ========================
 * RATE LIMITING APPLICATION
 * ========================
 */

app.use(generalLimiter);
app.use('/api/v1/auth', authLimiter);
app.use('/api/v1/client/login', authLimiter);
app.use('/api/v1', apiLimiter);

/**
 * ========================
 * ROUTES
 * ========================
 */



// JWT Auth for API routes
app.use('/api/v1', authJwt());

// Import all routers
var customerRoutes = require('./routes/customer');
var clientRoutes = require('./routes/client');
var productRoutes = require('./routes/product');
var indexRouter = require('./routes/index');
var legalRouter = require('./routes/legal');
var sizeRoutes = require('./routes/sizes');
var orderRoutes = require('./routes/orders');
var emailSubscriptionsRoutes = require('./routes/emailSubscriptions');
var wishListRouter = require('./routes/wishList');
var wishlistStatsRouter = require('./routes/wishlistStats');
var serviceWishlistRouter = require('./routes/serviceWishlist');
var categoriesRouter = require('./routes/categories');
var productSalesRouter = require('./routes/productsale');
var discountCodeRouter = require('./routes/discountCode');
var bookingsRouter = require('./routes/booking');
var publicBookingRouter = require('./routes/publicBooking');
var staffRouter = require('./routes/staff');
var serviceRouter = require('./routes/services');
var adminRouter = require('./routes/admin');
var adminSiteAnalyticsRouter = require('./routes/adminSiteAnalytics');
var resourcesRouter = require('./routes/resources');
var PreorderPledgeRouter = require('./routes/preorderPledges');
var campaignsRouter = require('./routes/campaigns');
var votingCampaignsRouter = require('./routes/votingCampaigns');
const analyticsRoutes = require("./routes/analytics");
const paymentsRouter = require('./routes/payments');
const saasRouter = require('./routes/saas');
const revenueCommandCenterRouter = require('./routes/revenueCommandCenter');
const partnershipPricingRouter = require('./routes/partnershipPricing');
const partnershipQuoteRouter = require('./routes/partnershipQuote');
const teamRouter = require('./routes/team');
const b2bRouter = require('./routes/b2b');

app.use('/', legalRouter);
app.use('/', indexRouter);

const api = process.env.API_URL || '/api/v1';

// Public tracking routes (no JWT required)
app.use(`${api}/events`, trackingLimiter, trackingRoutes);
// PayFast ITN (no JWT — validated with PayFast server-side /eng/query/validate)
app.use(`${api}/payments`, paymentsRouter);
// Apply API routes
app.use(`${api}/wishlists/stats`, wishlistStatsRouter);
app.use(`${api}/wishlists`, wishListRouter);
app.use(`${api}/service-wishlist`, serviceWishlistRouter);
app.use(`${api}/categories`, categoriesRouter);
app.use(`${api}/emailsub`, emailSubscriptionsRoutes);
app.use(`${api}/orders`, orderRoutes);
app.use(`${api}/products`, productRoutes);
app.use(`${api}/customer`, customerRoutes);
app.use(`${api}/client`, clientRoutes);
app.use(`${api}/size`, sizeRoutes);
app.use(`${api}/productsales`, productSalesRouter);
app.use(`${api}/discountcode`, discountCodeRouter);
app.use(`${api}/bookings`, bookingsRouter);
app.use(`${api}/storefront/bookings`, publicBookingRouter);
app.use(`${api}/staff`, staffRouter);
app.use(`${api}/services`, serviceRouter);
app.use(`${api}/admin/bandwidth`, require('./routes/adminBandwidth'));
app.use(`${api}/admin`, adminRouter);
app.use(`${api}/admin/site-analytics`, adminSiteAnalyticsRouter);
app.use(`${api}/resources`, resourcesRouter); 
app.use(`${api}/analytics`, analyticsRoutes);
app.use(`${api}/preorderpledge`, PreorderPledgeRouter);
app.use(`${api}/campaigns`, campaignsRouter);
app.use(`${api}/votingcampaigns`, votingCampaignsRouter);
app.use(`${api}/email`, emailRouter);
app.use(`${api}/saas`, saasRouter);
app.use(`${api}/revenue`, revenueCommandCenterRouter);
app.use(`${api}/team`, teamRouter);
app.use(`${api}/b2b`, b2bRouter);
app.use(`${api}`, partnershipPricingRouter);
app.use(`${api}`, partnershipQuoteRouter);
app.use(api, legalRouter.apiRouter);


/**
 * ========================
 * DATABASE CONNECTION
 * ========================
 */

mongoose.connect(process.env.CONNECTION_STRING, {
    dbName: 'KhanaConnect_ProdDB',
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    autoIndex: true,
    bufferCommands: false,
})
.then(async () => {
  console.log('✅ DB Connected!');
  bandwidthMeter.startFlushing();

  const { resolvePublicBaseUrl } = require('./helpers/publicBaseUrl');
  const publicBase = resolvePublicBaseUrl();
  if (publicBase.includes('localhost') && (process.env.RENDER || process.env.NODE_ENV === 'production')) {
    console.warn(
      '⚠️ BASE_URL is not set on this server. Newsletter unsubscribe links will point to localhost. ' +
        'Set BASE_URL=https://khanaconnect.onrender.com in Render environment variables.'
    );
  } else {
    console.log(`📎 Public email link base: ${publicBase}`);
  }
  
  const { ensureEmailIndexes } = require('./helpers/ensureEmailIndexes');
  ensureEmailIndexes().catch((err) => {
    console.error('Failed to ensure email indexes:', err.message);
  });

  const { ensureKhanaWhatsAppAccountFromEnv } = require('./helpers/ensureKhanaWhatsAppAccount');
  ensureKhanaWhatsAppAccountFromEnv().catch((err) => {
    console.error('[whatsapp] Failed to upsert Khana Cloud API account:', err.message);
  });

  const { ensureWhatsAppPricingDefaults } = require('./helpers/ensureWhatsAppPricingDefaults');
  ensureWhatsAppPricingDefaults().catch((err) => {
    console.error('[whatsapp] Failed to seed WhatsApp pricing defaults:', err.message);
  });

  // Create indexes for tracking events
  const TrackingEvent = require('./models/TrackingEvent');
  TrackingEvent.createIndexes().catch(err => {
    console.error('Failed to create tracking indexes:', err);
  });
  
  // Start Booking Reminder Service
  try {
    const reminderService = new ReminderService();
    console.log('✅ Booking Reminder Service started');
  } catch (error) {
    console.error('❌ Failed to start Booking Reminder Service:', error);
  }

  try {
    const serviceWishlistReminderCron = require('./services/serviceWishlistReminderCron');
    serviceWishlistReminderCron.start();
    console.log('✅ Service wishlist reminder cron started');
  } catch (error) {
    console.error('❌ Failed to start service wishlist reminder cron:', error);
  }

  try {
    const cartRecoveryAutoReminderCron = require('./services/cartRecoveryAutoReminderCron');
    cartRecoveryAutoReminderCron.start();
    console.log('✅ Cart recovery auto-reminder cron started');
  } catch (error) {
    console.error('❌ Failed to start cart recovery auto-reminder cron:', error);
  }

  try {
    await startJobScheduler();
  } catch (error) {
    console.error('❌ Failed to start job scheduler:', error);
  }

  console.log('📊 Tracking System initialized');
  console.log('   - Event deduplication: Enabled');
  console.log('   - Event processor: Running');
  console.log('   - Batch endpoint: /api/events/batch');
  console.log('   - Job scheduler: MongoDB (Agenda)');
  console.log('   - Workers: Running');
})
.catch(err => {
  console.log('❌ DB Connection Error:', err);
  failureEmail.sendErrorEmail({
    subject: 'DB Connection Error',
    html: `<pre>${err.stack}</pre>`
  }).catch(e => console.error('Failed to send DB connection error email:', e));
});

/**
 * ========================
 * ERROR HANDLING
 * ========================
 */

// 404 Handler
app.use('*', (req, res) => {
  console.warn(`🚫 404 - Path not found: ${req.originalUrl}`);
  res.status(404).json({ error: 'Route not found' });
});

// Uncaught Error Handling
// After an uncaught exception the process state is unknown (half-written requests, broken
// sockets), so alert and exit; Render restarts a clean instance within seconds.
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT ERROR:', err);
  const exit = () => process.exit(1);
  setTimeout(exit, 5000).unref();
  failureEmail.sendErrorEmail({
    subject: 'UNCAUGHT EXCEPTION (server restarting)',
    html: `<pre>${String(err?.stack || err).replace(/</g, '&lt;')}</pre>`,
    dedupe: false,
  })
    .catch(e => console.error('Failed to send uncaughtException email:', e))
    .finally(exit);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
  failureEmail.sendErrorEmail({
    subject: 'UNHANDLED REJECTION',
    html: `<pre>${reason?.stack || reason}</pre>`
  }).catch(e => console.error('Failed to send unhandledRejection email:', e));
});

app.use(failureEmail.globalErrorHandler);

/**
 * ========================
 * SERVER SETUP
 * ========================
 */

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
bandwidthMeter.attachServer(server);

// Socket.IO
const io = new Server(server, { 
  cors: { 
    origin: ALLOWED_ORIGINS,
    methods: ['GET', 'POST']
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.locals.io = io;

io.on('connection', socket => {
  console.log('Socket connected:', socket.id);
  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔒 Security features enabled:`);
  console.log(`   - CORS Whitelist: ${ALLOWED_ORIGINS.length} domains`);
  console.log(`   - Rate Limiting: Active`);
  console.log(`   - Helmet Security: Active`);
  console.log(`📊 Tracking System:`);
  console.log(`   - Endpoint: /api/events/batch`);
  console.log(`   - Rate Limit: 1000 events/minute`);
  console.log(`   - Deduplication: Enabled`);
  console.log(`   - Job scheduler: MongoDB (Agenda)`);
  console.log(`📚 API Docs: http://localhost:${PORT}/api-docs`);
});

/**
 * ========================
 * GRACEFUL SHUTDOWN
 * ========================
 */

const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received, shutting down gracefully...`);

  try {
    await stopJobScheduler();
  } catch (e) {
    console.error('Error stopping job scheduler:', e.message);
  }
  
  // Wait for event processor to finish
  if (eventProcessor && eventProcessor.stats?.queued > 0) {
    console.log(`Waiting for ${eventProcessor.stats.queued} queued events...`);
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  
  try {
    await bandwidthMeter.stopFlushing();
  } catch (e) {
    console.error('Error flushing bandwidth meter:', e.message);
  }

  server.close(async () => {
    console.log('HTTP server closed');
    // Mongoose 7+ dropped the close() callback — without await this never exited cleanly.
    try {
      await mongoose.connection.close(false);
      console.log('MongoDB connection closed');
    } catch (e) {
      console.error('Error closing MongoDB connection:', e.message);
    }
    process.exit(0);
  });

  setTimeout(() => {
    console.error('Forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
