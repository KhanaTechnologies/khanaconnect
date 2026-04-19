const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const jwt = require('jsonwebtoken');
const WishList = require('../models/wishList');
const Product = require('../models/product');
const { wrapRoute } = require('../helpers/failureEmail');
const wishlistNotifyService = require('../services/wishlistNotifyService');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');


/** Storefront customer token must include `customerID` and `clientID` (see POST /customer/login). */
function requireCustomerAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - Bearer token required' });
  }
  const token = auth.split(' ')[1];
  try {
    const { decoded } = verifyJwtWithAnySecret(jwt, token);
    if (!decoded.clientID || !decoded.customerID) {
      return res.status(403).json({
        error: 'Wish lists require a customer session. Use POST /customer/login, then call with that JWT.',
      });
    }
    req.clientID = String(decoded.clientID);
    req.customerID = String(decoded.customerID);
    next();
  } catch (e) {
    return res.status(403).json({ error: 'Invalid or expired token', details: e.message });
  }
}

function badId(res) {
  return res.status(400).json({ error: 'Invalid id' });
}

function parseBool(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  }
  return Boolean(value);
}

/** Create a new list group */
router.post('/', requireCustomerAuth, wrapRoute(async (req, res) => {
  const { name, description = '', sortOrder = 0 } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const doc = await WishList.create({
    clientID: req.clientID,
    customerID: req.customerID,
    name: name.trim(),
    description: String(description || '').trim(),
    sortOrder: Number(sortOrder) || 0,
    items: [],
  });
  res.status(201).json(doc);
}));

/** All lists for this customer */
router.get('/', requireCustomerAuth, wrapRoute(async (req, res) => {
  const q = { clientID: req.clientID, customerID: req.customerID };
  const count = await WishList.countDocuments(q);
  if (count === 0) {
    try {
      await WishList.create({
        ...q,
        name: 'My wish list',
        description: 'Your default list',
        sortOrder: 0,
        items: [],
      });
    } catch (e) {
      if (e && e.code !== 11000) throw e;
    }
  }
  const lists = await WishList.find(q).sort({ sortOrder: 1, name: 1 }).lean();
  res.json({
    success: true,
    lists,
    count: lists.length,
  });
}));

/** One list with product details */
router.get('/:listId', requireCustomerAuth, wrapRoute(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.listId)) return badId(res);

  const list = await WishList.findOne({
    _id: req.params.listId,
    clientID: req.clientID,
    customerID: req.customerID,
  }).populate({
    path: 'items.product',
    select: 'productName price salePercentage countInStock images variants clientID',
  });

  if (!list) return res.status(404).json({ error: 'Wish list not found' });
  res.json({ success: true, list });
}));

/** Rename / describe a list */
router.put('/:listId', requireCustomerAuth, wrapRoute(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.listId)) return badId(res);

  const { name, description, sortOrder } = req.body;
  const update = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name must be a non-empty string when provided' });
    }
    update.name = name.trim();
  }
  if (description !== undefined) update.description = String(description).trim();
  if (sortOrder !== undefined) update.sortOrder = Number(sortOrder) || 0;

  const list = await WishList.findOneAndUpdate(
    { _id: req.params.listId, clientID: req.clientID, customerID: req.customerID },
    { $set: update },
    { new: true }
  );

  if (!list) return res.status(404).json({ error: 'Wish list not found' });
  res.json({ success: true, list });
}));

router.delete('/:listId', requireCustomerAuth, wrapRoute(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.listId)) return badId(res);

  const deleted = await WishList.findOneAndDelete({
    _id: req.params.listId,
    clientID: req.clientID,
    customerID: req.customerID,
  });

  if (!deleted) return res.status(404).json({ error: 'Wish list not found' });
  res.json({ success: true, message: 'Wish list deleted' });
}));

