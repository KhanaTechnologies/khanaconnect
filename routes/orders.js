const {Order} = require('../models/order');
const express = require('express');
const { OrderItem } = require('../models/orderItem');

const router = express.Router();
const jwt = require('jsonwebtoken');
const {Customer} = require('../models/customer');
const {Product} = require('../models/product');
const {Size} = require('../models/size');
const { sendOrderConfirmationEmail } = require('../utils/email');




const { orderItemProcessed } = require('../utils/email'); // Import the function to send a verification email
const Client = require('../models/client'); // Import your client model
router.get(`/`, async (req, res) =>{

    try {
    const token = req.headers.authorization;

    if (!token || !token.startsWith('Bearer ')) {return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });}
    const tokenValue = token.split(' ')[1];

    jwt.verify(tokenValue, process.env.secret, async (err, user) => {
        if (err) {
          return res.status(403).json({ error: 'Forbidden - Invalid token' });
        }

        req.user = user;
        const clientId = user.clientID;

        const orderList = await Order.find({ client: clientId }).populate('customer','customerFirstName emailAddress phoneNumber').populate('orderItems').sort({'dateOrdered': -1});
        // const orderList = await Order.find().populate('user', 'name').sort({'dateOrdered': -1});
        if(!orderList){res.status(500).json({succsess: false})}
        res.send(orderList);
    });

    }catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
      }
});


