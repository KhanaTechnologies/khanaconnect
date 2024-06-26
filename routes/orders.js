const {Order} = require('../models/order');
const express = require('express');
const { OrderItem } = require('../models/orderItem');

const router = express.Router();
const jwt = require('jsonwebtoken');
const {Customer} = require('../models/customer');
const {Product} = require('../models/product');
const {Size} = require('../models/size');




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

// Add item
router.post(`/`, async (req, res) => {
    try {
        // Extract the token from the request headers or body
        const token = req.headers.authorization ? req.headers.authorization.split(' ')[1] : req.body.token;

        // Verify the token
        jwt.verify(token, process.env.secret, async (err, user) => {
            if (err) {
                return res.status(401).json({ error: 'Unauthorized' });
            } else {
                try {
                    // Extract the site ID from the decoded token
                    req.user = user;

                    console.log(req.user);
                    const clientId = user.clientID;
                    // Rest of your existing code
                    const orderItemsIds = Promise.all(req.body.orderItems.map(async orderItem => {
                        let newOrderItem = new OrderItem({
                            quantity: orderItem.quantity,
                            product: orderItem.product,
                            size: orderItem.size
                        });
                        newOrderItem = await newOrderItem.save();

                        // Reduce the quantity of the ordered product from inventory
                        return newOrderItem._id;
                    }));
                    const orderItemsIdsResolved = await orderItemsIds;
                    const delivery = req.body.delivery;
                    const deliveryType = req.body.deliveryType;
                    const totalPrices = await Promise.all(orderItemsIdsResolved.map(async (orderItemsId) => {
                        const orderItem = await OrderItem.findById(orderItemsId).populate('product', 'price');
                        const totalPrice = (orderItem.product.price * orderItem.quantity);
                        return totalPrice;
                    }));

                    const totalPrice = totalPrices.reduce((a, b) => a + b, 0);

                    let order = new Order({
                        orderItems: orderItemsIdsResolved,
                        address: req.body.address,
                        postalCode: req.body.postalCode,
                        phone: req.body.phone,
                        status: req.body.status,
                        totalPrice: totalPrice + delivery,
                        customer: req.body.customer,
                        deliveryPrice: req.body.delivery,
                        deliveryType: deliveryType,
                        client: clientId,
                    });


                     // Update customer's details if provided
                     const updatedCustomerDetails = {};
                     if (req.body.name) updatedCustomerDetails.customerFirstName = req.body.name;
                     if (req.body.lastname) updatedCustomerDetails.customerLastName = req.body.lastname;
                     if (req.body.email) updatedCustomerDetails.emailAddress = req.body.email;
                     if (req.body.phone) updatedCustomerDetails.phoneNumber = req.body.phone;
                     if (req.body.address) updatedCustomerDetails.address = req.body.address;
                     if (req.body.postalCode) updatedCustomerDetails.postalCode = req.body.postalCode;
 
                   
                    //  if (Object.keys(updatedCustomerDetails).length !== 0) {
                    //      await Customer.findOne({ _id: req.user.customerID, clientID: req.user.clientID }, updatedCustomerDetails);
                    //  }

                    // if (Object.keys(updatedCustomerDetails).length !== 0) {
                    //     await Customer.findOneAndUpdate(
                    //         { _id: req.user.customerID, clientID: req.user.clientID },
                    //         updatedCustomerDetails,
                    //         { new: true } // This option returns the updated document
                    //     );
                    // }


                    order = await order.save();
                    if (!order) return res.status(500).send('The order cannot be created');
                    res.send(order);
                } catch (error) {
                    console.error('Error creating order:', error);
                    res.status(500).json({ error: 'Internal Server Error' });
                }
            }
        });
    } catch (error) {
        console.error('Error adding item:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


//update
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



        const order = await Order.findByIdAndUpdate(
            req.params.id,
            { status: req.body.status,orderLink : req.body.orderTrackingLink, orderCode : req.body.orderTrackingCode},
            { new: true }
        ).populate('customer').populate('orderItems');

       
    // Now 'products' should contain the updated order with populated 'orderItems' and 'product' fields
    
        let client = '';
        // Find the client based on a specific value (clientID in this example)
        client = await Client.findOne({ clientID: order.client });

        

        if (!order) {
            return res.status(400).send('The order cannot be updated!');
        }

        if (!client) {
             console.error('Client not found!');
        } else {

            if(req.body.status == 1){
                await orderItemProcessed(order.customer.emailAddress, client.businessEmail, client.businessEmailPassword);}
           
        }

        res.send(order);

    } catch (error) {
        console.error('Error:', error);
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


            const order = await Order.findOne({ _id: req.params.id, client: clientId })
                .populate('customer', 'customerFirstName emailAddress phoneNumber')
                .populate({path: 'orderItems', populate: {path: 'product', populate: 'category'}}).populate({path: 'orderItems',populate: {path: 'size'}});

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

// Route to get total sales for a specific client (authenticated)
router.get(`/get/totalsales`, authenticateToken, async (req, res) => {
    try {
        const totalSales = await Order.aggregate([
            { $match: { client: req.clientId } }, // Filter by clientId
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
        const orderCount = await Order.countDocuments({ client: req.clientId }); // Filter by clientId
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
        const userOrderList = await Order.find({ user: req.params.userid, client: req.clientId }) // Filter by clientId
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