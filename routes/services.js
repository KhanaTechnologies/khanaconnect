const express = require('express');
const jwt = require('jsonwebtoken');
const Service = require('../models/service');
const router = express.Router();

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
            next();
        });
    } catch (error) {
        console.error('Error in client validation:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

// **CREATE SERVICE**
router.post('/', validateClient, async (req, res) => {
    try {
        const clientID = req.clientId;

        const newService = new Service({ 
            name:req.body.name,
            description:req.body.description,
            price:req.body.price,
            clientID:clientID });
        await newService.save();

        res.status(201).json({ message: 'Service created successfully', service: newService });
    } catch (error) {
        console.error('Error creating service:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// **GET ALL SERVICES FOR A CLIENT**
router.get('/', validateClient, async (req, res) => {
    try {
        const services = await Service.find({ clientID: req.clientId });
        res.json(services);
    } catch (error) {
        console.error('Error fetching services:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// **GET A SINGLE SERVICE**
router.get('/:id', validateClient, async (req, res) => {
    try {
        const service = await Service.findOne({ _id: req.params.id, clientID: req.clientId });
        if (!service) {
            return res.status(404).json({ error: 'Service not found' });
        }
        res.json(service);
    } catch (error) {
        console.error('Error fetching service:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// **UPDATE A SERVICE**
router.put('/:id', validateClient, async (req, res) => {
    try {
        const { name, description, price } = req.body;
        const updatedService = await Service.findOneAndUpdate(
            { _id: req.params.id, clientID: req.clientId },
            { name, description, price },
            { new: true }
        );

        if (!updatedService) {
            return res.status(404).json({ error: 'Service not found' });
        }

        res.json({ message: 'Service updated successfully', service: updatedService });
    } catch (error) {
        console.error('Error updating service:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// **DELETE A SERVICE**
router.delete('/:id', validateClient, async (req, res) => {
    try {
        const deletedService = await Service.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });

        if (!deletedService) {
            return res.status(404).json({ error: 'Service not found' });
        }

        res.json({ message: 'Service deleted successfully' });
    } catch (error) {
        console.error('Error deleting service:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;
