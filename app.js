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
.then(() => console.log('DB Connected!'))
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

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));

module.exports = app;
