const { Order } = require('../models/order');
const { restockLineStock } = require('./productInventory');

/**
 * Cancel abandoned unpaid prepaid orders and restock reserved inventory.
 * Env: UNPAID_ORDER_EXPIRE_HOURS (default 24), UNPAID_ORDER_EXPIRE_BATCH (default 100).
 * Skips B2B on_account / net30 (legitimate unpaid).
 */
async function expireAbandonedUnpaidOrders() {
  const hours = Math.max(1, Number(process.env.UNPAID_ORDER_EXPIRE_HOURS || 24));
  const batch = Math.max(1, Math.min(500, Number(process.env.UNPAID_ORDER_EXPIRE_BATCH || 100)));
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

  const orders = await Order.find({
    paid: false,
    deletedAt: null,
    stockRestocked: { $ne: true },
    stockDeducted: { $ne: false },
    dateOrdered: { $lt: cutoff },
    status: {
      $nin: ['cancelled', 'canceled', 'refunded', 'delivered', 'shipped', 'completed'],
    },
    $or: [
      { orderType: { $ne: 'b2b' } },
      { paymentTerms: 'prepaid' },
      { paymentTerms: { $exists: false } },
      { paymentTerms: null },
    ],
  })
    .populate('orderItems')
    .sort({ dateOrdered: 1 })
    .limit(batch);

  let expired = 0;
  let restocked = 0;

  for (const order of orders) {
    try {
      if (order.stockDeducted !== false && !order.stockRestocked) {
        const warehouseId =
          order.stockSource === 'warehouse' && order.warehouseId ? order.warehouseId : null;
        for (const item of order.orderItems || []) {
          const productId = item.product?._id || item.product;
          if (!productId) continue;
          await restockLineStock({
            clientId: order.clientID,
            productId,
            quantity: item.quantity,
            variant: item.variant || '',
            orderId: String(order._id),
            reason: 'unpaid_expire_restock',
            warehouseId,
          });
        }
        order.stockRestocked = true;
        order.stockDeducted = false;
        restocked += 1;
      }

      order.status = 'cancelled';
      const note = `Auto-cancelled unpaid after ${hours}h`;
      order.orderNotes = [order.orderNotes, note].filter(Boolean).join(' | ').slice(0, 2000);
      await order.save();
      expired += 1;
    } catch (err) {
      console.error(`[expire-unpaid] failed for order ${order._id}:`, err.message);
    }
  }

  return { checked: orders.length, expired, restocked, hours };
}

module.exports = { expireAbandonedUnpaidOrders };
