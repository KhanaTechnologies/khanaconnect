/**
 * Storefront-token public booking API (self-serve).
 * Mounted at /api/v1/storefront/bookings
 */
const express = require('express');
const jwt = require('jsonwebtoken');
const Booking = require('../models/booking');
const Service = require('../models/service');
const Staff = require('../models/staff');
const Client = require('../models/client');
const { wrapRoute } = require('../helpers/failureEmail');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { isClientSubscriptionActive, subscriptionBlockedResponse } = require('../helpers/clientSubscription');
const {
  assertNoConflicts,
  resolveDayHours,
  buffersForServices,
} = require('../helpers/bookingConflicts');
const Resource = require('../models/resource');

// generateTimeSlots is local to booking.js — duplicate thin slot builder via conflicts helpers
const { timeToMinutes } = require('../helpers/bookingConflicts');

const router = express.Router();

async function storefrontAuth(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const { decoded } = verifyJwtWithAnySecret(jwt, token);
    const clientID = decoded.clientID || decoded.clientId;
    if (!clientID) return res.status(401).json({ error: 'Client context missing' });
    const client = await Client.findOne({ clientID }).select('role subscription clientID companyName businessEmail');
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!isClientSubscriptionActive(client)) return subscriptionBlockedResponse(res, client);
    req.clientId = clientID;
    req.storefrontClient = client;
    return next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

async function buildSlots(date, existingBookings, duration, hours, buffers) {
  const slots = [];
  if (hours?.closed) return slots;
  const before = Number(buffers?.before) || 0;
  const after = Number(buffers?.after) || 0;
  const dur = parseInt(duration, 10) || 60;
  const startMin = timeToMinutes(hours?.start || '09:00');
  const endMin = timeToMinutes(hours?.end || '17:00');
  for (let mins = startMin; mins + dur + after <= endMin; mins += 15) {
    const hour = Math.floor(mins / 60);
    const minute = mins % 60;
    const slotTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const slotEndMins = mins + dur;
    const slotEndTime = `${String(Math.floor(slotEndMins / 60)).padStart(2, '0')}:${String(slotEndMins % 60).padStart(2, '0')}`;
    const paddedStart = mins - before;
    const paddedEnd = slotEndMins + after;
    const busy = existingBookings.some((b) => {
      if (!b.time) return false;
      const bStart = timeToMinutes(b.time);
      const bEnd = b.endTime ? timeToMinutes(b.endTime) : bStart + (Number(b.duration) || 60);
      return paddedStart < bEnd && bStart < paddedEnd;
    });
    if (!busy) slots.push({ time: slotTime, endTime: slotEndTime, duration: dur, available: true });
  }
  return slots;
}

router.get('/services', storefrontAuth, wrapRoute(async (req, res) => {
  const services = await Service.find({ clientID: req.clientId, isActive: { $ne: false } })
    .select('name description price duration category image staffIds bufferBeforeMin bufferAfterMin')
    .sort({ name: 1 })
    .lean();
  res.json({ services });
}));

router.get('/availability', storefrontAuth, wrapRoute(async (req, res) => {
  const { date, serviceName, assignedTo, duration } = req.query;
  if (!date) return res.status(400).json({ error: 'date is required' });
  const names = serviceName ? [String(serviceName)] : [];
  const buffers = await buffersForServices(req.clientId, names);
  const bookingDuration = duration ? parseInt(duration, 10) : buffers.duration;
  const targetDate = new Date(date);
  const hours = await resolveDayHours({
    clientId: req.clientId,
    date: targetDate,
    assignedTo: assignedTo || null,
    resource: null,
  });
  const existing = await Booking.find({
    clientID: req.clientId,
    date: {
      $gte: new Date(new Date(targetDate).setHours(0, 0, 0, 0)),
      $lte: new Date(new Date(targetDate).setHours(23, 59, 59, 999)),
    },
    ...(assignedTo ? { assignedTo } : {}),
    status: { $nin: ['cancelled', 'no-show'] },
  }).lean();
  const availableSlots = await buildSlots(targetDate, existing, bookingDuration, hours, buffers);
  res.json({ date: targetDate.toISOString().slice(0, 10), duration: bookingDuration, hours, availableSlots });
}));

router.post('/', storefrontAuth, wrapRoute(async (req, res) => {
  const {
    customerName,
    customerEmail,
    customerPhone,
    services,
    date,
    time,
    duration,
    assignedTo,
    notes,
    depositAmount,
  } = req.body || {};

  if (!customerName || !customerEmail || !customerPhone || !date || !time) {
    return res.status(400).json({ error: 'customerName, customerEmail, customerPhone, date, and time are required' });
  }

  const servicesList = Array.isArray(services) ? services : services ? [services] : [];
  if (!servicesList.length) return res.status(400).json({ error: 'At least one service is required' });

  const buffers = await buffersForServices(req.clientId, servicesList);
  const bookingDuration = parseInt(duration, 10) || buffers.duration;
  const bookingDate = new Date(date);
  const [h, m] = String(time).split(':').map(Number);
  const endDateTime = new Date(bookingDate);
  endDateTime.setHours(h, m + bookingDuration, 0, 0);
  const endTime = `${String(endDateTime.getHours()).padStart(2, '0')}:${String(endDateTime.getMinutes()).padStart(2, '0')}`;

  let assignedToId = null;
  if (assignedTo) {
    const staff = await Staff.findOne({ _id: assignedTo, clientID: req.clientId, isActive: { $ne: false } });
    if (!staff) return res.status(400).json({ error: 'Staff not found' });
    // If service has staffIds, enforce eligibility
    const svc = await Service.findOne({ clientID: req.clientId, name: servicesList[0] }).select('staffIds');
    if (svc?.staffIds?.length && !svc.staffIds.map(String).includes(String(staff._id))) {
      return res.status(400).json({ error: 'Staff is not eligible for this service' });
    }
    assignedToId = staff._id;
  }

  try {
    await assertNoConflicts({
      clientId: req.clientId,
      date: bookingDate,
      time,
      endTime,
      durationMin: bookingDuration,
      assignedTo: assignedToId,
      bufferBeforeMin: buffers.before,
      bufferAfterMin: buffers.after,
    });
  } catch (e) {
    return res.status(e.status || 409).json({ error: e.message });
  }

  const deposit = Number(depositAmount) || 0;
  const booking = await Booking.create({
    customerName,
    customerEmail: String(customerEmail).toLowerCase().trim(),
    customerPhone,
    services: servicesList,
    date: bookingDate,
    time,
    endTime,
    duration: bookingDuration,
    assignedTo: assignedToId,
    notes: notes || '',
    clientID: req.clientId,
    bookingType: 'service',
    status: deposit > 0 ? 'pending' : 'confirmed',
    payment: {
      status: deposit > 0 ? 'pending' : 'pending',
      depositAmount: deposit || undefined,
      amount: deposit || undefined,
      currency: 'ZAR',
    },
    reminders: [],
  });

  res.status(201).json({
    booking,
    depositRequired: deposit > 0,
    message: deposit > 0
      ? 'Booking created pending deposit payment'
      : 'Booking created',
  });
}));

module.exports = router;
