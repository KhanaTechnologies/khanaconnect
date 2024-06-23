const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Product = require('../models/product');
const { Category } = require('../models/category');
const { Size } = require('../models/size');
const { Octokit } = require("@octokit/rest");
const multer = require('multer');
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
const upload = multer({ storage: storage });

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

// GET products with optional category filter
router.get('/', validateTokenAndExtractClientID, async (req, res) => {
  try {
    let filter = { clientID: req.clientID };

    if (req.query.categories) {
      const categoryIds = req.query.categories.split(',').map(id => id.trim());
      filter.category = { $in: categoryIds };
    }

    const products = await Product.find(filter).populate('category').populate('sizes');
    if (!products || products.length === 0) {
      return res.status(404).json({ success: false, message: 'No products found' });
    }

    res.status(200).json(products);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



// GET a single product by id
router.get('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, clientID: req.clientID }).populate('category').populate('sizes');
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// POST new product with images
router.post('/', validateTokenAndExtractClientID, upload.array('images', 5), async (req, res) => {
  try {
    const files = req.files;
    if (!files || files.length < 1) return res.status(400).send('No images in the request');

    const tokenValue = req.headers.authorization.split(' ')[1];
    const category = await Category.findById(req.body.category);

    // Split sizes string into an array of IDs
    const sizes = req.body.sizes.split(',').map(id => id.trim());
    const sizeDocuments = await Size.find({ _id: { $in: sizes } });

    jwt.verify(tokenValue, process.env.secret, async (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Forbidden - Invalid token', err });
      }
    console.log(user.clientID);
      const clientId = user.clientID;

     // Process all images and upload them to GitHub
const imageUploadPromises = files.map(file => {
    const fileNameParts = file.originalname.split(' ').join('-').split('.');
    const extension = fileNameParts.pop();
    const baseName = fileNameParts.join('.');
    const fileName = `${baseName}_${Date.now()}.${FILE_TYPE_MAP[file.mimetype]}`;
    return uploadImageToGitHub(file, fileName);
});
      const imagePaths = await Promise.all(imageUploadPromises);

      const newProduct = new Product({
        productName: req.body.productName,
        description: req.body.description,
        richDescription: req.body.richDescription,
        images: imagePaths, // Save all images under 'images'
        brand: req.body.brand,
        price: req.body.price,
        category: category,
        countInStock: req.body.countInStock,
        rating: req.body.rating,
        numReviews: req.body.numReviews,
        isFeatured: req.body.isFeatured,
        clientID: clientId,
        sizes: sizeDocuments // Use the array of size documents
      });

      // Save the new product to the database
      const savedProduct = await newProduct.save();

      res.json(savedProduct);
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// PUT to update an existing product with images
router.put('/:id', validateTokenAndExtractClientID, upload.array('images', 5), async (req, res) => {
  try {
    const files = req.files;
    const tokenValue = req.headers.authorization.split(' ')[1];
    const category = await Category.findById(req.body.category);

    // Split the string of sizes into an array of size IDs
    const sizeIds = req.body.sizes.split(',');

    // Find all sizes based on the size IDs
    const sizes = await Size.find({ _id: { $in: sizeIds } });

    jwt.verify(tokenValue, process.env.secret, async (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Forbidden - Invalid token', err });
      }

      const clientId = user.clientID;

      const product = await Product.findById(req.params.id);
      if (!product) return res.status(404).json({ error: 'Product not found' });

      // Merge existing images with new image paths
      let updatedImages = product.images;
      if (files.length > 0) {
        const imageUploadPromises = files.map(file => {
          const fileName = `${file.baseName.split(' ').join('-')}-${Date.now()}.${FILE_TYPE_MAP[file.mimetype]}`;
          return uploadImageToGitHub(file, fileName);
        });
        const newImagePaths = await Promise.all(imageUploadPromises);
        updatedImages = [...updatedImages, ...newImagePaths];
      }

      // Construct the updated product object
      const updatedProduct = {
        productName: req.body.productName,
        description: req.body.description,
        richDescription: req.body.richDescription,
        images: updatedImages,
        brand: req.body.brand,
        price: req.body.price,
        category: category,
        countInStock: req.body.countInStock,
        rating: req.body.rating,
        numReviews: req.body.numReviews,
        isFeatured: req.body.isFeatured,
        sizes: sizes // Include sizes from the array of size IDs
      };

      // Find and update the existing product in the database
      const updatedProductResult = await Product.findByIdAndUpdate(req.params.id, updatedProduct, { new: true });

      res.json(updatedProductResult);
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE a product by id
router.delete('/:id', async (req, res) => {
  try {
    const product = await Product.findOneAndDelete(req.params.id);
      console.log(product);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



// Helper function to upload image to GitHub
const uploadImageToGitHub = async (file, fileName) => {
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
};

router.get('/get/count', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const productCount = await Product.countDocuments({ clientID: req.clientID });
    res.json({ productCount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

router.get('/get/featured/:count', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const count = req.params.count ? parseInt(req.params.count, 10) : 0;
    const featureProducts = await Product.find({ clientID: req.clientID, isFeatured: true }).limit(count);
     console.log(featureProducts);
    res.json(featureProducts);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// Helper function to create a file path for the image
const createFilePath = (fileName) => `public/uploads/${fileName}`;

module.exports = router;