// Route to delete an order by ID
router.delete('/:id', async (req, res) => {
    try {
        const deletedOrder = await Order.findOneAndDelete({ _id: req.params.id });
        if (!deletedOrder) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }
        res.json({ success: true, message: 'Order deleted successfully' });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
router.post('/', async (req, res) => {
    try {
        console.log(req.body.orderItem);
        // Extract the token from the headers or body
        const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : req.body.token;
        if (!token) {
            return res.status(401).json({ error: 'Unauthorized - Token missing' });
        }

        // Verify the token
        jwt.verify(token, process.env.secret, async (err, user) => {
            if (err) {
                return res.status(401).json({ error: 'Unauthorized - Invalid token' });
            }

            try {
                const clientId = user.clientID;

                // Create OrderItem documents and save them
                const orderItemsIds = await Promise.all(req.body.orderItems.map(async orderItem => {
                    let newOrderItem = new OrderItem({
                        quantity: orderItem.quantity,
                        product: orderItem.product,
                        size: orderItem.size,
                        color: orderItem.color,
                        material: orderItem.material,
                        style: orderItem.style,
                        title: orderItem.title
                    });
                    newOrderItem = await newOrderItem.save();
                    return newOrderItem._id;
                }));

                // Calculate total prices
                const totalPrices = await Promise.all(orderItemsIds.map(async (orderItemsId) => {
                    const orderItem = await OrderItem.findById(orderItemsId).populate('product', 'price');
                    return (orderItem.product.price * orderItem.quantity);
                }));
                const totalPrice = totalPrices.reduce((a, b) => a + b, 0);

                // Create and save the new Order
                let order = new Order({
                    orderItems: orderItemsIds,
                    address: req.body.address,
                    postalCode: req.body.postalCode,
                    phone: req.body.phone,
                    status: req.body.status,
                    totalPrice: totalPrice + req.body.delivery,
                    customer: req.body.customer,
                    deliveryPrice: req.body.delivery,
                    deliveryType: req.body.deliveryType,
                    clientID: clientId,
                });

                // Update customer details if provided
                const updatedCustomerDetails = {};
                if (req.body.name) updatedCustomerDetails.customerFirstName = req.body.name;
                if (req.body.lastname) updatedCustomerDetails.customerLastName = req.body.lastname;
                if (req.body.email) updatedCustomerDetails.emailAddress = req.body.email;
                if (req.body.phone) updatedCustomerDetails.phoneNumber = req.body.phone;
                if (req.body.address) updatedCustomerDetails.address = req.body.address;
                if (req.body.postalCode) updatedCustomerDetails.postalCode = req.body.postalCode;

                // Save the order
                order = await order.save();
                if (!order) return res.status(500).send('The order cannot be created');

                res.send(order);
            } catch (error) {
                console.error('Error creating order:', error);
                res.status(500).json({ error: 'Internal Server Error' });
            }
        });
    } catch (error) {
        console.error('Error adding item:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});



//update
// Route to update the order
router.put('/:id', async (req, res) => {
    try {
        const token = req.headers.authorization;

        if (!token || !token.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
        }

        const tokenValue = token.split(' ')[1];

        // Decode the token to extract user details
        const decodedToken = jwt.verify(tokenValue, process.env.secret);
        const { clientID } = decodedToken;

        // Find the order by ID and update it
        const order = await Order.findOneAndUpdate(
            { _id: req.params.id, clientID: clientID },  // Ensure the order belongs to the client
            {
                status: req.body.status,
                orderLink: req.body.orderTrackingLink,
                orderCode: req.body.orderTrackingCode
            },
            { new: true }  // Return the updated document
        ).populate('customer')
         .populate('orderItems');

        if (!order) {
            return res.status(404).json({ error: 'Order not found or does not belong to client' });
        }

        // Find the client based on clientID
        const client = await Client.findOne({ clientID: order.client });
        
        if (!client) {
            console.error('Client not found!');
        } else {
            // Send email notification if status is 1
            if (req.body.status === 1) {
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




// Get order by ID
router.get('/:id', async (req, res) => {
    try {
        const token = req.headers.authorization;

        if (!token || !token.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
        }

        const tokenValue = token.split(' ')[1];

        jwt.verify(tokenValue, process.env.secret, async (err, user) => {
            if (err) {
                return res.status(403).json({ error: 'Forbidden - Invalid token' });
            }

            const clientId = user.clientID;


            const order = await Order.findOne({ _id: req.params.id, clientID: clientId })
                .populate('customer', 'customerFirstName emailAddress phoneNumber')
                .populate({path: 'orderItems',populate: {path: 'colors'}, populate: {path: 'product', populate: 'category'}});

            if (!order) {
                return res.status(404).json({ success: false, error: 'Order not found' });
            }

            res.json(order);
        });

    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


// Middleware function to verify JWT token and extract clientId
function authenticateToken(req, res, next) {
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
        next(); // Call next middleware
    });
}


// Route to update the order payment status based on the notification
router.post('/update-order-payment', async (req, res) => {
    try {
      // Extract orderId from the message
    const message = req.body.item_name; // Example: 'Order#66f3d162d1a4c2dd08106bb1'
    const orderId = message.split('#')[1]; // Extract the part after the '#' which is the orderId
    console.log('Extracted orderId:', orderId);
    const paid = req.body.payment_status;
    const { totalPrice } = req.body;
        
        // Validate the required fields
        if (!orderId || paid !== 'COMPLETE') {
            return res.status(400).json({ error: 'Order ID and paid status are required' });
        }

        // Find the order by ID and update the paid status and total price
        const order = await Order.findById(orderId).populate('orderItems');
        if (!order) {
            return res.status(404).json({ error: 'Order not found' });
        }
        console.log(order);
        // Update the order's paid status and total price
        order.paid = true;
        order.totalPrice = totalPrice;
        await order.save();

        // Deduct the quantity from the stock of each product
        for (const item of order.orderItems) {
            const product = await Product.findById(item.product);
            if (product) {
                // Find the variant if applicable and deduct its quantity
                if (item.size) {
                    const sizeVariant = product.sizes.id(item.size);
                    if (sizeVariant) {
                        sizeVariant.quantity -= item.quantity;
                    }
                }
                if (item.color) {
                    const colorVariant = product.colors.id(item.color);
                    if (colorVariant) {
                        colorVariant.quantity -= item.quantity;
                    }
                }
                // Similarly handle other variants like materials, styles, and titles if needed

                // Deduct the countInStock for the product
                product.countInStock -= item.quantity;
                await product.save();
            }
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




// Route to get total sales for a specific client (authenticated)
router.get(`/get/totalsales`, authenticateToken, async (req, res) => {
    try {
        const totalSales = await Order.aggregate([
            { $match: { clientID: req.clientId } }, // Filter by clientId
            { $group: { _id: null, totalsales: { $sum: '$totalPrice' } } }
        ]);
        if (!totalSales) {
            return res.status(400).send('The order sales cannot be generated!');
        }
        res.send({ totalsales: totalSales.pop() });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Route to get order count for a specific client (authenticated)
router.get(`/get/count`, authenticateToken, async (req, res) => {
    try {
        const orderCount = await Order.countDocuments({ clientID: req.clientId }); // Filter by clientId
        if (!orderCount) {
            return  res.send({ orderCount: 0 });

        }
        res.send({ orderCount: orderCount });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Route to get user orders by user ID for a specific client (authenticated)
router.get(`/get/userorders/:userid`, authenticateToken, async (req, res) => {
    try {
        const userOrderList = await Order.find({ user: req.params.userid, clientID: req.clientId }) // Filter by clientId
            .populate({ path: 'orderItems', populate: { path: 'product', populate: 'category' } })
            .sort({ 'dateOrderd': -1 });

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
