const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Product = require('../models/product');
const { SalesItem } = require('../models/salesItem');
const { wrapRoute } = require('../helpers/failureEmail'); // ✅ wrapRoute for error emails
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { createDashboardAuth } = require('../helpers/dashboardAuth');
require('dotenv').config();

const validateClient = createDashboardAuth('sales');

// -------------------- ROUTES -------------------- //

// GET all sales items for the client
router.get('/', validateClient, wrapRoute(async (req, res) => {
    const clientId = req.clientId;
    const salesItems = await SalesItem.find({ clientID: clientId }).populate('selectedProductIds');
    res.json(salesItems);
}));

// POST create a new sales item
router.post('/', validateClient, wrapRoute(async (req, res) => {
    const { itemType, selectedProductIds, discountPercentage, startDate, endDate } = req.body;
    const clientId = req.clientId;

    if (!itemType || !selectedProductIds || !discountPercentage || !startDate || !endDate) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const owned = await Product.find({
      _id: { $in: selectedProductIds },
      clientID: clientId,
    }).select('_id');
    if (owned.length !== selectedProductIds.length) {
      return res.status(400).json({ error: 'One or more products do not belong to this store' });
    }

    const salesItem = new SalesItem({
        itemType,
        selectedProductIds: owned.map((p) => p._id),
        discountPercentage,
        startDate,
        endDate,
        clientID: clientId
    });

    await Product.updateMany(
      { _id: { $in: owned.map((p) => p._id) }, clientID: clientId },
      { salePercentage: discountPercentage }
    );

    await salesItem.save();
    res.status(201).json(salesItem);
}));

// DELETE a sales item by ID
router.delete('/:id', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    const clientId = req.clientId;

    const salesItem = await SalesItem.findOneAndDelete({ _id: id, clientID: clientId });
    if (!salesItem) return res.status(404).json({ error: 'Sales item not found or unauthorized' });

    await Product.updateMany(
      { _id: { $in: salesItem.selectedProductIds }, clientID: clientId },
      { salePercentage: 0 }
    );

    res.json({ message: 'Sales item deleted successfully' });
}));

module.exports = router;
