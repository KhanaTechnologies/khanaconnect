const mongoose = require('mongoose');

const b2bLoginChallengeSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    buyerId: { type: mongoose.Schema.Types.ObjectId, ref: 'B2BBuyer', required: true },
    codeHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true, index: true },
    attempts: { type: Number, default: 0 },
    consumedAt: { type: Date, default: null },
    ipAddress: { type: String, default: '' },
    userAgent: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('B2BLoginChallenge', b2bLoginChallengeSchema);
