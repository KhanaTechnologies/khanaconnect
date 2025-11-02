const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const EmailSubscriber = require('../models/emailSubscriber');
const createCsvWriter = require('csv-writer').createObjectCsvWriter;
const { wrapRoute } = require('../helpers/failureEmail'); // ✅ Import wrapRoute

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
        req.clientID = decoded.clientID;
        next();
    });
};

// POST route for subscribing
router.post('/subscribe', validateToken, wrapRoute(async (req, res) => {
    const { email, name } = req.body;
    const clientID = req.clientID;
    const subscription = new EmailSubscriber({ email, name, clientID });
    await subscription.save();
    res.status(201).send('Subscription successful.');
}));

// POST route for unsubscribing
router.post('/unsubscribe', validateToken, wrapRoute(async (req, res) => {
    const { email, name } = req.body;
    const clientID = req.clientID;
    await EmailSubscriber.updateOne({ email, name, clientID }, { isActive: false });
    res.status(200).send('Unsubscribed successfully.');
}));

// GET route for exporting subscriptions to CSV
router.get('/export', validateToken, wrapRoute(async (req, res) => {
    const clientID = req.clientID;
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
}));

module.exports = router;
