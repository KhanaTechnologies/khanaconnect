const crypto = require('crypto');
const SaasIdempotencyKey = require('../models/SaasIdempotencyKey');

function stableJson(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
}

function hashRequestBody(body) {
  return crypto.createHash('sha256').update(stableJson(body || {})).digest('hex');
}

function idempotencyGuard(scope, ttlHours = 24) {
  return async function (req, res, next) {
    const key = String(req.headers['idempotency-key'] || '').trim();
    if (!key) return next();
    if (!req.tenant?.clientId) {
      return res.status(400).json({ ok: false, message: 'Tenant is required before idempotency guard' });
    }

    const requestHash = hashRequestBody(req.body || {});
    const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);

    const existing = await SaasIdempotencyKey.findOne({
      client_id: req.tenant.clientId,
      scope,
      idempotency_key: key,
      expires_at: { $gt: new Date() },
    }).lean();

    if (existing) {
      if (existing.request_hash !== requestHash) {
        return res.status(409).json({
          ok: false,
          message: 'Idempotency key reuse with different request payload',
        });
      }
      if (existing.completed) {
        return res.status(existing.response_status || 200).json(existing.response_body);
      }
      return res.status(409).json({ ok: false, message: 'Duplicate request in progress' });
    }

    await SaasIdempotencyKey.create({
      client_id: req.tenant.clientId,
      scope,
      idempotency_key: key,
      request_hash: requestHash,
      expires_at: expiresAt,
      completed: false,
    });

    const originalJson = res.json.bind(res);
    res.json = async (payload) => {
      try {
        await SaasIdempotencyKey.updateOne(
          { client_id: req.tenant.clientId, scope, idempotency_key: key },
          {
            $set: {
              completed: true,
              response_status: res.statusCode || 200,
              response_body: payload,
            },
          }
        );
      } catch (_) {}
      return originalJson(payload);
    };

    return next();
  };
}

module.exports = { idempotencyGuard };
