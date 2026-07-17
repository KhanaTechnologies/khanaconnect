const mongoose = require('mongoose');

const b2bAuditLogSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'B2BBuyer', default: null },
    teamMemberId: { type: mongoose.Schema.Types.ObjectId, ref: 'TeamMember', default: null },
    event: { type: String, required: true, index: true },
    summary: { type: String, default: '' },
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

b2bAuditLogSchema.index({ clientID: 1, createdAt: -1 });

module.exports = mongoose.model('B2BAuditLog', b2bAuditLogSchema);
