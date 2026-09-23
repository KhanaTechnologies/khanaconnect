/**
 * Prepaid Khana credit packs — buying ahead is cheaper per credit than spot top-ups.
 * Spot rate is intentionally worse so clients who wait until they need an ad pay more.
 */

const SPOT_ZAR_PER_CREDIT = Number(process.env.CREDITS_SPOT_ZAR_PER_CREDIT || 1.25);

/** Larger packs → more credits per rand (prepaid discount). */
const CREDIT_PACKS = [
  {
    id: 'starter',
    name: 'Starter',
    zar: 100,
    credits: 100,
    badge: null,
    description: 'List rate — good to get started',
  },
  {
    id: 'growth',
    name: 'Growth',
    zar: 250,
    credits: 300,
    badge: 'Save ~17%',
    description: 'Best for regular WhatsApp + occasional boosts',
  },
  {
    id: 'pro',
    name: 'Pro',
    zar: 500,
    credits: 650,
    badge: 'Save ~23%',
    description: 'Cheaper per credit when you plan campaigns ahead',
  },
  {
    id: 'scale',
    name: 'Scale',
    zar: 1000,
    credits: 1400,
    badge: 'Best value',
    description: 'Lowest rate — buy before you need to run ads',
  },
];

function enrichPack(pack) {
  const zar = Number(pack.zar);
  const credits = Number(pack.credits);
  const perCreditZar = credits > 0 ? Number((zar / credits).toFixed(4)) : zar;
  const spotCreditsForSameZar = zar / SPOT_ZAR_PER_CREDIT;
  const extraVsSpot = Number((credits - spotCreditsForSameZar).toFixed(2));
  return {
    ...pack,
    zar,
    credits,
    perCreditZar,
    currency: 'ZAR',
    spotZarPerCredit: SPOT_ZAR_PER_CREDIT,
    savingsVsSpotCredits: Math.max(0, extraVsSpot),
  };
}

function listCreditPacks() {
  return CREDIT_PACKS.map(enrichPack);
}

function getCreditPack(packId) {
  const id = String(packId || '').trim().toLowerCase();
  const pack = CREDIT_PACKS.find((p) => p.id === id);
  return pack ? enrichPack(pack) : null;
}

/**
 * Resolve credits awarded for a PayFast (or manual) top-up.
 * Prefer pack_id when present and amount matches; otherwise spot-rate math is worse than packs.
 */
function creditsForTopupPayment({ amountZar, packId = '', preferSpot = false } = {}) {
  const amount = Number(amountZar);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Invalid top-up amount');
  }

  const pack = getCreditPack(packId);
  if (pack) {
    const tol = Math.max(1, pack.zar * 0.02);
    if (Math.abs(amount - pack.zar) <= tol) {
      return {
        credits: pack.credits,
        packId: pack.id,
        rateLabel: `pack:${pack.id}`,
        zarPerCredit: pack.perCreditZar,
      };
    }
    // Amount does not match pack — fall through to proportional pack rate (still better than spot).
    const credits = Number(((amount / pack.zar) * pack.credits).toFixed(4));
    return {
      credits,
      packId: pack.id,
      rateLabel: `pack_prorata:${pack.id}`,
      zarPerCredit: pack.perCreditZar,
    };
  }

  const listRate = Number(process.env.CREDITS_PER_ZAR || 1);
  if (preferSpot || String(process.env.CREDITS_USE_SPOT_WITHOUT_PACK || '1') === '1') {
    const zarPer = SPOT_ZAR_PER_CREDIT;
    return {
      credits: Number((amount / zarPer).toFixed(4)),
      packId: '',
      rateLabel: 'spot',
      zarPerCredit: zarPer,
    };
  }

  return {
    credits: Number((amount * listRate).toFixed(4)),
    packId: '',
    rateLabel: 'list',
    zarPerCredit: listRate > 0 ? Number((1 / listRate).toFixed(4)) : 1,
  };
}

function prepaidCheaperHint() {
  return (
    'Your partnership includes monthly WhatsApp/ads credits (unused expire at month-end). ' +
    'Prepaid packs never expire and are cheaper per credit than last-minute top-ups — buy ahead before heavy campaigns.'
  );
}

module.exports = {
  CREDIT_PACKS,
  SPOT_ZAR_PER_CREDIT,
  listCreditPacks,
  getCreditPack,
  creditsForTopupPayment,
  prepaidCheaperHint,
  enrichPack,
};
