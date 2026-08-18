// routes/ordersRouter.js
const { Order } = require('../models/order');
const express = require('express');
const { OrderItem } = require('../models/orderItem');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Customer = require('../models/customer'); // Updated import
const DiscountCode = require('../models/discountCode');
const Product = require('../models/product');
const { Size } = require('../models/size');
const { sendOrderConfirmationEmail, sendOrderStatusUpdateEmail } = require('../utils/email');
const Client = require('../models/client');
const WhatsAppService = require('../services/saas/WhatsAppService');
const { body, validationResult } = require('express-validator');
const { wrapRoute } = require('../helpers/failureEmail');
const { clientEmailBrandingPayload } = require('../helpers/clientEmailBranding');
const { updateCustomerOrderHistory } = require('../helpers/orderCustomerHistory');
const { fulfillGatewayPayment } = require('../helpers/fulfillGatewayPayment');
const { orderPaymentWebhookOk } = require('../helpers/webhookAuth');
const wishlistNotifyService = require('../services/wishlistNotifyService');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { createDashboardAuth } = require('../helpers/dashboardAuth');
const { recordTeamActivityFromRequest } = require('../helpers/teamActivity');
const { normalizeOrderStatus, generateOrderNumber } = require('../helpers/orderStatus');
const { catalogUnitPrice, parseVariantFields } = require('../helpers/productUnitPrice');
const OrderReturn = require('../models/OrderReturn');

const authenticateToken = createDashboardAuth('orders');

async function restockOrderItems(order, reason = 'order_restock') {
  if (!order || order.stockRestocked) return { restocked: false, reason: 'already' };
  // false = never deducted (new unpaid hold). null/undefined = legacy (was deducted on create).
  if (order.stockDeducted === false) return { restocked: false, reason: 'not_deducted' };
  const items = order.orderItems || [];
  for (const item of items) {
    const productId = item.product?._id || item.product;
    if (!productId) continue;
    await restockLineStock({
      clientId: order.clientID,
      productId,
      quantity: item.quantity,
      variant: item.variant || '',
      orderId: String(order._id),
      reason,
    });
  }
  order.stockRestocked = true;
  order.stockDeducted = false;
  await order.save();
  return { restocked: true };
}

async function deductOrderItems(order, reason = 'order_deduct') {
  if (!order) return { deducted: false, reason: 'missing' };
  // true = already deducted; null/undefined = legacy already deducted at create — do not deduct again
  if (order.stockDeducted === true || order.stockDeducted == null) {
    if (order.stockDeducted == null) {
      order.stockDeducted = true;
      await order.save();
    }
    return { deducted: false, reason: order.stockDeducted === true ? 'already' : 'legacy_marked' };
  }
  const items = order.orderItems || [];
  for (const item of items) {
    const productId = item.product?._id || item.product;
    if (!productId) continue;
    await deductLineStock({
      clientId: order.clientID,
      productId,
      quantity: item.quantity,
      variant: item.variant || '',
      orderId: String(order._id),
      reason,
      allowOversell: true,
    });
  }
  order.stockDeducted = true;
  await order.save();
  return { deducted: true };
}

// -------------------- HELPER FUNCTIONS -------------------- //

/**
 * Calculate next reminder date based on customer's shopping habits
 */
function calculateNextReminder(reminderType, customHours = null) {
    const now = new Date();
    switch (reminderType) {
        case 'hour':
            return new Date(now.getTime() + 60 * 60 * 1000);
        case 'day':
            return new Date(now.getTime() + 24 * 60 * 60 * 1000);
        case 'week':
            return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        case 'month':
            return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
        case 'custom':
            return new Date(now.getTime() + (customHours || 24) * 60 * 60 * 1000);
        default:
            return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
}

// -------------------- ROUTES -------------------- //

// Get all orders
router.get('/', authenticateToken, wrapRoute(async (req, res) => {
    const filter = { clientID: req.clientId, deletedAt: null };
    if (req.query.orderType === 'retail' || req.query.orderType === 'b2b') {
        filter.orderType = req.query.orderType;
    }

    const orderList = await Order.find(filter)
        .populate('customer', 'customerFirstName customerLastName emailAddress phoneNumber')
        .populate({
            path: 'orderItems',
            populate: { path: 'product', select: 'productName price images category sku' }
        })
        .sort({ dateOrdered: -1 });

    if (!orderList) return res.status(500).json({ success: false, error: 'Failed to fetch orders' });
    res.send(orderList);
}));

// Get order by ID
router.get('/:id', authenticateToken, wrapRoute(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, clientID: req.clientId, deletedAt: null })
        .populate('customer', 'customerFirstName customerLastName emailAddress phoneNumber')
        .populate({
            path: 'orderItems',
            populate: { path: 'product', select: 'productName price images category sku' }
        });

    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json(order);
}));

