const crypto = require('crypto');
const Product = require('../models/product');
const Warehouse = require('../models/Warehouse');
const WarehouseStock = require('../models/WarehouseStock');
const { mergeB2bSettings } = require('./b2bDefaults');

function variantKeyFromItem(variant) {
  if (!variant || typeof variant !== 'object') return { variantName: '', variantValue: '' };
  return {
    variantName: String(variant.name || '').trim(),
    variantValue: String(variant.value || '').trim(),
  };
}

function isMultiWarehouseEnabled(client) {
  return !!mergeB2bSettings(client).multiWarehouseEnabled;
}

async function getActiveWarehouses(clientID, { buyerAllowedIds = null } = {}) {
  const filter = { clientID, active: true };
  const rows = await Warehouse.find(filter).sort({ priority: -1, name: 1 }).lean();
  if (!buyerAllowedIds?.length) return rows;
  const allowed = new Set(buyerAllowedIds.map(String));
  return rows.filter((w) => allowed.has(String(w._id)));
}

async function getStockRow(clientID, warehouseId, productId, variant) {
  const { variantName, variantValue } = variantKeyFromItem(variant);
  return WarehouseStock.findOne({
    clientID,
    warehouseId,
    productId,
    variantName,
    variantValue,
  });
}

async function getAvailableQuantity({ clientID, warehouseId, productId, variant }) {
  const row = await getStockRow(clientID, warehouseId, productId, variant);
  if (!row) return 0;
  return Math.max(0, row.quantity - (row.reservedQuantity || 0));
}

async function getTotalAvailable({ clientID, productId, variant, warehouseIds = null }) {
  const { variantName, variantValue } = variantKeyFromItem(variant);
  const filter = { clientID, productId, variantName, variantValue };
  if (warehouseIds?.length) filter.warehouseId = { $in: warehouseIds };

  const rows = await WarehouseStock.find(filter).lean();
  return rows.reduce(
    (sum, row) => sum + Math.max(0, (row.quantity || 0) - (row.reservedQuantity || 0)),
    0
  );
}

async function getStockByWarehouse(clientID, productId, variant) {
  const { variantName, variantValue } = variantKeyFromItem(variant);
  const rows = await WarehouseStock.find({ clientID, productId, variantName, variantValue })
    .populate('warehouseId', 'name code isDefault active priority')
    .lean();

  return rows.map((row) => ({
    warehouseId: row.warehouseId?._id || row.warehouseId,
    warehouse: row.warehouseId,
    quantity: row.quantity,
    reservedQuantity: row.reservedQuantity || 0,
    availableQuantity: Math.max(0, (row.quantity || 0) - (row.reservedQuantity || 0)),
    reorderLevel: row.reorderLevel || 0,
  }));
}

async function resolveFulfillmentWarehouse({ client, buyer, items, requestedWarehouseId }) {
  const settings = mergeB2bSettings(client);
  const allowedIds = buyer?.allowedWarehouseIds?.length
    ? buyer.allowedWarehouseIds
    : null;
  const warehouses = await getActiveWarehouses(client.clientID, { buyerAllowedIds: allowedIds });
  if (!warehouses.length) {
    throw new Error('No active warehouses configured');
  }

  if (requestedWarehouseId) {
    const match = warehouses.find((w) => String(w._id) === String(requestedWarehouseId));
    if (!match) throw new Error('Selected warehouse is not available for your account');
    for (const item of items) {
      const available = await getAvailableQuantity({
        clientID: client.clientID,
        warehouseId: match._id,
        productId: item.product,
        variant: item.variant,
      });
      if (available < item.quantity) {
        throw new Error(`Insufficient stock at ${match.name} for ${item.productName || 'a product'}`);
      }
    }
    return match;
  }

  if (buyer?.preferredWarehouseId) {
    const preferred = warehouses.find((w) => String(w._id) === String(buyer.preferredWarehouseId));
    if (preferred) {
      let ok = true;
      for (const item of items) {
        const available = await getAvailableQuantity({
          clientID: client.clientID,
          warehouseId: preferred._id,
          productId: item.product,
          variant: item.variant,
        });
        if (available < item.quantity) ok = false;
      }
      if (ok) return preferred;
    }
  }

  if (settings.defaultAllocationStrategy === 'highest_stock') {
    const scores = await Promise.all(
      warehouses.map(async (wh) => {
        let minAvailable = Infinity;
        for (const item of items) {
          const available = await getAvailableQuantity({
            clientID: client.clientID,
            warehouseId: wh._id,
            productId: item.product,
            variant: item.variant,
          });
          minAvailable = Math.min(minAvailable, available);
        }
        return { warehouse: wh, minAvailable };
      })
    );
    const best = scores
      .filter((s) => s.minAvailable >= Math.max(...items.map((i) => i.quantity)))
      .sort((a, b) => b.minAvailable - a.minAvailable)[0];
    if (best) return best.warehouse;
  }

  const defaultWh = warehouses.find((w) => w.isDefault) || warehouses[0];
  for (const item of items) {
    const available = await getAvailableQuantity({
      clientID: client.clientID,
      warehouseId: defaultWh._id,
      productId: item.product,
      variant: item.variant,
    });
    if (available < item.quantity) {
      for (const wh of warehouses) {
        const alt = await getAvailableQuantity({
          clientID: client.clientID,
          warehouseId: wh._id,
          productId: item.product,
          variant: item.variant,
        });
        if (alt >= item.quantity) return wh;
      }
      throw new Error(`Insufficient stock across all warehouses for ${item.productName || 'a product'}`);
    }
  }
  return defaultWh;
}

