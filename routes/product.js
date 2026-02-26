const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Product = require('../models/product');
const { Category } = require('../models/category');
const multer = require('multer');
const { Octokit } = require("@octokit/rest");
const { body, validationResult } = require('express-validator');
const { SalesItem } = require('../models/salesItem');
const { wrapRoute } = require('../helpers/failureEmail'); // ✅ Import wrapRoute
require('dotenv').config();

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const FILE_TYPE_MAP = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpg'
};

const storage = multer.memoryStorage();
const upload = multer({ 
    storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const createFilePath = (fileName) => `public/uploads/${fileName}`;

const uploadImageToGitHub = async (file, fileName) => {
    const filePath = createFilePath(fileName);
    const content = file.buffer.toString('base64');

    const owner = process.env.GITHUB_REPO.split('/')[0];
    const repo = process.env.GITHUB_REPO.split('/')[1];
    const branch = process.env.GITHUB_BRANCH;

    let sha;

    try {
        const existingFile = await octokit.repos.getContent({
            owner,
            repo,
            path: filePath,
            ref: branch
        });

        sha = existingFile.data.sha;
    } catch (err) {
        if (err.status !== 404) {
            throw err;
        }
    }

    const response = await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: filePath,
        message: `Upload ${fileName}`,
        content,
        branch,
        ...(sha && { sha })
    });

    return response.data.content.download_url;
};

// Middleware to authenticate JWT and attach clientId
const validateClient = (req, res, next) => {
    const token = req.headers.authorization;
    if (!token || !token.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });

    const tokenValue = token.split(' ')[1];
    jwt.verify(tokenValue, process.env.secret, (err, user) => {
        if (err || !user.clientID) return res.status(403).json({ error: 'Forbidden - Invalid token' });
        req.clientId = user.clientID;
        next();
    });
};

// -------------------- ROUTES -------------------- //

// CREATE new product
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
    wrapRoute(async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        const files = req.files;
        if (!files || files.length < 1) return res.status(400).json({ error: 'No images provided' });

        const category = await Category.findById(req.body.category);
        if (!category) return res.status(400).json({ error: 'Invalid category ID' });

        // Parse variants
        let variants = [];
        if (req.body.variants) {
            try {
                const parsedVariants = typeof req.body.variants === 'string' ? JSON.parse(req.body.variants) : req.body.variants;
                variants = parsedVariants.map(variant => ({
                    name: variant.attributes?.[0]?.name || '',
                    values: (variant.attributes?.[0]?.values || []).map(v => ({
                        value: v.value || '',
                        price: Number(v.price) || 0,
                        stock: Number(v.stock) || 0
                    }))
                }));
            } catch (err) {
                return res.status(400).json({ error: 'Invalid variants format', details: err.message });
            }
        }

        // Upload images to GitHub
        const imagePaths = await Promise.all(files.map(file => {
            if (!FILE_TYPE_MAP[file.mimetype]) throw new Error('Invalid file type');
            const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${FILE_TYPE_MAP[file.mimetype]}`;
            return uploadImageToGitHub(file, fileName);
        }));

        const newProduct = new Product({
            productName: req.body.productName,
            description: req.body.description || '',
            richDescription: req.body.richDescription || '',
            images: imagePaths,
            brand: req.body.brand || '',
            price: Number(req.body.price),
            countInStock: Number(req.body.countInStock),
            category: category._id,
            rating: 0,
            numReviews: 0,
            isFeatured: false,
            clientID: req.clientId,
            ingredients: req.body.ingredients || '',
            usage: req.body.usage || '',
            variants
        });

        const savedProduct = await newProduct.save();
        res.json(savedProduct);
    })
);

// UPDATE existing product
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
    wrapRoute(async (req, res) => {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        const product = await Product.findById(req.params.id);
        if (!product) return res.status(404).json({ error: 'Product not found' });

        const category = req.body.category ? await Category.findById(req.body.category) : product.category;
        if (!category) return res.status(400).json({ error: 'Invalid category ID' });

        let variants = product.variants || [];
        if (req.body.variants) {
            try {
                variants = typeof req.body.variants === 'string' ? JSON.parse(req.body.variants) : req.body.variants;
            } catch (err) {
                return res.status(400).json({ error: 'Invalid variants format' });
            }
        }

        // Handle deleted images
        let updatedImages = [...product.images];
        if (req.body.deletedImages) {
            try {
                const deletedImages = typeof req.body.deletedImages === 'string' ? JSON.parse(req.body.deletedImages) : req.body.deletedImages;
                updatedImages = updatedImages.filter(img => !deletedImages.includes(img));
            } catch (err) {
                return res.status(400).json({ error: 'Invalid deletedImages format' });
            }
        }

        // Upload new images
        const files = req.files || [];
        if (files.length > 0) {
            const newImagePaths = await Promise.all(files.map(file => {
                if (!FILE_TYPE_MAP[file.mimetype]) throw new Error('Invalid file type');
                const fileName = `${file.originalname.split(' ').join('-')}-${Date.now()}.${FILE_TYPE_MAP[file.mimetype]}`;
                return uploadImageToGitHub(file, fileName);
            }));
            updatedImages = [...updatedImages, ...newImagePaths];
        }

        const updatedProduct = await Product.findByIdAndUpdate(req.params.id, {
            productName: req.body.productName || product.productName,
            description: req.body.description || product.description,
            richDescription: req.body.richDescription || product.richDescription,
            images: updatedImages,
            brand: req.body.brand || product.brand,
            price: req.body.price || product.price,
            category: category._id,
            countInStock: req.body.countInStock || product.countInStock,
            rating: req.body.rating || product.rating,
            numReviews: req.body.numReviews || product.numReviews,
            isFeatured: req.body.isFeatured || product.isFeatured,
            ingredients: req.body.ingredients || product.ingredients,
            usage: req.body.usage || product.usage,
            variants
        }, { new: true });

        res.json(updatedProduct);
    })
);

// GET all products
router.get('/', validateClient, wrapRoute(async (req, res) => {
    const products = await Product.find({ clientID: req.clientId }).populate('category');
    res.json(products);
}));

// GET featured products
router.get('/get/featured/:count', validateClient, wrapRoute(async (req, res) => {
    const count = parseInt(req.params.count, 10) || 0;
    const featuredProducts = await Product.find({ isFeatured: true, clientID: req.clientId }).limit(count);
    res.json(featuredProducts);
}));

// GET product by ID
router.get('/:id', validateClient, wrapRoute(async (req, res) => {
    const product = await Product.findOne({ _id: req.params.id, clientID: req.clientId }).populate('category');
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
}));

// DELETE product by ID
router.delete('/:id', validateClient, wrapRoute(async (req, res) => {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product deleted successfully' });
}));

module.exports = router;
