const crypto = require('crypto');

function safeEqualHex(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  try {
    return crypto.timingSafeEqual(A, B);
  } catch {
    return false;
  }
}

function getRawBody(req) {
  if (typeof req.rawBody === 'string' && req.rawBody.length > 0) return req.rawBody;
  return JSON.stringify(req.body || {});
}

function verifyMetaWebhookSignature(appSecretEnvName) {
  return function (req, res, next) {
    const appSecret = process.env[appSecretEnvName] || '';
    if (!appSecret) {
      return res.status(500).json({ ok: false, message: `Missing ${appSecretEnvName} for webhook signature validation` });
    }
    const signature = String(req.headers['x-hub-signature-256'] || '');
    if (!signature.startsWith('sha256=')) {
      return res.status(401).json({ ok: false, message: 'Missing Meta webhook signature' });
    }
    const digest = crypto
      .createHmac('sha256', appSecret)
      .update(getRawBody(req), 'utf8')
      .digest('hex');
    const expected = `sha256=${digest}`;
    if (!safeEqualHex(signature, expected)) {
      return res.status(401).json({ ok: false, message: 'Invalid Meta webhook signature' });
    }
    return next();
  };
}

function handleMetaWebhookChallenge(verifyTokenEnvName) {
  return function (req, res) {
    const mode = String(req.query['hub.mode'] || '');
    const token = String(req.query['hub.verify_token'] || '');
    const challenge = String(req.query['hub.challenge'] || '');
    const expected = String(process.env[verifyTokenEnvName] || '');
    if (mode === 'subscribe' && expected && token === expected) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Verification failed');
  };
}

module.exports = {
  verifyMetaWebhookSignature,
  handleMetaWebhookChallenge,
};
