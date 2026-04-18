/**
 * PayFast ITN (Instant Transaction Notification) validation.
 * @see https://developers.payfast.co.za/docs#step_4_confirm_payment
 *
 * PayFast requires POSTing the received variables back to /eng/query/validate.
 * Response body must be the plain text "VALID" to treat the ITN as authentic.
 */

const axios = require('axios');

function payfastHost() {
  return process.env.PAYFAST_SANDBOX === 'true' ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
}

/**
 * Re-post ITN fields to PayFast for server-side confirmation.
 * @param {Record<string, string>} body - req.body from urlencoded ITN
 * @returns {Promise<boolean>} true if PayFast responds with VALID
 */
async function validateItnWithPayfast(body) {
  if (!body || typeof body !== 'object') return false;

  const url = `https://${payfastHost()}/eng/query/validate`;
  const params = new URLSearchParams();

  for (const [key, val] of Object.entries(body)) {
    if (val === undefined || val === null) continue;
    if (String(val) === '') continue;
    params.append(key, String(val));
  }

  try {
    const response = await axios.post(url, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 20000,
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 500,
    });

    const text =
      typeof response.data === 'string' ? response.data.trim() : String(response.data || '').trim();
    return text === 'VALID';
  } catch (err) {
    console.error('PayFast validate request failed:', err.message);
    return false;
  }
}

module.exports = {
  validateItnWithPayfast,
  payfastHost,
};
