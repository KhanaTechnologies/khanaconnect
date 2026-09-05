const express = require('express');
const { publicLegalMeta } = require('../helpers/legalPolicies');
const { renderLegalPage, renderLegalIndex } = require('../helpers/legalHtml');

const router = express.Router();

function sendHtml(res, html) {
  if (!html) return res.status(404).type('text').send('Not found');
  res.set('Cache-Control', 'public, max-age=300');
  res.type('html').send(html);
}

function sendPolicies(req, res) {
  res.set('Cache-Control', 'public, max-age=120');
  res.json({ success: true, legal: publicLegalMeta() });
}

router.get('/legal', (_req, res) => sendHtml(res, renderLegalIndex()));
router.get('/terms', (_req, res) => sendHtml(res, renderLegalPage('tos')));
router.get('/terms-of-service', (_req, res) => sendHtml(res, renderLegalPage('tos')));
router.get('/aup', (_req, res) => sendHtml(res, renderLegalPage('aup')));
router.get('/acceptable-use', (_req, res) => sendHtml(res, renderLegalPage('aup')));
router.get('/legal/takedown', (_req, res) => sendHtml(res, renderLegalPage('takedown')));
router.get('/legal/policies', sendPolicies);
router.get('/legal/policies.json', sendPolicies);

const apiRouter = express.Router();
apiRouter.get('/legal/policies', sendPolicies);

module.exports = router;
module.exports.apiRouter = apiRouter;
