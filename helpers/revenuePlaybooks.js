const Client = require('../models/client');
const Customer = require('../models/customer');
const { Order } = require('../models/order');
const { mergeRevenueSettings } = require('./revenueDefaults');
const { resolveRevenueCapabilities, moduleAllowed } = require('./revenueCapabilities');
const { getAbandonedCarts, resolveSegmentCustomers } = require('./revenueCommandCenter');
const { getAbandonedBookings } = require('./revenueMetrics');
const { sendCartReminderEmail } = require('../utils/cartReminderEmail');
const {
  sendWinBackEmail,
  sendPostPurchaseEmail,
  sendBookingAbandonmentEmail,
} = require('./revenueLifecycleEmails');
const { resolveSmtpHost } = require('./mailHost');

const MS_DAY = 24 * 60 * 60 * 1000;

const PLAYBOOK_CATALOG = [
  {
    id: 'recover_carts',
    label: 'Recover abandoned carts',
    description: 'Email up to 25 customers with items left in cart',
    module: 'cart_recovery',
    requiresSmtp: true,
    businessTypes: ['retail', 'mixed'],
  },
  {
    id: 'win_back',
    label: 'Win back inactive customers',
    description: 'Re-engage shoppers inactive 60+ days',
    module: 'segments',
    requiresSmtp: true,
    businessTypes: ['retail', 'services', 'mixed'],
  },
  {
    id: 'recover_bookings',
    label: 'Recover abandoned bookings',
    description: 'Nudge customers who started but did not confirm a booking',
    module: 'bookings',
    requiresSmtp: true,
    businessTypes: ['services', 'mixed'],
  },
  {
    id: 'post_purchase',
    label: 'Post-purchase follow-up',
    description: 'Thank recent buyers and encourage repeat purchases',
    module: 'orders',
    requiresSmtp: true,
    businessTypes: ['retail', 'mixed'],
  },
  {
    id: 'wishlist_promo',
    label: 'Promote wishlist favorites',
    description: 'Create a promo for top wishlisted products',
    module: 'wishlist',
    requiresSmtp: false,
    navigateTo: '/dashboard/sales',
    businessTypes: ['retail', 'mixed'],
  },
];

function getPlaybooksForClient(clientDoc) {
  const settings = mergeRevenueSettings(clientDoc?.revenueSettings);
  const capabilities = resolveRevenueCapabilities(clientDoc);
  const businessType = settings.businessType || 'mixed';

  return PLAYBOOK_CATALOG.filter(
    (p) =>
      p.businessTypes.includes(businessType) &&
      moduleAllowed(p.module, businessType, capabilities) &&
      (p.id !== 'recover_carts' || settings.cartRecoveryEnabled) &&
      (p.id !== 'win_back' || settings.winBackEmailsEnabled) &&
      (p.id !== 'post_purchase' || settings.postPurchaseEmailsEnabled) &&
      (p.id !== 'recover_bookings' || settings.bookingAbandonmentEnabled)
  ).map((p) => ({
    id: p.id,
    label: p.label,
    description: p.description,
    requiresSmtp: p.requiresSmtp,
    navigateTo: p.navigateTo || null,
  }));
}

