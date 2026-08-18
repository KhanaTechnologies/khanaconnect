const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Product = require('../models/product');
const { Category } = require('../models/category');
const multer = require('multer');
const { body, validationResult } = require('express-validator');
const { SalesItem } = require('../models/salesItem');
const { wrapRoute } = require('../helpers/failureEmail'); // ✅ Import wrapRoute
const wishlistNotifyService = require('../services/wishlistNotifyService');
const { createDashboardAuth } = require('../helpers/dashboardAuth');
const { recordTeamActivityFromRequest } = require('../helpers/teamActivity');
const {
  pickProductCatalogFields,
  publishedProductFilter,
  slugify,
} = require('../helpers/productCatalogFields');
const { uploadPublicAsset } = require('../helpers/publicAssetUpload');
const Collection = require('../models/collection');
const ProductReview = require('../models/ProductReview');
const InventoryMovement = require('../models/InventoryMovement');
require('dotenv').config();

const validateClient = createDashboardAuth('products');

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

const uploadProductImage = async (file, fileName, req) => {
  const result = await uploadPublicAsset(file.buffer, `public/uploads/${fileName}`, req);
  return result.url;
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

        const category = await Category.findOne({ _id: req.body.category, clientID: req.clientId });
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
        const imagePaths = [];

            for (const file of files) {
                if (!FILE_TYPE_MAP[file.mimetype]) {
                    throw new Error('Invalid file type');
                }

                const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${FILE_TYPE_MAP[file.mimetype]}`;

                const imageUrl = await uploadProductImage(file, fileName, req);
                imagePaths.push(imageUrl);
            }

        const catalogFields = pickProductCatalogFields(req.body, null);

        if (catalogFields.sku) {
          const dup = await Product.findOne({
            clientID: req.clientId,
            sku: catalogFields.sku,
          }).select('_id');
          // Soft check only — do not block saves (clients may already share blank/duplicate SKUs)
          if (dup) {
            console.warn(`[products] duplicate SKU "${catalogFields.sku}" for client ${req.clientId} (create allowed)`);
          }
        }

        const newProduct = new Product({
            productName: req.body.productName,
            description: req.body.description || '',
            richDescription: req.body.richDescription || '',
            images: imagePaths,
            brand: req.body.brand || '',
            price: Number(req.body.price),
            costPrice: req.body.costPrice !== undefined && req.body.costPrice !== ''
              ? Number(req.body.costPrice)
              : null,
            countInStock: Number(req.body.countInStock),
            category: category._id,
            rating: 0,
            numReviews: 0,
            clientID: req.clientId,
            ingredients: req.body.ingredients || '',
            usage: req.body.usage || '',
            variants,
            ...catalogFields,
            isFeatured: catalogFields.isFeatured === true,
        });

        const savedProduct = await newProduct.save();
        res.json(savedProduct);
        recordTeamActivityFromRequest(req, {
          category: 'products',
          action: 'product.created',
          summary: `Product created: ${savedProduct.productName}`,
          metadata: { productId: String(savedProduct._id) },
        });
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

        const product = await Product.findOne({ _id: req.params.id, clientID: req.clientId });
        if (!product) return res.status(404).json({ error: 'Product not found' });

        const category = req.body.category
          ? await Category.findOne({ _id: req.body.category, clientID: req.clientId })
          : product.category;
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
                 const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${FILE_TYPE_MAP[file.mimetype]}`;
                return uploadProductImage(file, fileName, req);
            }));
            updatedImages = [...updatedImages, ...newImagePaths];
        }

        const prevSnapshot = product.toObject({ depopulate: true });
        const catalogFields = pickProductCatalogFields(req.body, product);

        if (catalogFields.sku) {
          const dup = await Product.findOne({
            clientID: req.clientId,
            sku: catalogFields.sku,
            _id: { $ne: product._id },
          }).select('_id');
          if (dup) {
            console.warn(`[products] duplicate SKU "${catalogFields.sku}" for client ${req.clientId} (update allowed)`);
          }
        }

        const updatedProduct = await Product.findOneAndUpdate(
          { _id: req.params.id, clientID: req.clientId },
          {
            productName: req.body.productName || product.productName,
            description: req.body.description || product.description,
            richDescription: req.body.richDescription || product.richDescription,
            images: updatedImages,
            brand: req.body.brand || product.brand,
            price: req.body.price || product.price,
            costPrice:
              req.body.costPrice !== undefined && req.body.costPrice !== ''
                ? Number(req.body.costPrice)
                : req.body.costPrice === '' || req.body.costPrice === null
                  ? null
                  : product.costPrice,
            category: category._id,
            countInStock: req.body.countInStock !== undefined ? req.body.countInStock : product.countInStock,
            salePercentage: req.body.salePercentage !== undefined ? req.body.salePercentage : product.salePercentage,
            rating: req.body.rating || product.rating,
            numReviews: req.body.numReviews || product.numReviews,
            ingredients: req.body.ingredients || product.ingredients,
            usage: req.body.usage || product.usage,
            variants,
            ...catalogFields,
        }, { new: true });

        wishlistNotifyService
          .handleProductUpdate(prevSnapshot, updatedProduct.toObject({ depopulate: true }))
          .catch((err) => console.error('wishlist notify (product update):', err.message));

        res.json(updatedProduct);
        recordTeamActivityFromRequest(req, {
          category: 'products',
          action: 'product.updated',
          summary: `Product updated: ${updatedProduct.productName}`,
          metadata: { productId: String(updatedProduct._id) },
        });
    })
);

