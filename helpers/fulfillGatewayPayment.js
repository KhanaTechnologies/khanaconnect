const mongoose = require('mongoose');
const { Order } = require('../models/order');
const Client = require('../models/client');
const Customer = require('../models/customer');
const { sendOrderConfirmationEmail } = require('../utils/email');
const { updateCustomerOrderHistory } = require('./orderCustomerHistory');
const { mergeRevenueSettings } = require('./revenueDefaults');
const { sendPostPurchaseEmail } = require('./revenueLifecycleEmails');
const { resolveSmtpHost } = require('./mailHost');
const { clientEmailBrandingPayload } = require('./clientEmailBranding');
const WhatsAppService = require('../services/saas/WhatsAppService');

const { deductLineStock } = require('./productInventory');

/**
 * Mark order paid, adjust stock if needed, update customer history, send confirmation email/WA.
 * Idempotent if order is already paid (atomic claim).
 */
async function fulfillGatewayPayment(orderId, totalPrice) {
  if (!mongoose.Types.ObjectId.isValid(String(orderId))) {
    return { ok: false, error: 'Invalid order id' };
  }

  const setPayload = { paid: true };
  if (totalPrice != null && !Number.isNaN(Number(totalPrice))) {
    setPayload.totalPrice = Number(totalPrice);
  }

  const claimed = await Order.findOneAndUpdate(
    { _id: orderId, paid: false, deletedAt: null },
    { $set: setPayload },
    { new: true }
  );
  if (!claimed) {
    const existing = await Order.findById(orderId);
    if (existing?.paid) return { ok: true, alreadyPaid: true };
    return { ok: false, error: 'Order not found' };
  }

  const order = await Order.findById(orderId).populate('orderItems').populate('customer');
  if (!order) return { ok: false, error: 'Order not found' };

  // Stock rules:
  // - stockDeducted === true → already reserved on create
  // - stockDeducted == null → legacy order; stock already deducted on create — mark true
  // - stockDeducted === false → unpaid hold without reservation; deduct now
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

  if (order.customer) {
    await updateCustomerOrderHistory(order.customer._id || order.customer, order, order.orderItems);
  }

  const client = await Client.findOne({ clientID: order.clientID });
  if (client && order.customer) {
    try {
      await sendOrderConfirmationEmail(
        order.customer.emailAddress,
        order.orderItems,
        client.businessEmail,
        client.businessEmailPassword,
        order.deliveryPrice,
        order.clientID,
        order.orderNumber || String(orderId),
        client.emailSignature || '',
        clientEmailBrandingPayload(client),
        order.clientID
      );
    } catch (emailError) {
      console.error('Order confirmation email failed:', emailError.message);
    }

    WhatsAppService.safeNotifyOrderConfirmation({
      clientId: order.clientID,
      to: order.customer.phoneNumber || order.phone,
      companyName: client.companyName,
      orderRef: String(order.orderNumber || order._id),
      total:
        order.finalPrice != null ? `R${Number(order.finalPrice).toFixed(2)}` : undefined,
    }).catch(() => {});

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
