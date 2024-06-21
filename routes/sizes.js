const { Size } = require('../models/size');
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

// Middleware to validate token and extract clientID
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

// Get all categories
router.get('/', validateTokenAndExtractClientID, async (req, res) => {
  try {
    
    const sizeList = await Size.find({ clientID: req.clientID });
    if (!sizeList) {
      res.status(500).json({ success: false, message: 'Failed to fetch categories' });
    }

    res.status(200).send(sizeList);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get a specific size by ID
router.get('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const size = await Size.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!size) {
      return res.status(404).send('The size with the given ID was not found');
    }
    res.status(200).send(size);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Update a category
router.put('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const size = await Size.findOneAndUpdate(
      { _id: req.params.id, clientId: req.clientID },
      {
        name: req.body.name,
        description: req.body.description,
      },
      { new: true }
    );
    if (!size) {
      return res.status(400).send('The size could not be updated');
    }
    res.send(size);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Create a new category
router.post('/', validateTokenAndExtractClientID, async (req, res) => {
  try {
    let size = new Size({
      name: req.body.name,
      description: req.body.description,
      clientID: req.clientID,
    });
    size = await size.save();
    if (!size) {
      return res.status(404).send('The size could not be created');
    }
    res.send(size);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Delete a category
router.delete('/:id', async (req, res) => {
  try {
    const size = await Size.findOneAndDelete({ _id: req.params.id});
    if (!size) {
      return res.status(404).json({ success: false, message: 'size not found' });
    }
    res.status(200).json({ success: true, message: 'size deleted successfully' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
