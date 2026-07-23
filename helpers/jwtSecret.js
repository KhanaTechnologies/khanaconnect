/**
 * JWT signing / verification secrets.
 *
 * Prefer a single strong JWT_SECRET (32+ random bytes).
 * Legacy ENCRYPTION_KEY / `secret` remain accepted for verify-only so existing
 * tokens keep working during rotation — new tokens always use getJwtSecret().
 */

const MIN_SECRET_LENGTH = 32;

function getConfiguredSecrets() {
  const raw = [process.env.JWT_SECRET, process.env.ENCRYPTION_KEY, process.env.secret]
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
  return [...new Set(raw)];
}

function getJwtSecrets() {
  return getConfiguredSecrets();
}

function getJwtSecret() {
  const list = getConfiguredSecrets();
  if (!list.length) {
    throw new Error(
      'JWT_SECRET is not configured. Set a strong JWT_SECRET (32+ characters) in the environment.'
    );
  }

  const preferred = process.env.JWT_SECRET && process.env.JWT_SECRET.trim();
  const secret = (preferred && list.includes(preferred) ? preferred : list[0]);

  if (secret.length < MIN_SECRET_LENGTH && process.env.NODE_ENV === 'production') {
    console.warn(
      `[security] JWT signing secret is only ${secret.length} chars; use a 32+ character JWT_SECRET.`
    );
  }

  return secret;
}

function verifyJwtWithAnySecret(jwt, token) {
  const secrets = getConfiguredSecrets();
  if (!secrets.length) {
    throw new Error('No JWT secret configured');
  }

  let lastError = null;
  for (const secret of secrets) {
    try {
      return { decoded: jwt.verify(token, secret), secretUsed: secret };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('No JWT secret configured');
}

module.exports = { getJwtSecret, getJwtSecrets, verifyJwtWithAnySecret };
