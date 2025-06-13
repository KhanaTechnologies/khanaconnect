const { Order } = require('../models/order');
const express = require('express');
const { OrderItem } = require('../models/orderItem');
const router = express.Router();
const jwt = require('jsonwebtoken');
const { Customer } = require('../models/customer');
const DiscountCode = require('../models/discountCode');

const Product = require('../models/product');
const { Size } = require('../models/size');
const { sendOrderConfirmationEmail } = require('../utils/email');
const { sendOrderStatusUpdateEmail } = require('../utils/email');
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
        const orderList = await Order.find({ clientID: req.clientId })
            .populate('customer', 'customerFirstName emailAddress phoneNumber')
            .populate({
                path: 'orderItems',
                populate: {
                    path: 'product', // Populate the product inside orderItems
                    select: 'productName price images' // Adjust fields as needed
                }
            })
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

            const { address, postalCode, phone, customer, deliveryType, deliveryPrice, discountCode } = req.body;
            const orderItems = req.body.orderItems;

            // Validate discount code
            let discountAmount = 0;
            let isUsed = false;
            if (discountCode) {
                const code = await DiscountCode.findOne({ code: discountCode, clientID: req.clientId });

                if (!code) {
                    return res.status(400).json({ error: 'Invalid discount code' });
                }

                // Loop through cart products and check eligibility
                for (const orderItem of orderItems) {
                    const product = await Product.findOne({_id: orderItem.product});
                    for (const item of code.appliesTo){
                        if (product.id.toString() ===  item.toString() ) {
                            if (product.salePercentage > 0){
                                productCurrentPrice = (product.price * product.salePercentage) / 100;
                                discountAmount += ( productCurrentPrice * code.discount) / 100;
                            }else{discountAmount += (product.price * code.discount) / 100;}
                            isUsed = true;
                        }
                    }
                    
                }
                // Increase the usage count
                if (isUsed)
                {
                    code.usageCount += 1;
                    await code.save();
                }
            }

            // Create OrderItem documents and save them
            const orderItemsIds = await Promise.all(orderItems.map(async (orderItem) => {
                const newOrderItem = new OrderItem({
                    quantity: orderItem.quantity,
                    product: orderItem.product,
                    variant: orderItem.variant,
                    variantPrice: orderItem.variantPrice
                });
                await newOrderItem.save();
                return newOrderItem._id;
            }));

            const orderItemsIdsResolved = await orderItemsIds;

            const totalPrices = await Promise.all(orderItemsIds.map(async (orderItemId) => {
                const orderItem = await OrderItem.findById(orderItemId).populate('product', 'price');
                let price = 0;
            
                // Check if the variantPrice exists; if it does, use it, otherwise use the product's base price
                if (orderItem.variant && orderItem.variantPrice) {
                    price = orderItem.variantPrice * orderItem.quantity;
                } else {
                    // Use the base price of the product if no variantPrice is specified
                    price = orderItem.product.price * orderItem.quantity;
                }
            
                return price;
            }));
            
            // Sum up all the prices to get the final total price
            let totalPrice = totalPrices.reduce((a, b) => a + b, 0);


            // Apply discount
            totalPrice_ = Math.max(0, totalPrice - discountAmount) + deliveryPrice;

            // Create and save the new Order
            const order = new Order({
                orderItems: orderItemsIdsResolved,
                address: req.body.address,
                postalCode :req.body.postalCode ,
                phone :req.body.phone,
                status: 'Pending',
                totalPrice,
                discountAmount : discountAmount,
                checkoutCode : req.body.discountCode,
                customer: req.body.customer,
                deliveryPrice: req.body.deliveryPrice,
                deliveryType : req.body.deliveryType,
                clientID: req.clientId,
                finalPrice: totalPrice_,
                orderNotes: req.body.orderNotes,
                orderTrackingLink: '',
                orderTrackingCode:''
            });

            await order.save();

            // Deduct stock count for each product and variant
            for (const product_ of orderItems) {
                const product = await Product.findOne({_id: product_.product});
                if (!product) {
                    console.error(`Product not found: ${product_.product}`);
                    continue;
                }
                // Deduct countInStock for the product
                product.countInStock -= product_.quantity;
                await product.save();
            }

            // Send order confirmation email
            // const client = await Client.findOne({ clientID: req.clientId });
            // if (client) {
            //     await sendOrderConfirmationEmail(
            //         order.customer.emailAddress,
            //         order.orderItems,
            //         client.businessEmail,
            //         client.businessEmailPassword,
            //         order.deliveryPrice
            //     );
            // }

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
        console.log(req.body)
        let setStatus;
        if (req.body.orderTrackingLink && req.body.orderTrackingCode) {
            setStatus = 'shipped';
        } else if (req.body.status) {
            setStatus = req.body.status;
        }
    

        console.log(setStatus)
        const order = await Order.findOneAndUpdate(
            { _id: req.params.id, clientID: req.clientId },
            {
                status: setStatus || '',
                orderTrackingLink: req.body.orderTrackingLink|| '',
                orderTrackingCode: req.body.orderTrackingCode|| '',
            },
            { new: true }
        ).populate('customer')
         .populate('orderItems');

        if (!order) {
            return res.status(404).json({ error: 'Order not found or does not belong to client' });
        }

        const client = await Client.findOne({ clientID: req.clientId });
        if (client) {
            if (setStatus === 'processed') {
                await sendOrderStatusUpdateEmail(
                    order.customer.emailAddress,
                    order.customer.customerFirstName + ' ' + order.customer.customerLastName,
                    setStatus,
                    req.params.id,
                    client.return_url,
                    client.businessEmail,
                    client.businessEmailPassword,
                    client.companyName,
                    'nothing',
                    'nothing',
                );
            }

            if (setStatus === 'delivered') {
                await sendOrderStatusUpdateEmail(
                    order.customer.emailAddress,
                    order.customer.customerFirstName + ' ' + order.customer.customerLastName,
                    setStatus,
                    req.params.id,
                    client.return_url,
                    client.businessEmail,
                    client.businessEmailPassword,
                    client.companyName,
                    'nothing',
                    'nothing',
                );
            }

            if (setStatus === 'shipped') {
                await sendOrderStatusUpdateEmail(
                     order.customer.emailAddress,
                    order.customer.customerFirstName + ' ' + order.customer.customerLastName,
                    setStatus,
                    req.params.id,
                    client.return_url,
                    client.businessEmail,
                    client.businessEmailPassword,
                    client.companyName,
                    order._id, // for link to view order
                    order.orderTrackingLink // tracking link
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
        const order = await Order.findOne({ _id: req.params.id, clientID: req.clientId })
            .populate('customer', 'customerFirstName emailAddress phoneNumber')
            .populate({
                path: 'orderItems',
                populate: {
                    path: 'product', // Populate the product inside orderItems
                    select: 'productName price images' // Adjust fields as needed
                }
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
        const { item_name, payment_status, totalPrice,m_payment_id } = req.body;

        if (!item_name || payment_status !== 'COMPLETE') {
            return res.status(400).json({ error: 'Invalid payment details' });
        }


        const orderId = item_name.split('#')[1]; // Extract order ID from item_name
        const order = await Order.findOne({ _id: orderId }).populate('orderItems').populate('customer');

        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }

        if (order.paid) {
            console.log('Order already marked as paid. Skipping email and stock deduction.');
            return res.json({ success: true, message: 'Order already processed.' });
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

            await product.save();
        }

        // Send order confirmation email
        const client = await Client.findOne({ clientID: order.clientID });
        if (client) {
            console.log('sending mail')
            await sendOrderConfirmationEmail(
                order.customer.emailAddress,
                order.orderItems,
                client.businessEmail,
                client.businessEmailPassword,
                order.deliveryPrice,
                order.clientID,
                orderId
            );
        }

        res.json({ success: true});
    } catch (error) {
        res.json({ success: false});
       // console.error('Error updating order payment status:', error);
       // res.status(500).json({ error: 'Internal Server Error' });
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
        const userOrderList = await Order.find({ customer: req.params.userid, clientID: req.clientId })
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