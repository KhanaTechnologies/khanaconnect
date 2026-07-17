/**
 * WhatsApp click-to-chat helpers (wa.me links for Business App numbers).
 * Not Cloud API — no tokens required.
 */

/**
 * Normalize a phone number to digits-only E.164 without leading +.
 * South African local numbers starting with 0 become 27…
 * @param {string} raw
 * @param {string} [defaultCountryCode='27']
 * @returns {string} e.g. '27673572252' or '' if invalid
 */
function normalizePhoneE164(raw, defaultCountryCode = '27') {
  if (raw == null) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (!digits) return '';

  if (digits.startsWith('00')) {
    digits = digits.slice(2);
  }

  // Local SA: 072… → 2772…
  if (digits.startsWith('0') && digits.length >= 9 && digits.length <= 11) {
    digits = `${defaultCountryCode}${digits.slice(1)}`;
  }

  // Already has country code without +
  if (digits.length < 10 || digits.length > 15) return '';
  return digits;
}

/**
 * Build a wa.me click-to-chat URL.
 * @param {{ phoneE164?: string, phone?: string, message?: string }} opts
 * @returns {string} URL or '' if no valid phone
 */
function buildWhatsAppUrl({ phoneE164, phone, message } = {}) {
  const e164 = normalizePhoneE164(phoneE164 || phone || '');
  if (!e164) return '';

  const base = `https://wa.me/${e164}`;
  const text = message != null ? String(message).trim() : '';
  if (!text) return base;
  return `${base}?text=${encodeURIComponent(text)}`;
}

/**
 * Sanitize client.whatsapp settings from API body.
 * @param {object} input
 */
function sanitizeWhatsappSettings(input = {}) {
  const phoneE164 = normalizePhoneE164(input.phoneE164 || input.phone || '');
  const enabled = input.enabled === true;
  const displayLabel =
    typeof input.displayLabel === 'string' && input.displayLabel.trim()
      ? input.displayLabel.trim().slice(0, 80)
      : 'Chat on WhatsApp';
  const defaultMessage =
    typeof input.defaultMessage === 'string' ? input.defaultMessage.trim().slice(0, 500) : '';

  return {
    enabled: enabled && !!phoneE164,
    phoneE164,
    displayLabel,
    defaultMessage,
    notificationsEnabled: input.notificationsEnabled === true,
  };
}

/**
 * Public-safe WhatsApp payload for storefronts / dashboard preview.
 * @param {object|null|undefined} whatsapp
 */
function publicWhatsappPayload(whatsapp) {
  if (!whatsapp || typeof whatsapp !== 'object') {
    return {
      enabled: false,
      phoneE164: '',
      displayLabel: 'Chat on WhatsApp',
      defaultMessage: '',
      notificationsEnabled: false,
      chatUrl: '',
    };
  }

  const phoneE164 = normalizePhoneE164(whatsapp.phoneE164 || '');
  const enabled = whatsapp.enabled === true && !!phoneE164;
  const defaultMessage = String(whatsapp.defaultMessage || '').trim();
  const displayLabel = String(whatsapp.displayLabel || 'Chat on WhatsApp').trim() || 'Chat on WhatsApp';

  return {
    enabled,
    phoneE164: enabled ? phoneE164 : '',
    displayLabel,
    defaultMessage,
    notificationsEnabled: whatsapp.notificationsEnabled === true,
    chatUrl: enabled ? buildWhatsAppUrl({ phoneE164, message: defaultMessage }) : '',
  };
}

module.exports = {
  normalizePhoneE164,
  buildWhatsAppUrl,
  sanitizeWhatsappSettings,
  publicWhatsappPayload,
};