/** Add a product line to a list (Takealot-style saved item + optional alerts) */
router.post('/:listId/items', requireCustomerAuth, wrapRoute(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.listId)) return badId(res);

  const {
    productId,
    quantity = 1,
    variantName = '',
    variantValue = '',
    notifyOnSale,
    notifyOnRestock,
    notes = '',
  } = req.body;

  if (!productId || !mongoose.Types.ObjectId.isValid(String(productId))) {
    return res.status(400).json({ error: 'productId is required (Mongo ObjectId)' });
  }

  const product = await Product.findOne({
    _id: productId,
    clientID: req.clientID,
  });
  if (!product) return res.status(404).json({ error: 'Product not found for this store' });

  const vn = String(variantName || '').trim();
  const vv = String(variantValue || '').trim();
  if (vn || vv) {
    const line = wishlistNotifyService.resolveLine(product, vn, vv);
    if (!line) {
      return res.status(400).json({ error: 'Variant not found on this product' });
    }
  }

  const list = await WishList.findOne({
    _id: req.params.listId,
    clientID: req.clientID,
    customerID: req.customerID,
  });
  if (!list) return res.status(404).json({ error: 'Wish list not found' });

  const dup = list.items.find(
    (i) =>
      String(i.product) === String(productId) &&
      String(i.variantName || '') === vn &&
      String(i.variantValue || '') === vv
  );
  if (dup) {
    dup.quantity = Math.max(1, Number(quantity) || 1);
    dup.notifyOnSale = parseBool(notifyOnSale, true);
    dup.notifyOnRestock = parseBool(notifyOnRestock, true);
    if (notes !== undefined) dup.notes = String(notes);
    const snap = wishlistNotifyService.snapshotFromProduct(product, dup);
    if (snap) {
      dup.lastKnownEffectivePrice = snap.lastKnownEffectivePrice;
      dup.lastKnownSalePercent = snap.lastKnownSalePercent;
      dup.lastKnownStock = snap.lastKnownStock;
    }
    await list.save();
    await list.populate({
      path: 'items.product',
      select: 'productName price salePercentage countInStock images variants clientID',
    });
    return res.status(200).json({ success: true, list, updated: true });
  }

  list.items.push({
    product: productId,
    quantity: Math.max(1, Number(quantity) || 1),
    variantName: vn,
    variantValue: vv,
    notifyOnSale: parseBool(notifyOnSale, true),
    notifyOnRestock: parseBool(notifyOnRestock, true),
    notes: String(notes || ''),
  });

  const newItem = list.items[list.items.length - 1];
  const snap = wishlistNotifyService.snapshotFromProduct(product, newItem);
  if (snap) {
    newItem.lastKnownEffectivePrice = snap.lastKnownEffectivePrice;
    newItem.lastKnownSalePercent = snap.lastKnownSalePercent;
    newItem.lastKnownStock = snap.lastKnownStock;
  }

  await list.save();
  await list.populate({
    path: 'items.product',
    select: 'productName price salePercentage countInStock images variants clientID',
  });
  res.status(201).json({ success: true, list });
}));

/** Update quantity, notes, or notification toggles */
router.patch('/:listId/items/:itemId', requireCustomerAuth, wrapRoute(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.listId) || !mongoose.Types.ObjectId.isValid(req.params.itemId)) {
    return badId(res);
  }

  const list = await WishList.findOne({
    _id: req.params.listId,
    clientID: req.clientID,
    customerID: req.customerID,
  });
  if (!list) return res.status(404).json({ error: 'Wish list not found' });

  const item = list.items.id(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const { quantity, notes, notifyOnSale, notifyOnRestock } = req.body;
  if (quantity !== undefined) item.quantity = Math.max(1, Number(quantity) || 1);
  if (notes !== undefined) item.notes = String(notes);
  if (notifyOnSale !== undefined) item.notifyOnSale = parseBool(notifyOnSale, true);
  if (notifyOnRestock !== undefined) item.notifyOnRestock = parseBool(notifyOnRestock, true);

  const product = await Product.findById(item.product);
  if (product) {
    const snap = wishlistNotifyService.snapshotFromProduct(product, item);
    if (snap) {
      item.lastKnownEffectivePrice = snap.lastKnownEffectivePrice;
      item.lastKnownSalePercent = snap.lastKnownSalePercent;
      item.lastKnownStock = snap.lastKnownStock;
    }
  }

  await list.save();
  await list.populate({
    path: 'items.product',
    select: 'productName price salePercentage countInStock images variants clientID',
  });
  res.json({ success: true, list });
}));

router.delete('/:listId/items/:itemId', requireCustomerAuth, wrapRoute(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.listId) || !mongoose.Types.ObjectId.isValid(req.params.itemId)) {
    return badId(res);
  }

  const list = await WishList.findOne({
    _id: req.params.listId,
    clientID: req.clientID,
    customerID: req.customerID,
  });
  if (!list) return res.status(404).json({ error: 'Wish list not found' });

  const item = list.items.id(req.params.itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  list.items.pull(item._id);
  await list.save();
  res.json({ success: true, message: 'Item removed' });
}));

module.exports = router;
