const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Client = require('../models/client');
const Customer = require('../models/customer');
const authJwt = require('../helpers/jwt');
const router = express.Router();
const { sendVerificationEmail } = require('../utils/sendVerificationEmail');
const { clientEmailBrandingPayload } = require('../helpers/clientEmailBranding');
const { wrapRoute } = require('../helpers/failureEmail');
const { getJwtSecret } = require('../helpers/jwtSecret');

router.use(authJwt());

// Helper function to generate a JWT token
function generateToken(client) {
    const secret = getJwtSecret();
    const payload = {
        clientID: client.clientID,
        companyName: client.companyName,
        merchant_id: client.merchant_id,
        merchant_key: client.merchant_key,
        passphrase: client.passphrase,
    };
    return jwt.sign(payload, secret, { expiresIn: '1y' });
}

// CREATE a new user (client or customer)
router.post('/', wrapRoute(async (req, res) => {
    const {
        userType,
        clientID,
        companyName,
        merchant_id,
        merchant_key,
        password,
        passphrase,
        return_url,
        cancel_url,
        notify_url,
        businessEmail,
        businessEmailPassword,
        customerFirstName,
        customerLastName,
        emailAddress,
        phoneNumber,
        street,
        apartment,
        city,
        postalCode
    } = req.body;

    let user;

    // Hash the password
    const hashedPassword = bcrypt.hashSync(password, 10);

    if (userType === 'client') {
        const token = generateToken({ clientID, companyName, merchant_id, merchant_key, passphrase });

        user = new Client({
            clientID,
            companyName,
            password: hashedPassword,
            merchant_id,
            merchant_key,
            passphrase,
            token,
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
        const client = await Client.findOne({ clientID });
        if (!client) {
            return res.status(400).json({ error: 'Client not found for customer registration' });
        }

        const verificationToken = crypto.randomBytes(32).toString('hex');
        savedUser.emailVerificationToken = verificationToken;
        savedUser.emailVerificationExpires = Date.now() + 3600000;
        await savedUser.save();

        const verifyUrl = `${client.return_url}/verify-email/${verificationToken}`;

        try {
            await sendVerificationEmail(
                savedUser.emailAddress,
                verifyUrl,
                client.businessEmail,
                client.businessEmailPassword,
                client.return_url,
                client.companyName,
                client.emailSignature || '',
                clientEmailBrandingPayload(client),
                client
            );
        } catch (emailError) {
            console.error('Verification email failed:', emailError.message);
        }
    }

    res.json({ user: savedUser });
}));

// GET all users (clients or customers)
router.get('/', wrapRoute(async (req, res) => {
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
}));

module.exports = router;
