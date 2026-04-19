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
const { body, validationResult } = require('express-validator');
const { wrapRoute } = require('../helpers/failureEmail');
const { updateCustomerOrderHistory } = require('../helpers/orderCustomerHistory');
const { fulfillGatewayPayment } = require('../helpers/fulfillGatewayPayment');
const { orderPaymentWebhookOk } = require('../helpers/webhookAuth');
const wishlistNotifyService = require('../services/wishlistNotifyService');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');

// Middleware to authenticate JWT token and extract clientId
const authenticateToken = (req, res, next) => {
    const token = req.headers.authorization;

    if (!token || !token.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
    }

    const tokenValue = token.split(' ')[1];

    try {
        const { decoded } = verifyJwtWithAnySecret(jwt, tokenValue);
        req.clientId = decoded.clientID;
        next();
    } catch (_err) {
        return res.status(403).json({ error: 'Forbidden - Invalid token' });
    }
};

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
    const orderList = await Order.find({ clientID: req.clientId })
        .populate('customer', 'customerFirstName customerLastName emailAddress phoneNumber')
        .populate({
            path: 'orderItems',
            populate: { path: 'product', select: 'productName price images category' }
        })
        .sort({ dateOrdered: -1 });

    if (!orderList) return res.status(500).json({ success: false, error: 'Failed to fetch orders' });
    res.send(orderList);
}));

// Get order by ID
router.get('/:id', authenticateToken, wrapRoute(async (req, res) => {
    const order = await Order.findOne({ _id: req.params.id, clientID: req.clientId })
        .populate('customer', 'customerFirstName customerLastName emailAddress phoneNumber')
        .populate({
            path: 'orderItems',
            populate: { path: 'product', select: 'productName price images category' }
        });

    if (!order) return res.status(404).json({ success: false, error: 'Order not found' });
    res.json(order);
}));

// Delete an order by ID
router.delete('/:id', authenticateToken, wrapRoute(async (req, res) => {
    const deletedOrder = await Order.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });
    if (!deletedOrder) return res.status(404).json({ success: false, error: 'Order not found or does not belong to client' });
    
    // Also remove from customer's order history
    await Customer.updateOne(
        { 'orderHistory.orderId': req.params.id },
        { $pull: { orderHistory: { orderId: req.params.id } } }
    );
    
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
        const prevSnapshot = product.toObject({ depopulate: true });
        product.countInStock -= product_.quantity;
        await product.save();
        wishlistNotifyService
            .handleProductUpdate(prevSnapshot, product.toObject({ depopulate: true }))
            .catch((err) => console.error('wishlist notify (order stock):', err.message));
    }

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
                order._id,
                client.emailSignature || '',
                req.clientId
            );
        } catch (emailError) {
            console.error('Order confirmation email failed to send:', emailError.message);
        }
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
                req.params.id,
                client.return_url,
                client.businessEmail,
                client.businessEmailPassword,
                client.companyName,
                setStatus === 'shipped' ? order._id : 'nothing',
                setStatus === 'shipped' ? order.orderTrackingLink : 'nothing',
                client.emailSignature || '',
                req.clientId
            );
        } catch (emailError) {
            console.error('Email failed to send:', emailError.message);
        }
    }

    res.json(order);
}));

// Update order payment (webhook auth only when ORDER_PAYMENT_WEBHOOK_ENABLED=true)
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