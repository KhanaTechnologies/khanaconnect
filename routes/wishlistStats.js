const express = require('express');
const jwt = require('jsonwebtoken');
const WishList = require('../models/wishList');
const { wrapRoute } = require('../helpers/failureEmail');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');

const router = express.Router();

/** Dashboard client JWT (`clientID` claim), same secret as other client routes. */
function requireClientAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - Bearer token required' });
  }
  const token = auth.split(' ')[1];
  try {
    const { decoded } = verifyJwtWithAnySecret(jwt, token);
    if (!decoded || !decoded.clientID) {
      return res.status(403).json({ error: 'Forbidden - client token required' });
    }
    req.clientID = String(decoded.clientID);
    next();
  } catch (e) {
    return res.status(403).json({ error: 'Invalid or expired token', details: e.message });
  }
}

/**
 * GET /
 * Aggregated wishlist popularity for the tenant: product + optional variant,
 * ranked by how often lines appear across all customers' lists.
 * No customer identifiers are returned.
 */
router.get('/', requireClientAuth, wrapRoute(async (req, res) => {
  const clientID = req.clientID;
  const order = String(req.query.order || 'desc').toLowerCase() === 'asc' ? 1 : -1;
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));
  const minSaves = Math.max(0, parseInt(String(req.query.minSaves || '1'), 10) || 1);

  const [summaryRow] = await WishList.aggregate([
    { $match: { clientID } },
    { $unwind: '$items' },
    {
      $group: {
        _id: null,
        totalWishlistLines: { $sum: 1 },
        customers: { $addToSet: '$customerID' },
      },
    },
    {
      $project: {
        _id: 0,
        totalWishlistLines: 1,
        customersWithWishlistActivity: { $size: '$customers' },
      },
    },
  ]);

  const ranked = await WishList.aggregate([
    { $match: { clientID } },
    { $unwind: '$items' },
    {
      $group: {
        _id: {
          product: '$items.product',
          variantName: { $ifNull: ['$items.variantName', ''] },
          variantValue: { $ifNull: ['$items.variantValue', ''] },
        },
        saveCount: { $sum: 1 },
        totalQuantitySaved: { $sum: { $ifNull: ['$items.quantity', 1] } },
        customers: { $addToSet: '$customerID' },
      },
    },
    { $match: { saveCount: { $gte: minSaves } } },
    {
      $project: {
        _id: 0,
        productId: '$_id.product',
        variantName: '$_id.variantName',
        variantValue: '$_id.variantValue',
        saveCount: 1,
        totalQuantitySaved: 1,
        customerCount: { $size: '$customers' },
      },
    },
    { $sort: { saveCount: order, productId: 1 } },
    { $limit: limit },
    {
      $lookup: {
        from: 'products',
        let: { pid: '$productId', cid: clientID },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [{ $eq: ['$_id', '$$pid'] }, { $eq: ['$clientID', '$$cid'] }],
              },
            },
          },
          {
            $project: {
              productName: 1,
              price: 1,
              salePercentage: 1,
              countInStock: 1,
              images: { $slice: ['$images', 1] },
            },
          },
        ],
        as: 'productArr',
      },
    },
    {
      $addFields: {
        product: { $arrayElemAt: ['$productArr', 0] },
      },
    },
    { $project: { productArr: 0 } },
  ]);

  const items = ranked.map((row, i) => ({
    rank: i + 1,
    productId: row.productId,
    variantName: row.variantName || '',
    variantValue: row.variantValue || '',
    saveCount: row.saveCount,
    totalQuantitySaved: row.totalQuantitySaved,
    customerCount: row.customerCount,
    product: row.product || null,
  }));

  res.json({
    success: true,
    summary: {
      totalWishlistLines: summaryRow?.totalWishlistLines || 0,
      customersWithWishlistActivity: summaryRow?.customersWithWishlistActivity || 0,
      rankedRowsReturned: items.length,
    },
    items,
  });
}));

module.exports = router;
