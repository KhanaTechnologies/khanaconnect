const express = require('express');
const multer = require('multer');
const NewsletterDraft = require('../models/NewsletterDraft');
const { wrapRoute } = require('../helpers/failureEmail');
const {
  listNewsletterTemplates,
  getNewsletterTemplate,
  isKnownTemplateId,
} = require('../helpers/newsletterTemplates');
const {
  FILE_TYPE_MAP,
  uploadNewsletterImage,
  validateNewsletterHtml,
} = require('../helpers/newsletterBuilder');

const router = express.Router();

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!FILE_TYPE_MAP[file.mimetype]) {
      return cb(new Error('Invalid file type. Use PNG, JPEG, GIF, or WebP.'), false);
    }
    cb(null, true);
  },
});

function pickUploadedImageFile(req) {
  if (req.file) return req.file;
  const names = ['image', 'file', 'photo', 'signature'];
  if (!req.files) return null;
  for (const name of names) {
    const list = req.files[name];
    if (list && list[0]) return list[0];
  }
  return null;
}

function acceptImageUpload(req, res, next) {
  imageUpload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'file', maxCount: 1 },
    { name: 'photo', maxCount: 1 },
  ])(req, res, (err) => {
    if (err) {
      return res.status(400).json({ ok: false, message: err.message || 'Upload failed' });
    }
    req.file = pickUploadedImageFile(req);
    return next();
  });
}

function parseJsonBody(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/** GET /newsletter/templates — list builder templates + field schemas */
router.get('/templates', wrapRoute(async (_req, res) => {
  res.json({
    ok: true,
    data: listNewsletterTemplates(),
  });
}));

/** GET /newsletter/templates/:templateId — template detail incl. htmlStructure starter */
router.get('/templates/:templateId', wrapRoute(async (req, res) => {
  const template = getNewsletterTemplate(req.params.templateId);
  if (!template) {
    return res.status(404).json({ ok: false, message: 'Template not found' });
  }
  res.json({ ok: true, data: template });
}));

/**
 * POST /newsletter/images — upload a newsletter asset (GitHub or /public/uploads).
 * Multipart field: image | file | photo
 */
router.post('/images', acceptImageUpload, wrapRoute(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      message: 'Missing image file (field name: image, file, or photo)',
    });
  }

  const result = await uploadNewsletterImage(req.file, req);
  res.status(201).json({
    ok: true,
    message: 'Image uploaded',
    data: {
      url: result.url,
      fileName: result.fileName,
    },
  });
}));

/**
 * POST /newsletter/preview — validate dashboard-composed HTML before send.
 * Body: { html, subject?, text?, templateId?, payload? }
 */
router.post('/preview', wrapRoute(async (req, res) => {
  const { html, subject, text, templateId, payload } = req.body || {};

  if (templateId && !isKnownTemplateId(templateId)) {
    return res.status(400).json({ ok: false, message: 'Unknown templateId' });
  }

  const validated = validateNewsletterHtml(html);
  if (!validated.ok) {
    return res.status(400).json({ ok: false, message: validated.error, warnings: validated.warnings });
  }

  res.json({
    ok: true,
    data: {
      subject: subject || '',
      html: validated.html,
      text: text || validated.text,
      templateId: templateId || null,
      payload: parseJsonBody(payload, {}),
      warnings: validated.warnings,
    },
  });
}));

/** GET /newsletter/drafts */
router.get('/drafts', wrapRoute(async (req, res) => {
  const drafts = await NewsletterDraft.find({
    clientID: req.client.clientID,
    isDeleted: false,
  })
    .sort({ updatedAt: -1 })
    .select('name templateId subject updatedAt createdAt')
    .lean();

  res.json({ ok: true, data: drafts });
}));

/** POST /newsletter/drafts */
router.post('/drafts', wrapRoute(async (req, res) => {
  const { name, templateId, subject, html, text, payload } = req.body || {};

  if (templateId && !isKnownTemplateId(templateId)) {
    return res.status(400).json({ ok: false, message: 'Unknown templateId' });
  }

  let safeHtml = html || '';
  let safeText = text || '';
  if (html) {
    const validated = validateNewsletterHtml(html);
    if (!validated.ok) {
      return res.status(400).json({ ok: false, message: validated.error });
    }
    safeHtml = validated.html;
    safeText = text || validated.text;
  }

  const draft = await NewsletterDraft.create({
    clientID: req.client.clientID,
    name: name || 'Untitled draft',
    templateId: templateId || '',
    subject: subject || '',
    html: safeHtml,
    text: safeText,
    payload: parseJsonBody(payload, {}),
  });

  res.status(201).json({ ok: true, data: draft });
}));

/** GET /newsletter/drafts/:id */
router.get('/drafts/:id', wrapRoute(async (req, res) => {
  const draft = await NewsletterDraft.findOne({
    _id: req.params.id,
    clientID: req.client.clientID,
    isDeleted: false,
  });

  if (!draft) {
    return res.status(404).json({ ok: false, message: 'Draft not found' });
  }

  res.json({ ok: true, data: draft });
}));

/** PUT /newsletter/drafts/:id */
router.put('/drafts/:id', wrapRoute(async (req, res) => {
  const draft = await NewsletterDraft.findOne({
    _id: req.params.id,
    clientID: req.client.clientID,
    isDeleted: false,
  });

  if (!draft) {
    return res.status(404).json({ ok: false, message: 'Draft not found' });
  }

  const { name, templateId, subject, html, text, payload } = req.body || {};

  if (templateId && !isKnownTemplateId(templateId)) {
    return res.status(400).json({ ok: false, message: 'Unknown templateId' });
  }

  if (name != null) draft.name = name;
  if (templateId != null) draft.templateId = templateId;
  if (subject != null) draft.subject = subject;
  if (payload != null) draft.payload = parseJsonBody(payload, {});

  if (html != null) {
    const validated = validateNewsletterHtml(html);
    if (!validated.ok) {
      return res.status(400).json({ ok: false, message: validated.error });
    }
    draft.html = validated.html;
    draft.text = text != null ? text : validated.text;
  } else if (text != null) {
    draft.text = text;
  }

  await draft.save();
  res.json({ ok: true, data: draft });
}));

/** DELETE /newsletter/drafts/:id */
router.delete('/drafts/:id', wrapRoute(async (req, res) => {
  const draft = await NewsletterDraft.findOneAndUpdate(
    { _id: req.params.id, clientID: req.client.clientID, isDeleted: false },
    { isDeleted: true },
    { new: true }
  );

  if (!draft) {
    return res.status(404).json({ ok: false, message: 'Draft not found' });
  }

  res.json({ ok: true, message: 'Draft deleted' });
}));

module.exports = router;
