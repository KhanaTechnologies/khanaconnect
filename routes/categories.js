// routes/categories.js
const { Category } = require('../models/category');
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { Octokit } = require("@octokit/rest");
require('dotenv').config();

const { wrapRoute } = require('../helpers/failureEmail'); // ensure correct path

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
    const [owner, repo] = process.env.GITHUB_REPO.split('/');
    const { data } = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: filePath,
      message: `Upload ${fileName}`,
      content,
      branch: process.env.GITHUB_BRANCH
    });
    // data.content.download_url may be undefined in some responses; return html_url or construct raw url
    return data && data.content && data.content.download_url
      ? data.content.download_url
      : `https://raw.githubusercontent.com/${owner}/${repo}/${process.env.GITHUB_BRANCH}/${filePath}`;
  } catch (error) {
    console.error('Error uploading image to GitHub:', error);
    throw new Error('Failed to upload image to GitHub');
  }
};

// Middleware to validate token and extract clientID
const validateTokenAndExtractClientID = (req, res, next) => {
  try {
    const token = req.headers.authorization;
    if (!token || !token.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
    }
    const tokenValue = token.split(' ')[1];
    jwt.verify(tokenValue, process.env.secret, (err, decoded) => {
      if (err) {
        return res.status(403).json({ error: 'Forbidden - Invalid token', err });
      }
      if (!decoded || !decoded.clientID) {
        return res.status(403).json({ error: 'Forbidden - Invalid token payload' });
      }
      req.clientID = decoded.clientID;
      next();
    });
  } catch (error) {
    // Unexpected error -> forward to global error handler (and email)
    console.error('Error in token validation middleware:', error);
    next(error);
  }
};

// Get all categories
router.get('/', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  const categoryList = await Category.find({ clientID: req.clientID });
  if (!categoryList) {
    return res.status(500).json({ success: false, message: 'Failed to fetch categories' });
  }
  res.status(200).send(categoryList);
}));

// Get a specific category by ID
router.get('/:id', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  const category = await Category.findOne({ _id: req.params.id, clientID: req.clientID });
  if (!category) {
    return res.status(404).send('The category with the given ID was not found');
  }
  res.status(200).send(category);
}));

// Update a category
router.put('/:id', upload.single('image'), validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  const file = req.file; // req.file, not req.files

  if (!file && !req.body.name && !req.body.icon && !req.body.color) {
    return res.status(400).json({ error: 'No image file or update fields provided' });
  }

  let imagePath = null;

  // If a file is provided, validate and upload
  if (file) {
    if (!FILE_TYPE_MAP[file.mimetype]) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    // Generate a unique file name
    const fileName = `${file.originalname.split(' ').join('-')}-${Date.now()}.${FILE_TYPE_MAP[file.mimetype]}`;

    // Upload image to GitHub
    imagePath = await uploadImageToGitHub(file, fileName);
  }

  // Build update object only with provided fields
  const update = {};
  if (typeof req.body.name !== 'undefined') update.name = req.body.name;
  if (typeof req.body.icon !== 'undefined') update.icon = req.body.icon;
  if (typeof req.body.color !== 'undefined') update.color = req.body.color;
  if (imagePath) update.image = imagePath;

  // Find and update the category
  const category = await Category.findOneAndUpdate(
    { _id: req.params.id, clientID: req.clientID }, // Ensure clientID matches
    update,
    { new: true } // Return the updated category
  );

  if (!category) {
    return res.status(400).send('The category could not be updated');
  }

  res.send(category);
}));

router.post('/', upload.single('image'), validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  const file = req.file;
  let imagePath = '';

  // If image is provided, validate and upload it
  if (file) {
    if (!FILE_TYPE_MAP[file.mimetype]) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    const fileName = `${file.originalname.split(' ').join('-')}-${Date.now()}.${FILE_TYPE_MAP[file.mimetype]}`;
    imagePath = await uploadImageToGitHub(file, fileName);
  }

  // Save to database
  let category = new Category({
    name: req.body.name,
    image: imagePath || '',
    icon: req.body.icon,
    color: req.body.color,
    clientID: req.clientID,
  });

  category = await category.save();
  if (!category) {
    return res.status(500).json({ error: 'The category could not be created' });
  }

  res.status(201).json(category);
}));

// Delete a category
router.delete('/:id', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  // Use findOneAndDelete to ensure clientID matches
  const category = await Category.findOneAndDelete({ _id: req.params.id, clientID: req.clientID });
  if (!category) {
    return res.status(404).json({ success: false, message: 'Category not found' });
  }
  res.status(200).json({ success: true, message: 'Category deleted successfully' });
}));

module.exports = router;
