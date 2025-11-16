const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Resource = require('../models/resource');
const { wrapRoute } = require('../helpers/failureEmail');

// Middleware to authenticate JWT and attach clientId
const validateClient = (req, res, next) => {
    const token = req.headers.authorization;
    if (!token || !token.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });

    const tokenValue = token.split(' ')[1];
    jwt.verify(tokenValue, process.env.secret, (err, user) => {
        if (err || !user.clientID) return res.status(403).json({ error: 'Forbidden - Invalid token' });
        req.clientId = user.clientID;
        next();
    });
};

// GET: Get all resources for client
router.get('/', validateClient, wrapRoute(async (req, res) => {
    const resources = await Resource.find({ clientID: req.clientId }).sort({ name: 1 });
    res.json(resources);
}));

// POST: Create a new resource
router.post('/', validateClient, wrapRoute(async (req, res) => {
    const { name, type, description, capacity, features, location, color, duration } = req.body;

    const resource = new Resource({
        name,
        type,
        description,
        capacity,
        features,
        location,
        color,
        duration,
        clientID: req.clientId
    });

    await resource.save();
    res.status(201).json(resource);
}));

// PUT: Update a resource
router.put('/:id', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid resource ID format' });
    }

    const resource = await Resource.findOne({ _id: id, clientID: req.clientId });
    if (!resource) {
        return res.status(404).json({ error: 'Resource not found or unauthorized' });
    }

    const updatableFields = ['name', 'type', 'description', 'capacity', 'features', 'location', 'color', 'duration', 'isActive'];
    updatableFields.forEach(field => {
        if (req.body[field] !== undefined) {
            resource[field] = req.body[field];
        }
    });

    await resource.save();
    res.json(resource);
}));

// DELETE: Delete a resource
router.delete('/:id', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid resource ID format' });
    }

    const resource = await Resource.findOneAndDelete({ _id: id, clientID: req.clientId });
    if (!resource) {
        return res.status(404).json({ error: 'Resource not found or unauthorized' });
    }

    res.json({ message: 'Resource deleted successfully' });
}));

module.exports = router;