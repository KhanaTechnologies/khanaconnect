const { Category } = require('../models/category');
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Octokit } = require("@octokit/rest");
require('dotenv').config();

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN
});

const FILE_TYPE_MAP = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpg'
};

const storage = multer.memoryStorage();
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // Limit file size to 5MB
    fileFilter: (req, file, cb) => {
      if (!FILE_TYPE_MAP[file.mimetype]) {
        return cb(new Error('Invalid file type'), false);
      }
      cb(null, true);
    },
});

const createFilePath = (fileName) => `public/uploads/${fileName}`;

const uploadImageToGitHub = async (file, fileName) => {
    try {
        const filePath = createFilePath(fileName);
        const content = file.buffer.toString('base64');
        const { data } = await octokit.repos.createOrUpdateFileContents({
            owner: process.env.GITHUB_REPO.split('/')[0],
            repo: process.env.GITHUB_REPO.split('/')[1],
            path: filePath,
            message: `Upload ${fileName}`,
            content: content,
            branch: process.env.GITHUB_BRANCH
        });
        return data.content.download_url;
    } catch (error) {
        console.error('Error uploading image to GitHub:', error);
        throw new Error('Failed to upload image to GitHub');
    }
};

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
router.put('/:id', upload.single('image'), validateTokenAndExtractClientID, async (req, res) => {
  try {
    const file = req.file; // ✅ Fix: req.file, not req.files

    if (!file && !req.body.name && !req.body.icon && !req.body.color) {
      return res.status(400).json({ error: 'No image file or update fields provided' });
    }

    let imagePath = null;

    // If a file is provided, validate and upload
    if (file) {
      if (!FILE_TYPE_MAP[file.mimetype]) {
        return res.status(400).json({ error: 'Invalid file type' });
      }

      // ✅ Generate a unique file name
      const fileName = `${file.originalname.split(' ').join('-')}-${Date.now()}.${FILE_TYPE_MAP[file.mimetype]}`;

      // ✅ Upload image to GitHub
      imagePath = await uploadImageToGitHub(file, fileName);
    }

    // Find and update the category
    const category = await Category.findOneAndUpdate(
      { _id: req.params.id, clientID: req.clientID }, // Ensure clientID matches
      {
        name: req.body.name || undefined, // Only update if provided
        icon: req.body.icon || undefined, 
        color: req.body.color || undefined,
        image: imagePath || undefined, // Update only if a new image is provided
      },
      { new: true } // Return the updated category
    );

    if (!category) {
      return res.status(400).send('The category could not be updated');
    }

    res.send(category); // Send the updated category
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



router.post('/', upload.single('image'), validateTokenAndExtractClientID, async (req, res) => {
  try {
    const file = req.file;
    let imagePath = '';

    // ✅ If image is provided, validate and upload it
    if (file) {
      if (!FILE_TYPE_MAP[file.mimetype]) {
        return res.status(400).json({ error: 'Invalid file type' });
      }

      const fileName = `${file.originalname.split(' ').join('-')}-${Date.now()}.${FILE_TYPE_MAP[file.mimetype]}`;
      imagePath = await uploadImageToGitHub(file, fileName);
    }

    // ✅ Save to database
    let category = new Category({
      name: req.body.name,
      image: imagePath || '', // Set empty string if no image
      icon: req.body.icon,
      color: req.body.color,
      clientID: req.clientID,
    });

    category = await category.save();
    if (!category) {
      return res.status(500).json({ error: 'The category could not be created' });
    }

    res.status(201).json(category);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



// Delete a category
router.delete('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const category = await Category.findByIdAndDelete({ _id: req.params.id, clientId: req.clientID });
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
