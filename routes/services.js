const express = require('express');
const jwt = require('jsonwebtoken');
const Service = require('../models/service');
const { wrapRoute } = require('../helpers/failureEmail'); // ✅ Import wrapRoute
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { createDashboardAuth } = require('../helpers/dashboardAuth');
const router = express.Router();

const validateClient = createDashboardAuth('services');

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
