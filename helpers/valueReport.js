/**
 * "What Khana did for you" — period totals for a client: sales, bookings, and
 * revenue recovered by cart reminders. Shown on the dashboard home and sent as a
 * monthly email so clients can see the platform paying for itself.
 */
const Customer = require('../models/customer');
const { Order } = require('../models/order');
const Booking = require('../models/booking');

const MS_DAY = 24 * 60 * 60 * 1000;
/** An order counts as recovered if it was paid within this window after a cart reminder. */
const RECOVERY_WINDOW_MS = 14 * MS_DAY;
const COUNTED_BOOKING_STATUSES = ['confirmed', 'scheduled', 'completed', 'checked-in', 'checked-out'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

async function orderTotals(clientID, from, to) {
  const [row] = await Order.aggregate([
    { $match: { clientID, paid: true, dateOrdered: { $gte: from, $lt: to } } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        // Same rule as the cart recovery stats: finalPrice, else totalPrice.
        revenue: {
          $sum: { $cond: [{ $gt: ['$finalPrice', 0] }, '$finalPrice', { $ifNull: ['$totalPrice', 0] }] },
        },
      },
    },
  ]);
  return { count: row?.count || 0, revenue: round2(row?.revenue) };
}

async function bookingTotals(clientID, from, to) {
  const count = await Booking.countDocuments({
    clientID,
    date: { $gte: from, $lt: to },
    status: { $in: COUNTED_BOOKING_STATUSES },
  });
  return { count };
}

/** Paid orders in [from, to) that followed a cart reminder by at most 14 days. */
async function recoveredCartTotals(clientID, from, to) {
  const reminded = await Customer.find({
    clientID,
    'cartReminder.lastSent': { $gte: new Date(from.getTime() - RECOVERY_WINDOW_MS), $lt: to },
  })
    .select('_id cartReminder.lastSent')
    .lean();

  let count = 0;
  let revenue = 0;
  for (const c of reminded) {
    const sentAt = new Date(c.cartReminder.lastSent);
    const start = new Date(Math.max(sentAt.getTime(), from.getTime()));
    const end = new Date(Math.min(sentAt.getTime() + RECOVERY_WINDOW_MS, to.getTime()));
    if (end <= start) continue;
    const orders = await Order.find({
      clientID,
      customer: c._id,
      paid: true,
      dateOrdered: { $gte: start, $lt: end },
    })
      .select('finalPrice totalPrice')
      .lean();
    const value = orders.reduce((s, o) => s + Number(o.finalPrice || o.totalPrice || 0), 0);
    if (value > 0) {
      count += 1;
      revenue += value;
    }
  }
  return { count, revenue: round2(revenue), remindersSent: reminded.length };
}

async function buildValueReport(clientID, from, to) {
  const [orders, bookings, recovered] = await Promise.all([
    orderTotals(clientID, from, to),
    bookingTotals(clientID, from, to),
    recoveredCartTotals(clientID, from, to),
  ]);
  return {
    from: from.toISOString(),
    to: to.toISOString(),
    orders,
    bookings,
    recoveredCarts: recovered,
  };
}

/** Calendar month (UTC) before `now`: { from, to, label: 'October 2026', key: '2026-10' }. */
function previousMonthRange(now = new Date()) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth() - 1, 1));
  const label = from.toLocaleString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const key = `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`;
  return { from, to, label, key };
}

module.exports = {
  buildValueReport,
  previousMonthRange,
  RECOVERY_WINDOW_MS,
};
