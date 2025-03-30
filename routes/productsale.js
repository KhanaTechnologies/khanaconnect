const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Product = require('../models/product');
const { Category } = require('../models/category');
const multer = require('multer');
const { Octokit } = require("@octokit/rest");
const { body, validationResult } = require('express-validator');
const { SalesItem } = require('../models/salesItem')
require('dotenv').config();



// Middleware for client validation
const validateClient = async (req, res, next) => {

    try {
        const token = req.headers.authorization;
        if (!token || !token.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
        }
        const tokenValue = token.split(' ')[1];
        jwt.verify(tokenValue, process.env.secret, async (err, user) => {
            if (err) {
                return res.status(403).json({ error: 'Forbidden - Invalid token', err });
            }
            if (!user.clientID) {
                return res.status(403).json({ error: 'Forbidden - Invalid token payload' });
            }
            req.clientId = user.clientID; // Attach client ID to request object
            console.log(req.clientId);
            next();
        });
    } catch (error) {
        console.error('Error in client validation:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};


// DELETE: Delete a sales item by ID
router.delete('/:id', validateClient, async (req, res) => {
    try {
        const { id } = req.params;
        const { clientId } = req;

        const salesItem = await SalesItem.findOneAndDelete({ _id: id, clientID: clientId });

        if (!salesItem) {
            return res.status(404).json({ error: 'Sales item not found or unauthorized' });
        }

        // Reset salePercentage for the affected products
        await Promise.all(salesItem.selectedProductIds.map(async (productId) => {
            const product = await Product.findById(productId);

            if (product) {
                // Reset the sale percentage to 0 (or whatever default value you prefer)
                const updatedProduct = await Product.findByIdAndUpdate(
                    productId,
                    { salePercentage: 0 },
                    { new: true }
                );
                console.log(`Sale percentage reset for product: ${updatedProduct.productName}`);
            }
        }));

        res.json({ message: 'Sales item deleted successfully' });
    } catch (error) {
        console.error('Error deleting sales item:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// GET: Get all sales items for a specific client
router.get('/', validateClient, async (req, res) => {
    try {
        const clientId = req.clientId; // Ensure it's a string
        console.log(req.clientId);

        const salesItems = await SalesItem.find({ clientID: clientId })
        .populate('selectedProductIds')
        res.json(salesItems);
    } catch (error) {
        console.error('Error fetching sales items:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// POST: Create a new sales item
router.post('/', validateClient, async (req, res) => {
    console.log(req.body);
    try {
        const { itemType, selectedProductIds, discountPercentage, startDate, endDate } = req.body;
        const  clientId = req.clientId;

        // Validate inputs
        if (!itemType || !selectedProductIds || !discountPercentage || !startDate || !endDate) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        console.log(clientId);
        const salesItem = new SalesItem({
            itemType,
            selectedProductIds,
            discountPercentage,
            startDate,
            endDate,
            clientID: clientId
        });
        console.log(salesItem);
        // Update salePercentage of the selected products
        await Promise.all(selectedProductIds.map(async (productId) => {
            const product = await Product.findById(productId);

            if (product) {
                const updatedProduct = await Product.findByIdAndUpdate(
                    productId,
                    { salePercentage: discountPercentage },
                    { new: true } // Return the updated product
                );
                console.log(`Sale percentage updated for product: ${updatedProduct.productName}`);
            }
        }));

        await salesItem.save();
        res.status(201).json(salesItem);
    } catch (error) {
        console.error('Error creating sales item:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


module.exports = router;