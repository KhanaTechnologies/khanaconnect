const express = require('express');
const router = express.Router();
const Booking = require('../models/booking'); // Import Booking model
const { validateClient } = require('../middleware/validateClient'); // Import validateClient middleware

// Middleware for client validation
const validateClient = async (req, res, next) => {

    try {
        const token = req.headers.authorization;
        if (!token || !token.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
        }
        const tokenValue = token.split(' ')[1];
        jwt.verify(tokenValue, process.env.secret, async (err, user) => {
            if (err) {
                return res.status(403).json({ error: 'Forbidden - Invalid token', err });
            }
            if (!user.clientID) {
                return res.status(403).json({ error: 'Forbidden - Invalid token payload' });
            }
            req.clientId = user.clientID; // Attach client ID to request object

            next();
        });
    } catch (error) {
        console.error('Error in client validation:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

// GET: Get all bookings for a specific client
router.get('/bookings', validateClient, async (req, res) => {
    try {
        const clientId = req.clientId;

        const bookings = await Booking.find({ clientID: clientId });
        res.json(bookings);
    } catch (error) {
        console.error('Error fetching bookings:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET: Get a booking by ID for a specific client
router.get('/bookings/:id', validateClient, async (req, res) => {
    try {
        const { id } = req.params;
        const clientId = req.clientId;

        const booking = await Booking.findOne({ _id: id, clientID: clientId });

        if (!booking) {
            return res.status(404).json({ error: 'Booking not found or unauthorized' });
        }

        res.json(booking);
    } catch (error) {
        console.error('Error fetching booking:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// POST: Create a new booking
router.post('/bookings', validateClient, async (req, res) => {
    try {
        const { bookingDetails, startDate, endDate } = req.body;
        const clientId = req.clientId;

        if (!bookingDetails || !startDate || !endDate) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const booking = new Booking({
            bookingDetails,
            startDate,
            endDate,
            clientID: clientId,
        });

        await booking.save();
        res.status(201).json(booking);
    } catch (error) {
        console.error('Error creating booking:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// PUT: Update a booking by ID
router.put('/bookings/:id', validateClient, async (req, res) => {
    try {
        const { id } = req.params;
        const clientId = req.clientId;
        const { bookingDetails, startDate, endDate } = req.body;

        const booking = await Booking.findOne({ _id: id, clientID: clientId });

        if (!booking) {
            return res.status(404).json({ error: 'Booking not found or unauthorized' });
        }

        booking.bookingDetails = bookingDetails || booking.bookingDetails;
        booking.startDate = startDate || booking.startDate;
        booking.endDate = endDate || booking.endDate;

        await booking.save();
        res.json(booking);
    } catch (error) {
        console.error('Error updating booking:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// DELETE: Delete a booking by ID
router.delete('/bookings/:id', validateClient, async (req, res) => {
    try {
        const { id } = req.params;
        const clientId = req.clientId;

        const booking = await Booking.findOneAndDelete({ _id: id, clientID: clientId });

        if (!booking) {
            return res.status(404).json({ error: 'Booking not found or unauthorized' });
        }

        res.json({ message: 'Booking deleted successfully' });
    } catch (error) {
        console.error('Error deleting booking:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

module.exports = router;
