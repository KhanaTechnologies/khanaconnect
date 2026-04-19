const cron = require('node-cron');
const ServiceWishlistReminder = require('../models/serviceWishlistReminder');
const Customer = require('../models/customer');
const Client = require('../models/client');
const { sendServiceWishlistMonthlyReminder } = require('../utils/serviceWishlistReminderEmail');
const { isReminderDueForSend } = require('../helpers/serviceWishlistReminderWindow');

/**
 * Sends service wishlist reminder emails (tenant SMTP).
 * Default schedule is **daily** so missed 1st-of-month runs are picked up while `catchUpIfMissed` is true (see `SERVICE_WISHLIST_CATCH_UP_DAYS_AFTER_MONTH`).
 * Set `SERVICE_WISHLIST_REMINDER_CRON=0 8 1 * *` if you only want to attempt on the 1st (catch-up still applies on next run within grace if that day fires).
 */
class ServiceWishlistReminderCron {
  constructor() {
    this.started = false;
  }

  start() {
    if (this.started) return;
    if (process.env.SERVICE_WISHLIST_REMINDER_DISABLED === '1' || process.env.SERVICE_WISHLIST_REMINDER_DISABLED === 'true') {
      console.log('📋 Service wishlist reminder cron: disabled (SERVICE_WISHLIST_REMINDER_DISABLED)');
      return;
    }
    this.started = true;
    const pattern = process.env.SERVICE_WISHLIST_REMINDER_CRON || '0 8 * * *';
    const opts = {};
    if (process.env.TZ) opts.timezone = process.env.TZ;
    cron.schedule(
      pattern,
      () => {
        this.runDueReminders().catch((err) => console.error('📋 Service wishlist reminder cron:', err.message));
      },
      opts
    );
    console.log(`📋 Service wishlist reminder cron scheduled (${pattern}${opts.timezone ? `, TZ=${opts.timezone}` : ''})`);
  }

  async runDueReminders() {
    const now = new Date();

    const candidates = await ServiceWishlistReminder.find({
      $or: [{ lastReminderSentAt: null }, { lastReminderSentAt: { $exists: false } }],
    })
      .populate('service', 'name price description clientID')
      .lean();

    const items = candidates.filter((row) => isReminderDueForSend(row, now));

    if (!items.length) {
      console.log('📋 Service wishlist reminders: none due (catch-up window or strict 1st)');
      return;
    }

    const byGroup = new Map();
    for (const row of items) {
      if (!row.service || String(row.service.clientID) !== String(row.clientID)) {
        continue;
      }
      const key = `${row.clientID}:${row.customerID}:${row.reminderYear}:${row.reminderMonth}`;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key).push(row);
    }

    let sent = 0;
    let failed = 0;

    for (const [, rows] of byGroup) {
      const { clientID, customerID, reminderYear, reminderMonth } = rows[0];
      try {
        const [customer, client] = await Promise.all([
          Customer.findOne({ _id: customerID, clientID }),
          Client.findOne({ clientID }),
        ]);
        if (!customer || !client) {
          console.warn('📋 Service wishlist skip: missing customer or client', { customerID, clientID });
          failed += rows.length;
          continue;
        }
        await sendServiceWishlistMonthlyReminder(customer, client, rows, {
          year: reminderYear,
          month: reminderMonth,
        });
        await ServiceWishlistReminder.updateMany(
          { _id: { $in: rows.map((r) => r._id) } },
          { $set: { lastReminderSentAt: new Date() } }
        );
        sent += rows.length;
      } catch (e) {
        console.error('📋 Service wishlist email failed:', clientID, customerID, e.message);
        failed += rows.length;
      }
    }

    console.log(`📋 Service wishlist reminders: ${sent} rows marked sent, ${failed} skipped/failed (${byGroup.size} emails)`);
  }
}

const singleton = new ServiceWishlistReminderCron();
module.exports = singleton;
