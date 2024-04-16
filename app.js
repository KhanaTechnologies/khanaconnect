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
require('dotenv/config');
const authJwt = require('./helpers/jwt');
const errorHandler = require('./helpers/error-handler');


app.use(cors());
app.options('*',cors());



//Routers
var customerRoutes = require('./routes/customer');
var clientRoutes = require('./routes/client');
var productRoutes = require('./routes/product');
var indexRouter = require('./routes/index');
var sizeRoutes = require('./routes/sizes');
var orderRoutes = require('./routes/orders');
var categoriesRouter = require('./routes/categories');
//Middleware
app.use(express.json());
app.use(morgan('tiny'));
app.use('/api/v1', authJwt());
app.use(authJwt());
app.use("/public/uploads", express.static(__dirname + "/public/uploads"));
app.use(errorHandler);
//----
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
//app.use(express.static(path.join(__dirname, 'public')));

// adding whats app



app.use('/', indexRouter);




app.use(cors());
app.options('*',cors());


 const api = process.env.API_URL;


 app.use(`${api}/categories`, categoriesRouter);
 app.use(`${api}/email`, emailRouter);
 app.use(`${api}/orders`, orderRoutes);
 app.use(`${api}/products`, productRoutes);
 app.use(`${api}/customer`, customerRoutes);
 app.use(`${api}/client`, clientRoutes);
 app.use(`${api}/size`, sizeRoutes);
mongoose.connect(process.env.CONNECTION_STRING,{ useNewUrlParser: true,useUnifiedTopology: true, dbName: 'KhanaConnect_ProdDB'} )
.then(()=>{
    console.log('Database Connection is ready...')
})
.catch((err)=>{
    console.log(err);
})

const PORT = process.env.PORT || 3000;
//Server
app.listen(PORT, ()=>{
    console.log('server is running http://localhost:3000');
})