// Hard-delete (legacy behaviour) with restock when stock was reserved.
router.delete('/:id', authenticateToken, wrapRoute(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, clientID: req.clientId, deletedAt: null }).populate('orderItems');
    if (!order) return res.status(404).json({ success: false, error: 'Order not found or does not belong to client' });

    if (order.stockDeducted !== false && !order.stockRestocked) {
      try {
        await restockOrderItems(order, 'order_delete_restock');
      } catch (e) {
        console.warn('[orders] restock on delete failed:', e.message);
      }
    }

    await Order.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });
    await OrderItem.deleteMany({ _id: { $in: (order.orderItems || []).map((i) => i._id || i) } }).catch(() => {});

    await Customer.updateOne(
        { 'orderHistory.orderId': req.params.id },
        { $pull: { orderHistory: { orderId: req.params.id } } }
    );

    res.json({ success: true, message: 'Order deleted successfully' });
    recordTeamActivityFromRequest(req, {
      category: 'orders',
      action: 'order.deleted',
      summary: `Order ${req.params.id} deleted`,
      metadata: { orderId: req.params.id },
    });
}));

// Create a new order
router.post('/', authenticateToken, [
    body('orderItems').isArray().withMessage('Order items must be an array'),
    body('address').notEmpty().withMessage('Address is required'),
    body('postalCode').notEmpty().withMessage('Postal code is required'),
    body('phone').notEmpty().withMessage('Phone number is required'),
    body('customer').notEmpty().withMessage('Customer ID is required'),
], wrapRoute(async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { address, postalCode, phone, customer, deliveryType, deliveryPrice, discountCode } = req.body;
    const orderItems = req.body.orderItems;
    const city = String(req.body.city || '').trim();
    const province = String(req.body.province || '').trim();
    const country = String(req.body.country || 'ZA').trim() || 'ZA';

    // Validate customer exists and belongs to client
    const customerDoc = await Customer.findOne({ _id: customer, clientID: req.clientId });
    if (!customerDoc) {
        return res.status(404).json({ error: 'Customer not found' });
    }

    // Validate discount code
    let discountAmount = 0, isUsed = false;
    if (discountCode) {
        const code = await DiscountCode.findOne({ code: discountCode, clientID: req.clientId });
        if (!code) return res.status(400).json({ error: 'Invalid discount code' });
        const alreadyUsedByCustomer = await Order.exists({
            clientID: req.clientId,
            customer,
            checkoutCode: discountCode,
        });
        if (alreadyUsedByCustomer) {
            return res.status(400).json({ error: 'This discount code has already been used on this account' });
        }
        if (code.usageCount >= code.usageLimit) {
            return res.status(400).json({ error: 'This discount code is no longer available' });
        }

        for (const orderItem of orderItems) {
            const product = await Product.findOne({
              _id: orderItem.product,
              clientID: req.clientId,
              status: { $ne: 'archived' },
            });
            if (!product) {
              return res.status(400).json({ error: 'One or more products are invalid for this store' });
            }
            const parsed = parseVariantFields(orderItem.variant);
            const unit = catalogUnitPrice(product, parsed.name, parsed.value || String(orderItem.variant || ''));
            for (const item of code.appliesTo) {
                if (product.id.toString() === item.toString()) {
                    discountAmount += (unit * code.discount) / 100;
                    isUsed = true;
                }
            }
        }

        if (isUsed) {
            code.usageCount += 1;
            await code.save();
        }
    }

    // Create OrderItem documents
    const orderItemsIds = await Promise.all(orderItems.map(async (orderItem) => {
        const product = await Product.findOne({
          _id: orderItem.product,
          clientID: req.clientId,
          status: { $ne: 'archived' },
        });
        if (!product) {
          throw Object.assign(new Error('Invalid product for this store'), { status: 400 });
        }
        const parsed = parseVariantFields(orderItem.variant);
        const variantLabel = parsed.value || (typeof orderItem.variant === 'string' ? orderItem.variant : '');
        const unit = catalogUnitPrice(product, parsed.name, variantLabel);
        const quantity = Math.max(1, Number(orderItem.quantity) || 1);
        const newOrderItem = new OrderItem({
          product: product._id,
          quantity,
          variant: variantLabel || parsed.name,
          variantPrice: unit,
        });
        await newOrderItem.save();
        return newOrderItem._id;
    }));

    const totalPrices = await Promise.all(orderItemsIds.map(async (orderItemId) => {
        const orderItem = await OrderItem.findById(orderItemId);
        return Number(orderItem.variantPrice || 0) * Number(orderItem.quantity || 0);
    }));

    const totalPrice = totalPrices.reduce((a, b) => a + b, 0);
    const shipping = Math.max(0, Number(deliveryPrice) || 0);
    const finalPrice = Math.max(0, totalPrice - discountAmount) + shipping;
    const allowPaid = !!(req.teamSession && req.teamSession.member);
    const markPaid = allowPaid && (req.body.paid === true || req.body.paid === 'true');

    const order = new Order({
        orderItems: orderItemsIds,
        address,
        city,
        province,
        country,
        postalCode,
        phone,
        status: 'pending',
        orderNumber: generateOrderNumber(),
        invoiceNumber: '',
        totalPrice,
        discountAmount,
        checkoutCode: discountCode,
        customer,
        deliveryPrice: shipping,
        deliveryType,
        clientID: req.clientId,
        finalPrice,
        orderNotes: req.body.orderNotes,
        paid: !!markPaid,
        // Match legacy: reserve stock on create for all orders (including unpaid PayFast).
        // stockDeducted starts false then flips true after deduct below.
        stockDeducted: false,
    });

    await order.save();
    if (!order.invoiceNumber) {
      order.invoiceNumber = `INV-${order.orderNumber}`;
      await order.save();
    }

    // Always deduct on create (same as pre-gap-close behaviour) so inventory stays reserved.
    // PayFast fulfill uses stockDeducted guard and will not double-deduct.
    const populated = await Order.findById(order._id).populate('orderItems');
    await deductOrderItems(populated, 'order_create');

    // Update customer order history and analytics (in background)
    updateCustomerOrderHistory(customer, order, orderItems).catch(error => {
        console.error('Failed to update customer order history:', error);
    });

    // Send order confirmation email
    const client = await Client.findOne({ clientID: req.clientId });
    if (client) {
        try {
            await sendOrderConfirmationEmail(
                customerDoc.emailAddress,
                orderItems,
                client.businessEmail,
                client.businessEmailPassword,
                deliveryPrice,
                req.clientId,
                order.orderNumber || order._id,
                client.emailSignature || '',
                clientEmailBrandingPayload(client),
                req.clientId
            );
        } catch (emailError) {
            console.error('Order confirmation email failed to send:', emailError.message);
        }

        WhatsAppService.safeNotifyOrderConfirmation({
            clientId: req.clientId,
            to: customerDoc.phoneNumber,
            companyName: client.companyName,
            orderRef: String(order.orderNumber || order._id),
            total:
                order.finalPrice != null
                    ? `R${Number(order.finalPrice).toFixed(2)}`
                    : undefined,
        }).catch(() => {});
    }

    res.status(201).json(order);
    recordTeamActivityFromRequest(req, {
      category: 'orders',
      action: 'order.created',
      summary: `Order ${order.orderNumber || order._id} created`,
      metadata: { orderId: String(order._id), orderNumber: order.orderNumber },
    });
}));

