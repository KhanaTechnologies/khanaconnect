const mongoose = require('mongoose');

const newsletterDraftSchema = new mongoose.Schema(
  {
    clientID: {
      type: String,
      required: true,
      index: true,
    },
    name: {
      type: String,
      trim: true,
      maxlength: 200,
      default: 'Untitled draft',
    },
    templateId: {
      type: String,
      trim: true,
      default: '',
    },
    subject: {
      type: String,
      trim: true,
      maxlength: 300,
      default: '',
    },
    html: {
      type: String,
      default: '',
    },
    text: {
      type: String,
      default: '',
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

newsletterDraftSchema.index({ clientID: 1, updatedAt: -1 });

module.exports = mongoose.model('NewsletterDraft', newsletterDraftSchema);
