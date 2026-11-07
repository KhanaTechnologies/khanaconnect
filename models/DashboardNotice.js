const mongoose = require('mongoose');

const dashboardNoticeSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 140 },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
    tone: {
      type: String,
      enum: ['info', 'warning', 'price'],
      default: 'info',
      index: true,
    },
    audienceType: {
      type: String,
      enum: ['all', 'plans', 'clients'],
      default: 'all',
      index: true,
    },
    plans: { type: [String], default: [] },
    clientIds: { type: [String], default: [] },
    publishAt: { type: Date, required: true, index: true },
    effectiveAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null, index: true },
    dismissible: { type: Boolean, default: true },
    linkLabel: { type: String, default: '', trim: true, maxlength: 80 },
    linkUrl: { type: String, default: '', trim: true, maxlength: 500 },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('DashboardNotice', dashboardNoticeSchema);
