const Booking = require('../models/booking');

const AUTO_COMPLETE_STATUSES = ['pending', 'confirmed', 'scheduled'];
const CHECKOUT_STATUSES = ['checked-in'];

function parseTimeOnDate(dateValue, timeStr) {
  const d = new Date(dateValue);
  if (!timeStr || typeof timeStr !== 'string') return d;
  const parts = timeStr.trim().split(':').map((p) => parseInt(p, 10));
  const hours = Number.isFinite(parts[0]) ? parts[0] : 0;
  const minutes = Number.isFinite(parts[1]) ? parts[1] : 0;
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/** When a booking should be considered finished (for auto status updates). */
function getBookingEndAt(booking) {
  const doc = booking && typeof booking.toObject === 'function' ? booking.toObject() : booking;
  const type = doc.bookingType || 'service';

  if ((type === 'accommodation' || type === 'mixed') && doc.accommodation?.checkOut) {
    const end = new Date(doc.accommodation.checkOut);
    end.setHours(23, 59, 59, 999);
    return end;
  }

  if (doc.endTime) {
    return parseTimeOnDate(doc.date, doc.endTime);
  }

  const start = parseTimeOnDate(doc.date, doc.time);
  const durationMins = Number(doc.duration);
  if (Number.isFinite(durationMins) && durationMins > 0) {
    return new Date(start.getTime() + durationMins * 60 * 1000);
  }

  return start;
}

function isBookingPast(booking, now = new Date()) {
  return getBookingEndAt(booking) < now;
}

/**
 * Move stale active bookings forward so the dashboard reflects reality.
 * - pending / confirmed / scheduled → completed after end time
 * - checked-in (accommodation) → checked-out after checkout date
 */
async function autoAdvancePastBookings(filter = {}) {
  const now = new Date();
  const baseFilter = { ...filter };

  const active = await Booking.find({
    ...baseFilter,
    status: { $in: AUTO_COMPLETE_STATUSES },
  }).select('_id date time endTime duration bookingType accommodation status');

  const completeIds = [];
  for (const booking of active) {
    if (isBookingPast(booking, now)) {
      completeIds.push(booking._id);
    }
  }

  if (completeIds.length > 0) {
    await Booking.updateMany(
      { _id: { $in: completeIds } },
      { $set: { status: 'completed' } }
    );
  }

  const checkedIn = await Booking.find({
    ...baseFilter,
    status: { $in: CHECKOUT_STATUSES },
    bookingType: { $in: ['accommodation', 'mixed'] },
    'accommodation.checkOut': { $exists: true, $ne: null },
  }).select('_id accommodation');

  const checkoutIds = checkedIn
    .filter((b) => {
      const end = new Date(b.accommodation.checkOut);
      end.setHours(23, 59, 59, 999);
      return end < now;
    })
    .map((b) => b._id);

  if (checkoutIds.length > 0) {
    await Booking.updateMany(
      { _id: { $in: checkoutIds } },
      { $set: { status: 'checked-out' } }
    );
  }

  return { completed: completeIds.length, checkedOut: checkoutIds.length };
}

module.exports = {
  getBookingEndAt,
  isBookingPast,
  autoAdvancePastBookings,
};
