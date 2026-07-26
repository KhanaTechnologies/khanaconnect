const express = require('express');
const router = express.Router();
const Staff = require('../models/staff');
const { wrapRoute } = require('../helpers/failureEmail');
const { createDashboardAuth } = require('../helpers/dashboardAuth');

const validateClient = createDashboardAuth('staff');

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function normalizeOperatingHours(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const day of DAYS) {
    const oh = raw[day];
    if (!oh || typeof oh !== 'object') continue;
    out[day] = {
      start: String(oh.start || '09:00').slice(0, 5),
      end: String(oh.end || '17:00').slice(0, 5),
      closed: !!oh.closed,
    };
  }
  return Object.keys(out).length ? out : undefined;
}

// GET all staff members
router.get('/', validateClient, wrapRoute(async (req, res) => {
    const filter = { clientID: req.clientId };
    if (req.query.active === '1' || req.query.active === 'true') filter.isActive = true;
    const staffMembers = await Staff.find(filter);
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
    const { name, role, email, phone, skills, isActive, operatingHours } = req.body;

    if (!name || !role || !email || !phone) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const staff = new Staff({
        name,
        role,
        email,
        phone,
        skills: Array.isArray(skills) ? skills : [],
        isActive: isActive === undefined ? true : !!isActive,
        operatingHours: normalizeOperatingHours(operatingHours),
        clientID: req.clientId,
    });

    await staff.save();
    res.status(201).json(staff);
}));

// UPDATE a staff member by ID
router.put('/:id', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    const { name, role, email, phone, skills, isActive, operatingHours } = req.body;

    const staff = await Staff.findOne({ _id: id, clientID: req.clientId });
    if (!staff) return res.status(404).json({ error: 'Staff member not found or unauthorized' });

    if (name !== undefined) staff.name = name;
    if (role !== undefined) staff.role = role;
    if (email !== undefined) staff.email = email;
    if (phone !== undefined) staff.phone = phone;
    if (skills !== undefined) staff.skills = Array.isArray(skills) ? skills : staff.skills;
    if (isActive !== undefined) staff.isActive = !!isActive;
    if (operatingHours !== undefined) staff.operatingHours = normalizeOperatingHours(operatingHours);

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
