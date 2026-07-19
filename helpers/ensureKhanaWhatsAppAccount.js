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

  // Avoid #100/33 from findOne picking an older active Khana row (different Phone number ID).
  const stale = await SaasWhatsAppAccount.updateMany(
    {
      client_id: 'Khana',
      status: 'active',
      phone_number_id: { $ne: phone_number_id },
    },
    { $set: { status: 'disabled' } }
  );
  if (stale.modifiedCount > 0) {
    console.log(
      `[whatsapp] disabled ${stale.modifiedCount} stale Khana WhatsApp account(s); active phone_number_id=${phone_number_id}`
    );
  } else {
    console.log('[whatsapp] Khana Cloud API account active for phone_number_id', phone_number_id);
  }
  return doc;
}

module.exports = { ensureKhanaWhatsAppAccountFromEnv };
