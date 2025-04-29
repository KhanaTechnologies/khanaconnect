const express = require('express');
const Customer = require('../models/customer');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { sendVerificationEmail } = require('../utils/email'); // Import the function to send a verification email
const Client = require('../models/client'); // Import your client model
const rateLimit = require('express-rate-limit');



const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    error: 'Too many login attempts, please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware function to validate token and extract clientID
const validateTokenAndExtractClientID = (req, res, next) => {
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


// Verification endpoint
router.get('/verify', async (req, res) => {
  try {
    const verificationToken = req.query.token;
    const decoded = jwt.verify(verificationToken, process.env.emailSecret);
    const { customerId } = decoded;
    
    // Fetch customer details including isVerified field
    const customer = await Customer.findById(customerId);

    // If customer not found or already verified, return error
    if (!customer || customer.isVerified) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    // Update the isVerified field to true
    await Customer.findByIdAndUpdate(customerId, { isVerified: true });

    // Send response indicating successful verification
    res.json({ message: 'Email verification successful' });
  } catch (error) {
    console.error('Error verifying token:', error);
    res.status(400).json({ error: 'Invalid or expired token' });
  }
});





// __________________________________________________________________________________________________________
// __________________________________________________________________________________________________________
// __________________________________________________________________________________________________________
//       Good code
// __________________________________________________________________________________________________________
// __________________________________________________________________________________________________________
// __________________________________________________________________________________________________________


//Create a new customer
router.post('/', async (req, res) => {
  try {
    const token = req.headers.authorization;
    if (!token || !token.startsWith('Bearer ')) {return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });}
    const tokenValue = token.split(' ')[1];

    jwt.verify(tokenValue, process.env.secret, async (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Forbidden - Invalid token', err });
      }
      const clientId = user.clientID;

      let client = '';
      const newCustomer = new Customer({
        customerFirstName:req.body.customerFirstName,
        customerLastName:req.body.customerLastName,
        emailAddress:req.body.emailAddress,
        phoneNumber:req.body.phoneNumber,
        passwordHash:bcrypt.hashSync(req.body.password,10),
        street:req.body.street,
        apartment:req.body.apartment,
        city:req.body.city,
        postalCode:req.body.postalCode,
        clientID: clientId,
      });
      try {
         client = await Client.findOne({ clientID: clientId });

      } catch (error) {
        console.error('Error finding clients:', error);
      }

      try {
        const savedCustomer = await newCustomer.save();
         // Send verification email
      const verificationToken = jwt.sign({ customerId: savedCustomer._id }, process.env.emailSecret, { expiresIn: '1h' });
      await sendVerificationEmail(savedCustomer.emailAddress, verificationToken, client.businessEmail, client.businessEmailPassword);

        res.json(savedCustomer);
      } catch (saveError) {
        console.error('Error saving customer:', saveError);
        res.status(500).json({ error: 'Error saving customer' });
      }
  });
    
  } catch (error) {
    console.error('Error saving customer:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});




//Oline registration a new customer
router.post('/registration', async (req, res) => {
  try {

    const token = req.headers.authorization;
    if (!token || !token.startsWith('Bearer ')) {return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });}
    const tokenValue = token.split(' ')[1];

    jwt.verify(tokenValue, process.env.secret, async (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Forbidden - Invalid token', err });
      }
      const clientId = user.clientID;
      let client = '';
      const newCustomer = new Customer({
        customerFirstName:req.body.customerFirstName,
        customerLastName:req.body.customerLastName,
        emailAddress:req.body.emailAddress.toLowerCase(),
        passwordHash:bcrypt.hashSync(req.body.password,10),
        clientID: clientId,
      });
      try {
         client = await Client.findOne({ clientID: clientId });

      } catch (error) {
        console.error('Error finding clients:', error);
      }

      try {
        const savedCustomer = await newCustomer.save();
         // Send verification email
      const verificationToken = jwt.sign({ customerId: savedCustomer._id }, process.env.emailSecret, { expiresIn: '1h' });
      await sendVerificationEmail(savedCustomer.emailAddress, verificationToken, client.businessEmail, client.businessEmailPassword);

        res.json(savedCustomer);
      } catch (saveError) {
        console.error('Error saving customer:', saveError);
        res.status(500).json({ error: 'Error saving customer' });
      }
  });
    
  } catch (error) {
    console.error('Error saving customer:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



// Update an existing customer
router.put('/:customerId', async (req, res) => {
  console.log(req.body);
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

      const clientId = user.clientID;
      const customerId = req.params.customerId;

      // Find the customer by ID and clientID
      const existingCustomer = await Customer.findOne({ _id: customerId, clientID: clientId });

      if (!existingCustomer) {
        return res.status(404).json({ error: 'Customer not found' });
      }

      // Update customer fields based on request body
      existingCustomer.customerFirstName = req.body.customerFirstName || existingCustomer.customerFirstName;
      existingCustomer.customerLastName = req.body.customerLastName || existingCustomer.customerLastName;
      existingCustomer.emailAddress = req.body.emailAddress || existingCustomer.emailAddress;
      existingCustomer.phoneNumber = req.body.phoneNumber || existingCustomer.phoneNumber;
      if (req.body.password) {
        existingCustomer.passwordHash = bcrypt.hashSync(req.body.password, 10);
      }
      existingCustomer.address = req.body.street || existingCustomer.address;
      existingCustomer.city = req.body.city || existingCustomer.city;
      existingCustomer.postalCode = req.body.postalCode || existingCustomer.postalCode;
      // Save the updated customer
      try {
        const updatedCustomer = await existingCustomer.save();
        res.json(updatedCustomer);
      } catch (updateError) {
        console.error('Error updating customer:', updateError);
        res.status(500).json({ error: 'Error updating customer' });
      }
    });
  } catch (error) {
    console.error('Error updating customer:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



// Login route
router.post('/login', loginLimiter, validateTokenAndExtractClientID, async (req, res) => {
  try {
    const { emailAddress, password } = req.body;
    const siteToken = req.headers.authorization;

    if (!siteToken || !siteToken.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - Site token missing or invalid format' });
    }

    const tokenValue = siteToken.split(' ')[1];

    // Convert email to lowercase if it's a string
    const emailAddressLower = typeof emailAddress === 'string' ? emailAddress.toLowerCase() : '';

    // Find customer by email and clientID
    const customer = await Customer.findOne({
      emailAddress: emailAddressLower,
      clientID: req.clientID
    });

    // If customer is not found, return error **before accessing passwordHash**
    if (!customer) {
      return res.status(401).json({ error: 'Invalid email address or password' });
    }

    // Check password match
    const passwordMatch = bcrypt.compareSync(password, customer.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email address or password' });
    }

    // Verify site token
    jwt.verify(tokenValue, process.env.secret, (err, decoded) => {
      if (err) {
        return res.status(403).json({ error: 'Forbidden - Invalid site token', err });
      }

      if (decoded.clientID !== customer.clientID) {
        return res.status(403).json({ error: 'Forbidden - Site token clientID does not match customer clientID' });
      }

      const customer_id = customer._id;

      // Generate JWT token
      const token = jwt.sign({ customerID: customer._id, clientID: customer.clientID }, process.env.secret);

      // Send token in response
      res.json({ token, customer_id });
    });

  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// Get customer by ID
router.get('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const customerId = req.params.id;
    // Find the customer by ID and clientID
    const customer = await Customer.findOne({ _id: customerId, clientID: req.clientID }).select('-passwordHash');

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    res.json(customer);
  } catch (error) {
    console.error('Error getting customer:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// Get all customers
router.get('/', validateTokenAndExtractClientID, async (req, res) => {
  try {
    // Fetch customers associated with the client ID extracted from the token
    const customers = await Customer.find({ clientID: req.clientID });
    res.json(customers);
  } catch (error) {
    console.error('Error getting customers:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


router.delete('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const customerId = req.params.id;
    // Find the customer by ID and clientID
    const customer = await Customer.findOne({ _id: customerId, clientID: req.clientID });
    if (!customer) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    // Remove the customer
    await Customer.findByIdAndRemove(customerId);
    res.status(200).json({ success: true, message: 'The customer has been deleted' });
  } catch (error) {
    console.error('Error deleting customer:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

router.get('/get/count', validateTokenAndExtractClientID, async (req, res) => {
  try {
    // Count the number of customers associated with the client ID
    const customerCount = await Customer.countDocuments({ clientID: req.clientID });
    res.json({ success: true, customerCount });
  } catch (error) {
    console.error('Error counting customers:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});





// Function to get client's website URL based on clientID
async function getClientWebsiteURL(clientID) {
  try {
    // Find the client in the database based on clientID
    // const client = await Client.findById(clientID);
    const client = await Client.findById(clientID);
    // If client not found or website URL is not available, return null
    if (!client || !client.return_url) {
      return null;
    }

    // Return the website URL of the client
    return client.return_url;
  } catch (error) {
    console.error('Error fetching client website URL:', error);
    throw error; // Throw error to handle it in the calling function
  }
}


module.exports = router;
