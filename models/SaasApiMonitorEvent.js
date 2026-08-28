const mongoose = require('mongoose');

/**
 * Integration API monitor events (Meta OAuth, WhatsApp CAPI, Graph API, etc.).
 * Used to diagnose permission, auth, and upstream failures per tenant.
 */
const saasApiMonitorEventSchema = new mongoose.Schema(
  {
    client_id: { type: String, default: '', index: true, trim: true },
    integration: {
      type: String,
      enum: ['meta_oauth', 'meta_ads', 'meta_graph', 'whatsapp_cloud', 'whatsapp_capi', 'whatsapp_inbox', 'system'],
      required: true,
      index: true,
    },
    operation: { type: String, required: true, trim: true, index: true },
    outcome: { type: String, enum: ['success', 'warning', 'error'], required: true, index: true },
    /** Short human-readable summary for dashboards. */
    message: { type: String, default: '', trim: true },
    /** Machine cause bucket for grouping (permission_denied, business_admin_required, etc.). */
    cause: { type: String, default: 'unknown', index: true, trim: true },
    http_status: { type: Number, default: null },
    duration_ms: { type: Number, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasApiMonitorEventSchema.index({ created_at: -1 });
saasApiMonitorEventSchema.index({ integration: 1, outcome: 1, created_at: -1 });
saasApiMonitorEventSchema.index({ client_id: 1, integration: 1, created_at: -1 });

// Auto-expire old events (default 90 days).
const retentionDays = Math.max(7, Number(process.env.API_MONITOR_RETENTION_DAYS || 90) || 90);
saasApiMonitorEventSchema.index(
  { created_at: 1 },
  { expireAfterSeconds: retentionDays * 24 * 60 * 60 }
);

module.exports = mongoose.model('SaasApiMonitorEvent', saasApiMonitorEventSchema);
