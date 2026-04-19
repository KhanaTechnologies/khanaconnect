function getJwtSecrets() {
  const raw = [process.env.ENCRYPTION_KEY, process.env.JWT_SECRET, process.env.secret]
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());
  return [...new Set(raw)];
}

function getJwtSecret() {
  const list = getJwtSecrets();
  return list[0];
}

function verifyJwtWithAnySecret(jwt, token) {
  const secrets = getJwtSecrets();
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
