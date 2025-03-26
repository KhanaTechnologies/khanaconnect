const { Order } = require('../models/order');
const express = require('express');
const { OrderItem } = require('../models/orderItem');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { Customer } = require('../models/customer');
const DiscountCode = require('../models/discountCode');

const { Product } = require('../models/product');
const { Size } = require('../models/size');
const { sendOrderConfirmationEmail, orderItemProcessed } = require('../utils/email');
const Client = require('../models/client');
const { body, validationResult } = require('express-validator');

// Middleware to authenticate JWT token and extract clientId
const authenticateToken = (req, res, next) => {
    const token = req.headers.authorization;

    if (!token || !token.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
    }

    const tokenValue = token.split(' ')[1];

    jwt.verify(tokenValue, process.env.secret, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Forbidden - Invalid token' });
        }
        req.clientId = user.clientID; // Attach clientId to the request object
        next();
    });
};

// Get all orders for the authenticated client
router.get('/', authenticateToken, async (req, res) => {
    try {
        const orderList = await Order.find({ client: req.clientId })
            .populate('customer', 'customerFirstName emailAddress phoneNumber')
            .populate('orderItems')
            .sort({ dateOrdered: -1 });

        if (!orderList) {
            return res.status(500).json({ success: false, error: 'Failed to fetch orders' });
        }

        res.send(orderList);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Delete an order by ID
router.delete('/:id', authenticateToken, async (req, res) => {
    try {
        const deletedOrder = await Order.findOneAndDelete({ _id: req.params.id, client: req.clientId });
        if (!deletedOrder) {
            return res.status(404).json({ success: false, error: 'Order not found or does not belong to client' });
        }
        res.json({ success: true, message: 'Order deleted successfully' });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Create a new order
// Create a new order
router.post(
    '/',
    authenticateToken,
    [
        body('orderItems').isArray().withMessage('Order items must be an array'),
        body('address').notEmpty().withMessage('Address is required'),
        body('postalCode').notEmpty().withMessage('Postal code is required'),
        body('phone').notEmpty().withMessage('Phone number is required'),
        body('customer').notEmpty().withMessage('Customer ID is required'),
    ],
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const { orderItems, address, postalCode, phone, customer, deliveryType, deliveryPrice, discountCode } = req.body;

            // Validate discount code
            let discountAmount = 0;
            if (discountCode) {
                const code = await DiscountCode.findOne({ code: discountCode, clientID: req.clientId });

                if (!code) {
                    return res.status(400).json({ error: 'Invalid discount code' });
                }

                // Loop through cart products and check eligibility
                for (const productId of orderItems) {
                    const product = await Product.findById(productId);
                    if (product && discount.appliesTo.some(id => id.toString() === product._id.toString())) {
                        eligibleProducts.push(product);
                        discountAmount += (product.price * discount.discount) / 100;
                    }
                }

                // Increase the usage count
                code.usageCount += 1;
                await code.save();

                discountAmount = code.discountAmount || 0;
            }

            // Create OrderItem documents and save them
            const orderItemsIds = await Promise.all(orderItems.map(async (orderItem) => {
                const newOrderItem = new OrderItem({
                    quantity: orderItem.quantity,
                    product: orderItem.product,
                    size: orderItem.size,
                    color: orderItem.color,
                    material: orderItem.material,
                    style: orderItem.style,
                    title: orderItem.title,
                });
                await newOrderItem.save();
                return newOrderItem._id;
            }));

            // Calculate total prices
            const totalPrices = await Promise.all(orderItemsIds.map(async (orderItemId) => {
                const orderItem = await OrderItem.findById(orderItemId).populate('product', 'price');
                return orderItem.product.price * orderItem.quantity;
            }));
            let totalPrice = totalPrices.reduce((a, b) => a + b, 0);

            // Apply discount
            totalPrice = Math.max(0, totalPrice - discountAmount) + deliveryPrice;

            // Create and save the new Order
            const order = new Order({
                orderItems: orderItemsIds,
                address,
                postalCode,
                phone,
                status: 'Pending',
                totalPrice,
                customer,
                deliveryPrice,
                deliveryType,
                client: req.clientId,
            });

            await order.save();

            // Deduct stock count for each product and variant
            for (const orderItem of orderItems) {
                const product = await Product.findById(orderItem.product);
                if (!product) {
                    console.error(`Product not found: ${orderItem.product}`);
                    continue;
                }

                // Deduct countInStock for the product
                product.countInStock -= orderItem.quantity;

                // Deduct quantity for variants (size, color, etc.)
                if (orderItem.size) {
                    const sizeVariant = product.sizes.id(orderItem.size);
                    if (sizeVariant) {
                        sizeVariant.quantity -= orderItem.quantity;
                    }
                }
                if (orderItem.color) {
                    const colorVariant = product.colors.id(orderItem.color);
                    if (colorVariant) {
                        colorVariant.quantity -= orderItem.quantity;
                    }
                }
                if (orderItem.material) {
                    const materialVariant = product.materials.id(orderItem.material);
                    if (materialVariant) {
                        materialVariant.quantity -= orderItem.quantity;
                    }
                }
                if (orderItem.style) {
                    const styleVariant = product.styles.id(orderItem.style);
                    if (styleVariant) {
                        styleVariant.quantity -= orderItem.quantity;
                    }
                }
                if (orderItem.title) {
                    const titleVariant = product.titles.id(orderItem.title);
                    if (titleVariant) {
                        titleVariant.quantity -= orderItem.quantity;
                    }
                }

                await product.save();
            }

            // Send order confirmation email
            const client = await Client.findOne({ clientID: req.clientId });
            if (client) {
                await sendOrderConfirmationEmail(
                    order.customer.emailAddress,
                    order.orderItems,
                    client.businessEmail,
                    client.businessEmailPassword,
                    order.deliveryPrice
                );
            }

            res.status(201).json(order);
        } catch (error) {
            console.error('Error creating order:', error);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
);


// Update an order by ID
router.put('/:id', authenticateToken, async (req, res) => {
    try {
        const { status, orderTrackingLink, orderTrackingCode } = req.body;

        const order = await Order.findOneAndUpdate(
            { _id: req.params.id, client: req.clientId },
            {
                status,
                orderLink: orderTrackingLink,
                orderCode: orderTrackingCode,
            },
            { new: true }
        ).populate('customer')
         .populate('orderItems');

        if (!order) {
            return res.status(404).json({ error: 'Order not found or does not belong to client' });
        }

        // Send email notification if status is updated to "Processed"
        if (status === 'Processed') {
            const client = await Client.findOne({ clientID: req.clientId });
            if (client) {
                await orderItemProcessed(
                    order.customer.emailAddress,
                    client.businessEmail,
                    client.businessEmailPassword
                );
            }
        }

        res.json(order);
    } catch (error) {
        console.error('Error updating order:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get an order by ID
router.get('/:id', authenticateToken, async (req, res) => {
    try {
        const order = await Order.findOne({ _id: req.params.id, client: req.clientId })
            .populate('customer', 'customerFirstName emailAddress phoneNumber')
            .populate({
                path: 'orderItems',
                populate: { path: 'product', populate: 'category' },
            });

        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        res.json(order);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Update order payment status
router.post('/update-order-payment', async (req, res) => {
    try {
        const { item_name, payment_status, totalPrice } = req.body;

        if (!item_name || payment_status !== 'COMPLETE') {
            return res.status(400).json({ error: 'Invalid payment details' });
        }

        const orderId = item_name.split('#')[1]; // Extract order ID from item_name
        const order = await Order.findOne({ _id: orderId }).populate('orderItems').populate('customer');

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        order.paid = true;
        order.totalPrice = totalPrice;
        await order.save();

        // Deduct stock count for each product and variant
        for (const orderItem of order.orderItems) {
            const product = await Product.findById(orderItem.product);
            if (!product) {
                console.error(`Product not found: ${orderItem.product}`);
                continue;
            }

            // Deduct countInStock for the product
            product.countInStock -= orderItem.quantity;

            // Deduct quantity for variants (size, color, etc.)
            if (orderItem.size) {
                const sizeVariant = product.sizes.id(orderItem.size);
                if (sizeVariant) {
                    sizeVariant.quantity -= orderItem.quantity;
                }
            }
            if (orderItem.color) {
                const colorVariant = product.colors.id(orderItem.color);
                if (colorVariant) {
                    colorVariant.quantity -= orderItem.quantity;
                }
            }
            if (orderItem.material) {
                const materialVariant = product.materials.id(orderItem.material);
                if (materialVariant) {
                    materialVariant.quantity -= orderItem.quantity;
                }
            }
            if (orderItem.style) {
                const styleVariant = product.styles.id(orderItem.style);
                if (styleVariant) {
                    styleVariant.quantity -= orderItem.quantity;
                }
            }
            if (orderItem.title) {
                const titleVariant = product.titles.id(orderItem.title);
                if (titleVariant) {
                    titleVariant.quantity -= orderItem.quantity;
                }
            }

            await product.save();
        }

        // Send order confirmation email
        const client = await Client.findOne({ clientID: order.client });
        if (client) {
            await sendOrderConfirmationEmail(
                order.customer.emailAddress,
                order.orderItems,
                client.businessEmail,
                client.businessEmailPassword,
                order.deliveryPrice
            );
        }

        res.json({ success: true, order });
    } catch (error) {
        console.error('Error updating order payment status:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get total sales for the authenticated client
router.get('/get/totalsales', authenticateToken, async (req, res) => {
    try {
        const totalSales = await Order.aggregate([
            { $match: { client: req.clientId } },
            { $group: { _id: null, totalsales: { $sum: '$totalPrice' } } },
        ]);

        if (!totalSales || totalSales.length === 0) {
            return res.send({ totalsales: 0 });
        }

        res.send({ totalsales: totalSales[0].totalsales });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get order count for the authenticated client
router.get('/get/count', authenticateToken, async (req, res) => {
    try {
        const orderCount = await Order.countDocuments({ client: req.clientId });
        res.send({ orderCount });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get user orders by user ID for the authenticated client
router.get('/get/userorders/:userid', authenticateToken, async (req, res) => {
    try {
        const userOrderList = await Order.find({ user: req.params.userid, client: req.clientId })
            .populate({ path: 'orderItems', populate: { path: 'product', populate: 'category' } })
            .sort({ dateOrdered: -1 });

        if (!userOrderList) {
            return res.status(500).json({ success: false });
        }

        res.send(userOrderList);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});



module.exports = router;