const mongoose = require('mongoose');

/**
 * Hourly bandwidth counters written by middleware/bandwidthMeter.js.
 * One document per (hour bucket, dimension, key) — e.g. ('route', 'GET /api/v1/products').
 * Used by the admin Bandwidth page to explain Render outbound bandwidth usage.
 */
const bandwidthUsageSchema = new mongoose.Schema(
  {
    bucket: { type: Date, required: true },
    dim: {
      type: String,
      // apitoken: routes called with a storefront API token (what public websites rely on).
      // failed: endpoint + exact status code for 4xx/5xx responses.
      enum: ['total', 'wire', 'route', 'file', 'origin', 'client', 'agent', 'status', 'apitoken', 'failed'],
      required: true,
    },
    key: { type: String, required: true, trim: true },
    requests: { type: Number, default: 0 },
    bytesOut: { type: Number, default: 0 },
    bytesIn: { type: Number, default: 0 },
  },
  { versionKey: false, collection: 'bandwidth_usage' }
);

bandwidthUsageSchema.index({ bucket: 1, dim: 1, key: 1 }, { unique: true });
bandwidthUsageSchema.index({ dim: 1, bucket: -1 });
// Keep ~4 months of history.
bandwidthUsageSchema.index({ bucket: 1 }, { expireAfterSeconds: 120 * 24 * 60 * 60 });

module.exports = mongoose.models.BandwidthUsage || mongoose.model('BandwidthUsage', bandwidthUsageSchema);
