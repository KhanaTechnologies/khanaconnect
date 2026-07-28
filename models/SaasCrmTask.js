const mongoose = require('mongoose');

const saasCrmTaskSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    status: {
      type: String,
      enum: ['open', 'completed', 'cancelled'],
      default: 'open',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
      index: true,
    },
    due_at: { type: Date, default: null, index: true },
    reminder_at: { type: Date, default: null, index: true },
    reminder_sent_at: { type: Date, default: null },
    reminder_status: {
      type: String,
      enum: ['pending', 'sent', 'failed'],
      default: 'pending',
      index: true,
    },
    assignee_name: { type: String, default: '', trim: true },
    assignee_user_id: { type: String, default: '', trim: true },
    linked_opportunity_id: { type: mongoose.Schema.Types.ObjectId, ref: 'SaasCrmOpportunity', default: null },
    linked_order_id: { type: String, default: '', trim: true },
    linked_booking_id: { type: String, default: '', trim: true },
    customer_name: { type: String, default: '', trim: true },
    customer_email: { type: String, default: '', trim: true },
    customer_phone: { type: String, default: '', trim: true },
    completed_at: { type: Date, default: null },
    cancelled_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasCrmTaskSchema.index({ client_id: 1, status: 1, due_at: 1 });

module.exports = mongoose.model('SaasCrmTask', saasCrmTaskSchema);
