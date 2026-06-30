const Customer = require('../models/customer');
const { Order } = require('../models/order');
const Email = require('../models/Email');
const Booking = require('../models/booking');
const { isAbandonedCart } = require('./revenueCommandCenter');

const MS_DAY = 24 * 60 * 60 * 1000;
const RECOVERY_WINDOW_MS = 14 * MS_DAY;

async function getCartRecoveryStats(clientID) {
  const reminded = await Customer.find({
    clientID,
    'cartReminder.lastSent': { $exists: true, $ne: null },
  }).select('_id cartReminder cart');

  let recoveredCount = 0;
  let recoveredRevenue = 0;
  let remindersSent = reminded.length;

  for (const c of reminded) {
    const sentAt = new Date(c.cartReminder.lastSent);
    const windowEnd = new Date(sentAt.getTime() + RECOVERY_WINDOW_MS);

    const orders = await Order.find({
      clientID,
      customer: c._id,
      paid: true,
      dateOrdered: { $gte: sentAt, $lte: windowEnd },
    }).select('finalPrice totalPrice dateOrdered');

    if (!orders.length) continue;

    const revenue = orders.reduce(
      (s, o) => s + Number(o.finalPrice || o.totalPrice || 0),
      0
    );
    if (revenue > 0) {
      recoveredCount += 1;
      recoveredRevenue += revenue;
    }
  }

  return {
    remindersSent,
    recoveredCount,
    recoveredRevenue: Math.round(recoveredRevenue * 100) / 100,
  };
}

async function getCampaignAttribution(clientID, limit = 15) {
  const newsletters = await Email.find({
    clientID,
    isNewsletter: true,
    direction: 'outbound',
  })
    .sort({ date: -1 })
    .limit(limit)
    .select('newsletterId subject date recipientName');

  if (!newsletters.length) return [];

  const byNewsletter = new Map();
  for (const row of newsletters) {
    const key = row.newsletterId || row.subject || String(row._id);
    if (!byNewsletter.has(key)) {
      byNewsletter.set(key, {
        newsletterId: row.newsletterId || null,
        subject: row.subject || 'Newsletter',
        sentAt: row.date,
        recipientCount: 0,
      });
    }
    byNewsletter.get(key).recipientCount += 1;
  }

  const campaigns = [];
  for (const camp of byNewsletter.values()) {
    const sentAt = new Date(camp.sentAt);
    const windowEnd = new Date(sentAt.getTime() + 7 * MS_DAY);

    const orders = await Order.find({
      clientID,
      paid: true,
      dateOrdered: { $gte: sentAt, $lte: windowEnd },
    })
      .populate('customer', 'emailAddress')
      .select('finalPrice totalPrice dateOrdered customer');

    const revenue = orders.reduce(
      (s, o) => s + Number(o.finalPrice || o.totalPrice || 0),
      0
    );

    campaigns.push({
      ...camp,
      attributedOrders: orders.length,
      attributedRevenue: Math.round(revenue * 100) / 100,
      note: 'Orders within 7 days of send (store-wide; refine with UTM later)',
    });
  }

  return campaigns.sort((a, b) => b.attributedRevenue - a.attributedRevenue);
}

async function getAbandonedBookings(clientID, limit = 50) {
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const stale = new Date(Date.now() - 7 * MS_DAY);

  const bookings = await Booking.find({
    clientID,
    status: 'pending',
    createdAt: { $lte: cutoff, $gte: stale },
  })
    .select('customerName customerEmail customerPhone date time services createdAt')
    .sort({ createdAt: -1 })
    .limit(limit);

  return bookings.map((b) => ({
    bookingId: b._id,
    customerName: b.customerName,
    customerEmail: b.customerEmail,
    customerPhone: b.customerPhone,
    date: b.date,
    time: b.time,
    services: b.services || [],
    createdAt: b.createdAt,
  }));
}

async function listCustomersDueAutoCartReminder(clientID, maxPerClient = 40) {
  const now = Date.now();
  const idleMs = MS_DAY;
  const secondReminderMs = 3 * MS_DAY;

  const customers = await Customer.find({
    clientID,
    'cart.0': { $exists: true },
    'preferences.notificationPreferences.cartReminders': { $ne: false },
  })
    .select('emailAddress cart lastActivity cartReminder preferences')
    .limit(500);

  const due = [];

  for (const c of customers) {
    if (!isAbandonedCart(c)) continue;

    const rem = c.cartReminder || {};
    const count = Number(rem.autoReminderCount || 0);
    if (count >= 2) continue;

    const lastSent = rem.lastSent ? new Date(rem.lastSent).getTime() : 0;
    const lastActivity = c.lastActivity ? new Date(c.lastActivity).getTime() : 0;
    if (!lastActivity || now - lastActivity < idleMs) continue;

    if (count === 0 && (!lastSent || now - lastSent > idleMs)) {
      due.push(c);
      continue;
    }

    if (count === 1 && lastSent && now - lastSent >= secondReminderMs) {
      due.push(c);
    }
  }

  return due.slice(0, maxPerClient);
}

module.exports = {
  getCartRecoveryStats,
  getCampaignAttribution,
  getAbandonedBookings,
  listCustomersDueAutoCartReminder,
  RECOVERY_WINDOW_MS,
};
