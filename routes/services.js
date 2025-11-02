const express = require('express');
const jwt = require('jsonwebtoken');
const Service = require('../models/service');
const { wrapRoute } = require('../helpers/failureEmail'); // ✅ Import wrapRoute
const router = express.Router();

// Middleware for client validation
const validateClient = async (req, res, next) => {
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
            req.clientId = user.clientID; // Attach client ID to request object
            next();
        });
    } catch (error) {
        console.error('Error in client validation:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

// -------------------- ROUTES -------------------- //

// CREATE SERVICE
router.post('/', validateClient, wrapRoute(async (req, res) => {
    const clientID = req.clientId;
    const newService = new Service({ 
        name: req.body.name,
        description: req.body.description,
        price: req.body.price,
        isActive: req.body.isActive,
        clientID
    });
    await newService.save();
    res.status(201).json({ message: 'Service created successfully', service: newService });
}));

// GET ALL SERVICES FOR A CLIENT
router.get('/', validateClient, wrapRoute(async (req, res) => {
    const services = await Service.find({ clientID: req.clientId });
    res.json(services);
}));

// GET A SINGLE SERVICE
router.get('/:id', validateClient, wrapRoute(async (req, res) => {
    const service = await Service.findOne({ _id: req.params.id, clientID: req.clientId });
    if (!service) return res.status(404).json({ error: 'Service not found' });
    res.json(service);
}));

// UPDATE A SERVICE
router.put('/:id', validateClient, wrapRoute(async (req, res) => {
    const updatedService = await Service.findOneAndUpdate(
        { _id: req.params.id, clientID: req.clientId },
        {
            name: req.body.name,
            description: req.body.description,
            price: req.body.price,
            isActive: req.body.isActive
        },
        { new: true }
    );
    if (!updatedService) return res.status(404).json({ error: 'Service not found' });
    res.json({ message: 'Service updated successfully', service: updatedService });
}));

// DELETE A SERVICE
router.delete('/:id', validateClient, wrapRoute(async (req, res) => {
    const deletedService = await Service.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });
    if (!deletedService) return res.status(404).json({ error: 'Service not found' });
    res.json({ message: 'Service deleted successfully' });
}));

module.exports = router;
