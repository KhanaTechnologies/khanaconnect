const mongoose = require('mongoose');

/**
 * Client success stories for the marketing site. Edited by platform admins at
 * /dashboard/case-studies; only `published` ones are public.
 */
const metricSchema = new mongoose.Schema(
  {
    value: { type: String, required: true, trim: true, maxlength: 40 }, // e.g. "R12,400"
    label: { type: String, required: true, trim: true, maxlength: 80 }, // e.g. "recovered from abandoned carts"
  },
  { _id: false }
);

const caseStudySchema = new mongoose.Schema(
  {
    company: { type: String, required: true, trim: true, maxlength: 120 },
    industry: { type: String, default: '', trim: true, maxlength: 80 },
    website: { type: String, default: '', trim: true, maxlength: 300 },
    logoUrl: { type: String, default: '', trim: true, maxlength: 500 },
    headline: { type: String, required: true, trim: true, maxlength: 160 },
    summary: { type: String, default: '', trim: true, maxlength: 1200 },
    metrics: { type: [metricSchema], default: [], validate: (v) => v.length <= 4 },
    quote: { type: String, default: '', trim: true, maxlength: 600 },
    quoteAuthor: { type: String, default: '', trim: true, maxlength: 120 },
    published: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

caseStudySchema.index({ published: 1, sortOrder: 1 });

module.exports = mongoose.models.CaseStudy || mongoose.model('CaseStudy', caseStudySchema);
