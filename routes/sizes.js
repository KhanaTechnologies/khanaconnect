const { Size } = require('../models/size');
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { wrapRoute } = require('../helpers/failureEmail'); // ✅ Wrap async routes to send email on error

// Middleware to validate token and extract clientID
const validateTokenAndExtractClientID = (req, res, next) => {
    const token = req.headers.authorization;
    if (!token || !token.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
    }
    const tokenValue = token.split(' ')[1];
    jwt.verify(tokenValue, process.env.secret, (err, decoded) => {
        if (err || !decoded.clientID) {
            return res.status(403).json({ error: 'Forbidden - Invalid token' });
        }
        req.clientId = decoded.clientID; // standardized name
        next();
    });
};

// GET all sizes
router.get('/', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
    const sizeList = await Size.find({ clientID: req.clientId });
    res.status(200).json(sizeList);
}));

// GET a specific size by ID
router.get('/:id', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
    const size = await Size.findOne({ _id: req.params.id, clientID: req.clientId });
    if (!size) return res.status(404).json({ error: 'Size not found' });
    res.status(200).json(size);
}));

// CREATE a new size
router.post('/', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
    let size = new Size({
        name: req.body.name,
        description: req.body.description,
        clientID: req.clientId,
    });
    size = await size.save();
    res.status(201).json(size);
}));

// UPDATE a size
router.put('/:id', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
    const size = await Size.findOneAndUpdate(
        { _id: req.params.id, clientID: req.clientId },
        { name: req.body.name, description: req.body.description },
        { new: true }
    );
    if (!size) return res.status(404).json({ error: 'Size could not be updated' });
    res.json(size);
}));

// DELETE a size
router.delete('/:id', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
    const size = await Size.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });
    if (!size) return res.status(404).json({ error: 'Size not found' });
    res.status(200).json({ message: 'Size deleted successfully' });
}));

module.exports = router;
