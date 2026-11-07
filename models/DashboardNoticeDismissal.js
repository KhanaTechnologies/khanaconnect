const mongoose = require('mongoose');

const dashboardNoticeDismissalSchema = new mongoose.Schema(
  {
    noticeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DashboardNotice',
      required: true,
      index: true,
    },
    clientID: { type: String, required: true, index: true },
    dismissedBy: { type: String, default: '' },
    dismissedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

dashboardNoticeDismissalSchema.index({ noticeId: 1, clientID: 1 }, { unique: true });

module.exports = mongoose.model('DashboardNoticeDismissal', dashboardNoticeDismissalSchema);
