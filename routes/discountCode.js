const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Order } = require('../models/order');
const { OrderItem } = require('../models/orderItem');
const { Customer } = require('../models/customer');
const DiscountCode = require('../models/discountCode');
const Product = require('../models/product');

// Middleware to authenticate JWT token and extract clientId
const authenticateToken = (req, res, next) => {
  const token = req.headers.authorization;
  if (!token || !token.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });

  const tokenValue = token.split(' ')[1];
  jwt.verify(tokenValue, process.env.secret, (err, user) => {
    if (err) return res.status(403).json({ error: 'Forbidden - Invalid token' });
    req.clientId = user.clientID;
    next();
  });
};

// --------------------
// VERIFY DISCOUNT CODE
// --------------------
router.post('/verify-discount-code', authenticateToken, async (req, res) => {
  const { discountCode, cartProductIds } = req.body;
  if (!discountCode || !Array.isArray(cartProductIds) || cartProductIds.length === 0) {
    return res.status(400).json({ error: 'Invalid discount code or cart is empty' });
  }

  try {
    const discount = await DiscountCode.findOne({ code: discountCode, clientID: req.clientId });
    if (!discount) return res.status(404).json({ error: 'Discount code not found for this client' });
    if (discount.usageCount >= discount.usageLimit) return res.status(400).json({ error: 'Discount code usage limit reached' });

    const eligibleProducts = [];
    let totalDiscount = 0;

    for (const productId of cartProductIds) {
      const product = await Product.findById(productId);
      if (product && discount.appliesTo.some(id => id.toString() === product._id.toString())) {
        eligibleProducts.push(product);
        totalDiscount += (product.price * discount.discount) / 100;
      }
    }

    if (eligibleProducts.length === 0) {
      return res.status(400).json({ error: 'No eligible products for this discount code' });
    }

    res.json({ success: true, discountPercentage: discount.discount, totalDiscount, eligibleProducts });
  } catch (error) {
    console.error('Error verifying discount code:', error);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// --------------------
// CREATE CHECKOUT CODE
// --------------------
router.post('/createCheckoutCode', authenticateToken, async (req, res) => {
  try {
    const { code, discount, type = 'all', appliesTo = [], usageLimit = 1, isActive = true, appliesToModel } = req.body;

    const newCheckoutCode = new DiscountCode({
      id: `code${Math.floor(Math.random() * 10000)}`,
      code,
      discount,
      type,
      appliesTo,
      appliesToModel: appliesToModel || (appliesTo.length > 0 ? 'Product' : 'Service'),
      usageLimit: Number(usageLimit),
      clientID: req.clientId,
      isActive
    });

    await newCheckoutCode.save();
    res.status(201).json({ message: 'Checkout code created successfully!', checkoutCode: newCheckoutCode });
  } catch (err) {
    console.error('Error creating checkout code:', err);
    res.status(400).json({ error: 'Failed to create checkout code', details: err.message });
  }
});

// --------------------
// GET ALL CHECKOUT CODES
// --------------------
router.get('/checkout-codes', authenticateToken, async (req, res) => {
  try {
    const codes = await DiscountCode.find({ clientID: req.clientId });
    if (!codes.length) return res.status(404).json({ error: 'No checkout codes found' });
    res.json(codes);
  } catch (err) {
    console.error('Error fetching checkout codes:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------
// UPDATE CHECKOUT CODE
// --------------------
router.put('/checkout-codes/:id', authenticateToken, async (req, res) => {
  try {
    const updated = await DiscountCode.findOneAndUpdate(
      { _id: req.params.id, clientID: req.clientId },
      { isActive: req.body.isActive },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: 'Checkout code not found or does not belong to the client' });
    res.json(updated);
  } catch (err) {
    console.error('Error updating checkout code:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------
// DELETE CHECKOUT CODE
// --------------------
router.delete('/checkout-codes/:id', authenticateToken, async (req, res) => {
  try {
    const deleted = await DiscountCode.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });
    if (!deleted) return res.status(404).json({ error: 'Checkout code not found or does not belong to client' });
    res.json({ success: true, message: 'Checkout code deleted successfully' });
  } catch (err) {
    console.error('Error deleting checkout code:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
