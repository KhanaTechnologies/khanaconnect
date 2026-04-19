const mongoose = require('mongoose');
const { Order } = require('../models/order');
const Product = require('../models/product');
const Client = require('../models/client');
const { sendOrderConfirmationEmail } = require('../utils/email');
const { updateCustomerOrderHistory } = require('./orderCustomerHistory');

/**
 * Mark order paid, adjust stock, update customer history, send confirmation email.
 * Idempotent if order is already paid.
 */
async function fulfillGatewayPayment(orderId, totalPrice) {
  if (!mongoose.Types.ObjectId.isValid(String(orderId))) {
    return { ok: false, error: 'Invalid order id' };
  }

  const order = await Order.findById(orderId).populate('orderItems').populate('customer');
  if (!order) return { ok: false, error: 'Order not found' };
  if (order.paid) return { ok: true, alreadyPaid: true };

  order.paid = true;
  if (totalPrice != null && !Number.isNaN(Number(totalPrice))) {
    order.totalPrice = Number(totalPrice);
  }
  await order.save();

  for (const orderItem of order.orderItems) {
    const product = await Product.findById(orderItem.product);
    if (!product) continue;
    product.countInStock -= orderItem.quantity;
    await product.save();
  }

  await updateCustomerOrderHistory(order.customer._id, order, order.orderItems);

  const client = await Client.findOne({ clientID: order.clientID });
  if (client) {
    try {
      await sendOrderConfirmationEmail(
        order.customer.emailAddress,
        order.orderItems,
        client.businessEmail,
        client.businessEmailPassword,
        order.deliveryPrice,
        order.clientID,
        String(orderId),
        client.emailSignature || '',
        order.clientID
      );
    } catch (emailError) {
      console.error('Order confirmation email failed:', emailError.message);
    }
  }

  return { ok: true };
}

module.exports = { fulfillGatewayPayment };
