const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Product = require('../models/product');
const { Category } = require('../models/category');
const { Size } = require('../models/size'); 
const multer = require('multer');

const FILE_TYPE_MAP = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg'
};


const storage = multer.diskStorage({
  destination: function (req, file, cb) {
      const isValid = FILE_TYPE_MAP[file.mimetype];
      let uploadError = new Error('invalid image type');

      if (isValid) {
          uploadError = null;
      }
      cb(uploadError, 'public/uploads');
  },
  filename: function (req, file, cb) {
      const fileName = file.originalname.split(' ').join('-');
      const extension = FILE_TYPE_MAP[file.mimetype];
      cb(null, `${fileName}-${Date.now()}.${extension}`);
  }
});


const upload = multer({ storage: storage });
// get all items
// router.get(`/`, async (req, res) =>{
//     let filter = {};
//     if (req.query.categories) {
//         filter = { category: req.query.categories.split(',') };
//     }
//     //show all the data
//     const productList = await Product.find(filter).populate('category');
//     //show specific details
//     //const productList = await Product.find().select('name image -_id');
//     if(!productList){res.status(500).json({succsess: false})}
//     res.send(productList);
// })


// GET products for a specific client
router.get('/', async (req, res) => {
  try {
    // Extract the token from the Authorization header
    const token = req.headers.authorization;
    console.log(req.query.apiKey); 
    if (!token || !token.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
    }

    console.log(token);

    // Extract the token value
    const tokenValue = token.split(' ')[1];

    jwt.verify(tokenValue, process.env.secret, async (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Forbidden - Invalid token' });
      }
      
      req.user = user;
      console.log(user.clientID);
      const clientId = user.clientID;
      
      let filter = { client: clientId }; // Always filter by client ID
      if (req.query.categories) {
        // Split categories by comma and construct the filter
        filter.category = { $in: req.query.categories.split(',') };
      }

      const products = await Product.find(filter).populate('category').populate('sizes');
      res.json(products);
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});



// POST new product with images
router.post('/', upload.array('images', 5), async (req, res) => {
  try {
    console.log(req.body);

    console.log(req.files);
    const token = req.headers.authorization;

    if (!token || !token.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
    }

    const files = req.files;
    if (!files || files.length < 1) return res.status(400).send('No images in the request');

    const tokenValue = token.split(' ')[1];
    const category = await Category.findById(req.body.category);

    // Split sizes string into an array of IDs
    const sizes = req.body.sizes.split(',').map(id => id.trim());
    const sizeDocuments = await Size.find({ _id: { $in: sizes } });

    const basePath = `${req.protocol}://${req.get('host')}/public/uploads/`;

    jwt.verify(tokenValue, process.env.secret, async (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Forbidden - Invalid token', err });
      }

      const clientId = user.clientID;

      // Process all images and save their paths
      const imagePaths = files.map(file => basePath + file.filename);

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
        client: clientId,
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




// // PUT to update an existing product with images
// router.put('/:id', upload.array('images', 5), async (req, res) => {
//   try {
//     const token = req.headers.authorization;
    
//     console.log('Sizes: ', req.body.sizes);

//     if (!token || !token.startsWith('Bearer ')) {
//       return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
//     }

//     const files = req.files;
//     const tokenValue = token.split(' ')[1];
//     const category = await Category.findById(req.body.category);

//     // Split the string of sizes into an array of size IDs
//     const sizeIds = req.body.sizes.split(',');

//     // Find all sizes based on the size IDs
//     const sizes = await Size.find({ _id: { $in: sizeIds } });

//     const basePath = `${req.protocol}://${req.get('host')}/public/uploads/`;
//     const newImagePaths = files.map(file => basePath + file.filename); // Get paths of uploaded images

//     jwt.verify(tokenValue, process.env.secret, async (err, user) => {
//       if (err) {
//         return res.status(403).json({ error: 'Forbidden - Invalid token', err });
//       }

//       const clientId = user.clientID;

//       const product = await Product.findById(req.params.id);
//       if (!product) return res.status(404).json({ error: 'Product not found' });

//       // Append new image paths to the existing images array
//       const updatedImages = product.images.concat(newImagePaths);

//       const updatedProduct = {
//         // Populate other product details from req.body
//         productName: req.body.productName,
//         description: req.body.description,
//         richDescription: req.body.richDescription,
//         image: updatedImages,
//         brand: req.body.brand,
//         price: req.body.price,
//         category: category,
//         countInStock: req.body.countInStock,
//         rating: req.body.rating,
//         numReviews: req.body.numReviews,
//         isFeatured: req.body.isFeatured,
//         client: clientId,
//         sizes: sizes // Include sizes from the array of size IDs
//       };

//       // Find and update the existing product in the database
//       const updatedProductResult = await Product.findByIdAndUpdate(req.params.id, updatedProduct, { new: true });

//       res.json(updatedProductResult);
//     });
//   } catch (error) {
//     console.error('Error:', error);
//     res.status(500).json({ error: 'Internal Server Error' });
//   }
// });




// PUT to update an existing product with images
router.put('/:id', upload.array('images', 5), async (req, res) => {
  try {
    const token = req.headers.authorization;
    
    console.log('Sizes: ', req.body.sizes);

    if (!token || !token.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
    }

    const files = req.files;
    const tokenValue = token.split(' ')[1];
    const category = await Category.findById(req.body.category);

    // Split the string of sizes into an array of size IDs
    const sizeIds = req.body.sizes.split(',');

    // Find all sizes based on the size IDs
    const sizes = await Size.find({ _id: { $in: sizeIds } });

    const basePath = `${req.protocol}://${req.get('host')}/public/uploads/`;
    const newImagePaths = files.map(file => basePath + file.filename); // Get paths of uploaded images

    jwt.verify(tokenValue, process.env.secret, async (err, user) => {
      if (err) {
        return res.status(403).json({ error: 'Forbidden - Invalid token', err });
      }

      const clientId = user.clientID;

      const product = await Product.findById(req.params.id);
      if (!product) return res.status(404).json({ error: 'Product not found' });

      // Merge existing images with new image paths
      const updatedImages = [...product.images, ...newImagePaths];

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



  //get specific item
router.get(`/:id`, async (req, res) =>{
  try {
    const token = req.headers.authorization;
    if (!token || !token.startsWith('Bearer ')) {return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });}
    const tokenValue = token.split(' ')[1];

    console.log(token);

      jwt.verify(tokenValue, process.env.secret, async (err, user) => {if (err) {return res.status(403).json({ error: 'Forbidden - Invalid token', err });}

        const clientId = user.clientID;
        const product = await Product.findById(req.params.id).populate('category').populate('sizes');//creating reationships .populate('category') ---- get back to this!!!!!!!!!!!!!!!!!!!
        if(!product){return res.status(500).json({succsess: false})}
        res.send(product);

      });

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
})

//delete specific item
router.delete(`/:id`, (req, res) =>{
  Product.findOneAndDelete({_id: req.params.id}).then(product =>{
      if(product){
          return res.status(200).json({success: true, message: 'The product has been deleted'});
      } else {
          return res.status(404).json({success: false, message: 'The product has not been deleted'});
      }
  }).catch(err => {
      return res.status(500).json({success: false, error: err});
  });
});

router.get(`/get/featured/:count`, authenticateToken, async (req, res) =>{
  try {
    const count = req.params.count ? req.params.count : 0;
    const featureProducts = await Product.find({ isFeatured: true, client: req.clientId }).limit(+count);
    if (!featureProducts || featureProducts.length === 0) {
      return res.status(404).json({ success: false, message: 'No featured products found for this client' });
    }
     res.send(featureProducts);

      // // Simulate a delay of 1 minute (60 seconds) before sending the response
      // setTimeout(() => {
      //   res.send(featureProducts);
      // }, 20000); // 60000 milliseconds = 1 minute

  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});


// Middleware function to verify JWT token and extract clientId
function authenticateToken(req, res, next) {
  const token = req.headers.authorization;

  if (!token || !token.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
  }

  const tokenValue = token.split(' ')[1];

  jwt.verify(tokenValue, process.env.secret, (err, user) => {
      if (err) {
          return res.status(403).json({ error: 'Forbidden - Invalid token' });
      }
      req.clientId = user.clientID; // Attach clientId to the request object
      next(); // Call next middleware
  });
}


// Route to get the count of products for a specific client (authenticated)
router.get(`/get/count`, authenticateToken, async (req, res) => {
  try {
      const productCount = await Product.countDocuments({ client: req.clientId }); // Count products by clientId
      res.json({ productCount: productCount });
  } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ error: 'Internal Server Error' });
  }
});



module.exports = router;
