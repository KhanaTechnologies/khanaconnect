const express = require('express');
const Customer = require('../models/customer');
const Client = require('../models/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { sendVerificationEmail } = require('../utils/sendVerificationEmail');
const { sendResetPasswordEmail } = require('../utils/email');
const router = express.Router();

// Rate limiter for login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware to validate token and extract clientID
const validateTokenAndExtractClientID = (req, res, next) => {
  const token = req.headers.authorization;
  if (!token || !token.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });

  const tokenValue = token.split(' ')[1];
  jwt.verify(tokenValue, process.env.secret, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Forbidden - Invalid token', err });
    req.clientID = decoded.clientID;
    next();
  });
};

// --------------------
// CREATE / REGISTER CUSTOMER
// --------------------
router.post('/', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const client = await Client.findOne({ clientID: req.clientID });
    if (!client) return res.status(400).json({ error: 'Client not found' });

    const newCustomer = new Customer({
      clientID: req.clientID,
      customerFirstName: req.body.customerFirstName,
      customerLastName: req.body.customerLastName,
      emailAddress: req.body.emailAddress.toLowerCase(),
      phoneNumber: req.body.phoneNumber,
      passwordHash: bcrypt.hashSync(req.body.password, 10),
      address: `${req.body.street}, ${req.body.apartment}`,
      city: req.body.city,
      postalCode: req.body.postalCode
    });

    const savedCustomer = await newCustomer.save();

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    savedCustomer.emailVerificationToken = verificationToken;
    savedCustomer.emailVerificationExpires = Date.now() + 3600000; // 1 hour
    await savedCustomer.save();

    const verifyUrl = `${client.return_url}/verify-email/${verificationToken}`;

    try {
      await sendVerificationEmail(savedCustomer.emailAddress, verifyUrl, client.businessEmail, client.businessEmailPassword, client.return_url, client.companyName);
    } catch (emailError) {
      console.error('Email failed to send:', emailError.message);
    }

    res.status(201).json(savedCustomer);
  } catch (error) {
    console.error('Error registering customer:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------
// LOGIN CUSTOMER
// --------------------
router.post('/login', loginLimiter, validateTokenAndExtractClientID, async (req, res) => {
  try {
    const { emailAddress, password } = req.body;
    const customer = await Customer.findOne({ emailAddress: emailAddress.toLowerCase(), clientID: req.clientID });
    if (!customer) return res.status(401).json({ error: 'Invalid email address or password' });

    const passwordMatch = bcrypt.compareSync(password, customer.passwordHash);
    if (!passwordMatch) return res.status(401).json({ error: 'Invalid email address or password' });

    const token = jwt.sign({ customerID: customer._id, clientID: customer.clientID, isActive: true }, process.env.secret, { expiresIn: '1d' });
    res.json({ token, customer });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------
// VERIFY EMAIL
// --------------------
router.post('/verify/:token', async (req, res) => {
  try {
    const customer = await Customer.findOne({
      emailVerificationToken: req.params.token,
      emailVerificationExpires: { $gt: Date.now() }
    });
    if (!customer) return res.status(400).json({ message: 'Invalid or expired token' });

    customer.isVerified = true;
    customer.emailVerificationToken = undefined;
    customer.emailVerificationExpires = undefined;
    await customer.save();

    res.json({ message: 'Email verification successful' });
  } catch (err) {
    console.error('Error verifying email:', err);
    res.status(500).json({ message: 'Error verifying email' });
  }
});

// --------------------
// RESET PASSWORD REQUEST
// --------------------
router.post('/reset-password', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const customer = await Customer.findOne({ emailAddress: req.body.emailAddress.toLowerCase(), clientID: req.clientID });
    if (!customer) return res.status(404).json({ message: 'User not found' });

    const client = await Client.findOne({ clientID: req.clientID });
    const token = crypto.randomBytes(32).toString('hex');
    customer.resetPasswordToken = token;
    customer.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await customer.save();

    const resetUrl = `${client.return_url}/reset-password/${token}`;
    await sendResetPasswordEmail(customer.emailAddress, `${customer.customerFirstName} ${customer.customerLastName}`, client.return_url, resetUrl, client.businessEmail, client.businessEmailPassword, client.companyName);

    res.json({ message: 'Reset link sent to email' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error sending reset email' });
  }
});

// --------------------
// RESET PASSWORD
// --------------------
router.post('/reset-password/:token', async (req, res) => {
  try {
    const customer = await Customer.findOne({ resetPasswordToken: req.params.token, resetPasswordExpires: { $gt: Date.now() } });
    if (!customer) return res.status(400).json({ message: 'Invalid or expired token' });

    customer.passwordHash = bcrypt.hashSync(req.body.password, 10);
    customer.resetPasswordToken = undefined;
    customer.resetPasswordExpires = undefined;
    await customer.save();

    res.json({ message: 'Password successfully updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Error resetting password' });
  }
});

// --------------------
// GET CUSTOMER BY ID
// --------------------
router.get('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID }).select('-passwordHash');
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    res.json(customer);
  } catch (error) {
    console.error('Error getting customer:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------
// GET ALL CUSTOMERS
// --------------------
router.get('/', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const customers = await Customer.find({ clientID: req.clientID });
    res.json(customers);
  } catch (error) {
    console.error('Error getting customers:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// --------------------
// DELETE CUSTOMER
// --------------------
router.delete('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) return res.status(404).json({ success: false, message: 'Customer not found' });

    await Customer.findByIdAndRemove(customer._id);
    res.status(200).json({ success: true, message: 'Customer deleted successfully' });
  } catch (error) {
    console.error('Error deleting customer:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// --------------------
// CUSTOMER COUNT
// --------------------
router.get('/get/count', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const customerCount = await Customer.countDocuments({ clientID: req.clientID });
    res.json({ success: true, customerCount });
  } catch (error) {
    console.error('Error counting customers:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

module.exports = router;