// Update an order
router.put('/:id', authenticateToken, wrapRoute(async (req, res) => {
    const existing = await Order.findOne({ _id: req.params.id, clientID: req.clientId, deletedAt: null }).populate('orderItems');
    if (!existing) return res.status(404).json({ error: 'Order not found or does not belong to client' });

    let setStatus = req.body.orderTrackingLink && req.body.orderTrackingCode
        ? 'shipped'
        : req.body.status || existing.status;
    setStatus = normalizeOrderStatus(setStatus, existing.status || 'pending');

    const prevStatus = normalizeOrderStatus(existing.status, 'pending');

    existing.status = setStatus;
    if (req.body.orderTrackingLink !== undefined) existing.orderTrackingLink = req.body.orderTrackingLink || '';
    if (req.body.orderTrackingCode !== undefined) existing.orderTrackingCode = req.body.orderTrackingCode || '';
    if (req.body.city !== undefined) existing.city = String(req.body.city || '');
    if (req.body.province !== undefined) existing.province = String(req.body.province || '');
    if (req.body.country !== undefined) existing.country = String(req.body.country || 'ZA');
    if (req.body.address !== undefined) existing.address = String(req.body.address || existing.address);
    await existing.save();

    // Cancel → restock once
    if (setStatus === 'cancelled' && prevStatus !== 'cancelled') {
      await restockOrderItems(existing, 'order_cancel_restock');
    }

    const order = await Order.findById(existing._id).populate('customer').populate('orderItems');

    // Update customer order history status
    if (setStatus) {
        await Customer.updateOne(
            { 'orderHistory.orderId': req.params.id },
            { $set: { 'orderHistory.$.status': setStatus } }
        );
    }

    const client = await Client.findOne({ clientID: req.clientId });
    if (client) {
        try {
            await sendOrderStatusUpdateEmail(
                order.customer.emailAddress,
                `${order.customer.customerFirstName} ${order.customer.customerLastName}`,
                setStatus,
                order.orderNumber || req.params.id,
                client.return_url,
                client.businessEmail,
                client.businessEmailPassword,
                client.companyName,
                setStatus === 'shipped' ? order._id : 'nothing',
                setStatus === 'shipped' ? order.orderTrackingLink : 'nothing',
                client.emailSignature || '',
                clientEmailBrandingPayload(client),
                req.clientId
            );
        } catch (emailError) {
            console.error('Email failed to send:', emailError.message);
        }

        const phone =
            order.customer?.phoneNumber ||
            order.customerPhone ||
            order.phone ||
            '';
        WhatsAppService.safeNotifyOrderStatus({
            clientId: req.clientId,
            to: phone,
            companyName: client.companyName,
            orderRef: String(order.orderNumber || order._id),
            status: setStatus || order.status || 'updated',
        }).catch(() => {});
    }

    res.json(order);
    recordTeamActivityFromRequest(req, {
      category: 'orders',
      action: 'order.updated',
      summary: `Order ${order.orderNumber || order._id} updated (${setStatus || 'status change'})`,
      metadata: { orderId: String(order._id), status: setStatus },
    });
}));

