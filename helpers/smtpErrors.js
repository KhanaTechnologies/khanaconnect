/**
 * Shared SMTP error classification for retry + outbound queue logic.
 */

function isNonRetryableSmtpError(err) {
  const m = String((err && err.message) || '');
  const code = err && err.responseCode;
  if (code === 535 || code === 534 || code === 533) return true;
  if (/535|534|533|authentication failed|invalid credentials|bad username or password|not accepted/i.test(m)) return true;
  if (/550|551|552|553|554|permanent|mailbox unavailable|user unknown|no such user|invalid recipient|recipient rejected|policy rejection|spam|blocked|blacklist/i.test(m))
    return true;
  return false;
}

function isRetryableSmtpError(err) {
  if (!err || isNonRetryableSmtpError(err)) return false;
  const c = err.code;
  const m = String(err.message || '');
  if (c === 'ECONNRESET' || c === 'ETIMEDOUT' || c === 'ECONNREFUSED' || c === 'ESOCKET' || c === 'EPIPE') return true;
  if (/ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|connection closed|TLS|SSL|wrong version number|SSL routines/i.test(m)) return true;
  const rc = err.responseCode;
  if (typeof rc === 'number' && rc >= 420 && rc < 500) return true;
  return false;
}

module.exports = {
  isNonRetryableSmtpError,
  isRetryableSmtpError,
};
