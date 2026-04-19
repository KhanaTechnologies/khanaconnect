const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * Customer reminder: book a service in a future calendar month.
 * Cron sends via tenant SMTP when due; if `catchUpIfMissed` (default true), missed runs are sent as soon as the job sees them (within grace after month-end).
 */
const serviceWishlistReminderSchema = new Schema(
  {
    clientID: { type: String, required: true, index: true },
    customerID: { type: String, required: true, index: true },
    service: { type: Schema.Types.ObjectId, ref: 'Service', required: true },
    reminderYear: { type: Number, required: true, min: 2000, max: 2100 },
    reminderMonth: { type: Number, required: true, min: 1, max: 12 },
    notes: { type: String, default: '', trim: true, maxlength: 2000 },
    /** Set when the monthly reminder email was successfully sent for this row. */
    lastReminderSentAt: { type: Date, default: null },
    /**
     * When true (default), if the server was down on the 1st, the next daily cron still sends until grace after month-end.
     * When false, only sends when the job runs on the 1st of the target month (strict).
     */
    catchUpIfMissed: { type: Boolean, default: true },
  },
  { timestamps: true }
);

serviceWishlistReminderSchema.index(
  { clientID: 1, customerID: 1, service: 1, reminderYear: 1, reminderMonth: 1 },
  { unique: true }
);
serviceWishlistReminderSchema.index({ reminderYear: 1, reminderMonth: 1, lastReminderSentAt: 1 });
serviceWishlistReminderSchema.index({ lastReminderSentAt: 1, catchUpIfMissed: 1 });

module.exports = mongoose.model('ServiceWishlistReminder', serviceWishlistReminderSchema);
