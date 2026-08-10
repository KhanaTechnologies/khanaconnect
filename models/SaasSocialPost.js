const mongoose = require('mongoose');

const saasSocialPostSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    destinations: {
      type: [String],
      default: ['instagram'],
    },
    mediaType: {
      type: String,
      enum: ['IMAGE', 'CAROUSEL', 'VIDEO', 'REELS', 'TEXT'],
      default: 'IMAGE',
    },
    caption: { type: String, default: '' },
    imageUrls: { type: [String], default: [] },
    videoUrl: { type: String, default: '' },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled'],
      default: 'draft',
      index: true,
    },
    scheduledFor: { type: Date, default: null, index: true },
    publishedAt: { type: Date, default: null },
    agendaJobId: { type: String, default: '' },
    results: { type: mongoose.Schema.Types.Mixed, default: null },
    lastError: { type: String, default: '' },
  },
  { timestamps: true }
);

saasSocialPostSchema.index({ client_id: 1, status: 1, scheduledFor: 1 });

module.exports = mongoose.model('SaasSocialPost', saasSocialPostSchema);