// GET all products (dashboard: all statuses; ?status=published|draft|archived filters)
router.get('/', validateClient, wrapRoute(async (req, res) => {
    const filter = { clientID: req.clientId };
    const status = String(req.query.status || '').trim().toLowerCase();
    if (['draft', 'published', 'archived'].includes(status)) filter.status = status;
    const products = await Product.find(filter).populate('category');
    res.json(products);
}));

// GET featured products (published only — storefront-safe)
router.get('/get/featured/:count', validateClient, wrapRoute(async (req, res) => {
    const count = parseInt(req.params.count, 10) || 0;
    const featuredProducts = await Product.find(
      publishedProductFilter({ isFeatured: true, clientID: req.clientId })
    ).limit(count);
    res.json(featuredProducts);
}));

// CSV export
router.get('/export/csv', validateClient, wrapRoute(async (req, res) => {
  const products = await Product.find({ clientID: req.clientId }).populate('category').lean();
  const header = [
    'sku',
    'productName',
    'price',
    'countInStock',
    'status',
    'category',
    'tags',
    'slug',
    'weightKg',
  ];
  const escape = (v) => {
    const s = String(v ?? '');
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [header.join(',')];
  for (const p of products) {
    lines.push(
      [
        p.sku || '',
        p.productName || '',
        p.price ?? '',
        p.countInStock ?? '',
        p.status || 'published',
        p.category?.name || p.category || '',
        (p.tags || []).join('|'),
        p.slug || '',
        p.weightKg ?? '',
      ]
        .map(escape)
        .join(',')
    );
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
  res.send(lines.join('\n'));
}));

// CSV import (JSON body: { rows: [{ sku, productName, price, countInStock, status, tags }] })
router.post('/import/csv', validateClient, wrapRoute(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: 'rows array required' });

  let created = 0;
  let updated = 0;
  const errors = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const sku = String(row.sku || '').trim();
    const productName = String(row.productName || row.name || '').trim();
    const price = Number(row.price);
    const countInStock = Number(row.countInStock ?? row.stock ?? 0);
    if (!productName || !Number.isFinite(price)) {
      errors.push({ row: i + 1, error: 'productName and price required' });
      continue;
    }

    let categoryId = row.categoryId || row.category;
    if (!categoryId || !mongoose.Types.ObjectId.isValid(String(categoryId))) {
      const firstCat = await Category.findOne({ clientID: req.clientId }).select('_id');
      categoryId = firstCat?._id;
    }
    if (!categoryId) {
      errors.push({ row: i + 1, error: 'No category available' });
      continue;
    }

    const payload = {
      productName,
      description: String(row.description || productName),
      price,
      countInStock: Number.isFinite(countInStock) ? countInStock : 0,
      category: categoryId,
      clientID: req.clientId,
      status: ['draft', 'published', 'archived'].includes(String(row.status || '').toLowerCase())
        ? String(row.status).toLowerCase()
        : 'published',
      sku,
      slug: slugify(row.slug || productName),
      tags: String(row.tags || '')
        .split(/[|,]/)
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    };

    if (sku) {
      const existing = await Product.findOne({ clientID: req.clientId, sku });
      if (existing) {
        Object.assign(existing, payload);
        await existing.save();
        updated += 1;
        continue;
      }
    }
    await Product.create(payload);
    created += 1;
  }

  res.json({ ok: true, created, updated, errors });
}));

