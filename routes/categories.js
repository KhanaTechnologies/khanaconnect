// routes/categories.js
const { Category } = require('../models/category');
const express = require('express');
const router = express.Router();
const multer = require('multer');
const mongoose = require('mongoose');
require('dotenv').config();

const { wrapRoute } = require('../helpers/failureEmail');
const { createDashboardAuth } = require('../helpers/dashboardAuth');
const { uploadPublicAsset } = require('../helpers/publicAssetUpload');

const FILE_TYPE_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
};

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!FILE_TYPE_MAP[file.mimetype]) {
      return cb(new Error('Invalid file type'), false);
    }
    cb(null, true);
  },
});

const validateTokenAndExtractClientID = createDashboardAuth('categories');

async function uploadCategoryImage(file, req) {
  const ext = FILE_TYPE_MAP[file.mimetype] || 'jpg';
  const fileName = `category-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const result = await uploadPublicAsset(file.buffer, `public/uploads/categories/${fileName}`, req);
  return result.url;
}

async function resolveParentId(clientID, rawParentId) {
  if (rawParentId === undefined || rawParentId === null || rawParentId === '' || rawParentId === 'none') {
    return null;
  }
  if (!mongoose.Types.ObjectId.isValid(String(rawParentId))) {
    const err = new Error('Invalid parent category');
    err.status = 400;
    throw err;
  }
  const parent = await Category.findOne({ _id: rawParentId, clientID });
  if (!parent) {
    const err = new Error('Parent category not found');
    err.status = 400;
    throw err;
  }
  // Max depth 2: parent must be a root
  if (parent.parentId) {
    const err = new Error('Only one nesting level is allowed (parent must be a root category)');
    err.status = 400;
    throw err;
  }
  return parent._id;
}

function buildTree(flat) {
  const byId = new Map();
  flat.forEach((c) => {
    const obj = typeof c.toObject === 'function' ? c.toObject({ virtuals: true }) : { ...c };
    obj.children = [];
    byId.set(String(obj._id || obj.id), obj);
  });
  const roots = [];
  for (const node of byId.values()) {
    const pid = node.parentId ? String(node.parentId) : null;
    if (pid && byId.has(pid)) {
      byId.get(pid).children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// Get all categories (flat by default; ?tree=1 for nested)
router.get('/', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  const categoryList = await Category.find({ clientID: req.clientID }).sort({ name: 1 });
  if (String(req.query.tree || '') === '1' || String(req.query.tree || '') === 'true') {
    return res.status(200).json(buildTree(categoryList));
  }
  res.status(200).send(categoryList);
}));

router.get('/:id', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  const category = await Category.findOne({ _id: req.params.id, clientID: req.clientID });
  if (!category) {
    return res.status(404).send('The category with the given ID was not found');
  }
  res.status(200).send(category);
}));

router.put('/:id', upload.single('image'), validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  const file = req.file;
  const existing = await Category.findOne({ _id: req.params.id, clientID: req.clientID });
  if (!existing) {
    return res.status(400).send('The category could not be updated');
  }

  let imagePath = null;
  if (file) {
    imagePath = await uploadCategoryImage(file, req);
  }

  if (typeof req.body.name !== 'undefined') existing.name = String(req.body.name || '').trim();
  if (typeof req.body.description !== 'undefined') existing.description = String(req.body.description || '');
  if (typeof req.body.icon !== 'undefined') existing.icon = req.body.icon;
  if (typeof req.body.color !== 'undefined') existing.color = req.body.color;
  if (imagePath) existing.image = imagePath;

  if (typeof req.body.parentId !== 'undefined') {
    const nextParent = await resolveParentId(req.clientID, req.body.parentId);
    if (nextParent && String(nextParent) === String(existing._id)) {
      return res.status(400).json({ error: 'Category cannot be its own parent' });
    }
    // Cannot nest under a child of self
    if (nextParent) {
      const childCount = await Category.countDocuments({
        clientID: req.clientID,
        parentId: existing._id,
      });
      if (childCount > 0) {
        return res.status(400).json({ error: 'Move or remove child categories before nesting this one' });
      }
    }
    existing.parentId = nextParent;
  }

  await existing.save();
  res.send(existing);
}));

router.post('/', upload.single('image'), validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  const file = req.file;
  let imagePath = '';
  if (file) {
    imagePath = await uploadCategoryImage(file, req);
  }

  const parentId = await resolveParentId(req.clientID, req.body.parentId);

  let category = new Category({
    name: req.body.name,
    description: String(req.body.description || ''),
    image: imagePath || '',
    icon: req.body.icon,
    color: req.body.color,
    parentId,
    clientID: req.clientID,
  });

  category = await category.save();
  if (!category) {
    return res.status(500).json({ error: 'The category could not be created' });
  }

  res.status(201).json(category);
}));

router.delete('/:id', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  const childCount = await Category.countDocuments({
    clientID: req.clientID,
    parentId: req.params.id,
  });
  if (childCount > 0) {
    return res.status(400).json({
      success: false,
      message: 'Delete or reassign child categories first',
    });
  }
  const category = await Category.findOneAndDelete({ _id: req.params.id, clientID: req.clientID });
  if (!category) {
    return res.status(404).json({ success: false, message: 'Category not found' });
  }
  res.status(200).json({ success: true, message: 'Category deleted successfully' });
}));

module.exports = router;
