const mongoose = require('mongoose');

const saasCrmOpportunitySchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    stage_id: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['open', 'won', 'lost'],
      default: 'open',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    value: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: 'ZAR' },
    customer_name: { type: String, default: '', trim: true },
    customer_email: { type: String, default: '', trim: true },
    customer_phone: { type: String, default: '', trim: true },
    source: { type: String, default: '', trim: true },
    notes: { type: String, default: '' },
    owner_name: { type: String, default: '', trim: true },
    owner_user_id: { type: String, default: '', trim: true },
    linked_order_id: { type: String, default: '', trim: true },
    linked_booking_id: { type: String, default: '', trim: true },
    last_activity_at: { type: Date, default: null, index: true },
    closed_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasCrmOpportunitySchema.index({ client_id: 1, stage_id: 1, status: 1 });

module.exports = mongoose.model('SaasCrmOpportunity', saasCrmOpportunitySchema);
