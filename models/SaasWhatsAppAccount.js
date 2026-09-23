const mongoose = require('mongoose');

const saasWhatsAppAccountSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    waba_id: { type: String, required: true, trim: true },
    phone_number_id: { type: String, required: true, trim: true },
    /** Human-readable sender from Meta (e.g. +27 …) — set on Embedded Signup / refresh. */
    display_phone_number: { type: String, default: '', trim: true },
    verified_name: { type: String, default: '', trim: true },
    access_token_encrypted: { type: String, required: true },
    mode: { type: String, enum: ['embedded', 'manual'], default: 'embedded' },
    coexistence: { type: Boolean, default: false },
    embedded_signup_at: { type: Date, default: null },
    phone_registered_at: { type: Date, default: null },
    last_register_error: { type: String, default: '', trim: true },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
    /**
     * Meta Conversions dataset linked to THIS client's WABA (Events Manager).
     * Always scoped per WhatsApp Business Account — never share Khana's website Pixel
     * across tenants for messaging events.
     */
    dataset_id: { type: String, default: '', trim: true },
    /** waba = created/fetched via /{WABA_ID}/dataset; cleared = decommissioned locally */
    dataset_source: {
      type: String,
      enum: ['waba', 'cleared'],
      default: undefined,
    },
    dataset_linked_at: { type: Date, default: null },
    dataset_decommissioned_at: { type: Date, default: null },
    last_conversion_at: { type: Date, default: null },
    last_conversion_event_name: { type: String, default: '', trim: true },
    last_conversion_error: { type: String, default: '', trim: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppAccountSchema.index(
  { client_id: 1, phone_number_id: 1 },
  { unique: true }
);

/** One active Cloud sender phone ID across the whole platform (tenant isolation). */
saasWhatsAppAccountSchema.index(
  { phone_number_id: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'active' },
  }
);

module.exports = mongoose.model('SaasWhatsAppAccount', saasWhatsAppAccountSchema);
