const { Order } = require('../models/order');
const express = require('express');
const { OrderItem } = require('../models/orderItem');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { Customer } = require('../models/customer');
const DiscountCode = require('../models/discountCode');
const mongoose = require('mongoose');
const Product = require('../models/product');
const { Size } = require('../models/size');
const { body, validationResult } = require('express-validator');

// Middleware to authenticate JWT token and extract clientId
const authenticateToken = (req, res, next) => {
    const token = req.headers.authorization;

    if (!token || !token.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
    }

    const tokenValue = token.split(' ')[1];

    jwt.verify(tokenValue, process.env.secret, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Forbidden - Invalid token' });
        }
        req.clientId = user.clientID; // Attach clientId to the request object
        next();
    });
};



// Verify if a discount code applies
router.post('/verify-discount-code', authenticateToken, async (req, res) => {
    const { discountCode, cartProductIds } = req.body;

    if (!discountCode || !Array.isArray(cartProductIds)) {
        return res.status(400).json({ error: 'Invalid input' });
    }

    if (cartProductIds.length === 0) {
        return res.status(400).json({ error: 'Cart is empty' });
    }

    try {
        // Ensure clientId is available
        if (!req.clientId) {
            return res.status(400).json({ error: 'Client ID not provided or invalid' });
        }

        // Find the discount code
        const discount = await DiscountCode.findOne({ code: discountCode, clientID: req.clientId });

        if (!discount) {
            return res.status(404).json({ error: 'Discount code not found or not applicable to this client' });
        }


        if (discount.usageCount >= discount.usageLimit){
            return res.status(404).json({ error: 'Discount code has been over used' });
        }

        let eligibleProducts = [];
        let totalDiscount = 0;

        // Loop through cart products and check eligibility
        for (const productId of cartProductIds) {
            const product = await Product.findById(productId);
            if (product && discount.appliesTo.some(id => id.toString() === product._id.toString())) {
                eligibleProducts.push(product);
                totalDiscount += (product.price * discount.discount) / 100;
            }
        }

        // If no eligible products, return an error
        if (eligibleProducts.length === 0) {
            return res.status(400).json({ error: 'No eligible products for this discount code' });
        }

        // Check if the discount can still be applied based on its usage limit
        if (discount.usageLimit !== undefined && discount.usageLimit <= 0) {
            return res.status(400).json({ error: 'Discount code usage limit reached' });
        }

        res.json({ success: true, discountPercentage: discount.discount, totalDiscount,eligibleProducts});
    } catch (error) {
        console.error('Error verifying discount code:', error);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
    }
});





// POST endpoint to create a new checkout code
router.post('/createCheckoutCode', authenticateToken, async (req, res) => {
    console.log('Request body:', req.body);  // Log the request body to ensure the data is coming in correctly
    const { code, discount, type = 'all', appliesTo, isActive = true } = req.body;

    // Generate a unique ID for the checkout code (e.g., 'code1', 'code2', etc.)
    const id = `code${Math.floor(Math.random() * 10000)}`;
    console.log('Generated ID:', id);

    // Convert usageLimit to a number
    const usageLimit = Number(req.body.usageLimit);
    console.log('Usage Limit:', usageLimit);

    // Check for the appliesToModel field and set it (default to 'Product' or 'Service' based on appliesTo type)
    const appliesToModel = req.body.appliesToModel || (Array.isArray(appliesTo) ? 'Product' : 'Service');

    try {
        // Create new CheckoutCode instance
        const newCheckoutCode = new DiscountCode({
            id: id,  // Use the generated id here
            code: req.body.code,
            usageLimit: usageLimit,
            discount: req.body.discount,
            type: req.body.type,
            appliesTo: appliesTo,
            appliesToModel: appliesToModel, // Ensure this is included
            clientID: req.clientId,
            isActive: isActive // Adding isActive field if needed
        });

        console.log('New Checkout Code:', newCheckoutCode);  // This should print the object with all the properties

        // Save the new checkout code
        await newCheckoutCode.save();
        res.status(201).json({
            message: 'Checkout code created successfully!',
            checkoutCode: newCheckoutCode,
        });
    } catch (err) {
        console.error('Error saving checkout code:', err); // Log any errors
        res.status(400).json({ error: 'Failed to create checkout code', details: err.message });
    }
});




// Get all checkout codes for the authenticated client
// Example route for fetching checkout codes (assuming you're querying DiscountCode model)
router.get('/checkout-codes', authenticateToken, async (req, res) => {
    try {
        // Assuming clientId is part of the authenticated user
        const clientId = req.clientId;

        // Validate clientId if needed
        if (!clientId) {
            return res.status(400).json({ error: 'Client ID is required' }
            );
        }

        // Query DiscountCode model (or the correct model)
        const checkoutCodes = await DiscountCode.find({ clientID: clientId }
        );

        if (!checkoutCodes || checkoutCodes.length === 0) {
            return res.status(404).json({ error: 'No checkout codes found' });
        }

        res.json(checkoutCodes);
    } catch (error) {
        console.error('Error fetching checkout codes:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});





// Update a checkout code by ID
router.put('/checkout-codes/:id', authenticateToken, async (req, res) => {
    try {
        // Update the checkout code with the provided data
        const updatedCheckoutCode = await DiscountCode.findOneAndUpdate(
            { _id: req.params.id, clientID: req.clientId }, // Ensure the client is the owner of the checkout code
            { isActive: req.body.isActive}, // Fields to update
            { new: true } // Return the updated document
        );

        console.log(updatedCheckoutCode);

        if (!updatedCheckoutCode) {
            return res.status(404).json({ error: 'Checkout code not found or does not belong to the client' });
        }

        res.json(updatedCheckoutCode);
    } catch (error) {
        console.error('Error updating checkout code:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// Delete a checkout code by ID
router.delete('/checkout-codes/:id', authenticateToken, async (req, res) => {
    try {
        const deletedCheckoutCode = await DiscountCode.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });

        if (!deletedCheckoutCode) {
            return res.status(404).json({ error: 'Checkout code not found or does not belong to client' });
        }

        res.json({ success: true, message: 'Checkout code deleted successfully' });
    } catch (error) {
        console.error('Error deleting checkout code:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});



module.exports = router;