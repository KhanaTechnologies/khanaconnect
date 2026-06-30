const WishList = require('../models/wishList');
const Product = require('../models/product');

async function getBackInStockOpportunities(clientID) {
  const lists = await WishList.find({
    clientID,
    items: { $elemMatch: { notifyOnRestock: true } },
  }).select('customerID items');

  const byProduct = new Map();

  for (const list of lists) {
    for (const item of list.items) {
      if (!item.notifyOnRestock) continue;
      const pid = String(item.product || '');
      if (!pid) continue;

      const entry =
        byProduct.get(pid) ||
        {
          productId: pid,
          subscriberCount: 0,
          customerIds: new Set(),
          lastNotifiedAt: null,
        };
      entry.subscriberCount += 1;
      entry.customerIds.add(String(list.customerID));
      if (item.lastRestockNotifiedAt) {
        const ts = new Date(item.lastRestockNotifiedAt).getTime();
        if (!entry.lastNotifiedAt || ts > entry.lastNotifiedAt) {
          entry.lastNotifiedAt = ts;
        }
      }
      byProduct.set(pid, entry);
    }
  }

  const productIds = [...byProduct.keys()];
  const products = await Product.find({ _id: { $in: productIds }, clientID }).select(
    'productName countInStock images salePercentage'
  );
  const productMap = Object.fromEntries(products.map((p) => [String(p._id), p]));

  const rows = [];
  for (const [pid, sub] of byProduct) {
    const product = productMap[pid];
    if (!product) continue;
    const stock = Number(product.countInStock) || 0;
    rows.push({
      productId: pid,
      productName: product.productName,
      countInStock: stock,
      subscriberCount: sub.subscriberCount,
      uniqueCustomers: sub.customerIds.size,
      status: stock > 0 ? 'ready_to_notify' : 'out_of_stock',
      lastNotifiedAt: sub.lastNotifiedAt ? new Date(sub.lastNotifiedAt) : null,
    });
  }

  rows.sort((a, b) => b.subscriberCount - a.subscriberCount);

  return {
    summary: {
      productsWithWaitlist: rows.length,
      totalSubscribers: rows.reduce((sum, row) => sum + row.subscriberCount, 0),
      readyToNotify: rows.filter((row) => row.status === 'ready_to_notify').length,
      outOfStock: rows.filter((row) => row.status === 'out_of_stock').length,
    },
    products: rows,
  };
}

module.exports = {
  getBackInStockOpportunities,
};
