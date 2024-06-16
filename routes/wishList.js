const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/user');
const Client = require('../models/client');
const WishList = require('../models/wishList');

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
        next();
    });
};

// POST route for creating a new wish list
router.post('/', validateToken, async (req, res) => {
    try {
        const { name, items } = req.body;
            const token = req.headers.authorization;
            if (!token || !token.startsWith('Bearer ')) {return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });}
            const tokenValue = token.split(' ')[1];

        jwt.verify(tokenValue, process.env.secret, async (err, user) => {
            if (err) {
              return res.status(403).json({ error: 'Forbidden - Invalid token', err });
            }
        
            const Client = user.clientID;
            const User = user.id;
            if (!Client) {
                return res.status(404).json({ error: 'Client not found' });
            }

            console.log(user);
            const newWishList = new WishList({
                customerID: user.customerID,
                name: name,
                 items: items,
                clientID: user.clientID  // Ensure client is assigned as an ObjectId
            });
    
            const savedWishList = await newWishList.save();
    
            res.status(201).json(savedWishList);

        })


        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET route to retrieve all wish lists for a client
router.get('/', validateToken, async (req, res) => {
    try {
        const clientID = req.clientID;

        const wishLists = await WishList.find({ 'client': clientID });  // Ensure client is searched by _id properly

        res.status(200).json(wishLists);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET route to retrieve a single wish list by ID
router.get('/:id', validateToken, async (req, res) => {
    try {
        const wishList = await WishList.findOne({ _id: req.params.id, 'client': req.clientID });  // Ensure client is searched by _id properly

        if (!wishList) {
            return res.status(404).json({ error: 'Wish list not found' });
        }

        res.status(200).json(wishList);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PUT route to update a wish list by ID
router.put('/:id', validateToken, async (req, res) => {
    try {
        const { name, items } = req.body;

        const updatedWishList = await WishList.findOneAndUpdate(
            { _id: req.params.id, 'client': req.clientID },  // Ensure client is searched by _id properly
            { name: name, items: items },
            { new: true }
        );

        if (!updatedWishList) {
            return res.status(404).json({ error: 'Wish list not found' });
        }

        res.status(200).json(updatedWishList);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// DELETE route to delete a wish list by ID
router.delete('/:id', validateToken, async (req, res) => {
    try {
        const deletedWishList = await WishList.findOneAndDelete({ _id: req.params.id, 'client': req.clientID });  // Ensure client is searched by _id properly

        if (!deletedWishList) {
            return res.status(404).json({ error: 'Wish list not found' });
        }

        res.status(200).json({ message: 'Wish list deleted successfully' });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;
