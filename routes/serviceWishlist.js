const express = require('express');
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const ServiceWishlistReminder = require('../models/serviceWishlistReminder');
const Service = require('../models/service');
const { wrapRoute } = require('../helpers/failureEmail');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');

const router = express.Router();

function requireCustomerAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - Bearer token required' });
  }
  const token = auth.split(' ')[1];
  try {
    const { decoded } = verifyJwtWithAnySecret(jwt, token);
    if (!decoded.clientID || !decoded.customerID) {
      return res.status(403).json({
        error: 'Use POST /customer/login, then send this customer JWT.',
      });
    }
    req.clientID = String(decoded.clientID);
    req.customerID = String(decoded.customerID);
    next();
  } catch (e) {
    return res.status(403).json({ error: 'Invalid or expired token', details: e.message });
  }
}

function isReminderMonthInPast(year, month) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return year < y || (year === y && month < m);
}

router.get('/', requireCustomerAuth, wrapRoute(async (req, res) => {
  const list = await ServiceWishlistReminder.find({
    clientID: req.clientID,
    customerID: req.customerID,
  })
    .sort({ reminderYear: 1, reminderMonth: 1, createdAt: -1 })
    .populate('service', 'name price description clientID')
    .lean();
  res.json({ success: true, items: list, count: list.length });
}));

router.post('/', requireCustomerAuth, wrapRoute(async (req, res) => {
  const { serviceId, reminderYear, reminderMonth, notes = '', catchUpIfMissed } = req.body;
  if (!serviceId || !mongoose.Types.ObjectId.isValid(String(serviceId))) {
    return res.status(400).json({ error: 'serviceId must be a valid Mongo id' });
  }
  const y = parseInt(String(reminderYear), 10);
  const mo = parseInt(String(reminderMonth), 10);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) {
    return res.status(400).json({ error: 'reminderYear and reminderMonth (1–12) are required' });
  }
  if (isReminderMonthInPast(y, mo)) {
    return res.status(400).json({ error: 'Reminder month must be this month or in the future' });
  }

  const service = await Service.findOne({
    _id: serviceId,
    clientID: req.clientID,
  }).lean();
  if (!service) {
    return res.status(404).json({ error: 'Service not found for this store' });
  }

  try {
    const doc = await ServiceWishlistReminder.create({
      clientID: req.clientID,
      customerID: req.customerID,
      service: service._id,
      reminderYear: y,
      reminderMonth: mo,
      notes: String(notes || '').trim().slice(0, 2000),
      catchUpIfMissed: catchUpIfMissed === undefined ? true : Boolean(catchUpIfMissed),
    });
    const populated = await ServiceWishlistReminder.findById(doc._id).populate(
      'service',
      'name price description clientID'
    );
    return res.status(201).json({ success: true, item: populated });
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).json({
        error: 'You already have this service on your wish list for that month',
      });
    }
    throw e;
  }
}));

router.patch('/:id', requireCustomerAuth, wrapRoute(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const { reminderYear, reminderMonth, notes, catchUpIfMissed } = req.body;

  const existing = await ServiceWishlistReminder.findOne({
    _id: req.params.id,
    clientID: req.clientID,
    customerID: req.customerID,
  });
  if (!existing) {
    return res.status(404).json({ error: 'Reminder not found' });
  }

  const update = {};
  if (notes !== undefined) update.notes = String(notes || '').trim().slice(0, 2000);
  if (catchUpIfMissed !== undefined) update.catchUpIfMissed = Boolean(catchUpIfMissed);

  const y =
    reminderYear !== undefined ? parseInt(String(reminderYear), 10) : existing.reminderYear;
  const mo =
    reminderMonth !== undefined ? parseInt(String(reminderMonth), 10) : existing.reminderMonth;

  if (reminderYear !== undefined || reminderMonth !== undefined) {
    if (!Number.isFinite(y) || !Number.isFinite(mo) || mo < 1 || mo > 12) {
      return res.status(400).json({ error: 'Invalid reminderYear / reminderMonth' });
    }
    if (isReminderMonthInPast(y, mo)) {
      return res.status(400).json({ error: 'Reminder month must be this month or in the future' });
    }
    update.reminderYear = y;
    update.reminderMonth = mo;
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update (reminderYear, reminderMonth, notes, catchUpIfMissed)' });
  }

  const payload = { $set: update };
  if (reminderYear !== undefined || reminderMonth !== undefined) {
    payload.$unset = { lastReminderSentAt: 1 };
  }

  try {
    const doc = await ServiceWishlistReminder.findOneAndUpdate(
      { _id: req.params.id, clientID: req.clientID, customerID: req.customerID },
      payload,
      { new: true }
    ).populate('service', 'name price description clientID');

    if (!doc) return res.status(404).json({ error: 'Reminder not found' });
    return res.json({ success: true, item: doc });
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).json({ error: 'Duplicate service + month for this wish list' });
    }
    throw e;
  }
}));

router.delete('/:id', requireCustomerAuth, wrapRoute(async (req, res) => {
  if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid id' });
  }
  const result = await ServiceWishlistReminder.deleteOne({
    _id: req.params.id,
    clientID: req.clientID,
    customerID: req.customerID,
  });
  if (!result.deletedCount) {
    return res.status(404).json({ error: 'Reminder not found' });
  }
  res.json({ success: true, deleted: true });
}));

module.exports = router;
