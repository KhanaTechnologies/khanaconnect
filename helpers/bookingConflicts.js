const Booking = require('../models/booking');
const Service = require('../models/service');
const Staff = require('../models/staff');

function timeToMinutes(t) {
  const [h, m] = String(t || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Find conflicting bookings for staff and/or resource on a date.
 */
async function findBookingConflicts({
  clientId,
  date,
  time,
  endTime,
  durationMin,
  assignedTo,
  resourceId,
  excludeBookingId = null,
  bufferBeforeMin = 0,
  bufferAfterMin = 0,
}) {
  if (!date || !time) return [];

  const day = new Date(date);
  const dayStart = new Date(day);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(day);
  dayEnd.setHours(23, 59, 59, 999);

  const startMin = timeToMinutes(time) - (Number(bufferBeforeMin) || 0);
  let endMin = endTime
    ? timeToMinutes(endTime)
    : startMin + (Number(durationMin) || 60) + (Number(bufferBeforeMin) || 0);
  endMin += Number(bufferAfterMin) || 0;

  const or = [];
  if (assignedTo) or.push({ assignedTo });
  if (resourceId) or.push({ resourceId });
  if (!or.length) return [];

  const filter = {
    clientID: clientId,
    date: { $gte: dayStart, $lte: dayEnd },
    status: { $nin: ['cancelled', 'no-show'] },
    bookingType: { $in: ['service', 'mixed'] },
    $or: or,
  };
  if (excludeBookingId) filter._id = { $ne: excludeBookingId };

  const existing = await Booking.find(filter).select('time endTime duration assignedTo resourceId customerName').lean();
  const conflicts = [];
  for (const b of existing) {
    if (!b.time) continue;
    const bStart = timeToMinutes(b.time);
    const bEnd = b.endTime ? timeToMinutes(b.endTime) : bStart + (Number(b.duration) || 60);
    if (rangesOverlap(startMin, endMin, bStart, bEnd)) {
      conflicts.push(b);
    }
  }
  return conflicts;
}

async function assertNoConflicts(opts) {
  const conflicts = await findBookingConflicts(opts);
  if (conflicts.length) {
    const err = new Error(
      `Time slot conflicts with existing booking (${conflicts[0].customerName || 'booked'} ${conflicts[0].time}-${conflicts[0].endTime || ''})`
    );
    err.status = 409;
    err.conflicts = conflicts;
    throw err;
  }
}

/**
 * Resolve operating window for a day from staff or defaults.
 */
async function resolveDayHours({ clientId, date, assignedTo, resource }) {
  const dayName = new Date(date).toLocaleDateString('en-US', { weekday: 'long' });
  if (resource?.operatingHours?.[dayName]) {
    const oh = resource.operatingHours[dayName];
    if (oh.closed) return { closed: true };
    return {
      closed: false,
      start: oh.start || '09:00',
      end: oh.end || '17:00',
    };
  }
  if (assignedTo) {
    const staff = await Staff.findOne({ _id: assignedTo, clientID: clientId }).lean();
    const oh = staff?.operatingHours?.[dayName] || staff?.availability?.[dayName];
    if (oh) {
      if (oh.closed) return { closed: true };
      return { closed: false, start: oh.start || '09:00', end: oh.end || '17:00' };
    }
  }
  return { closed: false, start: '09:00', end: '17:00' };
}

async function buffersForServices(clientId, serviceNames = []) {
  if (!serviceNames.length) return { before: 0, after: 0, duration: 60 };
  const services = await Service.find({
    clientID: clientId,
    name: { $in: serviceNames },
    isActive: { $ne: false },
  })
    .select('bufferBeforeMin bufferAfterMin duration')
    .lean();
  let before = 0;
  let after = 0;
  let duration = 0;
  for (const s of services) {
    before = Math.max(before, Number(s.bufferBeforeMin) || 0);
    after = Math.max(after, Number(s.bufferAfterMin) || 0);
    duration += Number(s.duration) || 0;
  }
  return { before, after, duration: duration || 60 };
}

module.exports = {
  timeToMinutes,
  findBookingConflicts,
  assertNoConflicts,
  resolveDayHours,
  buffersForServices,
};
