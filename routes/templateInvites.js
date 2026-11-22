const express = require('express');
const rateLimit = require('express-rate-limit');
const { wrapRoute } = require('../helpers/failureEmail');
const { requireAdmin } = require('../middleware/requireAdmin');
const {
  serializeInvite,
  createInvite,
  resendInvite,
  extendInvite,
  revokeInvite,
  listInvites,
  checkInvite,
} = require('../helpers/templateInvites');

/**
 * Invites to the private website-design gallery (/templates on the marketing site).
 *   Admin:  /admin/template-invites (list, create, send, extend, revoke)
 *   Public: /public/template-invites/:token (the gallery checks its link)
 */
const router = express.Router();

const checkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300, // the gallery re-checks on each page load
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Please try again later.' },
});

function sendError(res, err) {
  const status = err.status || 500;
  if (status >= 500) throw err;
  return res.status(status).json({ success: false, error: err.message });
}

router.get('/admin/template-invites', requireAdmin, wrapRoute(async (req, res) => {
  const invites = await listInvites({ limit: req.query.limit });
  const now = new Date();
  res.json({ success: true, invites: invites.map((i) => serializeInvite(i, now)) });
}));

router.post('/admin/template-invites', requireAdmin, wrapRoute(async (req, res) => {
  try {
    const { invite, emailError } = await createInvite(req.body || {}, {
      createdBy: req.user?.email || req.user?.clientID || '',
    });
    res.status(201).json({ success: true, invite: serializeInvite(invite), emailError });
  } catch (err) {
    sendError(res, err);
  }
}));

router.post('/admin/template-invites/:id/send', requireAdmin, wrapRoute(async (req, res) => {
  try {
    const invite = await resendInvite(req.params.id, { days: req.body?.days });
    res.json({ success: true, invite: serializeInvite(invite) });
  } catch (err) {
    sendError(res, err);
  }
}));

router.post('/admin/template-invites/:id/extend', requireAdmin, wrapRoute(async (req, res) => {
  try {
    const invite = await extendInvite(req.params.id, { days: req.body?.days });
    res.json({ success: true, invite: serializeInvite(invite) });
  } catch (err) {
    sendError(res, err);
  }
}));

router.delete('/admin/template-invites/:id', requireAdmin, wrapRoute(async (req, res) => {
  try {
    const invite = await revokeInvite(req.params.id);
    res.json({ success: true, invite: serializeInvite(invite) });
  } catch (err) {
    sendError(res, err);
  }
}));

router.get('/public/template-invites/:token', checkLimiter, wrapRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const result = await checkInvite(req.params.token, { countVisit: req.query.visit === '1' });
  res.status(result.valid ? 200 : 404).json({ success: result.valid, ...result });
}));

module.exports = router;