router.get('/inventory/movements', validateClient, wrapRoute(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const filter = { client_id: req.clientId };
  if (req.query.productId) filter.product_id = req.query.productId;
  const rows = await InventoryMovement.find(filter).sort({ created_at: -1 }).limit(limit).lean();
  res.json({ movements: rows });
}));

// Collections CRUD
router.get('/collections/list', validateClient, wrapRoute(async (req, res) => {
  const rows = await Collection.find({ clientID: req.clientId }).sort({ name: 1 }).lean();
  res.json(rows);
}));

router.post('/collections', validateClient, wrapRoute(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  const doc = await Collection.create({
    clientID: req.clientId,
    name,
    slug: slugify(req.body.slug || name),
    description: String(req.body.description || ''),
    image: String(req.body.image || ''),
    productIds: Array.isArray(req.body.productIds) ? req.body.productIds : [],
    isActive: req.body.isActive !== false,
  });
  if (doc.productIds?.length) {
    await Product.updateMany(
      { _id: { $in: doc.productIds }, clientID: req.clientId },
      { $addToSet: { collectionIds: doc._id } }
    );
  }
  res.status(201).json(doc);
}));

router.put('/collections/:id', validateClient, wrapRoute(async (req, res) => {
  const doc = await Collection.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!doc) return res.status(404).json({ error: 'Collection not found' });
  if (req.body.name !== undefined) doc.name = String(req.body.name || '').trim();
  if (req.body.slug !== undefined) doc.slug = slugify(req.body.slug || doc.name);
  if (req.body.description !== undefined) doc.description = String(req.body.description || '');
  if (req.body.image !== undefined) doc.image = String(req.body.image || '');
  if (req.body.isActive !== undefined) doc.isActive = !!req.body.isActive;
  if (Array.isArray(req.body.productIds)) {
    const prev = (doc.productIds || []).map(String);
    doc.productIds = req.body.productIds;
    await Product.updateMany(
      { clientID: req.clientId, collectionIds: doc._id },
      { $pull: { collectionIds: doc._id } }
    );
    await Product.updateMany(
      { _id: { $in: doc.productIds }, clientID: req.clientId },
      { $addToSet: { collectionIds: doc._id } }
    );
    void prev;
  }
  await doc.save();
  res.json(doc);
}));

router.delete('/collections/:id', validateClient, wrapRoute(async (req, res) => {
  const doc = await Collection.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });
  if (!doc) return res.status(404).json({ error: 'Collection not found' });
  await Product.updateMany(
    { clientID: req.clientId, collectionIds: doc._id },
    { $pull: { collectionIds: doc._id } }
  );
  res.json({ deleted: true, id: req.params.id });
}));

// Reviews
router.get('/:id/reviews', validateClient, wrapRoute(async (req, res) => {
  const reviews = await ProductReview.find({
    clientID: req.clientId,
    product: req.params.id,
    approved: true,
  })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  res.json({ reviews });
}));

router.post('/:id/reviews', validateClient, wrapRoute(async (req, res) => {
  const product = await Product.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!product) return res.status(404).json({ error: 'Product not found' });
  const rating = Number(req.body.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'rating must be 1-5' });
  }
  const review = await ProductReview.create({
    clientID: req.clientId,
    product: product._id,
    customerName: String(req.body.customerName || '').trim().slice(0, 80),
    customerEmail: String(req.body.customerEmail || '').trim().toLowerCase().slice(0, 120),
    rating,
    title: String(req.body.title || '').trim().slice(0, 120),
    body: String(req.body.body || '').trim().slice(0, 2000),
    approved: true,
  });

  const agg = await ProductReview.aggregate([
    { $match: { product: product._id, approved: true } },
    { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } },
  ]);
  product.rating = agg[0] ? Math.round(agg[0].avg * 10) / 10 : rating;
  product.numReviews = agg[0]?.count || 1;
  await product.save();

  res.status(201).json(review);
}));

// GET product by ID
router.get('/:id', validateClient, wrapRoute(async (req, res) => {
    const product = await Product.findOne({ _id: req.params.id, clientID: req.clientId }).populate('category');
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json(product);
}));

// DELETE product by ID
router.delete('/:id', validateClient, wrapRoute(async (req, res) => {
    const product = await Product.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({ message: 'Product deleted successfully' });
    recordTeamActivityFromRequest(req, {
      category: 'products',
      action: 'product.deleted',
      summary: `Product ${req.params.id} deleted`,
      metadata: { productId: req.params.id },
    });
}));

module.exports = router;
