/**
 * Client-facing WhatsApp credit rates (1 credit ≈ R1).
 * Utility/auth use volume discounts based on calendar-month send count.
 */
const VOLUME_TIERS = {
  utility: [
    { min: 0, cost: 1.0, label: 'Standard' },
    { min: 1000, cost: 0.85, label: 'Volume' },
    { min: 5000, cost: 0.75, label: 'High volume' },
  ],
  auth: [
    { min: 0, cost: 1.0, label: 'Standard' },
    { min: 1000, cost: 0.85, label: 'Volume' },
    { min: 5000, cost: 0.75, label: 'High volume' },
  ],
};

const FLAT_RATES = {
  marketing: 2.25,
  service: 0.2,
};

function tiersForMessageType(messageType) {
  const key = String(messageType || '').toLowerCase();
  return VOLUME_TIERS[key] || null;
}

function unitCostAtVolume(messageType, monthCountSoFar) {
  const key = String(messageType || '').toLowerCase();
  const flat = FLAT_RATES[key];
  if (flat != null) return flat;

  const tiers = tiersForMessageType(key);
  if (!tiers?.length) return null;

  const n = Math.max(0, Number(monthCountSoFar) || 0);
  let cost = tiers[0].cost;
  for (const tier of tiers) {
    if (n >= tier.min) cost = tier.cost;
  }
  return cost;
}

/**
 * Progressive pricing across `units` starting after `monthCountSoFar` messages this month.
 */
function creditsForUnits(messageType, monthCountSoFar, units = 1) {
  const count = Math.max(0, Number(monthCountSoFar) || 0);
  const qty = Math.max(1, Number(units) || 1);
  let total = 0;
  for (let i = 0; i < qty; i += 1) {
    const rate = unitCostAtVolume(messageType, count + i);
    if (rate == null) return null;
    total += rate;
  }
  return Number(total.toFixed(4));
}

function describeVolumeTiers(messageType) {
  const tiers = tiersForMessageType(messageType);
  if (!tiers?.length) {
    const flat = FLAT_RATES[String(messageType || '').toLowerCase()];
    return flat != null ? [`Flat ${flat} credits / message`] : [];
  }
  return tiers.map((t, i) => {
    const next = tiers[i + 1];
    const range = next ? `${t.min}–${next.min - 1}/mo` : `${t.min}+/mo`;
    return `${t.label}: ${t.cost} credits (${range})`;
  });
}

module.exports = {
  VOLUME_TIERS,
  FLAT_RATES,
  unitCostAtVolume,
  creditsForUnits,
  describeVolumeTiers,
  tiersForMessageType,
};
