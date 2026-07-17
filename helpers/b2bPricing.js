const Product = require('../models/product');
const B2BPriceList = require('../models/B2BPriceList');
const Client = require('../models/client');
const {
  isMultiWarehouseEnabled,
  getTotalAvailable,
  getStockByWarehouse,
  getAvailableQuantity,
} = require('./warehouseInventory');
const { mergeB2bSettings } = require('./b2bDefaults');
const {
  attachWarehouseStockWarnings,
  attachVariantStockWarnings,
  resolveCatalogStockWarning,
  buildProductStockWarning,
} = require('./b2bBuyerStockWarnings');
const Warehouse = require('../models/Warehouse');

/**
 * Resolve trade unit price for a product tier + quantity.
 */
async function resolveB2BUnitPrice({ clientID, tierId, productId, quantity = 1, variantDelta = 0 }) {
  const qty = Math.max(1, Number(quantity) || 1);
  const entries = await B2BPriceList.find({
    clientID,
    tierId,
    productId,
    active: true,
    minQty: { $lte: qty },
  })
    .sort({ minQty: -1 })
    .limit(1)
    .lean();

  if (entries.length) {
    return Number(entries[0].price) + Number(variantDelta || 0);
  }

  const product = await Product.findOne({ _id: productId, clientID }).select('price salePercentage').lean();
  if (!product) return null;

  if (product.salePercentage > 0) {
    return (product.price * product.salePercentage) / 100 + Number(variantDelta || 0);
  }
  return Number(product.price) + Number(variantDelta || 0);
}

async function resolveStockAvailability({ client, buyer, productId, variant, warehouseId = null }) {
  const multi = isMultiWarehouseEnabled(client);
  if (!multi) {
    const product = await Product.findOne({ _id: productId, clientID: client.clientID })
      .select('countInStock variants')
      .lean();
    if (!product) return 0;
    if (variant?.name && product.variants?.length) {
      const opt = product.variants.find((v) => v.name === variant.name);
      const val = opt?.values?.find((v) => v.value === variant.value);
      return val ? Number(val.stock) || 0 : Number(product.countInStock) || 0;
    }
    return Number(product.countInStock) || 0;
  }

  const allowedIds = buyer?.allowedWarehouseIds?.length ? buyer.allowedWarehouseIds : null;
  if (warehouseId) {
    return getAvailableQuantity({
      clientID: client.clientID,
      warehouseId,
      productId,
      variant,
    });
  }
  return getTotalAvailable({
    clientID: client.clientID,
    productId,
    variant,
    warehouseIds: allowedIds,
  });
}

