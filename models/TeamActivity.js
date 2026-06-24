const mongoose = require('mongoose');

const teamActivitySchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    category: {
      type: String,
      enum: ['team', 'orders', 'products', 'bookings', 'sales', 'email', 'campaigns', 'account'],
      required: true,
      index: true,
    },
    action: { type: String, required: true },
    summary: { type: String, required: true },
    actorMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'TeamMember', default: null },
    actorLabel: { type: String, default: 'System' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

teamActivitySchema.index({ clientID: 1, createdAt: -1 });

module.exports = mongoose.model('TeamActivity', teamActivitySchema);