// Manual refund (merchant marks refunded; gateway refund is out-of-band until PayFast API)
router.post('/:id/refund', authenticateToken, wrapRoute(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, clientID: req.clientId, deletedAt: null }).populate('orderItems').populate('customer');
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.refunded) return res.status(400).json({ error: 'Order already refunded' });

  if (order.stockDeducted !== false && !order.stockRestocked) {
    await restockOrderItems(order, 'order_refund_restock');
  }

  order.refunded = true;
  order.refundedAt = new Date();
  order.status = 'refunded';
  await order.save();

  const client = await Client.findOne({ clientID: req.clientId });
  if (client && order.customer) {
    WhatsAppService.safeNotifyOrderStatus({
      clientId: req.clientId,
      to: order.customer.phoneNumber || order.phone,
      companyName: client.companyName,
      orderRef: String(order.orderNumber || order._id),
      status: 'refunded',
    }).catch(() => {});
  }

  res.json({
    ok: true,
    order,
    note: 'Marked refunded in Khana. Process the payment refund in PayFast/your gateway separately until API refunds are enabled.',
  });
}));

// Partial fulfill line items
router.post('/:id/fulfill', authenticateToken, wrapRoute(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, clientID: req.clientId, deletedAt: null }).populate('orderItems');
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const lines = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!lines.length) return res.status(400).json({ error: 'items array required [{ orderItemId, qty }]' });

  for (const line of lines) {
    const item = order.orderItems.find((oi) => String(oi._id) === String(line.orderItemId || line.id));
    if (!item) continue;
    const add = Math.max(0, Number(line.qty || line.quantity) || 0);
    const next = Math.min(Number(item.quantity) || 0, (Number(item.fulfilledQty) || 0) + add);
    item.fulfilledQty = next;
    await item.save();
  }

  const refreshed = await Order.findById(order._id).populate('orderItems');
  const allDone = (refreshed.orderItems || []).every(
    (oi) => Number(oi.fulfilledQty || 0) >= Number(oi.quantity || 0)
  );
  const anyDone = (refreshed.orderItems || []).some((oi) => Number(oi.fulfilledQty || 0) > 0);
  if (allDone) refreshed.status = 'shipped';
  else if (anyDone) refreshed.status = 'processed';
  await refreshed.save();

  res.json(refreshed);
}));

