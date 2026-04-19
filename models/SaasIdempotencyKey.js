const mongoose = require('mongoose');

const saasIdempotencyKeySchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    scope: { type: String, required: true, index: true },
    idempotency_key: { type: String, required: true },
    request_hash: { type: String, required: true },
    response_status: { type: Number, default: 0 },
    response_body: { type: mongoose.Schema.Types.Mixed, default: null },
    completed: { type: Boolean, default: false, index: true },
    expires_at: { type: Date, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasIdempotencyKeySchema.index(
  { client_id: 1, scope: 1, idempotency_key: 1 },
  { unique: true }
);
saasIdempotencyKeySchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('SaasIdempotencyKey', saasIdempotencyKeySchema);
