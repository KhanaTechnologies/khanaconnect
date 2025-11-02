const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Product = require('../models/product');
const { SalesItem } = require('../models/salesItem');
const { wrapRoute } = require('../helpers/failureEmail'); // ✅ wrapRoute for error emails
require('dotenv').config();

// Middleware for client validation
const validateClient = (req, res, next) => {
    try {
        const token = req.headers.authorization;
        if (!token || !token.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
        }
        const tokenValue = token.split(' ')[1];
        jwt.verify(tokenValue, process.env.secret, (err, user) => {
            if (err || !user.clientID) {
                return res.status(403).json({ error: 'Forbidden - Invalid token' });
            }
            req.clientId = user.clientID;
            next();
        });
    } catch (error) {
        console.error('Error in client validation:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

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

    const salesItem = new SalesItem({
        itemType,
        selectedProductIds,
        discountPercentage,
        startDate,
        endDate,
        clientID: clientId
    });

    // Update salePercentage of selected products
    await Promise.all(selectedProductIds.map(async (productId) => {
        const product = await Product.findById(productId);
        if (product) {
            await Product.findByIdAndUpdate(productId, { salePercentage: discountPercentage }, { new: true });
        }
    }));

    await salesItem.save();
    res.status(201).json(salesItem);
}));

// DELETE a sales item by ID
router.delete('/:id', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    const clientId = req.clientId;

    const salesItem = await SalesItem.findOneAndDelete({ _id: id, clientID: clientId });
    if (!salesItem) return res.status(404).json({ error: 'Sales item not found or unauthorized' });

    // Reset salePercentage for affected products
    await Promise.all(salesItem.selectedProductIds.map(async (productId) => {
        const product = await Product.findById(productId);
        if (product) {
            await Product.findByIdAndUpdate(productId, { salePercentage: 0 }, { new: true });
        }
    }));

    res.json({ message: 'Sales item deleted successfully' });
}));

module.exports = router;
