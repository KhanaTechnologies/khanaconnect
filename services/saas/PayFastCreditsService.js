const crypto = require('crypto');
const BillingService = require('./BillingService');

function verifyPayFastSignature(payload, passphrase = '') {
  const incomingSig = payload.signature || '';
  const pairs = Object.keys(payload)
    .filter((k) => k !== 'signature')
    .sort()
    .map((k) => `${k}=${encodeURIComponent(String(payload[k]).trim()).replace(/%20/g, '+')}`);

  if (passphrase) pairs.push(`passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`);
  const query = pairs.join('&');
  const expected = crypto.createHash('md5').update(query).digest('hex');
  return incomingSig.toLowerCase() === expected.toLowerCase();
}

class PayFastCreditsService {
  static async handleTopupItn(payload) {
    const passphrase = process.env.PAYFAST_PASSPHRASE || '';
    if (!verifyPayFastSignature(payload, passphrase)) {
      throw new Error('Invalid PayFast signature');
    }

    const clientId = String(payload.custom_str1 || payload.name_first || '').trim();
    if (!clientId) throw new Error('Missing client identifier in PayFast ITN payload');

    const amount = Number(payload.amount_gross || payload.amount_fee || 0);
    const creditsMultiplier = Number(process.env.CREDITS_PER_ZAR || 1);
    const credits = Number((amount * creditsMultiplier).toFixed(4));
    const reference = payload.m_payment_id || payload.pf_payment_id || `pf-${Date.now()}`;

    return BillingService.topUpCredits({
      clientId,
      credits,
      amount,
      method: 'payfast',
      reference,
      metadata: payload,
    });
  }
}

module.exports = PayFastCreditsService;
