const CANONICAL = new Set([
  'pending',
  'processed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
  'canceled',
  'completed',
  'refunded',
]);

function normalizeOrderStatus(raw, fallback = 'pending') {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return fallback;
  const s = trimmed.toLowerCase();
  if (s === 'canceled') return 'cancelled';
  if (s === 'processing') return 'processed';
  if (CANONICAL.has(s)) return s;
  // Preserve unknown / custom client statuses — do not force to pending
  return trimmed;
}

function generateOrderNumber() {
  const n = Math.floor(Math.random() * 1e6)
    .toString()
    .padStart(6, '0');
  return `KC-${n}`;
}

module.exports = {
  normalizeOrderStatus,
  generateOrderNumber,
};
