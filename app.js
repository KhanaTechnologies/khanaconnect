// app.js
const { config } = require('dotenv');
var express = require('express');
const app = express();
//var path = require('path');
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
// Make sure this path matches where you put failureEmail.js
const failureEmail = require('./helpers/failureEmail');

// <-- NEW: Booking Reminder Service
const ReminderService = require('./helpers/reminderService');

// <-- NEW: required for IMAP + Socket.IO integration
const http = require('http');
const { Server } = require('socket.io');
const emailRouter = require('./routes/emailRouter');
const { startImap } = require('./helpers/imapService');

/**
 * Security & Performance Middleware
 */
app.use(helmet());
app.use(cors());
app.options('*', cors());
app.use(compression());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.disable('x-powered-by');
app.set('trust proxy', 1); // or 'trust proxy', true

/**
 * Request Parsing
 */
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(logger('dev'));
app.use(morgan('tiny'));

// <-- NEW: capture outgoing responses (must be mounted AFTER body parsers, BEFORE routers)
// This allows failureEmail to capture the outgoing JSON/body so emails include it.
app.use(failureEmail.captureResponse);

// Static Files
app.use("/public/uploads", express.static(__dirname + "/public/uploads"));

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


app.use('/', indexRouter);

app.use(cors());
app.options('*',cors());

const api = process.env.API_URL || '/api/v1';

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

// <-- NEW: mount email router under /api/v1/email
app.use(`${api}/email`, emailRouter);

// mongoose.connect(process.env.CONNECTION_STRING,{ useNewUrlParser: true,useUnifiedTopology: true, dbName: 'KhanaConnect_DevDB',} )
// DB Connection with Pooling
// Replace your current mongoose.connect() with this:
mongoose.connect(process.env.CONNECTION_STRING, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    dbName: 'KhanaConnect_ProdDB',
    maxPoolSize: 10, // Changed from poolSize to maxPoolSize
    serverSelectionTimeoutMS: 5000, // Optional but recommended
    socketTimeoutMS: 45000, // Optional but recommended
})
.then(() => {
  console.log('DB Connected!');
  
  // <-- NEW: Start the Booking Reminder Service after DB connection is established
  try {
    const reminderService = new ReminderService();
    console.log('✅ Booking Reminder Service started successfully');
  } catch (error) {
    console.error('❌ Failed to start Booking Reminder Service:', error);
    // Notify via email about reminder service failure
    failureEmail.sendErrorEmail({
      subject: 'Booking Reminder Service Failed to Start',
      html: `<h3>Booking Reminder Service Startup Error</h3><pre>${error && error.stack ? error.stack : JSON.stringify(error)}</pre>`
    }).catch(e => console.error('Failed to send reminder service error email:', e));
  }
})
.catch(err => {
  console.log('DB Connection Error:', err);
  // optionally notify on DB connection failure
  failureEmail.sendErrorEmail({
    subject: 'DB Connection Error',
    html: `<pre>${err && err.stack ? err.stack : JSON.stringify(err)}</pre>`
  }).catch(e => console.error('Failed to send DB connection error email:', e));
});


/**
 * Uncaught Error Handling
 * Also notify via email (best-effort). These handlers won't have a request object.
 */
process.on('uncaughtException', (err) => {
  console.error('💥 UNCAUGHT ERROR:', err);
  // best-effort email
  failureEmail.sendErrorEmail({
    subject: 'UNCAUGHT EXCEPTION in KhanaConnect',
    html: `<h3>Uncaught Exception</h3><pre>${err && err.stack ? err.stack : JSON.stringify(err)}</pre>`
  }).catch(e => console.error('Failed to send uncaughtException email:', e));
  // optionally exit process after some time or restart manager will do it
  // process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 UNHANDLED REJECTION:', reason);
  failureEmail.sendErrorEmail({
    subject: 'UNHANDLED REJECTION in KhanaConnect',
    html: `<h3>Unhandled Rejection</h3><pre>${reason && reason.stack ? reason.stack : JSON.stringify(reason)}</pre>`
  }).catch(e => console.error('Failed to send unhandledRejection email:', e));
});

/**
 * Mount the global error handler from failureEmail
 * This should be AFTER all routers so it can catch uncaught route errors.
 */
app.use(failureEmail.globalErrorHandler);

// ---------------------------
// REPLACED: create HTTP server, attach Socket.IO, start IMAP worker
// ---------------------------
const PORT = process.env.PORT || 3000;

// create http server and attach socket.io so we can emit events from IMAP worker
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// make io available on app.locals if any other code needs it
app.locals.io = io;

io.on('connection', socket => {
  console.log('socket connected', socket.id);
  // optional: listen to client events
  socket.on('disconnect', () => console.log('socket disconnected', socket.id));
});

// No IMAP worker needed on startup with Option 2
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

// export app for testing (you can still require app in tests)
module.exports = app;