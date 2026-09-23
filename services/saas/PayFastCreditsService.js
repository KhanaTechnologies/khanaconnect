const { creditsForTopupPayment, prepaidCheaperHint } = require('../../helpers/creditPacks');
const BillingService = require('./BillingService');
const SaasTransaction = require('../../models/SaasTransaction');
const { validateItnWithPayfast } = require('../../helpers/payfast');
const crypto = require('crypto');

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
    const body = payload || {};
    const passphrase = process.env.PAYFAST_PASSPHRASE || '';
    if (!passphrase) {
      throw new Error('PAYFAST_PASSPHRASE is not configured');
    }
    if (!verifyPayFastSignature(body, passphrase)) {
      throw new Error('Invalid PayFast signature');
    }

    const confirmed = await validateItnWithPayfast(body);
    if (!confirmed) {
      throw new Error('PayFast ITN did not validate');
    }

    if (String(body.payment_status || '').trim() !== 'COMPLETE') {
      return { ignored: true, reason: body.payment_status || 'not_complete' };
    }

    const clientId = String(body.custom_str1 || '').trim();
    if (!clientId) throw new Error('Missing client identifier in PayFast ITN payload');

    const amount = Number(body.amount_gross || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Invalid amount_gross');
    }

    // custom_str2 = prepaid pack id (growth, pro, …). Without a pack → higher spot rate.
    const packId = String(body.custom_str2 || body.pack_id || '').trim();
    const awarded = creditsForTopupPayment({
      amountZar: amount,
      packId,
      preferSpot: !packId,
    });

    const reference = String(body.pf_payment_id || body.m_payment_id || '').trim();
    if (!reference) throw new Error('Missing PayFast payment reference');

    const existing = await SaasTransaction.findOne({
      method: 'payfast',
      type: 'topup',
      reference,
      status: 'success',
    });
    if (existing) {
      return { alreadyProcessed: true, clientId: existing.client_id, reference };
    }

    const result = await BillingService.topUpCredits({
      clientId,
      credits: awarded.credits,
      amount,
      method: 'payfast',
      reference,
      metadata: {
        pf_payment_id: body.pf_payment_id,
        m_payment_id: body.m_payment_id,
        merchant_id: body.merchant_id,
        packId: awarded.packId || null,
        rateLabel: awarded.rateLabel,
        zarPerCredit: awarded.zarPerCredit,
        hint: prepaidCheaperHint(),
      },
    });

    return { ...result, awarded };
  }
}

module.exports = PayFastCreditsService;
