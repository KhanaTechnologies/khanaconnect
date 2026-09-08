const Product = require('../models/product');
const InventoryMovement = require('../models/InventoryMovement');
const Client = require('../models/client');

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function matchVariantValue(product, variantLabel) {
  const label = String(variantLabel || '').trim().toLowerCase();
  if (!label || !Array.isArray(product.variants)) return null;

  for (const variant of product.variants) {
    const values = Array.isArray(variant.values) ? variant.values : [];
    for (const val of values) {
      const valueStr = String(val.value || '').trim().toLowerCase();
      const combo = `${String(variant.name || '').trim().toLowerCase()}: ${valueStr}`;
      if (valueStr === label || combo === label || label.includes(valueStr)) {
        return { variant, val };
      }
    }
  }
  return null;
}

function resolveVariantObject(product, variant) {
  if (variant && typeof variant === 'object' && (variant.name || variant.value)) {
    return {
      name: String(variant.name || '').trim(),
      value: String(variant.value || '').trim(),
    };
  }
  const matched = matchVariantValue(product, variant);
  if (matched) {
    return {
      name: String(matched.variant.name || '').trim(),
      value: String(matched.val.value || '').trim(),
    };
  }
  return { name: '', value: '' };
}

async function recordMovement({
  clientId,
  productId,
  variantValue = '',
  delta,
  reason,
  orderId = '',
  note = '',
}) {
  try {
    await InventoryMovement.create({
      client_id: clientId,
      product_id: productId,
      variant_value: variantValue || '',
      delta: Number(delta) || 0,
      reason: reason || 'adjust',
      order_id: orderId ? String(orderId) : '',
      note: String(note || '').slice(0, 500),
    });
  } catch (e) {
    console.warn('[inventory] movement record failed:', e.message);
  }
}

/**
 * Deduct stock for one order line. Prefers variant stock when variant is present.
 * When multi-warehouse is enabled, warehouse stock is the source of truth and Product
 * countInStock is synced from warehouses (avoids dual-ledger oversell).
 * allowOversell (default true): match legacy order create which allowed negative stock
 * so existing client checkouts are not rejected after deploy.
 * @returns {{ productId: string, variantValue: string, qty: number }}
 */
async function deductLineStock({
  clientId,
  productId,
  quantity,
  variant = '',
  orderId = '',
  reason = 'order_deduct',
  allowOversell = true,
  warehouseId = null,
}) {
  const qty = Math.max(0, Number(quantity) || 0);
  if (!qty) return null;

  const product = await Product.findOne({ _id: productId, clientID: clientId });
  if (!product) throw httpError('Product not found for stock deduction', 404);

  const {
    isMultiWarehouseEnabled,
    deductAcrossWarehousesThenSync,
  } = require('./warehouseInventory');

  const client = await Client.findOne({ clientID: clientId }).select('b2bSettings').lean();
  if (isMultiWarehouseEnabled(client)) {
    const { getActiveWarehouses } = require('./warehouseInventory');
    const warehouses = await getActiveWarehouses(clientId);
    if (warehouses.length) {
      const variantObj = resolveVariantObject(product, variant);
      try {
        await deductAcrossWarehousesThenSync({
          clientID: clientId,
          productId: product._id,
          quantity: qty,
          variant: variantObj,
          preferredWarehouseId: warehouseId,
          allowOversell,
        });
      } catch (e) {
        throw httpError(e.message || 'Warehouse stock deduction failed', e.status || 400);
      }
      await recordMovement({
        clientId,
        productId: String(product._id),
        variantValue: variantObj.value || '',
        delta: -qty,
        reason,
        orderId,
      });
      return {
        productId: String(product._id),
        variantValue: variantObj.value || '',
        qty,
      };
    }
  }

  const matched = matchVariantValue(product, variant);
  if (matched) {
    if (!allowOversell && Number(matched.val.stock) < qty) {
      throw httpError(
        `Insufficient stock for ${product.productName} (${matched.val.value}): need ${qty}, have ${matched.val.stock}`,
        400
      );
    }
    if (Number(matched.val.stock) < qty) {
      console.warn(
        `[inventory] oversell allowed for ${product.productName} (${matched.val.value}): need ${qty}, have ${matched.val.stock}`
      );
    }
    matched.val.stock = Number(matched.val.stock) - qty;
    const sum = (product.variants || []).reduce(
      (acc, v) => acc + (v.values || []).reduce((a, x) => a + (Number(x.stock) || 0), 0),
      0
    );
    product.countInStock = sum;
    await product.save();
    await recordMovement({
      clientId,
      productId: String(product._id),
      variantValue: String(matched.val.value || ''),
      delta: -qty,
      reason,
      orderId,
    });
    return { productId: String(product._id), variantValue: String(matched.val.value || ''), qty };
  }

  if (!allowOversell && Number(product.countInStock) < qty) {
    throw httpError(
      `Insufficient stock for ${product.productName}: need ${qty}, have ${product.countInStock}`,
      400
    );
  }
  if (Number(product.countInStock) < qty) {
    console.warn(
      `[inventory] oversell allowed for ${product.productName}: need ${qty}, have ${product.countInStock}`
    );
  }
  product.countInStock = Number(product.countInStock) - qty;
  await product.save();
  await recordMovement({
    clientId,
    productId: String(product._id),
    variantValue: '',
    delta: -qty,
    reason,
    orderId,
  });
  return { productId: String(product._id), variantValue: '', qty };
}

