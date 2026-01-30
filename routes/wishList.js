const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const WishList = require('../models/wishList');
const { wrapRoute } = require('../helpers/failureEmail'); // ✅ Import wrapRoute

// Middleware to validate token and extract clientID
const validateToken = (req, res, next) => {
    const token = req.headers.authorization;

    if (!token || !token.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
    }

    const tokenValue = token.split(' ')[1];
    jwt.verify(tokenValue, process.env.secret, (err, decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Forbidden - Invalid token', err });
        }
        req.clientID = decoded.clientID;  // Extract client ID from token
        req.customerID = decoded.customerID; // If available
        next();
    });
};

// POST route for creating a new wish list
router.post('/', validateToken, wrapRoute(async (req, res) => {
    const { name, items } = req.body;

    const newWishList = new WishList({
        customerID: req.customerID || null,
        name,
        items,
        clientID: req.clientID
    });

    const savedWishList = await newWishList.save();
    res.status(201).json(savedWishList);
}));

// GET all wish lists for a client
router.get('/', validateToken, wrapRoute(async (req, res) => {
    const wishLists = await WishList.find({ clientID: req.clientID });
    res.status(200).json(wishLists);
}));

// GET a single wish list by ID
router.get('/:id', validateToken, wrapRoute(async (req, res) => {
    const wishList = await WishList.findOne({ _id: req.params.id, clientID: req.clientID });

    if (!wishList) {
        return res.status(404).json({ error: 'Wish list not found' });
    }

    res.status(200).json(wishList);
}));

// PUT route to update a wish list by ID
router.put('/:id', validateToken, wrapRoute(async (req, res) => {
    const { name, items } = req.body;

    const updatedWishList = await WishList.findOneAndUpdate(
        { _id: req.params.id, clientID: req.clientID },
        { name, items },
        { new: true }
    );

    if (!updatedWishList) {
        return res.status(404).json({ error: 'Wish list not found' });
    }

    res.status(200).json(updatedWishList);
}));

// DELETE route to delete a wish list by ID
router.delete('/:id', validateToken, wrapRoute(async (req, res) => {
    const deletedWishList = await WishList.findOneAndDelete({ _id: req.params.id, clientID: req.clientID });

    if (!deletedWishList) {
        return res.status(404).json({ error: 'Wish list not found' });
    }

    res.status(200).json({ message: 'Wish list deleted successfully' });
}));

module.exports = router;
