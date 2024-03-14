const { Category } = require('../models/category');
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
    
    const categoryList = await Category.find({ clientID: req.clientID });
    if (!categoryList) {
      res.status(500).json({ success: false, message: 'Failed to fetch categories' });
    }
    console.log("here: ",categoryList);
    res.status(200).send(categoryList);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Get a specific category by ID
router.get('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const category = await Category.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!category) {
      return res.status(404).send('The category with the given ID was not found');
    }
    res.status(200).send(category);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Update a category
router.put('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const category = await Category.findOneAndUpdate(
      { _id: req.params.id, clientId: req.clientID },
      {
        name: req.body.name,
        icon: req.body.icon,
        color: req.body.color,
      },
      { new: true }
    );
    if (!category) {
      return res.status(400).send('The category could not be updated');
    }
    res.send(category);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Create a new category
router.post('/', validateTokenAndExtractClientID, async (req, res) => {
  try {
    let category = new Category({
      name: req.body.name,
      icon: req.body.icon,
      color: req.body.color,
      clientId: req.clientID,
    });
    category = await category.save();
    if (!category) {
      return res.status(404).send('The category could not be created');
    }
    res.send(category);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Delete a category
router.delete('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const category = await Category.findOneAndDelete({ _id: req.params.id, clientId: req.clientID });
    if (!category) {
      return res.status(404).json({ success: false, message: 'Category not found' });
    }
    res.status(200).json({ success: true, message: 'Category deleted successfully' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

module.exports = router;
