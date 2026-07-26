const { SalesItem } = require('../models/salesItem');
const Product = require('../models/product');

/**
 * Clear salePercentage on products whose sales campaigns have ended.
 */
async function expireEndedProductSales() {
  const now = new Date();
  const ended = await SalesItem.find({
    itemType: 'product',
    endDate: { $lt: now },
  })
    .select('selectedProductIds clientID')
    .lean();

  let cleared = 0;
  for (const sale of ended) {
    const ids = sale.selectedProductIds || [];
    if (!ids.length) continue;
    const result = await Product.updateMany(
      {
        _id: { $in: ids },
        clientID: sale.clientID,
        salePercentage: { $gt: 0 },
      },
      { $set: { salePercentage: 0 } }
    );
    cleared += result.modifiedCount || 0;
  }
  return { salesChecked: ended.length, productsCleared: cleared };
}

module.exports = { expireEndedProductSales };
