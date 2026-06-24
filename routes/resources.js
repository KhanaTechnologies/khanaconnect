//routes/resources.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Resource = require('../models/resource');
const { wrapRoute } = require('../helpers/failureEmail');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { createDashboardAuth } = require('../helpers/dashboardAuth');

const validateClient = createDashboardAuth('bookings');

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