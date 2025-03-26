const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const router = express.Router();
const authJwt = require('../helpers/jwt'); // Import the authJwt middleware

router.use(authJwt());

// Create a new client
router.post('/', async (req, res) => {
  try {
    const { clientID, companyName,merchant_id,merchant_key, password, passphrase, return_url,cancel_url,notify_url,businessEmail,businessEmailPassword} = req.body;


    
     
    // Hash the password before saving it to the database
    const hashedPassword = await bcrypt.hashSync(password, 10);

    // const hashedPassphrase = await bcrypt.hashSync(passphrase,10);

    const token = generateToken({ clientID, companyName,merchant_id});

    const newClient = new Client({
      clientID,
      companyName,
      password: hashedPassword,
      merchant_id,
      merchant_key,
      passphrase,
      token : token,
      return_url,
      cancel_url,
      notify_url,
      businessEmail,
      businessEmailPassword,
      // Other client-related data
    });

    const savedClient = await newClient.save();


    res.json({ client: savedClient, token });
  } catch (error) {console.error('Error saving client:', error);res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get all clients
router.get('/', async (req, res) => {
  try {
    const clients = await Client.find();
    res.json(clients);
  } catch (error) {
    console.error('Error getting clients:', error);
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
    // Add any other relevant data you want in the token
  };

  // Replace 'your-secret-key' with a strong, secret key for signing the token
  const token = jwt.sign(payload, secret, { expiresIn: '1y' });

  return token;
}



// Protected route that requires a valid token - this was just a test
router.get('/protected', authenticateToken, (req, res) => {
  res.json({ message: 'This is a protected route.', user: req.user });
});

// Middleware to authenticate the token
function authenticateToken(req, res, next) {
  const token = req.headers.authorization;
  const secret = process.env.secret;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized - Token missing' });
  }



  const tokenValue = token.split(' ')[1];
  jwt.verify(tokenValue, secret, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Forbidden - Invalid token' });
    }

    // Additional verification logic if needed
    // For example, check if the user has certain roles or permissions

    req.user = user;
    next();
  });
}



// Get client by ID
router.get('/:clientId', async (req, res) => {
  try {
    const clientId = req.params.clientId;
    
    var client = await Client.findOne({ clientID: clientId });

    if (!client || Object.keys(client).length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json(client);
  } catch (error) {
    console.error('Error getting client by ID:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



// Edit client details
router.put('/:clientId', async (req, res) => {
  try {
    const clientId = req.params.clientId;
    const updates = req.body;
    const options = { new: true }; // Return the modified document rather than the original

    // Hash the password if it's being updated
    if (updates.password) {
      updates.password = await bcrypt.hashSync(updates.password, 10);
    }

    const updatedClient = await Client.findOneAndUpdate(
      { clientID: clientId },
      updates,
      options
    );

    if (!updatedClient) {
      return res.status(404).json({ error: 'Client not found' });
    }

    res.json(updatedClient);
  } catch (error) {
    console.error('Error updating client:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});





// This is where they can login and get a session ID
router.post('/login', async (req, res) => {
  try {
    const client = await Client.findOne({ clientID: req.body.clientID });
    const secret = process.env.secret;


    if (!client) {
      return res.status(400).send('The client could not be found');
    }

    if (client && bcrypt.compareSync(req.body.password, client.password)) {
      const token = jwt.sign(
        {
          clientID: client.clientID,
          merchant_id: client.merchant_id
        },
        secret,
        { expiresIn: '1d' }
      );

      // Terminate previous session if client is already logged in
      if (client.isLoggedIn) {
        client.sessionToken = null;
        client.sessionExpires = null;
      }

      // Update the client session info
      client.sessionToken = token;
      client.sessionExpires = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day
      client.isLoggedIn = true; // Set logged-in status
      await client.save();

      res.status(200).send({ ID: client.clientID, merchant_id: client.merchant_id, token: token, permissions: client.permissions });
    } else {
      res.status(400).send('The user email and password are incorrect!');
    }
  } catch (error) {
    console.error('Error during login:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



router.post('/logout', async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    const decoded = jwt.verify(token, process.env.secret);

    const client = await Client.findOne({ clientID: decoded.clientID });

    if (!client) {
      return res.status(400).send('Client not found');
    }

    client.sessionToken = null;
    client.sessionExpires = null;
    client.isLoggedIn = false; // Set logged-in status to false
    await client.save();

    res.status(200).send('Logout successful');
  } catch (error) {
    console.error('Error during logout:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
