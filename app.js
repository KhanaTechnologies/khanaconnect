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


// Security & Performance Middleware
app.use(helmet());
app.use(cors());
app.options('*', cors());
app.use(compression());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.disable('x-powered-by');
app.set('trust proxy', 1); // or 'trust proxy', true


// Request Parsing
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(logger('dev'));
app.use(morgan('tiny'));

// Static Files
app.use("/public/uploads", express.static(__dirname + "/public/uploads"));

// JWT Auth (only for /api/v1)
app.use('/api/v1', authJwt());


//Routers
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


 const api = process.env.API_URL;

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
.catch(err => console.log('DB Connection Error:', err));


  // Uncaught Error Handling
process.on('uncaughtException', (err) => console.error('💥 UNCAUGHT ERROR:', err));
process.on('unhandledRejection', (err) => console.error('💥 UNHANDLED REJECTION:', err));


// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));