async function restockLineStock({
  clientId,
  productId,
  quantity,
  variant = '',
  orderId = '',
  reason = 'order_restock',
  warehouseId = null,
}) {
  const qty = Math.max(0, Number(quantity) || 0);
  if (!qty) return null;

  const product = await Product.findOne({ _id: productId, clientID: clientId });
  if (!product) return null;

  const {
    isMultiWarehouseEnabled,
    restockToWarehouseThenSync,
  } = require('./warehouseInventory');

  const client = await Client.findOne({ clientID: clientId }).select('b2bSettings').lean();
  if (isMultiWarehouseEnabled(client)) {
    const { getActiveWarehouses } = require('./warehouseInventory');
    const warehouses = await getActiveWarehouses(clientId);
    if (warehouses.length) {
      const variantObj = resolveVariantObject(product, variant);
      await restockToWarehouseThenSync({
        clientID: clientId,
        productId: product._id,
        quantity: qty,
        variant: variantObj,
        preferredWarehouseId: warehouseId,
      });
      await recordMovement({
        clientId,
        productId: String(product._id),
        variantValue: variantObj.value || '',
        delta: qty,
        reason,
        orderId,
      });
      return {
        productId: String(product._id),
        variantValue: variantObj.value || '',
        qty,
      };
    }
  }

  const matched = matchVariantValue(product, variant);
  if (matched) {
    matched.val.stock = Number(matched.val.stock || 0) + qty;
    const sum = (product.variants || []).reduce(
      (acc, v) => acc + (v.values || []).reduce((a, x) => a + (Number(x.stock) || 0), 0),
      0
    );
    product.countInStock = sum;
    await product.save();
    await recordMovement({
      clientId,
      productId: String(product._id),
      variantValue: String(matched.val.value || ''),
      delta: qty,
      reason,
      orderId,
    });
    return { productId: String(product._id), variantValue: String(matched.val.value || ''), qty };
  }

  product.countInStock = Number(product.countInStock || 0) + qty;
  await product.save();
  await recordMovement({
    clientId,
    productId: String(product._id),
    variantValue: '',
    delta: qty,
    reason,
    orderId,
  });
  return { productId: String(product._id), variantValue: '', qty };
}

module.exports = {
  matchVariantValue,
  deductLineStock,
  restockLineStock,
  recordMovement,
};
