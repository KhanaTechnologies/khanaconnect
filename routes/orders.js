const { Order } = require('../models/order');
const express = require('express');
const { OrderItem } = require('../models/orderItem');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { Customer } = require('../models/customer');
const DiscountCode = require('../models/discountCode');
const Product = require('../models/product');
const { Size } = require('../models/size');
const { sendOrderConfirmationEmail, sendOrderStatusUpdateEmail } = require('../utils/email');
const Client = require('../models/client');
const { body, validationResult } = require('express-validator');
const { wrapRoute } = require('../helpers/failureEmail'); // ✅ wrapRoute import

// Middleware to authenticate JWT token and extract clientId
const authenticateToken = (req, res, next) => {
    const token = req.headers.authorization;

    if (!token || !token.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
    }

    const tokenValue = token.split(' ')[1];

    jwt.verify(tokenValue, process.env.secret, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden - Invalid token' });
        req.clientId = user.clientID;
        next();
    });
};

// -------------------- ROUTES -------------------- //

// Get all orders
router.get('/', authenticateToken, wrapRoute(async (req, res) => {
    const orderList = await Order.find({ clientID: req.clientId })
        .populate('customer', 'customerFirstName emailAddress phoneNumber')
        .populate({
            path: 'orderItems',
            populate: { path: 'product', select: 'productName price images' }
        })
        .sort({ dateOrdered: -1 });

    if (!orderList) return res.status(500).json({ success: false, error: 'Failed to fetch orders' });
    res.send(orderList);
}));

// Get order by ID
router.get('/:id', authenticateToken, wrapRoute(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, clientID: req.clientId })
        .populate('customer', 'customerFirstName emailAddress phoneNumber')
        .populate({
            path: 'orderItems',
            populate: { path: 'product', select: 'productName price images' }
        });

    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json(order);
}));

// Delete an order by ID
router.delete('/:id', authenticateToken, wrapRoute(async (req, res) => {
    const deletedOrder = await Order.findOneAndDelete({ _id: req.params.id, client: req.clientId });
    if (!deletedOrder) return res.status(404).json({ success: false, error: 'Order not found or does not belong to client' });
    res.json({ success: true, message: 'Order deleted successfully' });
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

    // Validate discount code
    let discountAmount = 0, isUsed = false;
    if (discountCode) {
        const code = await DiscountCode.findOne({ code: discountCode, clientID: req.clientId });
        if (!code) return res.status(400).json({ error: 'Invalid discount code' });

        for (const orderItem of orderItems) {
            const product = await Product.findById(orderItem.product);
            for (const item of code.appliesTo) {
                if (product.id.toString() === item.toString()) {
                    if (product.salePercentage > 0) {
                        const productCurrentPrice = (product.price * product.salePercentage) / 100;
                        discountAmount += (productCurrentPrice * code.discount) / 100;
                    } else {
                        discountAmount += (product.price * code.discount) / 100;
                    }
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
        const newOrderItem = new OrderItem(orderItem);
        await newOrderItem.save();
        return newOrderItem._id;
    }));

    // Calculate total price
    const totalPrices = await Promise.all(orderItemsIds.map(async (orderItemId) => {
        const orderItem = await OrderItem.findById(orderItemId).populate('product', 'price');
        return (orderItem.variant && orderItem.variantPrice ? orderItem.variantPrice : orderItem.product.price) * orderItem.quantity;
    }));

    const totalPrice = totalPrices.reduce((a, b) => a + b, 0);
    const finalPrice = Math.max(0, totalPrice - discountAmount) + deliveryPrice;

    const order = new Order({
        orderItems: orderItemsIds,
        address, postalCode, phone,
        status: 'Pending',
        totalPrice, discountAmount, checkoutCode: discountCode,
        customer, deliveryPrice, deliveryType, clientID: req.clientId,
        finalPrice, orderNotes: req.body.orderNotes
    });

    await order.save();

    // Deduct stock count
    for (const product_ of orderItems) {
        const product = await Product.findById(product_.product);
        if (!product) continue;
        product.countInStock -= product_.quantity;
        await product.save();
    }

    res.status(201).json(order);
}));

// Update an order
router.put('/:id', authenticateToken, wrapRoute(async (req, res) => {
    let setStatus = req.body.orderTrackingLink && req.body.orderTrackingCode
        ? 'shipped'
        : req.body.status || '';

    const order = await Order.findOneAndUpdate(
        { _id: req.params.id, clientID: req.clientId },
        {
            status: setStatus,
            orderTrackingLink: req.body.orderTrackingLink || '',
            orderTrackingCode: req.body.orderTrackingCode || ''
        },
        { new: true }
    ).populate('customer').populate('orderItems');

    if (!order) return res.status(404).json({ error: 'Order not found or does not belong to client' });

    const client = await Client.findOne({ clientID: req.clientId });
    if (client) {
        try {
            await sendOrderStatusUpdateEmail(
                order.customer.emailAddress,
                `${order.customer.customerFirstName} ${order.customer.customerLastName}`,
                setStatus,
                req.params.id,
                client.return_url,
                client.businessEmail,
                client.businessEmailPassword,
                client.companyName,
                setStatus === 'shipped' ? order._id : 'nothing',
                setStatus === 'shipped' ? order.orderTrackingLink : 'nothing'
            );
        } catch (emailError) {
            console.error('Email failed to send:', emailError.message);
        }
    }

    res.json(order);
}));

// Update order payment
router.post('/update-order-payment', wrapRoute(async (req, res) => {
    const { item_name, payment_status, totalPrice } = req.body;
    if (!item_name || payment_status !== 'COMPLETE') return res.status(400).json({ error: 'Invalid payment details' });

    const orderId = item_name.split('#')[1];
    const order = await Order.findById(orderId).populate('orderItems').populate('customer');
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.paid) return res.json({ success: true, message: 'Order already processed.' });

    order.paid = true;
    order.totalPrice = totalPrice;
    await order.save();

    // Deduct stock
    for (const orderItem of order.orderItems) {
        const product = await Product.findById(orderItem.product);
        if (!product) continue;
        product.countInStock -= orderItem.quantity;
        await product.save();
    }

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
                orderId
            );
        } catch (emailError) {
            console.error('Email failed to send:', emailError.message);
        }
    }

    res.json({ success: true });
}));

// Get total sales
router.get('/get/totalsales', authenticateToken, wrapRoute(async (req, res) => {
    const totalSales = await Order.aggregate([
        { $match: { clientID: req.clientId } },
        { $group: { _id: null, totalsales: { $sum: '$totalPrice' } } },
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

module.exports = router;