async function runPlaybook(clientId, playbookId, options = {}) {
  const client = await Client.findOne({ clientID: clientId });
  if (!client) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }

  const settings = mergeRevenueSettings(client.revenueSettings);
  const caps = resolveRevenueCapabilities(client);
  const maxSend = Math.min(Number(options.limit) || 25, 50);

  if (playbookId === 'wishlist_promo') {
    return {
      success: true,
      playbookId,
      action: 'navigate',
      path: '/dashboard/sales',
      sent: 0,
      failed: 0,
      skipped: 0,
    };
  }

  if (!resolveSmtpHost(client)) {
    const err = new Error('Configure business email / SMTP first');
    err.status = 400;
    throw err;
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  switch (playbookId) {
    case 'recover_carts': {
      if (!settings.cartRecoveryEnabled || !caps.orders) {
        const err = new Error('Cart recovery is not enabled');
        err.status = 400;
        throw err;
      }
      const carts = await getAbandonedCarts(clientId, maxSend);
      for (const row of carts) {
        try {
          const customer = await Customer.findOne({ _id: row.customerId, clientID: clientId });
          if (!customer?.cart?.length) {
            skipped += 1;
            continue;
          }
          if (customer.preferences?.notificationPreferences?.cartReminders === false) {
            skipped += 1;
            continue;
          }
          await sendCartReminderEmail(customer, client);
          customer.cartReminder = customer.cartReminder || {};
          customer.cartReminder.lastSent = new Date();
          await customer.save();
          sent += 1;
        } catch (_e) {
          failed += 1;
        }
      }
      break;
    }

    case 'win_back': {
      if (!settings.winBackEmailsEnabled) {
        const err = new Error('Win-back emails are disabled in Revenue settings');
        err.status = 400;
        throw err;
      }
      const inactive = await resolveSegmentCustomers(clientId, { preset: 'inactive_60' });
      const cooldown = Date.now() - 30 * MS_DAY;
      for (const c of inactive.slice(0, maxSend * 2)) {
        if (sent >= maxSend) break;
        const lastWin = c.revenueLifecycle?.winBackSentAt;
        if (lastWin && new Date(lastWin).getTime() > cooldown) {
          skipped += 1;
          continue;
        }
        try {
          await sendWinBackEmail(c, client);
          c.revenueLifecycle = c.revenueLifecycle || {};
          c.revenueLifecycle.winBackSentAt = new Date();
          await c.save();
          sent += 1;
        } catch (_e) {
          failed += 1;
        }
      }
      break;
    }

    case 'recover_bookings': {
      if (!settings.bookingAbandonmentEnabled || !caps.bookings) {
        const err = new Error('Booking abandonment recovery is not enabled');
        err.status = 400;
        throw err;
      }
      const bookings = await getAbandonedBookings(clientId, maxSend * 2);
      const cooldown = Date.now() - 7 * MS_DAY;
      for (const b of bookings) {
        if (sent >= maxSend) break;
        if (!b.customerEmail) {
          skipped += 1;
          continue;
        }
        const existing = await Customer.findOne({
          clientID: clientId,
          emailAddress: b.customerEmail,
        }).select('revenueLifecycle');
        const lastNudge = existing?.revenueLifecycle?.bookingNudgeSentAt;
        if (lastNudge && new Date(lastNudge).getTime() > cooldown) {
          skipped += 1;
          continue;
        }
        try {
          await sendBookingAbandonmentEmail(b, client);
          if (existing) {
            existing.revenueLifecycle = existing.revenueLifecycle || {};
            existing.revenueLifecycle.bookingNudgeSentAt = new Date();
            await existing.save();
          }
          sent += 1;
        } catch (_e) {
          failed += 1;
        }
      }
      break;
    }

    case 'post_purchase': {
      if (!settings.postPurchaseEmailsEnabled || !caps.orders) {
        const err = new Error('Post-purchase emails are not enabled');
        err.status = 400;
        throw err;
      }
      const weekAgo = new Date(Date.now() - 7 * MS_DAY);
      const cooldown = Date.now() - 30 * MS_DAY;
      const recentOrders = await Order.find({
        clientID: clientId,
        paid: true,
        dateOrdered: { $gte: weekAgo },
      })
        .populate('customer', 'emailAddress customerFirstName revenueLifecycle')
        .sort({ dateOrdered: -1 })
        .limit(100);

      const seen = new Set();
      for (const order of recentOrders) {
        if (sent >= maxSend) break;
        const customer = order.customer;
        if (!customer?.emailAddress) continue;
        const cid = String(customer._id);
        if (seen.has(cid)) continue;
        seen.add(cid);

        const lastSent = customer.revenueLifecycle?.postPurchaseSentAt;
        if (lastSent && new Date(lastSent).getTime() > cooldown) {
          skipped += 1;
          continue;
        }

        try {
          await sendPostPurchaseEmail(customer, client);
          const full = await Customer.findById(customer._id);
          if (full) {
            full.revenueLifecycle = full.revenueLifecycle || {};
            full.revenueLifecycle.postPurchaseSentAt = new Date();
            await full.save();
          }
          sent += 1;
        } catch (_e) {
          failed += 1;
        }
      }
      break;
    }

    default: {
      const err = new Error('Unknown playbook');
      err.status = 400;
      throw err;
    }
  }

  return { success: true, playbookId, sent, failed, skipped };
}

module.exports = {
  PLAYBOOK_CATALOG,
  getPlaybooksForClient,
  runPlaybook,
};
