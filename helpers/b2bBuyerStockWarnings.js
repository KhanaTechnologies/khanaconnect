const { mergeB2bSettings } = require('./b2bDefaults');
const { effectiveThreshold, severityFor } = require('./b2bWarehouseAlerts');

function buyerStockWarningsEnabled(client) {
  return !!mergeB2bSettings(client).buyerLowStockWarningsEnabled;
}

function buildStockWarningMessage({ severity, available, warehouseName, showQuantity }) {
  if (severity === 'out') {
    return warehouseName ? `Out of stock at ${warehouseName}` : 'Out of stock';
  }
  if (showQuantity) {
    return warehouseName
      ? `Only ${available} left at ${warehouseName}`
      : `Only ${available} left — order soon`;
  }
  return warehouseName ? `Low stock at ${warehouseName}` : 'Low stock — order soon';
}

function buildProductStockWarning({ available, reorderLevel, settings, warehouseName = null }) {
  if (!settings?.buyerLowStockWarningsEnabled) return null;

  const qty = Math.max(0, Number(available) || 0);
  const threshold = effectiveThreshold({ reorderLevel: reorderLevel || 0 }, settings);
  const severity = severityFor(qty, threshold);
  if (!severity) return null;

  const showQuantity = settings.buyerLowStockShowQuantity !== false;

  return {
    severity,
    availableQuantity: qty,
    threshold,
    message: buildStockWarningMessage({ severity, available: qty, warehouseName, showQuantity }),
  };
}

function attachWarehouseStockWarnings(warehouseStock, settings) {
  if (!settings?.buyerLowStockWarningsEnabled || !Array.isArray(warehouseStock)) {
    return warehouseStock;
  }

  return warehouseStock.map((row) => ({
    ...row,
    stockWarning: buildProductStockWarning({
      available: row.availableQuantity,
      reorderLevel: row.reorderLevel,
      settings,
      warehouseName: row.warehouse?.name || null,
    }),
  }));
}

function attachVariantStockWarnings(product, settings) {
  if (!settings?.buyerLowStockWarningsEnabled || !product.variants?.length) {
    return product.variants;
  }

  return product.variants.map((opt) => ({
    ...opt,
    values: (opt.values || []).map((val) => {
      const available =
        val.stock != null ? Number(val.stock) || 0 : Number(product.countInStock) || 0;
      return {
        ...val,
        stockWarning: buildProductStockWarning({
          available,
          reorderLevel: 0,
          settings,
        }),
      };
    }),
  }));
}

function resolveCatalogStockWarning({ availableStock, warehouseStock, settings, warehouseId }) {
  if (!settings?.buyerLowStockWarningsEnabled) return null;

  if (warehouseId && Array.isArray(warehouseStock)) {
    const row = warehouseStock.find((w) => String(w.warehouseId) === String(warehouseId));
    if (row) {
      return buildProductStockWarning({
        available: row.availableQuantity,
        reorderLevel: row.reorderLevel,
        settings,
        warehouseName: row.warehouse?.name || null,
      });
    }
  }

  const reorderLevel = Array.isArray(warehouseStock)
    ? Math.max(0, ...warehouseStock.map((r) => Number(r.reorderLevel) || 0))
    : 0;

  return buildProductStockWarning({
    available: availableStock,
    reorderLevel,
    settings,
  });
}

function buyerPortalStockSettings(client) {
  const settings = mergeB2bSettings(client);
  return {
    buyerLowStockWarningsEnabled: !!settings.buyerLowStockWarningsEnabled,
    buyerLowStockShowQuantity: settings.buyerLowStockShowQuantity !== false,
  };
}

module.exports = {
  buyerStockWarningsEnabled,
  buildProductStockWarning,
  attachWarehouseStockWarnings,
  attachVariantStockWarnings,
  resolveCatalogStockWarning,
  buyerPortalStockSettings,
};
