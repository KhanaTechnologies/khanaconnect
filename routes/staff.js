const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Staff = require('../models/staff');
const { wrapRoute } = require('../helpers/failureEmail'); // ✅ Import wrapRoute

// Middleware for client validation
const validateClient = async (req, res, next) => {
    try {
        const token = req.headers.authorization;
        if (!token || !token.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
        }
        const tokenValue = token.split(' ')[1];
        jwt.verify(tokenValue, process.env.secret, (err, user) => {
            if (err) {
                return res.status(403).json({ error: 'Forbidden - Invalid token', err });
            }
            if (!user.clientID) {
                return res.status(403).json({ error: 'Forbidden - Invalid token payload' });
            }
            req.clientId = user.clientID; // Attach client ID to request
            next();
        });
    } catch (error) {
        console.error('Error in client validation:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

// GET all staff members
router.get('/', validateClient, wrapRoute(async (req, res) => {
    const staffMembers = await Staff.find({ clientID: req.clientId });
    res.status(200).json(staffMembers);
}));

// GET staff member by ID
router.get('/:id', validateClient, wrapRoute(async (req, res) => {
    const staff = await Staff.findOne({ _id: req.params.id, clientID: req.clientId });
    if (!staff) return res.status(404).json({ error: 'Staff member not found or unauthorized' });
    res.status(200).json(staff);
}));

// CREATE a new staff member
router.post('/', validateClient, wrapRoute(async (req, res) => {
    const { name, role, email, phone, skills } = req.body;

    if (!name || !role || !email || !phone) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const staff = new Staff({
        name,
        role,
        email,
        phone,
        skills,
        clientID: req.clientId,
    });

    await staff.save();
    res.status(201).json(staff);
}));

// UPDATE a staff member by ID
router.put('/:id', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    const { name, role, email, phone, skills } = req.body;

    const staff = await Staff.findOne({ _id: id, clientID: req.clientId });
    if (!staff) return res.status(404).json({ error: 'Staff member not found or unauthorized' });

    staff.name = name || staff.name;
    staff.role = role || staff.role;
    staff.email = email || staff.email;
    staff.phone = phone || staff.phone;
    staff.skills = skills || staff.skills;

    await staff.save();
    res.status(200).json(staff);
}));

// DELETE a staff member by ID
router.delete('/:id', validateClient, wrapRoute(async (req, res) => {
    const staff = await Staff.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });
    if (!staff) return res.status(404).json({ error: 'Staff member not found or unauthorized' });

    res.status(200).json({ message: 'Staff member deleted successfully' });
}));

module.exports = router;
