const mongoose = require('mongoose');

const stageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    order: { type: Number, default: 0 },
    color: { type: String, default: '' },
    isClosed: { type: Boolean, default: false },
  },
  { _id: false }
);

const saasCrmWorkspaceSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, unique: true, index: true },
    vertical: {
      type: String,
      enum: ['generic', 'salon', 'restaurant', 'retail', 'services'],
      default: 'generic',
      index: true,
    },
    stages: { type: [stageSchema], default: [] },
    reminderSettings: {
      enabled: { type: Boolean, default: true },
      minutesBefore: { type: Number, default: 30, min: 0, max: 60 * 24 * 7 },
      followUpMinutes: { type: Number, default: 1440, min: 0, max: 60 * 24 * 30 },
    },
    templateAppliedAt: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

module.exports = mongoose.model('SaasCrmWorkspace', saasCrmWorkspaceSchema);
