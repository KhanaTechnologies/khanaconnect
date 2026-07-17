const DEFAULT_B2B_SETTINGS = {
  requireTwoFactor: true,
  sessionHours: 24,
  maxLoginAttempts: 5,
  lockoutMinutes: 30,
  otpExpiryMinutes: 10,
  multiWarehouseEnabled: false,
  allowBuyerWarehouseChoice: true,
  defaultAllocationStrategy: 'preferred', // nearest | highest_stock | preferred
  warehouseLowStockAlertsEnabled: true,
  warehouseLowStockDefaultThreshold: 5,
  warehouseLowStockAlertCooldownHours: 24,
  warehouseLowStockAlertEmails: [],
  buyerLowStockWarningsEnabled: false,
  buyerLowStockShowQuantity: true,
};

function mergeB2bSettings(client) {
  const src = client?.b2bSettings && typeof client.b2bSettings === 'object' ? client.b2bSettings : {};
  return { ...DEFAULT_B2B_SETTINGS, ...src };
}

module.exports = { DEFAULT_B2B_SETTINGS, mergeB2bSettings };