// Returns RMA
router.post('/:id/returns', authenticateToken, wrapRoute(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, clientID: req.clientId, deletedAt: null }).populate('orderItems');
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const orderItemId = req.body.orderItemId || req.body.orderItem;
  const qty = Math.max(1, Number(req.body.quantity) || 1);
  const item = order.orderItems.find((oi) => String(oi._id) === String(orderItemId));
  if (!item) return res.status(400).json({ error: 'orderItemId not on this order' });

  const ret = await OrderReturn.create({
    clientID: req.clientId,
    order: order._id,
    orderItem: item._id,
    product: item.product,
    quantity: Math.min(qty, Number(item.quantity) || qty),
    reason: String(req.body.reason || '').trim(),
    status: req.body.approve === true || req.body.status === 'approved' ? 'approved' : 'requested',
  });

  if (ret.status === 'approved' && !ret.restocked) {
    await restockLineStock({
      clientId: req.clientId,
      productId: item.product,
      quantity: ret.quantity,
      variant: item.variant || '',
      orderId: String(order._id),
      reason: 'order_return_restock',
    });
    ret.restocked = true;
    await ret.save();
  }

  res.status(201).json(ret);
}));

router.post('/:id/returns/:returnId/approve', authenticateToken, wrapRoute(async (req, res) => {
  const ret = await OrderReturn.findOne({ _id: req.params.returnId, clientID: req.clientId, order: req.params.id });
  if (!ret) return res.status(404).json({ error: 'Return not found' });
  if (ret.status === 'approved' && ret.restocked) return res.json(ret);

  const item = await OrderItem.findById(ret.orderItem);
  ret.status = 'approved';
  if (item && !ret.restocked) {
    await restockLineStock({
      clientId: req.clientId,
      productId: item.product,
      quantity: ret.quantity,
      variant: item.variant || '',
      orderId: String(ret.order),
      reason: 'order_return_restock',
    });
    ret.restocked = true;
  }
  await ret.save();
  res.json(ret);
}));

