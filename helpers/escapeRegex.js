/**
 * Make user-typed search text safe to use inside a MongoDB $regex / RegExp:
 * special characters are matched literally, and very long input is cut short.
 */
function escapeRegex(value, maxLength = 200) {
  return String(value ?? '')
    .slice(0, maxLength)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { escapeRegex };
