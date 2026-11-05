const express = require('express');
const mongoose = require('mongoose');
const CaseStudy = require('../models/CaseStudy');
const { wrapRoute } = require('../helpers/failureEmail');
const { requireAdmin } = require('../middleware/requireAdmin');

const router = express.Router();

const EDITABLE = ['company', 'industry', 'website', 'logoUrl', 'headline', 'summary', 'metrics', 'quote', 'quoteAuthor', 'published', 'sortOrder'];
const HTTP_URL = /^https?:\/\//i;

function pickEditable(body) {
  const out = {};
  for (const key of EDITABLE) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  if (Array.isArray(out.metrics)) {
    out.metrics = out.metrics
      .filter((m) => m && String(m.value || '').trim() && String(m.label || '').trim())
      .slice(0, 4)
      .map((m) => ({ value: String(m.value).trim(), label: String(m.label).trim() }));
  }
  for (const key of ['website', 'logoUrl']) {
    if (out[key] && !HTTP_URL.test(String(out[key]))) out[key] = '';
  }
  if (out.published !== undefined) out.published = !!out.published;
  if (out.sortOrder !== undefined) out.sortOrder = Number(out.sortOrder) || 0;
  return out;
}

function validId(req, res) {
  if (mongoose.isValidObjectId(req.params.id)) return true;
  res.status(400).json({ success: false, error: 'Invalid id' });
  return false;
}

/** Public — marketing website (published only). */
router.get('/public/case-studies', wrapRoute(async (_req, res) => {
  const items = await CaseStudy.find({ published: true })
    .sort({ sortOrder: 1, createdAt: -1 })
    .select('-__v -published')
    .lean();
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ success: true, items });
}));

/** Admin — all case studies, including drafts. */
router.get('/admin/case-studies', requireAdmin, wrapRoute(async (_req, res) => {
  const items = await CaseStudy.find().sort({ sortOrder: 1, createdAt: -1 }).lean();
  res.json({ success: true, items });
}));

router.post('/admin/case-studies', requireAdmin, wrapRoute(async (req, res) => {
  try {
    const item = await CaseStudy.create(pickEditable(req.body || {}));
    res.status(201).json({ success: true, item });
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
    throw err;
  }
}));

router.put('/admin/case-studies/:id', requireAdmin, wrapRoute(async (req, res) => {
  if (!validId(req, res)) return;
  try {
    const item = await CaseStudy.findByIdAndUpdate(req.params.id, { $set: pickEditable(req.body || {}) }, {
      new: true,
      runValidators: true,
    });
    if (!item) return res.status(404).json({ success: false, error: 'Not found' });
    res.json({ success: true, item });
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ success: false, error: err.message });
    throw err;
  }
}));

router.delete('/admin/case-studies/:id', requireAdmin, wrapRoute(async (req, res) => {
  if (!validId(req, res)) return;
  const result = await CaseStudy.deleteOne({ _id: req.params.id });
  if (!result.deletedCount) return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true });
}));

module.exports = router;
