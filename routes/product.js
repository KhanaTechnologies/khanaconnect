const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Product = require('../models/product');
const {Category}  = require('../models/category');
const multer = require('multer');
const { Octokit } = require("@octokit/rest");
const { body, validationResult } = require('express-validator');
const { SalesItem } = require('../models/salesItem')
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
    limits: { fileSize: 5 * 1024 * 1024 } // Limit file size to 5MB
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

const processVariants = (variantData) => {
    if (!variantData) return [];
    if (typeof variantData === 'string') {
        try {
            variantData = JSON.parse(variantData);
        } catch (error) {
            console.error('Failed to parse variantData as JSON:', error);
            return [];
        }
    }
    if (!Array.isArray(variantData)) {
        variantData = [variantData];
    }
    return variantData.map(v => ({
        value: v.value ? v.value.trim() : '',
        price: parseFloat(v.price) || 0,
        quantity: parseInt(v.quantity) || 0
    }));
};

// Middleware for client validation
const validateClient = async (req, res, next) => {

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
            if (!user.clientID) {
                return res.status(403).json({ error: 'Forbidden - Invalid token payload' });
            }
            req.clientId = user.clientID; // Attach client ID to request object

            next();
        });
    } catch (error) {
        console.error('Error in client validation:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};

// Centralized error handling middleware
router.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

// Create new product
router.post(
    '/',
    upload.array('images', 5),
    [
        body('productName').notEmpty().withMessage('Product name is required'),
        body('price').isFloat({ gt: 0 }).withMessage('Price must be a positive number'),
        body('category').isMongoId().withMessage('Invalid category ID'),
        body('countInStock').isInt({ min: 0 }).withMessage('Count in stock must be a non-negative integer'),
    ],
    validateClient,
    async (req, res) => {
        console.log('Incoming Body:', req.body);

        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const files = req.files;
            if (!files || files.length < 1) {
                return res.status(400).send('No images in the request');
            }

            const category = await Category.findById(req.body.category);
            if (!category) {
                return res.status(400).json({ error: 'Invalid category ID' });
            }

            // ✅ Parse and transform variants
            let variants = [];
            try {
                if (!req.body.variants || typeof req.body.variants !== 'string') {
                    throw new Error('Variants data is required and must be a string');
                }

                const parsedVariants = JSON.parse(req.body.variants);

                if (!Array.isArray(parsedVariants)) {
                    throw new Error('Parsed variants should be an array');
                }

                variants = parsedVariants.map(variant => {
                    const attribute = variant.attributes?.[0];

                    if (!attribute || !attribute.name || !Array.isArray(attribute.values)) {
                        throw new Error('Invalid variant attribute structure');
                    }

                    return {
                        name: attribute.name,
                        values: attribute.values.map(value => ({
                            value: value.value,
                            price: Number(value.price),
                            stock: Number(value.stock)
                        }))
                    };
                });

                console.log('✅ Transformed Variants:', JSON.stringify(variants, null, 2));
            } catch (err) {
                console.error('❌ Error parsing variants:', err.message);
                return res.status(400).json({ error: 'Invalid variants format', details: err.message });
            }

            // ✅ Upload images
            const imageUploadPromises = files.map(file => {
                if (!FILE_TYPE_MAP[file.mimetype]) {
                    throw new Error('Invalid file type');
                }

                const fileName = `${file.originalname.split(' ').join('-')}-${Date.now()}.${FILE_TYPE_MAP[file.mimetype]}`;
                return uploadImageToGitHub(file, fileName);
            });

            const imagePaths = await Promise.all(imageUploadPromises);

            // ✅ Create product document
            const newProduct = new Product({
                productName: req.body.productName,
                description: req.body.description,
                richDescription: req.body.richDescription || '',
                images: imagePaths,
                brand: req.body.brand || '',
                price: Number(req.body.price),
                countInStock: Number(req.body.countInStock),
                category: category._id,
                rating: 0,
                numReviews: 0,
                isFeatured: false,
                clientID: req.clientId, // double-check your middleware attaches this as `req.clientId`
                ingredients: req.body.ingredients,
                usage: req.body.usage,
                variants: variants
            });

            const savedProduct = await newProduct.save();
            console.log('✅ Product saved:', savedProduct);
            res.json(savedProduct);
        } catch (error) {
            console.error('❌ Internal Error:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    }
);






// PUT to update an existing product with images
router.put(
    '/:id',
    upload.array('images', 5),
    [
        body('productName').optional().notEmpty().withMessage('Product name is required'),
        body('price').optional().isFloat({ gt: 0 }).withMessage('Price must be a positive number'),
        body('category').optional().isMongoId().withMessage('Invalid category ID'),
        body('countInStock').optional().isInt({ min: 0 }).withMessage('Count in stock must be a non-negative integer'),
    ],
    validateClient,
    async (req, res) => {
        try {
            const errors = validationResult(req);
            if (!errors.isEmpty()) {
                return res.status(400).json({ errors: errors.array() });
            }

            const files = req.files;
            console.log(req.body)
            const category = await Category.findById(req.body.category);
            if (!category) return res.status(400).json({ error: 'Invalid category ID' });

            const product = await Product.findById(req.params.id);
            if (!product) return res.status(404).json({ error: 'Product not found' });

            // ✅ Parse dynamic variant fields
            let variants = [];
            try {
                const receivedVariants = JSON.parse(req.body.variants); // Expecting an array of objects
                if (!Array.isArray(receivedVariants)) throw new Error();
                variants = receivedVariants;
            } catch (err) {
                return res.status(400).json({ error: 'Invalid variants format' });
            }

            // ✅ Handle deleted images
            let updatedImages = [...product.images];
            if (req.body.deletedImages) {
                try {
                    const deletedImages = JSON.parse(req.body.deletedImages);
                    if (Array.isArray(deletedImages)) {
                        updatedImages = updatedImages.filter(img => !deletedImages.includes(img));
                    }
                } catch (err) {
                    return res.status(400).json({ error: 'Invalid deletedImages format' });
                }
            }
            
            // ✅ Upload new images
            if (files.length > 0) {
                const imageUploadPromises = files.map(file => {
                    if (!FILE_TYPE_MAP[file.mimetype]) {
                        throw new Error('Invalid file type');
                    }
                    const fileName = `${file.originalname.split(' ').join('-')}-${Date.now()}.${FILE_TYPE_MAP[file.mimetype]}`;
                    return uploadImageToGitHub(file, fileName);
                });
                const newImagePaths = await Promise.all(imageUploadPromises);
                updatedImages = [...updatedImages, ...newImagePaths];
            }

            const updatedProduct = {
                productName: req.body.productName || product.productName,
                description: req.body.description || product.description,
                richDescription: req.body.richDescription || product.richDescription,
                images: updatedImages,
                brand: req.body.brand || product.brand,
                price: req.body.price || product.price,
                category: category || product.category,
                countInStock: req.body.countInStock || product.countInStock,
                rating: req.body.rating || product.rating,
                numReviews: req.body.numReviews || product.numReviews,
                isFeatured: req.body.isFeatured || product.isFeatured,
                ingredients: req.body.ingredients || product.ingredients,
                usage: req.body.usage || product.usage,
                variants,  // ✅ Store dynamic variants
            };

            const updatedProductResult = await Product.findByIdAndUpdate(req.params.id, updatedProduct, { new: true });
            res.json(updatedProductResult);
        } catch (error) {
            console.error('Error:', error);
            res.status(500).json({ error: error.message || 'Internal Server Error' });
        }
    }
);

// GET featured products
router.get('/get/featured/:count', validateClient, async (req, res) => {
    try {
        const clientId = req.clientId;
        const count = req.params.count ? parseInt(req.params.count, 10) : 0;
        const featuredProducts = await Product.find({ isFeatured: true, clientID: clientId }).limit(count);
        res.json(featuredProducts);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET all products
router.get('/', validateClient, async (req, res) => {

    try {
        const clientId = req.clientId;
        const productList = await Product.find({ clientID: clientId }).populate('category');
        res.json(productList);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// GET a single product by id
router.get('/:id', validateClient, async (req, res) => {
    try {
        const clientId = req.clientId;
        const product = await Product.findOne({ _id: req.params.id, clientID: clientId }).populate('category');
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        console.log(product);
        res.json(product);
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// DELETE a product by id
router.delete('/:id', validateClient, async (req, res) => {
    try {
        const product = await Product.findByIdAndDelete(req.params.id);
        if (!product) {
            return res.status(404).json({ error: 'Product not found' });
        }
        res.json({ message: 'Product deleted successfully' });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});




module.exports = router;