async function buildB2BCatalog({ clientID, tierId, buyer = null, warehouseId = null, productQuery = {} }) {
  const client = await Client.findOne({ clientID }).select('b2bSettings clientID').lean();
  const settings = mergeB2bSettings(client);
  const multi = client && isMultiWarehouseEnabled(client);

  let selectedWarehouseName = null;
  if (warehouseId) {
    const wh = await Warehouse.findOne({ _id: warehouseId, clientID, active: true })
      .select('name')
      .lean();
    selectedWarehouseName = wh?.name || null;
  }

  const products = await Product.find({ clientID, ...productQuery })
    .select('productName price salePercentage images category countInStock variants')
    .lean();

  const priceRows = await B2BPriceList.find({ clientID, tierId, active: true }).lean();
  const byProduct = new Map();
  for (const row of priceRows) {
    const key = String(row.productId);
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key).push(row);
  }

  const catalog = [];
  for (const product of products) {
    const rows = (byProduct.get(String(product._id)) || []).sort((a, b) => a.minQty - b.minQty);
    const retail =
      product.salePercentage > 0 ? (product.price * product.salePercentage) / 100 : product.price;
    const tradeTiers = rows.map((r) => ({ minQty: r.minQty, price: r.price }));
    const defaultTrade = rows.length ? rows[0].price : retail;

    const entry = {
      ...product,
      id: String(product._id),
      retailPrice: retail,
      tradePrice: defaultTrade,
      tradeTiers,
      countInStock: product.countInStock,
    };

    if (multi && client) {
      entry.warehouseStock = attachWarehouseStockWarnings(
        await getStockByWarehouse(clientID, product._id, null),
        settings
      );
      entry.availableStock = warehouseId
        ? await getAvailableQuantity({
            clientID,
            warehouseId,
            productId: product._id,
            variant: null,
          })
        : await getTotalAvailable({
            clientID,
            productId: product._id,
            variant: null,
            warehouseIds: buyer?.allowedWarehouseIds?.length ? buyer.allowedWarehouseIds : null,
          });
      entry.countInStock = entry.availableStock;
      entry.stockWarning = resolveCatalogStockWarning({
        availableStock: entry.availableStock,
        warehouseStock: entry.warehouseStock,
        settings,
        warehouseId,
      });
    } else if (settings.buyerLowStockWarningsEnabled) {
      entry.stockWarning = buildProductStockWarning({
        available: Number(product.countInStock) || 0,
        reorderLevel: 0,
        settings,
      });
      if (product.variants?.length) {
        entry.variants = attachVariantStockWarnings(product, settings);
      }
    }

    if (multi && client && product.variants?.length && settings.buyerLowStockWarningsEnabled && warehouseId) {
      entry.variants = await Promise.all(
        product.variants.map(async (opt) => ({
          ...opt,
          values: await Promise.all(
            (opt.values || []).map(async (val) => {
              const variant = { name: opt.name, value: val.value };
              const rows = await getStockByWarehouse(clientID, product._id, variant);
              const row = rows.find((r) => String(r.warehouseId) === String(warehouseId));
              const available = row
                ? row.availableQuantity
                : await getAvailableQuantity({
                    clientID,
                    warehouseId,
                    productId: product._id,
                    variant,
                  });
              return {
                ...val,
                stockWarning: buildProductStockWarning({
                  available,
                  reorderLevel: row?.reorderLevel || 0,
                  settings,
                  warehouseName: selectedWarehouseName,
                }),
              };
            })
          ),
        }))
      );
    }

    catalog.push(entry);
  }

  return catalog;
}

async function calculateB2BLineItems({ clientID, tierId, items, client = null, buyer = null, warehouseId = null }) {
  if (!client) {
    client = await Client.findOne({ clientID }).select('b2bSettings clientID').lean();
  }
  const settings = mergeB2bSettings(client);

  let warehouseName = null;
  if (warehouseId) {
    const wh = await Warehouse.findOne({ _id: warehouseId, clientID, active: true })
      .select('name')
      .lean();
    warehouseName = wh?.name || null;
  }

  const lines = [];
  let subtotal = 0;

  for (const item of items) {
    const product = await Product.findOne({ _id: item.product, clientID });
    if (!product) {
      throw new Error(`Product not found: ${item.product}`);
    }

    const variantDelta =
      item.variant && item.variantPrice != null
        ? Number(item.variantPrice) - Number(product.price)
        : 0;

    const unitPrice = await resolveB2BUnitPrice({
      clientID,
      tierId,
      productId: product._id,
      quantity: item.quantity,
      variantDelta,
    });

    if (unitPrice == null) {
      throw new Error(`Unable to price product: ${product.productName}`);
    }

    const qty = Math.max(1, Number(item.quantity) || 1);
    const available = await resolveStockAvailability({
      client,
      buyer,
      productId: product._id,
      variant: item.variant,
      warehouseId,
    });

    if (available < qty) {
      throw new Error(`Insufficient stock for ${product.productName} (available: ${available})`);
    }

    const lineTotal = unitPrice * qty;
    subtotal += lineTotal;

    let stockWarning = null;
    if (settings.buyerLowStockWarningsEnabled) {
      let reorderLevel = 0;
      if (isMultiWarehouseEnabled(client) && warehouseId) {
        const rows = await getStockByWarehouse(clientID, product._id, item.variant || null);
        const row = rows.find((r) => String(r.warehouseId) === String(warehouseId));
        reorderLevel = row?.reorderLevel || 0;
      }
      stockWarning = buildProductStockWarning({
        available,
        reorderLevel,
        settings,
        warehouseName,
      });
    }

    lines.push({
      product: product._id,
      productName: product.productName,
      quantity: qty,
      unitPrice,
      lineTotal,
      variant: item.variant || null,
      variantPrice: item.variantPrice ?? null,
      availableStock: available,
      stockWarning,
    });
  }

  return { lines, subtotal };
}

module.exports = {
  resolveB2BUnitPrice,
  resolveStockAvailability,
  buildB2BCatalog,
  calculateB2BLineItems,
};
