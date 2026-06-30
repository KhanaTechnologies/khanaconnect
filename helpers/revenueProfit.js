const Product = require('../models/product');
const { Order } = require('../models/order');
const { OrderItem } = require('../models/orderItem');

const MS_DAY = 24 * 60 * 60 * 1000;

function round2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

function effectiveUnitPrice(product, unitPrice) {
  const pct = Math.min(100, Math.max(0, Number(product?.salePercentage) || 0));
  return Number(unitPrice || 0) * (1 - pct / 100);
}

function parseCostPrice(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function getProfitView(clientID, days = 30) {
  const filter = { clientID, paid: true };
  if (days > 0) {
    filter.dateOrdered = { $gte: new Date(Date.now() - days * MS_DAY) };
  }

  const orders = await Order.find(filter).select('finalPrice dateOrdered orderItems').lean();
  const itemIds = orders.flatMap((o) => o.orderItems || []).filter(Boolean);
  if (!itemIds.length) {
    const productsMissingCost = await Product.countDocuments({
      clientID,
      $or: [{ costPrice: { $exists: false } }, { costPrice: null }],
    });
    return {
      periodDays: days,
      totalRevenue: 0,
      productRevenueTracked: 0,
      estimatedCost: 0,
      grossProfit: 0,
      marginPercent: 0,
      paidOrders: 0,
      lineItemsWithCost: 0,
      lineItemsTotal: 0,
      costDataCoverage: 0,
      productsMissingCost,
      topProducts: [],
    };
  }

  const items = await OrderItem.find({ _id: { $in: itemIds } }).populate(
    'product',
    'productName price costPrice salePercentage'
  );
  const itemMap = new Map(items.map((i) => [String(i._id), i]));

  let totalRevenue = 0;
  let revenueWithCost = 0;
  let totalCost = 0;
  let lineItemsTotal = 0;
  let lineItemsWithCost = 0;
  const byProduct = new Map();

  for (const order of orders) {
    totalRevenue += Number(order.finalPrice) || 0;
    for (const itemId of order.orderItems || []) {
      const item = itemMap.get(String(itemId));
      if (!item?.product) continue;

      lineItemsTotal += 1;
      const qty = Number(item.quantity) || 1;
      const unitPrice = Number(item.variantPrice ?? item.product.price) || 0;
      const lineRevenue = effectiveUnitPrice(item.product, unitPrice) * qty;
      const unitCost = parseCostPrice(item.product.costPrice);

      if (unitCost === null) continue;

      lineItemsWithCost += 1;
      revenueWithCost += lineRevenue;
      const lineCost = unitCost * qty;
      totalCost += lineCost;

      const pid = String(item.product._id);
      const row =
        byProduct.get(pid) ||
        {
          productId: pid,
          productName: item.product.productName,
          unitsSold: 0,
          revenue: 0,
          cost: 0,
          costPrice: unitCost,
        };
      row.unitsSold += qty;
      row.revenue += lineRevenue;
      row.cost += lineCost;
      byProduct.set(pid, row);
    }
  }

  const grossProfit = revenueWithCost - totalCost;
  const marginPercent =
    revenueWithCost > 0 ? (grossProfit / revenueWithCost) * 100 : 0;

  const productsMissingCost = await Product.countDocuments({
    clientID,
    $or: [{ costPrice: { $exists: false } }, { costPrice: null }],
  });

  const topProducts = [...byProduct.values()]
    .map((row) => ({
      ...row,
      revenue: round2(row.revenue),
      cost: round2(row.cost),
      profit: round2(row.revenue - row.cost),
      marginPercent: row.revenue > 0 ? round2(((row.revenue - row.cost) / row.revenue) * 100) : 0,
    }))
    .sort((a, b) => b.profit - a.profit)
    .slice(0, 20);

  return {
    periodDays: days,
    totalRevenue: round2(totalRevenue),
    productRevenueTracked: round2(revenueWithCost),
    estimatedCost: round2(totalCost),
    grossProfit: round2(grossProfit),
    marginPercent: round2(marginPercent),
    paidOrders: orders.length,
    lineItemsWithCost,
    lineItemsTotal,
    costDataCoverage:
      lineItemsTotal > 0 ? round2((lineItemsWithCost / lineItemsTotal) * 100) : 0,
    productsMissingCost,
    topProducts,
  };
}

module.exports = {
  getProfitView,
  effectiveUnitPrice,
  parseCostPrice,
};
