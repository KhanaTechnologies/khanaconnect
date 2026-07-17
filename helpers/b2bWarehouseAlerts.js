const Warehouse = require('../models/Warehouse');
const WarehouseStock = require('../models/WarehouseStock');
const WarehouseLowStockAlert = require('../models/WarehouseLowStockAlert');
const Product = require('../models/product');
const Client = require('../models/client');
const { mergeB2bSettings } = require('./b2bDefaults');
const { isMultiWarehouseEnabled } = require('./warehouseInventory');
const { sendWarehouseLowStockAlertEmail } = require('../utils/sendWarehouseLowStockAlert');
const { recordB2BAudit } = require('./b2bSecurity');

function effectiveThreshold(row, settings) {
  const reorder = Number(row.reorderLevel) || 0;
  if (reorder > 0) return reorder;
  return Math.max(0, Number(settings.warehouseLowStockDefaultThreshold) || 5);
}

function availableQty(row) {
  return Math.max(0, (row.quantity || 0) - (row.reservedQuantity || 0));
}

function severityFor(available, threshold) {
  if (available <= 0) return 'out';
  if (available <= threshold) return 'low';
  return null;
}

function cooldownExpired(row, settings) {
  if (!row.lastLowStockAlertAt) return true;
  const hours = Number(settings.warehouseLowStockAlertCooldownHours) || 24;
  const elapsed = Date.now() - new Date(row.lastLowStockAlertAt).getTime();
  if (elapsed >= hours * 60 * 60 * 1000) return true;
  const prev = row.lastAlertAvailableQty;
  if (prev == null) return false;
  return availableQty(row) < prev;
}

async function findLowStockRows(clientID, settings) {
  const stockRows = await WarehouseStock.find({ clientID })
    .populate('warehouseId', 'name code active')
    .populate('productId', 'productName images')
    .lean();

  const alerts = [];
  for (const row of stockRows) {
    if (!row.warehouseId?.active) continue;
    const available = availableQty(row);
    const threshold = effectiveThreshold(row, settings);
    const severity = severityFor(available, threshold);
    if (!severity) continue;

    alerts.push({
      stockId: row._id,
      warehouseId: row.warehouseId._id,
      warehouseName: row.warehouseId.name,
      warehouseCode: row.warehouseId.code,
      productId: row.productId?._id || row.productId,
      productName: row.productId?.productName || 'Product',
      variantName: row.variantName || '',
      variantValue: row.variantValue || '',
      availableQuantity: available,
      quantity: row.quantity,
      reservedQuantity: row.reservedQuantity || 0,
      reorderLevel: row.reorderLevel || 0,
      threshold,
      severity,
      lastLowStockAlertAt: row.lastLowStockAlertAt,
      lastAlertAvailableQty: row.lastAlertAvailableQty,
      needsAlert: cooldownExpired(row, settings),
    });
  }

  return alerts.sort((a, b) => {
    if (a.severity === 'out' && b.severity !== 'out') return -1;
    if (b.severity === 'out' && a.severity !== 'out') return 1;
    return a.availableQuantity - b.availableQuantity;
  });
}

async function resolveAlertRecipients(client) {
  const settings = mergeB2bSettings(client);
  const configured = (settings.warehouseLowStockAlertEmails || []).filter(Boolean);
  if (configured.length) return configured;

  try {
    const { decrypt } = require('./encryption');
    const email = decrypt(client.businessEmail);
    if (email) return [email];
  } catch {
    // ignore
  }
  return [];
}

async function sendAlertsForClient(clientID, { force = false } = {}) {
  const client = await Client.findOne({ clientID }).select(
    'clientID companyName permissions b2bSettings businessEmail businessEmailPassword emailSignature smtpHost smtpPort return_url'
  );
  if (!client?.permissions?.b2b) {
    return { clientID, skipped: true, reason: 'b2b_disabled' };
  }
  if (!isMultiWarehouseEnabled(client)) {
    return { clientID, skipped: true, reason: 'multi_warehouse_disabled' };
  }

  const settings = mergeB2bSettings(client);
  if (!settings.warehouseLowStockAlertsEnabled) {
    return { clientID, skipped: true, reason: 'alerts_disabled' };
  }

  const rows = await findLowStockRows(clientID, settings);
  const toNotify = force ? rows : rows.filter((r) => r.needsAlert);
  if (!toNotify.length) {
    return { clientID, alerts: rows.length, emailsSent: 0 };
  }

  const recipients = await resolveAlertRecipients(client);
  if (!recipients.length) {
    return { clientID, skipped: true, reason: 'no_recipients', alerts: toNotify.length };
  }

  const byWarehouse = new Map();
  for (const item of toNotify) {
    const key = String(item.warehouseId);
    if (!byWarehouse.has(key)) {
      byWarehouse.set(key, { warehouseId: item.warehouseId, warehouseName: item.warehouseName, warehouseCode: item.warehouseCode, items: [] });
    }
    byWarehouse.get(key).items.push(item);
  }

  let emailsSent = 0;
  for (const group of byWarehouse.values()) {
    await sendWarehouseLowStockAlertEmail({
      client,
      recipients,
      warehouseName: group.warehouseName,
      warehouseCode: group.warehouseCode,
      items: group.items,
    });
    emailsSent += 1;

    for (const item of group.items) {
      await WarehouseStock.findByIdAndUpdate(item.stockId, {
        lastLowStockAlertAt: new Date(),
        lastAlertAvailableQty: item.availableQuantity,
      });

      await WarehouseLowStockAlert.create({
        clientID,
        warehouseId: item.warehouseId,
        productId: item.productId,
        variantName: item.variantName,
        variantValue: item.variantValue,
        availableQuantity: item.availableQuantity,
        threshold: item.threshold,
        severity: item.severity,
        notifiedEmails: recipients,
        emailSent: true,
      });
    }
  }

  await recordB2BAudit({
    clientID,
    event: 'warehouse_low_stock_alert',
    summary: `Low-stock alert sent for ${toNotify.length} SKU(s) across ${byWarehouse.size} warehouse(s)`,
    metadata: { count: toNotify.length, warehouses: byWarehouse.size, emailsSent },
  });

  return { clientID, alerts: rows.length, notified: toNotify.length, emailsSent };
}

async function checkWarehouseStockAlerts(clientID) {
  return sendAlertsForClient(clientID, { force: false });
}

async function processAllWarehouseLowStockAlerts() {
  const clients = await Client.find({ 'permissions.b2b': true }).select('clientID').lean();
  const results = [];
  for (const client of clients) {
    try {
      results.push(await sendAlertsForClient(client.clientID));
    } catch (err) {
      results.push({ clientID: client.clientID, error: err.message });
    }
  }
  return results;
}

module.exports = {
  effectiveThreshold,
  availableQty,
  severityFor,
  findLowStockRows,
  checkWarehouseStockAlerts,
  sendAlertsForClient,
  processAllWarehouseLowStockAlerts,
};
