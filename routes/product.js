const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const Product = require('../models/product');
const { Category } = require('../models/category');
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

      const products = await Product.find(filter).populate('category');
      res.json(products);
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});





// Router for posting new product with images
router.post('/', upload.single('image'), async (req, res) => { // 5 is the maximum number of images allowed
  try {
      const token = req.headers.authorization;

      if (!token || !token.startsWith('Bearer ')) {
          return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
      }
      const file = req.file;
    if (!file) return res.status(400).send('No image in the request');

      const tokenValue = token.split(' ')[1];
      const category = await Category.findById(req.body.category);

      const fileName = file.filename;
      const basePath = `${req.protocol}://${req.get('host')}/public/uploads/`;

      
      jwt.verify(tokenValue, process.env.secret, async (err, user) => {
          if (err) {
              return res.status(403).json({ error: 'Forbidden - Invalid token', err });
          }

          const clientId = user.clientID;

          // const images = req.files.map(file => file.path); // Get paths of uploaded images

          const newProduct = new Product({
              productName: req.body.productName,
              description: req.body.description,
              richDescription: req.body.richDescription,
              // image: req.files.length > 0 ? req.files[0].path : '', // Save the path of the first uploaded image
              // images: images,
              image:`${basePath}${fileName}`, //"http://localhost:3000/public/upload/image-2323232"
              brand: req.body.brand,
              price: req.body.price,
              category: category,
              countInStock: req.body.countInStock,
              rating: req.body.rating,
              numReviews: req.body.numReviews,
              isFeatured: req.body.isFeatured,
              client: clientId,
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

// Router for updating an existing product with images
router.put('/:id', upload.single('image'), async (req, res) => { // 5 is the maximum number of images allowed
  try {
      const token = req.headers.authorization;

      if (!token || !token.startsWith('Bearer ')) {
          return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
      }

      const tokenValue = token.split(' ')[1];
      const category = await Category.findById(req.body.category);
      jwt.verify(tokenValue, process.env.secret, async (err, user) => {
          if (err) {
              return res.status(403).json({ error: 'Forbidden - Invalid token', err });
          }

          const clientId = user.clientID;

          const file = req.file;
          let imagepath;
      
          if (file) {
              const fileName = file.filename;
              const basePath = `${req.protocol}://${req.get('host')}/public/uploads/`;
              imagepath = `${basePath}${fileName}`;
          } else {
              // imagepath = product.image;
          }
          const updatedProduct = {
              productName: req.body.productName,
              description: req.body.description,
              richDescription: req.body.richDescription,
              // image: req.files.length > 0 ? req.files[0].path : '', // Save the path of the first uploaded image
              // images: images,
              image: imagepath,
              brand: req.body.brand,
              price: req.body.price,
              category: req.body.category,
              countInStock: req.body.countInStock,
              rating: req.body.rating,
              numReviews: req.body.numReviews,
              isFeatured: req.body.isFeatured,
              client: clientId,
          };


          console.log(updatedProduct);

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
        const product = await Product.findById(req.params.id).populate('category');//creating reationships .populate('category') ---- get back to this!!!!!!!!!!!!!!!!!!!
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
  Product.findByIdAndRemove(req.params.id).then(product =>{
      if(Product){return res.status(200).json({succsess: true, message: 'The product has been deleted'})}
      else{return res.status(404).json({succsess: false, message: 'The product has been not deleted'})}
  }).catch(err=>{return res.status(500).json({succsess: false, error: err})})
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
