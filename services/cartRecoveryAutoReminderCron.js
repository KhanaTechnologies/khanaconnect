const cron = require('node-cron');
const Client = require('../models/client');
const { mergeRevenueSettings } = require('../helpers/revenueDefaults');
const { resolveSmtpHost } = require('../helpers/mailHost');
const { listCustomersDueAutoCartReminder } = require('../helpers/revenueMetrics');
const { sendCartReminderEmail } = require('../utils/cartReminderEmail');

/**
 * Hourly cart recovery auto-reminders for clients with cartRecoveryAutoReminders enabled.
 * Sends up to 2 automated reminders per abandoned cart (day 1 and day 3).
 */
class CartRecoveryAutoReminderCron {
  constructor() {
    this.started = false;
  }

  start() {
    if (this.started) return;
    if (
      process.env.CART_AUTO_REMINDER_DISABLED === '1' ||
      process.env.CART_AUTO_REMINDER_DISABLED === 'true'
    ) {
      console.log('🛒 Cart auto-reminder cron: disabled (CART_AUTO_REMINDER_DISABLED)');
      return;
    }
    this.started = true;
    const pattern = process.env.CART_AUTO_REMINDER_CRON || '0 * * * *';
    const opts = {};
    if (process.env.TZ) opts.timezone = process.env.TZ;
    cron.schedule(
      pattern,
      () => {
        this.runDueReminders().catch((err) =>
          console.error('🛒 Cart auto-reminder cron:', err.message)
        );
      },
      opts
    );
    console.log(
      `🛒 Cart auto-reminder cron scheduled (${pattern}${opts.timezone ? `, TZ=${opts.timezone}` : ''})`
    );
  }

  async runDueReminders() {
    const clients = await Client.find({
      'revenueSettings.cartRecoveryAutoReminders': true,
      'revenueSettings.cartRecoveryEnabled': { $ne: false },
    }).select('clientID revenueSettings businessEmail smtpHost smtpPort companyName return_url');

    let totalSent = 0;
    let totalFailed = 0;

    for (const client of clients) {
      const settings = mergeRevenueSettings(client.revenueSettings);
      if (!settings.cartRecoveryEnabled || !settings.cartRecoveryAutoReminders) continue;
      if (!resolveSmtpHost(client)) continue;

      const due = await listCustomersDueAutoCartReminder(client.clientID, 30);
      for (const customer of due) {
        try {
          await sendCartReminderEmail(customer, client);
          customer.cartReminder = customer.cartReminder || {};
          customer.cartReminder.lastSent = new Date();
          customer.cartReminder.autoReminderCount =
            Number(customer.cartReminder.autoReminderCount || 0) + 1;
          await customer.save();
          totalSent += 1;
        } catch (e) {
          console.error(
            '🛒 Cart auto-reminder failed:',
            client.clientID,
            customer._id,
            e.message
          );
          totalFailed += 1;
        }
      }
    }

    if (totalSent || totalFailed) {
      console.log(`🛒 Cart auto-reminders: ${totalSent} sent, ${totalFailed} failed`);
    }
  }
}

const singleton = new CartRecoveryAutoReminderCron();
module.exports = singleton;