router.get('/:id/invoice', authenticateToken, wrapRoute(async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, clientID: req.clientId, deletedAt: null })
    .populate('customer')
    .populate({ path: 'orderItems', populate: { path: 'product', select: 'productName price sku' } });
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const client = await Client.findOne({ clientID: req.clientId });
  const vatRate = Number(client?.vatRate ?? client?.settings?.vatRate ?? 15);
  const lines = (order.orderItems || []).map((oi) => {
    const unit = oi.variantPrice != null ? Number(oi.variantPrice) : Number(oi.product?.price || 0);
    const lineExVat = unit * Number(oi.quantity || 0);
    return {
      name: oi.product?.productName || 'Item',
      sku: oi.product?.sku || '',
      qty: oi.quantity,
      unit,
      lineExVat,
      vat: lineExVat * (vatRate / (100 + vatRate)),
      lineIncVat: lineExVat,
    };
  });
  const subtotalInc = Number(order.finalPrice != null ? order.finalPrice : order.totalPrice) || 0;
  const vatAmount = subtotalInc * (vatRate / (100 + vatRate));
  const exVat = subtotalInc - vatAmount;

  res.json({
    invoiceNumber: order.invoiceNumber || `INV-${order.orderNumber || order._id}`,
    creditNote: !!order.refunded,
    orderNumber: order.orderNumber || String(order._id),
    date: order.dateOrdered,
    status: order.status,
    customer: order.customer
      ? {
          name: `${order.customer.customerFirstName || ''} ${order.customer.customerLastName || ''}`.trim(),
          email: order.customer.emailAddress,
          phone: order.customer.phoneNumber || order.phone,
        }
      : null,
    address: {
      line1: order.address,
      city: order.city || '',
      province: order.province || '',
      country: order.country || 'ZA',
      postalCode: order.postalCode,
    },
    supplier: {
      name: client?.companyName || req.clientId,
      vatNumber: client?.vatNumber || client?.companyVAT || '',
      email: client?.businessEmail || '',
    },
    vatRate,
    lines,
    totals: {
      exVat: Math.round(exVat * 100) / 100,
      vat: Math.round(vatAmount * 100) / 100,
      incVat: Math.round(subtotalInc * 100) / 100,
      delivery: order.deliveryPrice || 0,
      discount: order.discountAmount || 0,
    },
  });
}));
router.post('/update-order-payment', wrapRoute(async (req, res) => {
    if (!orderPaymentWebhookOk(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { item_name, payment_status, totalPrice } = req.body;
    if (!item_name || payment_status !== 'COMPLETE') return res.status(400).json({ error: 'Invalid payment details' });

    const orderId = item_name.split('#')[1];
    const result = await fulfillGatewayPayment(orderId, totalPrice);
    if (!result.ok) return res.status(404).json({ error: result.error || 'Order not found' });
    res.json({ success: true, alreadyPaid: !!result.alreadyPaid });
}));

// Get total sales
router.get('/get/totalsales', authenticateToken, wrapRoute(async (req, res) => {
    const totalSales = await Order.aggregate([
        { $match: { clientID: req.clientId, paid: true } },
        { $group: { _id: null, totalsales: { $sum: '$finalPrice' } } },
    ]);

    res.send({ totalsales: totalSales.length > 0 ? totalSales[0].totalsales : 0 });
}));

// Get order count
router.get('/get/count', authenticateToken, wrapRoute(async (req, res) => {
    const orderCount = await Order.countDocuments({ clientID: req.clientId });
    res.send({ orderCount });
}));

// Get user orders
router.get('/get/userorders/:userid', authenticateToken, wrapRoute(async (req, res) => {
    const userOrderList = await Order.find({ customer: req.params.userid, clientID: req.clientId })
        .populate({ path: 'orderItems', populate: { path: 'product', populate: 'category' } })
        .sort({ dateOrdered: -1 });

    res.send(userOrderList);
}));

// Get customer order analytics
router.get('/analytics/customer/:customerId', authenticateToken, wrapRoute(async (req, res) => {
    try {
        const customer = await Customer.findOne({ _id: req.params.customerId, clientID: req.clientId });
        if (!customer) return res.status(404).json({ error: 'Customer not found' });

        const orders = await Order.find({ customer: req.params.customerId, clientID: req.clientId });
        
        const analytics = {
            totalOrders: orders.length,
            totalSpent: orders.reduce((sum, order) => sum + order.finalPrice, 0),
            averageOrderValue: orders.length > 0 ? orders.reduce((sum, order) => sum + order.finalPrice, 0) / orders.length : 0,
            orderFrequency: calculateOrderFrequency(orders),
            favoriteCategories: getCustomerFavoriteCategories(customer),
            recentOrders: orders.slice(0, 5).map(order => ({
                orderId: order._id,
                date: order.dateOrdered,
                total: order.finalPrice,
                status: order.status
            }))
        };

        res.json({ success: true, analytics });
    } catch (error) {
        console.error('Error getting customer order analytics:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}));

// Get sales analytics
router.get('/analytics/sales', authenticateToken, wrapRoute(async (req, res) => {
    try {
        const { period = 'monthly' } = req.query; // weekly, monthly, yearly
        
        const orders = await Order.find({ clientID: req.clientId, paid: true });
        const salesData = analyzeSalesData(orders, period);

        res.json({ success: true, period, salesData });
    } catch (error) {
        console.error('Error getting sales analytics:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}));

// -------------------- ANALYTICS HELPER FUNCTIONS -------------------- //

function calculateOrderFrequency(orders) {
    if (orders.length < 2) return 'Not enough data';
    
    const sortedOrders = orders.sort((a, b) => new Date(a.dateOrdered) - new Date(b.dateOrdered));
    let totalDays = 0;
    
    for (let i = 1; i < sortedOrders.length; i++) {
        const daysBetween = (new Date(sortedOrders[i].dateOrdered) - new Date(sortedOrders[i-1].dateOrdered)) / (1000 * 60 * 60 * 24);
        totalDays += daysBetween;
    }
    
    const averageDays = totalDays / (sortedOrders.length - 1);
    return `${averageDays.toFixed(1)} days`;
}

function getCustomerFavoriteCategories(customer) {
    const categoryCount = {};
    customer.orderHistory.forEach(order => {
        order.products.forEach(product => {
            if (product.category) {
                categoryCount[product.category] = (categoryCount[product.category] || 0) + 1;
            }
        });
    });

    return Object.entries(categoryCount)
        .sort(([,a], [,b]) => b - a)
        .slice(0, 5)
        .map(([category, count]) => ({ category, count }));
}

function analyzeSalesData(orders, period) {
    const now = new Date();
    let startDate;
    
    switch (period) {
        case 'weekly':
            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            break;
        case 'monthly':
            startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            break;
        case 'yearly':
            startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
            break;
        default:
            startDate = new Date(0); // All time
    }

    const filteredOrders = orders.filter(order => order.dateOrdered >= startDate);
    
    return {
        totalSales: filteredOrders.length,
        totalRevenue: filteredOrders.reduce((sum, order) => sum + order.finalPrice, 0),
        averageOrderValue: filteredOrders.length > 0 ? filteredOrders.reduce((sum, order) => sum + order.finalPrice, 0) / filteredOrders.length : 0,
        ordersByStatus: getOrdersByStatus(filteredOrders),
        revenueByPeriod: getRevenueByPeriod(filteredOrders, period),
        topProducts: getTopProducts(filteredOrders)
    };
}

function getOrdersByStatus(orders) {
    const statusCount = {};
    orders.forEach(order => {
        statusCount[order.status] = (statusCount[order.status] || 0) + 1;
    });
    return statusCount;
}

function getRevenueByPeriod(orders, period) {
    const revenueData = {};
    orders.forEach(order => {
        let key;
        const date = new Date(order.dateOrdered);
        
        if (period === 'weekly') {
            key = date.toISOString().split('T')[0]; // Daily for weekly view
        } else if (period === 'monthly') {
            key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        } else {
            key = date.getFullYear().toString();
        }
        
        revenueData[key] = (revenueData[key] || 0) + order.finalPrice;
    });
    
    return revenueData;
}

async function getTopProducts(orders) {
    const productStats = {};
    
    for (const order of orders) {
        const populatedOrder = await Order.findById(order._id).populate({
            path: 'orderItems',
            populate: { path: 'product', select: 'productName' }
        });
        
        populatedOrder.orderItems.forEach(item => {
            const productId = item.product._id.toString();
            if (!productStats[productId]) {
                productStats[productId] = {
                    productId,
                    productName: item.product.productName,
                    quantity: 0,
                    revenue: 0
                };
            }
            productStats[productId].quantity += item.quantity;
            productStats[productId].revenue += (item.variantPrice || item.product.price) * item.quantity;
        });
    }
    
    return Object.values(productStats)
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);
}

module.exports = router;