/** Default revenue / command-center settings — toggles off unless noted. */
const DEFAULT_REVENUE_SETTINGS = {
  businessType: 'mixed',
  cartRecoveryEnabled: true,
  cartRecoveryAutoReminders: false,
  inventoryPromosEnabled: false,
  lowStockThreshold: 5,
  slowMoverDays: 60,
  socialProofEnabled: false,
  showRecentOrders: true,
  showWishlistSaves: true,
  showStockUrgency: false,
  bundleUpsellsEnabled: true,
  bookingOptimizerEnabled: true,
  freeShippingThreshold: 0,
};

function mergeRevenueSettings(existing) {
  const src = existing && typeof existing.toObject === 'function' ? existing.toObject() : existing || {};
  return { ...DEFAULT_REVENUE_SETTINGS, ...src };
}

module.exports = {
  DEFAULT_REVENUE_SETTINGS,
  mergeRevenueSettings,
};