async function allocateWarehouseStock({ clientID, warehouseId, lines }) {
  for (const line of lines) {
    const { variantName, variantValue } = variantKeyFromItem(line.variant);
    const row = await WarehouseStock.findOne({
      clientID,
      warehouseId,
      productId: line.product,
      variantName,
      variantValue,
    });
    if (!row) {
      throw new Error(`No stock record for product at selected warehouse`);
    }
    const available = row.quantity - (row.reservedQuantity || 0);
    if (available < line.quantity) {
      throw new Error(`Insufficient warehouse stock for ${line.productName}`);
    }
    row.quantity -= line.quantity;
    await row.save();
  }
  queueWarehouseLowStockCheck(clientID);
}

async function syncLegacyProductStock(productId) {
  const product = await Product.findById(productId);
  if (!product) return;

  const baseRows = await WarehouseStock.find({
    clientID: product.clientID,
    productId: product._id,
    variantName: '',
    variantValue: '',
  }).lean();
  product.countInStock = baseRows.reduce((sum, r) => sum + (r.quantity || 0), 0);

  if (product.variants?.length) {
    for (const opt of product.variants) {
      for (const val of opt.values || []) {
        const rows = await WarehouseStock.find({
          clientID: product.clientID,
          productId: product._id,
          variantName: opt.name,
          variantValue: val.value,
        }).lean();
        val.stock = rows.reduce((sum, r) => sum + (r.quantity || 0), 0);
      }
    }
  }

  await product.save();
}

async function upsertWarehouseStock({
  clientID,
  warehouseId,
  productId,
  variant,
  quantity,
  reorderLevel,
}) {
  const { variantName, variantValue } = variantKeyFromItem(variant);
  const row = await WarehouseStock.findOneAndUpdate(
    { clientID, warehouseId, productId, variantName, variantValue },
    {
      clientID,
      warehouseId,
      productId,
      variantName,
      variantValue,
      quantity: Math.max(0, Number(quantity) || 0),
      ...(reorderLevel != null ? { reorderLevel: Math.max(0, Number(reorderLevel) || 0) } : {}),
    },
    { upsert: true, new: true }
  );
  await syncLegacyProductStock(productId);
  queueWarehouseLowStockCheck(clientID);
  return row;
}

async function transferStock({
  clientID,
  fromWarehouseId,
  toWarehouseId,
  productId,
  variant,
  quantity,
}) {
  const qty = Math.max(1, Number(quantity) || 1);
  const fromRow = await getStockRow(clientID, fromWarehouseId, productId, variant);
  if (!fromRow || fromRow.quantity < qty) {
    throw new Error('Insufficient stock at source warehouse');
  }
  fromRow.quantity -= qty;
  await fromRow.save();

  const { variantName, variantValue } = variantKeyFromItem(variant);
  const toRow = await WarehouseStock.findOneAndUpdate(
    { clientID, warehouseId: toWarehouseId, productId, variantName, variantValue },
    {
      $setOnInsert: { clientID, warehouseId: toWarehouseId, productId, variantName, variantValue },
      $inc: { quantity: qty },
    },
    { upsert: true, new: true }
  );

  await syncLegacyProductStock(productId);
  queueWarehouseLowStockCheck(clientID);
  return { fromRow, toRow };
}

function queueWarehouseLowStockCheck(clientID) {
  setImmediate(() => {
    const { checkWarehouseStockAlerts } = require('./b2bWarehouseAlerts');
    checkWarehouseStockAlerts(clientID).catch((err) => {
      console.error(`warehouse low-stock check (${clientID}):`, err.message);
    });
  });
}

function generateTransferRef() {
  return `WH-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

module.exports = {
  variantKeyFromItem,
  isMultiWarehouseEnabled,
  getActiveWarehouses,
  getAvailableQuantity,
  getTotalAvailable,
  getStockByWarehouse,
  resolveFulfillmentWarehouse,
  allocateWarehouseStock,
  syncLegacyProductStock,
  upsertWarehouseStock,
  transferStock,
  generateTransferRef,
};
