const mongoose = require('mongoose');

/**
 * An invite to the private website-design gallery on the marketing site (/templates).
 * The token in the link is the only credential: anyone holding a live (not expired or
 * revoked) link can browse the designs. Khana admins create, resend and revoke them.
 */
const templateGalleryInviteSchema = new mongoose.Schema(
  {
    token: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: '', trim: true, maxlength: 80 },
    businessName: { type: String, default: '', trim: true, maxlength: 80 },
    email: { type: String, default: '', trim: true, lowercase: true, maxlength: 200 },
    /** Private note for Khana (where the lead came from, what they asked for). Never shown to the client. */
    note: { type: String, default: '', trim: true, maxlength: 500 },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    emailSentAt: { type: Date, default: null },
    viewCount: { type: Number, default: 0 },
    firstViewedAt: { type: Date, default: null },
    lastViewedAt: { type: Date, default: null },
    createdBy: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TemplateGalleryInvite', templateGalleryInviteSchema);
