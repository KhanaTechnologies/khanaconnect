const mongoose = require('mongoose');

/**
 * Admin-defined windows when paid social / ads were active, for comparing to site analytics.
 */
const advertisingPeriodSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true, maxlength: 200 },
    /** Tenant this period applies to (required for per-store comparisons). */
    clientID: { type: String, required: true, index: true, trim: true },
    platform: {
      type: String,
      enum: ['meta', 'google', 'tiktok', 'pinterest', 'multi', 'other'],
      default: 'multi',
    },
    startAt: { type: Date, required: true, index: true },
    endAt: { type: Date, required: true, index: true },
    notes: { type: String, maxlength: 2000, default: '' },
    createdByClientID: { type: String, default: '' },
    isDeleted: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

advertisingPeriodSchema.index({ clientID: 1, startAt: 1, endAt: 1 });
advertisingPeriodSchema.index({ clientID: 1, isDeleted: 1, startAt: -1 });

module.exports = mongoose.model('AdvertisingPeriod', advertisingPeriodSchema);
