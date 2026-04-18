const mongoose = require('mongoose');

/** Records newsletter open (tracking pixel) events */
const NewsletterOpenSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    newsletterId: { type: String, required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    openedAt: { type: Date, default: Date.now },
    userAgent: { type: String, default: '' },
  },
  { timestamps: true }
);

NewsletterOpenSchema.index({ clientID: 1, newsletterId: 1, email: 1, openedAt: -1 });

module.exports = mongoose.model('NewsletterOpen', NewsletterOpenSchema);
