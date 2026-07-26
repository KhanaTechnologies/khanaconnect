const mongoose = require('mongoose');
const { Order } = require('../models/order');
const Client = require('../models/client');
const Customer = require('../models/customer');
const { sendOrderConfirmationEmail } = require('../utils/email');
const { updateCustomerOrderHistory } = require('./orderCustomerHistory');
const { mergeRevenueSettings } = require('./revenueDefaults');
const { sendPostPurchaseEmail } = require('./revenueLifecycleEmails');
const { resolveSmtpHost } = require('./mailHost');

const { deductLineStock } = require('./productInventory');

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

  // Stock rules:
  // - stockDeducted === true → already reserved (new create path or prior fulfill)
  // - stockDeducted == null → legacy order; stock was already deducted on create — mark true, do not deduct again
  // - stockDeducted === false → unpaid hold without reservation (rare); deduct now
  if (order.stockDeducted === false) {
    for (const orderItem of order.orderItems) {
      try {
        await deductLineStock({
          clientId: order.clientID,
          productId: orderItem.product,
          quantity: orderItem.quantity,
          variant: orderItem.variant || '',
          orderId: String(order._id),
          reason: 'payfast_fulfill',
          allowOversell: true,
        });
      } catch (stockErr) {
        console.error('[fulfill] stock deduct failed:', stockErr.message);
      }
    }
    order.stockDeducted = true;
    await order.save();
  } else if (order.stockDeducted == null) {
    order.stockDeducted = true;
    await order.save();
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

    const settings = mergeRevenueSettings(client.revenueSettings);
    if (settings.postPurchaseEmailsEnabled && resolveSmtpHost(client)) {
      const customer = order.customer;
      const lastSent = customer.revenueLifecycle?.postPurchaseSentAt;
      const cooldown = Date.now() - 30 * 24 * 60 * 60 * 1000;
      if (!lastSent || new Date(lastSent).getTime() < cooldown) {
        setImmediate(async () => {
          try {
            await sendPostPurchaseEmail(customer, client);
            const fresh = await Customer.findById(customer._id);
            if (fresh) {
              fresh.revenueLifecycle = fresh.revenueLifecycle || {};
              fresh.revenueLifecycle.postPurchaseSentAt = new Date();
              await fresh.save();
            }
          } catch (e) {
            console.error('Post-purchase email failed:', e.message);
          }
        });
      }
    }
  }

  return { ok: true };
}

module.exports = { fulfillGatewayPayment };
