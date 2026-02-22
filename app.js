// app.js
const { config } = require('dotenv');
var express = require('express');
const app = express();
var cookieParser = require('cookie-parser');
var logger = require('morgan');
const bodyParser = require("body-parser");
const morgan = require('morgan');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
require('dotenv/config');
const authJwt = require('./helpers/jwt');
const errorHandler = require('./helpers/error-handler');

// <-- NEW: failureEmail helper (single-file)
const failureEmail = require('./helpers/failureEmail');

// <-- NEW: Booking Reminder Service
const ReminderService = require('./helpers/reminderService');

// <-- NEW: required for IMAP + Socket.IO integration
const http = require('http');
const { Server } = require('socket.io');
const emailRouter = require('./routes/emailRouter');
const { startImap } = require('./helpers/imapService');

/**
 * ========================
 * SECURITY CONFIGURATION
 * ========================
 */

// Website Whitelist - Jason's specific domains
const ALLOWED_ORIGINS = [
  'https://herbeauty.co.za',
  'https://www.herbeauty.co.za',
  'https://khanatechnologies.co.za',
  'https://www.khanatechnologies.co.za',
  'https://www.gratiiam.co.za',
  'https://gratiiam.co.za',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://localhost:8080'
];

// IP Whitelist for sensitive endpoints (optional)
const ALLOWED_IPS = [
  '127.0.0.1',
  '::1',
  'localhost'
];

// Rate limiting configuration
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    error: 'Too many requests from this IP, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // Limit auth endpoints to 5 requests per windowMs
  message: {
    error: 'Too many authentication attempts, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit API endpoints to 200 requests per windowMs
  message: {
    error: 'Too many API requests, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * ========================
 * SECURITY MIDDLEWARE
 * ========================
 */

// Enhanced CORS with whitelist
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, curl requests)
    if (!origin) return callback(null, true);
    
    if (ALLOWED_ORIGINS.indexOf(origin) === -1) {
      const msg = `The CORS policy for this site does not allow access from the specified Origin: ${origin}`;
      console.warn(`🚫 Blocked CORS request from: ${origin}`);
      
      // Log suspicious CORS attempts
      failureEmail.sendErrorEmail({
        subject: 'CORS Blocked Request',
        html: `
          <h3>CORS Blocked Request</h3>
          <p><strong>Blocked Origin:</strong> ${origin}</p>
          <p><strong>Time:</strong> ${new Date().toISOString()}</p>
          <p><strong>Allowed Origins:</strong> ${ALLOWED_ORIGINS.join(', ')}</p>
        `
      }).catch(e => console.error('Failed to send CORS alert email:', e));
      
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.options('*', cors()); // Enable pre-flight for all routes

// Enhanced Helmet security
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  crossOriginEmbedderPolicy: false
}));

// Compression
app.use(compression());

// Trust proxy settings
app.set('trust proxy', 1); // Trust first proxy

// Remove X-Powered-By header
app.disable('x-powered-by');

/**
 * ========================
 * REQUEST PARSING & LOGGING
 * ========================
 */

// Body parsing with limits to prevent DoS
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ 
  extended: true, 
  limit: '10mb',
  parameterLimit: 100
}));

app.use(cookieParser());

// Enhanced logging
app.use(logger('combined'));
app.use(morgan('combined'));

// Request size limiting middleware
app.use((req, res, next) => {
  if (req.headers['content-length'] > 10 * 1024 * 1024) { // 10MB limit
    return res.status(413).json({ error: 'Request entity too large' });
  }
  next();
});

// <-- NEW: capture outgoing responses (must be mounted AFTER body parsers, BEFORE routers)
app.use(failureEmail.captureResponse);

// Static Files with security headers
app.use("/public/uploads", express.static(__dirname + "/public/uploads", {
  setHeaders: (res, path) => {
    // Security headers for static files
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
  }
}));

/**
 * ========================
 * RATE LIMITING APPLICATION
 * ========================
 */

// Apply general rate limiting to all routes
app.use(generalLimiter);

// Apply stricter rate limiting to auth endpoints
app.use('/api/v1/auth', authLimiter);
app.use('/api/v1/client/login', authLimiter);

// Apply API rate limiting
app.use('/api/v1', apiLimiter);

/**
 * ========================
 * JWT AUTH & ROUTES
 * ========================
 */

// JWT Auth (only for /api/v1)
app.use('/api/v1', authJwt());

// Routers
var customerRoutes = require('./routes/customer');
var clientRoutes = require('./routes/client');
var productRoutes = require('./routes/product');
var indexRouter = require('./routes/index');
var sizeRoutes = require('./routes/sizes');
var orderRoutes = require('./routes/orders');
var emailSubscriptionsRoutes = require('./routes/emailSubscriptions');
var wishListRouter = require('./routes/wishList');
var categoriesRouter = require('./routes/categories');
var productSalesRouter = require('./routes/productsale');
var discountCodeRouter = require('./routes/discountCode');
var bookingsRouter = require('./routes/booking');
var staffRouter = require('./routes/staff');
var serviceRouter = require('./routes/services');
var adminRouter = require('./routes/admin');
var resourcesRouter = require('./routes/resources');
var PreorderPledgeRouter = require('./routes/preorderPledges');
var campaignsRouter = require('./routes/campaigns');
var votingCampaignsRouter = require('./routes/votingCampaigns');

