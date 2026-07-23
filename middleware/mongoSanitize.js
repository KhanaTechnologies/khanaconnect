/**
 * Strip MongoDB operator / prototype-pollution keys from request input.
 * Prevents NoSQL injection via bodies like { email: { "$gt": "" } }.
 */

const DANGEROUS_KEY = /^\$/;

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function sanitizeValue(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    if (DANGEROUS_KEY.test(key)) {
      continue;
    }
    out[key] = sanitizeValue(child);
  }
  return out;
}

function sanitizeInPlace(target) {
  if (!isPlainObject(target) && !Array.isArray(target)) return;
  const cleaned = sanitizeValue(target);
  if (Array.isArray(target)) {
    target.length = 0;
    target.push(...cleaned);
    return;
  }
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, cleaned);
}

function mongoSanitize(req, _res, next) {
  try {
    if (req.body) sanitizeInPlace(req.body);
    if (req.query) sanitizeInPlace(req.query);
    if (req.params) sanitizeInPlace(req.params);
  } catch (err) {
    console.warn('[mongoSanitize] failed:', err.message);
  }
  return next();
}

module.exports = { mongoSanitize, sanitizeValue };
