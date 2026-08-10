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
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'sending', 'sent', 'failed'],
      default: 'draft',
      index: true,
    },
    scheduledFor: {
      type: Date,
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    recipientCount: {
      type: Number,
      default: 0,
    },
    lastSendError: {
      type: String,
      default: '',
    },
    agendaJobId: {
      type: String,
      default: '',
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

newsletterDraftSchema.index({ clientID: 1, updatedAt: -1 });
newsletterDraftSchema.index({ clientID: 1, status: 1, scheduledFor: 1 });

module.exports = mongoose.model('NewsletterDraft', newsletterDraftSchema);
