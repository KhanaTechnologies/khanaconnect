const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const EmailSubscriber = require('../models/emailSubscriber'); // Correct import path and case
const createCsvWriter = require('csv-writer').createObjectCsvWriter;

// Middleware to validate token
const validateToken = (req, res, next) => {
    const token = req.headers.authorization;
    if (!token || !token.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
    }
    const tokenValue = token.split(' ')[1];
    jwt.verify(tokenValue, process.env.secret, (err, decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Forbidden - Invalid token', err });
        }
        req.clientID = decoded.clientID;  // Assuming your token securely transmits the clientID
        next();
    });
};

// POST route for subscribing
router.post('/subscribe', validateToken, async (req, res) => {
//const { email, name } = req.body;
   
    const clientID = req.clientID; // Extracted from token via middleware
     console.log(req.body,"from :  ",clientID);
    try {
        const subscription = new EmailSubscriber({ 
            email: req.body.email, 
            name: req.body.name, 
            clientID: req.body.clientID });
        await subscription.save();
        res.status(201).send('Subscription successful.');
    } catch (error) {
        res.status(400).send(error.message);
    }
});

// POST route for unsubscribing
router.post('/unsubscribe', validateToken, async (req, res) => {
    const { email, name } = req.body;
    const clientID = req.clientID; // Extracted from token via middleware
    try {
        await EmailSubscriber.updateOne({ email, name, clientID }, { isActive: false });
        res.status(200).send('Unsubscribed successfully.');
    } catch (error) {
        res.status(400).send(error.message);
    }
});

// GET route for exporting subscriptions to CSV
router.get('/export', validateToken, async (req, res) => {
    const clientID = req.clientID; // Extracted from token via middleware
    try {
        const subscriptions = await EmailSubscriber.find({ clientID });
        const csvWriter = createCsvWriter({
            path: 'subscriptions.csv',
            header: [
                { id: 'name', title: 'NAME' },
                { id: 'email', title: 'EMAIL' },
                { id: 'clientID', title: 'CLIENT_ID' },
                { id: 'dateSubscribed', title: 'DATE_SUBSCRIBED' },
                { id: 'isActive', title: 'IS_ACTIVE' }
            ]
        });

        const data = subscriptions.map(sub => ({
            name: sub.name,
            email: sub.email,
            clientID: sub.clientID,
            dateSubscribed: sub.dateSubscribed,
            isActive: sub.isActive
        }));

        await csvWriter.writeRecords(data);
        res.download('subscriptions.csv');
    } catch (error) {
        res.status(500).send('Failed to export data.');
    }
});

module.exports = router;
