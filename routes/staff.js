const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Staff = require('../models/staff'); // Import Staff model

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

// GET: Get all staff members for a specific client
router.get('/', validateClient, async (req, res) => {
    try {
        const clientId = req.clientId;

        const staffMembers = await Staff.find({ clientID: clientId });
        res.json(staffMembers);
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET: Get a staff member by ID for a specific client
router.get('/:id', validateClient, async (req, res) => {
    try {
        const { id } = req.params;
        const clientId = req.clientId;

        const staff = await Staff.findOne({ _id: id, clientID: clientId });

        if (!staff) {
            return res.status(404).json({ error: 'Staff member not found or unauthorized' });
        }

        res.json(staff);
    } catch (error) {
        console.error('Error fetching staff:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST: Create a new staff member
router.post('/', validateClient, async (req, res) => {
    try {
        const { name, role, email,phone,skills } = req.body;
        const clientId = req.clientId;

        if (!name || !role || !phone || !email) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const staff = new Staff({
            name,
            role,
            email,
            phone,
            skills,
            clientID: clientId,
        });

        await staff.save();
        res.status(201).json(staff);
    } catch (error) {
        console.error('Error creating staff member:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PUT: Update a staff member by ID
router.put('/:id', validateClient, async (req, res) => {
    try {
        const { id } = req.params;
        const clientId = req.clientId;
        const { name, role, email,phone, skills} = req.body;

        const staff = await Staff.findOne({ _id: id, clientID: clientId });

        if (!staff) {
            return res.status(404).json({ error: 'Staff member not found or unauthorized' });
        }

        staff.name = name || staff.name;
        staff.role = role || staff.role;
        staff.email = email || staff.email;
        staff.phone = phone || staff. phone;
        staff.skills = skills || staff.skills;
        await staff.save();
        res.json(staff);
    } catch (error) {
        console.error('Error updating staff member:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// DELETE: Delete a staff member by ID
router.delete('/:id', validateClient, async (req, res) => {
    try {
        const { id } = req.params;
        const clientId = req.clientId;

        const staff = await Staff.findOneAndDelete({ _id: id, clientID: clientId });

        if (!staff) {
            return res.status(404).json({ error: 'Staff member not found or unauthorized' });
        }

        res.json({ message: 'Staff member deleted successfully' });
    } catch (error) {
        console.error('Error deleting staff member:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;