const analyticsRoutes = require("./routes/analytics");
app.use('/', indexRouter);

const api = process.env.API_URL || '/api/v1';

// Apply routes
app.use(`${api}/wishlists`, wishListRouter);
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
app.use(`${api}/staff`, staffRouter);
app.use(`${api}/services`, serviceRouter);
app.use(`${api}/admin`, adminRouter);
app.use(`${api}/resources`, resourcesRouter); 
app.use(`${api}/analytics`, analyticsRoutes);
app.use(`${api}/preorderpledge`, PreorderPledgeRouter);
app.use(`${api}/campaigns`, campaignsRouter);
app.use(`${api}/votingcampaigns`, votingCampaignsRouter);


// <-- NEW: mount email router under /api/v1/email
app.use(`${api}/email`, emailRouter);

/**
 * ========================
 * DATABASE CONNECTION
 * ========================
 */

// DB Connection with Pooling and enhanced security
mongoose.connect(process.env.CONNECTION_STRING, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
     dbName: 'KhanaConnect_ProdDB',
    //dbName: 'KhanaConnect_DevDB',
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000,
    autoIndex: false,
    bufferCommands: false,
})
.then(() => {
  console.log('DB Connected!');
  
  // <-- NEW: Start the Booking Reminder Service after DB connection is established
  try {
    const reminderService = new ReminderService();
    console.log('✅ Booking Reminder Service started successfully');
  } catch (error) {
    console.error('❌ Failed to start Booking Reminder Service:', error);
    failureEmail.sendErrorEmail({
      subject: 'Booking Reminder Service Failed to Start',
      html: `<h3>Booking Reminder Service Startup Error</h3><pre>${error && error.stack ? error.stack : JSON.stringify(error)}</pre>`
    }).catch(e => console.error('Failed to send reminder service error email:', e));
  }
})
.catch(err => {
  console.log('DB Connection Error:', err);
  failureEmail.sendErrorEmail({
    subject: 'DB Connection Error',
    html: `<pre>${err && err.stack ? err.stack : JSON.stringify(err)}</pre>`
  }).catch(e => console.error('Failed to send DB connection error email:', e));
});

/**
 * ========================
 * ERROR HANDLING
 * ========================
 */

// 404 Handler
app.use('*', (req, res) => {
  console.warn(`🚫 404 - Path not found: ${req.originalUrl} from IP: ${req.ip}`);
  res.status(404).json({ error: 'Route not found' });
});

// Uncaught Error Handling
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT ERROR:', err);
  failureEmail.sendErrorEmail({
    subject: 'UNCAUGHT EXCEPTION in KhanaConnect',
    html: `<h3>Uncaught Exception</h3><pre>${err && err.stack ? err.stack : JSON.stringify(err)}</pre>`
  }).catch(e => console.error('Failed to send uncaughtException email:', e));
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
  failureEmail.sendErrorEmail({
    subject: 'UNHANDLED REJECTION in KhanaConnect',
    html: `<h3>Unhandled Rejection</h3><pre>${reason && reason.stack ? reason.stack : JSON.stringify(reason)}</pre>`
  }).catch(e => console.error('Failed to send unhandledRejection email:', e));
});

// Mount the global error handler
app.use(failureEmail.globalErrorHandler);

/**
 * ========================
 * SERVER SETUP
 * ========================
 */

const PORT = process.env.PORT || 3000;

// Create HTTP server
const server = http.createServer(app);

// Socket.IO with enhanced security
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
  
  socket.on('disconnect', (reason) => {
    console.log('Socket disconnected:', socket.id, 'Reason:', reason);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔒 Security features enabled:`);
  console.log(`   - CORS Whitelist: ${ALLOWED_ORIGINS.length} domains`);
  console.log(`   - Protected Domains:`);
  console.log(`     • HerBeauty: herbeauty.co.za`);
  console.log(`     • Khana Technologies: khanatechnologies.co.za`);
  console.log(`     • Gratiiam: gratiiam.co.za`);
  console.log(`   - Rate Limiting: Active`);
  console.log(`   - Helmet Security: Active`);
});

/**
 * ========================
 * GRACEFUL SHUTDOWN
 * ========================
 */

const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received, shutting down gracefully...`);
  
  server.close(() => {
    console.log('HTTP server closed');
    mongoose.connection.close(false, () => {
      console.log('MongoDB connection closed');
      process.exit(0);
    });
  });

  // Force close after 10 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;