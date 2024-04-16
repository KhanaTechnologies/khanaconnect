const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const Customer = require('../models/customer');
const authJwt = require('../helpers/jwt'); // Import the authJwt middleware
const router = express.Router();
const { sendVerificationEmail } = require('../utils/email');

router.use(authJwt());

// Create a new user (client or customer)
router.post('/', async (req, res) => {
    try {
        const { userType, clientID, companyName, merchant_id, merchant_key, password, passphrase, return_url, cancel_url, notify_url, businessEmail, businessEmailPassword,
            customerFirstName, customerLastName, emailAddress, phoneNumber, street, apartment, city, postalCode } = req.body;

        let user;

        // Hash the password before saving it to the database
        const hashedPassword = await bcrypt.hashSync(password, 10);

        if (userType === 'client') {
            const token = generateToken({ clientID, companyName, merchant_id });

            user = new Client({
                clientID,
                companyName,
                password: hashedPassword,
                merchant_id,
                merchant_key,
                passphrase,
                token: token,
                return_url,
                cancel_url,
                notify_url,
                businessEmail,
                businessEmailPassword
            });
        } else if (userType === 'customer') {
            user = new Customer({
                clientID,
                customerFirstName,
                customerLastName,
                emailAddress,
                phoneNumber,
                passwordHash: hashedPassword,
                street,
                apartment,
                city,
                postalCode
            });
        } else {
            return res.status(400).json({ error: 'Invalid user type' });
        }

        const savedUser = await user.save();

        if (userType === 'customer') {
            // Send verification email
            const verificationToken = jwt.sign({ customerId: savedUser._id }, process.env.emailSecret, { expiresIn: '1h' });
            await sendVerificationEmail(savedUser.emailAddress, verificationToken, client.businessEmail, client.businessEmailPassword);
        }

        res.json({ user: savedUser });
    } catch (error) {
        console.error('Error saving user:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Get all users (clients or customers)
router.get('/', async (req, res) => {
    try {
        const { userType } = req.query;
        let users;

        if (userType === 'client') {
            users = await Client.find();
        } else if (userType === 'customer') {
            users = await Customer.find();
        } else {
            return res.status(400).json({ error: 'Invalid user type' });
        }

        res.json(users);
    } catch (error) {
        console.error('Error getting users:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// Helper function to generate a JWT token
function generateToken(client) {
    const secret = process.env.secret;
    const payload = {
        clientID: client.clientID,
        companyName: client.companyName,
        merchant_id: client.merchant_id,
        merchant_key: client.merchant_key,
        passphrase: client.passphrase,
    };

    const token = jwt.sign(payload, secret, { expiresIn: '1y' });

    return token;
}

module.exports = router;
