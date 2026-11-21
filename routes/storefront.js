/**
 * Public client-website API (storefront token). Mounted at /api/v1/storefront.
 *
 * Built for the client-site boilerplate (boilerplate/), but any client website can use it.
 * Bookings live next door at /api/v1/storefront/bookings (routes/publicBooking.js).
 *
 *   GET  /site                 company name, delivery options, WhatsApp link
 *   GET  /categories           catalogue categories
 *   GET  /products             published products (?category=<id>&featured=true&q=<text>)
 *   GET  /products/:idOrSlug   one published product
 *   POST /orders               guest checkout → unpaid order (then POST /payments/payfast/checkout)
 *   GET  /orders/:id           order status for the confirmation page (no address / contact details)
 *
 * Why not /products and /orders? Those are dashboard routes: GET /products returns drafts and
 * cost prices, and POST /orders rejects storefront tokens (dashboard writes need a team sign-in).
 *
 * Response shapes are the Storefront* schemas in config/openapi.js; keep them in step
 * (tests/boilerplateApiContract.test.js checks the boilerplate against them).
 */
const express = require('express');
const Product = require('../models/product');
const { Category } = require('../models/category');
const Customer = require('../models/customer');
const { Order } = require('../models/order');
const { OrderItem } = require('../models/orderItem');
const { wrapRoute } = require('../helpers/failureEmail');
const { storefrontAuth } = require('../helpers/storefrontAuth');
const { findCustomerByEmail } = require('../helpers/customerCart');
const { deductLineStock } = require('../helpers/productInventory');
const { publishedProductFilter } = require('../helpers/productCatalogFields');
const { escapeRegex } = require('../helpers/escapeRegex');
const {
  OBJECT_ID,
  siteInfo,
  storefrontCategory,
  storefrontProduct,
  storefrontOrder,
  createStorefrontOrder,
} = require('../helpers/storefrontCatalog');

const router = express.Router();

function sendError(res, err) {
  if (err && err.expose) {
    return res.status(err.status).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  throw err;
}

router.get('/site', storefrontAuth, wrapRoute(async (req, res) => {
  res.json(siteInfo(req.storefrontClient));
}));

router.get('/categories', storefrontAuth, wrapRoute(async (req, res) => {
  const categories = await Category.find({ clientID: req.clientId }).sort({ name: 1 }).lean();
  res.json({ categories: categories.map(storefrontCategory) });
}));

router.get('/products', storefrontAuth, wrapRoute(async (req, res) => {
  const extra = { clientID: req.clientId };
  const category = String(req.query.category || '');
  if (category) {
    if (!OBJECT_ID.test(category)) return res.status(400).json({ error: 'category must be a category id' });
    extra.category = category;
  }
  if (req.query.featured === 'true') extra.isFeatured = true;
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) extra.productName = { $regex: escapeRegex(q), $options: 'i' };

  const products = await Product.find(publishedProductFilter(extra))
    .populate('category', 'name')
    .sort({ isFeatured: -1, createdAt: -1 })
    .limit(500)
    .lean();
  res.json({ products: products.map(storefrontProduct) });
}));

router.get('/products/:idOrSlug', storefrontAuth, wrapRoute(async (req, res) => {
  const key = String(req.params.idOrSlug || '').slice(0, 200);
  const by = OBJECT_ID.test(key) ? { _id: key } : { slug: key };
  const product = await Product.findOne(publishedProductFilter({ ...by, clientID: req.clientId }))
    .populate('category', 'name')
    .lean();
  if (!product) return res.status(404).json({ error: 'Product not found' });
  res.json({ product: storefrontProduct(product) });
}));

router.post('/orders', storefrontAuth, wrapRoute(async (req, res) => {
  try {
    const { order } = await createStorefrontOrder({
      clientId: req.clientId,
      client: req.storefrontClient,
      body: req.body,
      customerId: req.storefrontCustomerId,
      deps: { Product, Customer, Order, OrderItem, findCustomerByEmail, deductLineStock },
    });
    const populated = await Order.findById(order._id).populate({
      path: 'orderItems',
      populate: { path: 'product', select: 'productName images' },
    });
    res.status(201).json({ order: storefrontOrder(populated) });
  } catch (err) {
    sendError(res, err);
  }
}));

router.get('/orders/:id', storefrontAuth, wrapRoute(async (req, res) => {
  if (!OBJECT_ID.test(String(req.params.id))) return res.status(400).json({ error: 'Invalid order id' });
  const filter = { _id: req.params.id, clientID: req.clientId, deletedAt: null };
  // A signed-in shopper only sees their own orders.
  if (req.storefrontCustomerId) filter.customer = req.storefrontCustomerId;
  const order = await Order.findOne(filter).populate({
    path: 'orderItems',
    populate: { path: 'product', select: 'productName images' },
  });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order: storefrontOrder(order) });
}));

module.exports = router;
