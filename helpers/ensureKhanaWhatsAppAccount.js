const { encrypt } = require('./encryption');
const SaasWhatsAppAccount = require('../models/SaasWhatsAppAccount');

/**
 * Upsert Khana platform WhatsApp Cloud API account from Render env vars.
 * Safe to call on every boot — no-op if env incomplete.
 */
async function ensureKhanaWhatsAppAccountFromEnv() {
  const waba_id = String(process.env.WHATSAPP_WABA_ID || '').trim();
  const phone_number_id = String(process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const access_token = String(process.env.WHATSAPP_ACCESS_TOKEN || '').trim();

  if (!waba_id || !phone_number_id || !access_token) {
    console.log(
      '[whatsapp] Khana Cloud API env incomplete (WHATSAPP_WABA_ID / PHONE_NUMBER_ID / ACCESS_TOKEN) — skip upsert'
    );
    return null;
  }

  const doc = await SaasWhatsAppAccount.findOneAndUpdate(
    { client_id: 'Khana', phone_number_id },
    {
      $set: {
        client_id: 'Khana',
        waba_id,
        phone_number_id,
        mode: 'manual',
        access_token_encrypted: encrypt(access_token),
        status: 'active',
      },
    },
    { upsert: true, new: true }
  );

  console.log('[whatsapp] Khana Cloud API account active for phone_number_id', phone_number_id);
  return doc;
}

module.exports = { ensureKhanaWhatsAppAccountFromEnv };
