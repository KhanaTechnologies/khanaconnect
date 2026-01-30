// routes/customerRouter.js
const express = require('express');
const Customer = require('../models/customer');
const Client = require('../models/client');
const Product = require('../models/product');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { sendVerificationEmail } = require('../utils/sendVerificationEmail');
const { sendResetPasswordEmail } = require('../utils/email');
const { sendCartReminderEmail } = require('../utils/cartReminderEmail');
const { wrapRoute } = require('../helpers/failureEmail');
const router = express.Router();

// Rate limiter for login attempts
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Enhanced token validation middleware
const validateTokenAndExtractClientID = (req, res, next) => {
  try {
    const token = req.headers.authorization;
    if (!token || !token.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
    }

    const tokenValue = token.split(' ')[1];
    jwt.verify(tokenValue, process.env.JWT_SECRET || process.env.secret, (err, decoded) => {
      if (err) {
        console.error('Token verification error:', err);
        return res.status(403).json({ error: 'Forbidden - Invalid token' });
      }
      req.clientID = decoded.clientID;
      next();
    });
  } catch (error) {
    console.error('Token validation error:', error);
    return res.status(401).json({ error: 'Unauthorized - Token validation failed' });
  }
};

// Input validation middleware
const validateCustomerInput = (req, res, next) => {
  const { customerFirstName, customerLastName, emailAddress, password } = req.body;
  
  if (!customerFirstName || !customerLastName) {
    return res.status(400).json({ error: 'First name and last name are required' });
  }
  
  if (!emailAddress || !/\S+@\S+\.\S+/.test(emailAddress)) {
    return res.status(400).json({ error: 'Valid email address is required' });
  }
  
  if (password && password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long' });
  }
  
  next();
};

// Email domain normalization function
const normalizeEmailDomain = (email) => {
  if (!email) return email;
  
  // Replace common domain variations with standard gmail.com
  return email
    .replace(/@gmail\.co\.za$/i, '@gmail.com')
    .replace(/@googlemail\.com$/i, '@gmail.com')
    .replace(/@gmai\.com$/i, '@gmail.com')
    .replace(/@gmal\.com$/i, '@gmail.com');
};

// --------------------
// CART MANAGEMENT ROUTES
// --------------------

// ADD TO CART
router.post('/:id/cart', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { productId, quantity = 1, variant } = req.body;
    
    // Validate input
    if (!productId) {
      return res.status(400).json({ error: 'Product ID is required' });
    }

    if (quantity < 1) {
      return res.status(400).json({ error: 'Quantity must be at least 1' });
    }
    
    // Verify product exists and belongs to client
    const product = await Product.findOne({ _id: productId, clientID: req.clientID });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    // Check stock availability
    let availableStock = product.countInStock;
    if (variant && product.variants && product.variants.length > 0) {
      const variantOption = product.variants.find(v => 
        v.name === variant.name && v.values.some(val => val.value === variant.value)
      );
      if (variantOption) {
        const specificVariant = variantOption.values.find(v => v.value === variant.value);
        availableStock = specificVariant ? specificVariant.stock : product.countInStock;
      }
    }

    if (availableStock < quantity) {
      return res.status(400).json({ 
        error: 'Insufficient stock available',
        availableStock 
      });
    }

    // Calculate final price (considering variants and sales)
    let finalPrice = product.price;
    if (variant && variant.price) {
      finalPrice = variant.price;
    }
    
    // Apply sale percentage if exists
    if (product.salePercentage > 0) {
      finalPrice = finalPrice * (1 - product.salePercentage / 100);
    }

    // Find existing item in cart
    const existingItemIndex = customer.cart.findIndex(item => 
      item.productId.toString() === productId && 
      JSON.stringify(item.variant) === JSON.stringify(variant)
    );
    
    if (existingItemIndex > -1) {
      // Update existing item
      const newQuantity = customer.cart[existingItemIndex].quantity + quantity;
      if (newQuantity > availableStock) {
        return res.status(400).json({ 
          error: 'Cannot add more than available stock',
          availableStock 
        });
      }
      customer.cart[existingItemIndex].quantity = newQuantity;
      customer.cart[existingItemIndex].lastAddedAt = new Date();
    } else {
      // Add new item
      customer.cart.push({
        productId,
        productName: product.productName,
        quantity,
        price: finalPrice,
        image: product.images && product.images[0] || '',
        category: product.category?.name || '',
        variant: variant || {},
        addedAt: new Date(),
        lastAddedAt: new Date()
      });
    }

    customer.lastActivity = new Date();
    await customer.save();

    // Populate cart with product details for response
    const populatedCart = await Promise.all(
      customer.cart.map(async (item) => {
        try {
          const productDetails = await Product.findById(item.productId).select('productName images category countInStock');
          return {
            ...item.toObject(),
            product: productDetails
          };
        } catch (error) {
          console.error('Error populating product details:', error);
          return item.toObject();
        }
      })
    );

    res.json({ 
      success: true, 
      message: 'Item added to cart',
      cart: populatedCart,
      cartSummary: {
        totalItems: customer.cart.reduce((sum, item) => sum + item.quantity, 0),
        totalValue: customer.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0)
      }
    });
  } catch (error) {
    console.error('Error adding to cart:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// UPDATE CART ITEM QUANTITY - FIXED VARIANT COMPARISON
router.put('/:id/cart/:productId', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { quantity, variant } = req.body;
    
    if (quantity === undefined) {
      return res.status(400).json({ error: 'Quantity is required' });
    }

    const cartItem = customer.cart.find(item => 
      item.productId.toString() === req.params.productId && 
      JSON.stringify(item.variant) === JSON.stringify(variant || {})
    );
    
    if (!cartItem) return res.status(404).json({ error: 'Item not found in cart' });

    // Check stock availability only if increasing quantity
    if (quantity > cartItem.quantity) {
      const product = await Product.findOne({ _id: req.params.productId, clientID: req.clientID });
      if (!product) return res.status(404).json({ error: 'Product not found' });

      let availableStock = product.countInStock;
      if (variant && product.variants && product.variants.length > 0) {
        const variantOption = product.variants.find(v => 
          v.name === variant.name && v.values.some(val => val.value === variant.value)
        );
        if (variantOption) {
          const specificVariant = variantOption.values.find(v => v.value === variant.value);
          availableStock = specificVariant ? specificVariant.stock : product.countInStock;
        }
      }

      const quantityIncrease = quantity - cartItem.quantity;
      if (quantityIncrease > availableStock) {
        return res.status(400).json({ error: 'Cannot add more than available stock' });
      }
    }

    if (quantity <= 0) {
      // Remove item if quantity is 0 or less
      customer.cart = customer.cart.filter(item => 
        !(item.productId.toString() === req.params.productId && 
          JSON.stringify(item.variant) === JSON.stringify(variant || {}))
      );
    } else {
      cartItem.quantity = quantity;
    }

    customer.lastActivity = new Date();
    await customer.save();

    res.json({ 
      success: true, 
      message: 'Cart updated',
      cart: customer.cart,
      cartSummary: {
        totalItems: customer.cart.reduce((sum, item) => sum + item.quantity, 0),
        totalValue: customer.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0)
      }
    });
  } catch (error) {
    console.error('Error updating cart:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// REMOVE FROM CART - FIXED VARIANT COMPARISON
router.delete('/:id/cart/:productId', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { variant } = req.body;
    
    const initialCartLength = customer.cart.length;
    customer.cart = customer.cart.filter(item => 
      !(item.productId.toString() === req.params.productId && 
        JSON.stringify(item.variant) === JSON.stringify(variant || {}))
    );
    
    if (customer.cart.length === initialCartLength) {
      return res.status(404).json({ error: 'Item not found in cart' });
    }
    
    customer.lastActivity = new Date();
    await customer.save();

    res.json({ 
      success: true, 
      message: 'Item removed from cart',
      cart: customer.cart,
      cartSummary: {
        totalItems: customer.cart.reduce((sum, item) => sum + item.quantity, 0),
        totalValue: customer.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0)
      }
    });
  } catch (error) {
    console.error('Error removing from cart:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// CLEAR CART
router.delete('/:id/cart', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    customer.cart = [];
    customer.lastActivity = new Date();
    await customer.save();

    res.json({ 
      success: true, 
      message: 'Cart cleared' 
    });
  } catch (error) {
    console.error('Error clearing cart:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// GET CART
router.get('/:id/cart', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Populate cart with product details
    const populatedCart = await Promise.all(
      customer.cart.map(async (item) => {
        try {
          const product = await Product.findById(item.productId).select('productName images category countInStock salePercentage');
          return {
            ...item.toObject(),
            product: product,
            currentPrice: item.price,
            isOnSale: product && product.salePercentage > 0
          };
        } catch (error) {
          console.error('Error populating product:', error);
          return {
            ...item.toObject(),
            product: null,
            currentPrice: item.price,
            isOnSale: false
          };
        }
      })
    );

    res.json({ 
      cart: populatedCart,
      summary: {
        totalItems: customer.cart.reduce((sum, item) => sum + item.quantity, 0),
        totalValue: customer.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0),
        itemCount: customer.cart.length
      }
    });
  } catch (error) {
    console.error('Error getting cart:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// --------------------
// ORDER HISTORY ROUTES
// --------------------

// ADD ORDER TO HISTORY
router.post('/:id/orders', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { orderId, products, totalAmount, status = 'completed' } = req.body;

    // Validate required fields
    if (!orderId || !products || !totalAmount) {
      return res.status(400).json({ error: 'Order ID, products, and total amount are required' });
    }

    // Add order to history
    customer.orderHistory.push({
      orderId,
      products: products.map(p => ({
        productId: p.productId,
        productName: p.productName,
        quantity: p.quantity,
        price: p.price,
        image: p.image,
        category: p.category,
        variant: p.variant || {}
      })),
      totalAmount,
      status,
      orderDate: new Date()
    });

    // Update customer analytics
    customer.totalOrders += 1;
    customer.totalSpent += totalAmount;
    customer.lastActivity = new Date();
    
    // Initialize shopping habits if not exists
    if (!customer.preferences.shoppingHabits) {
      customer.preferences.shoppingHabits = {
        averageOrderValue: 0,
        favoriteProducts: [],
        typicalOrderInterval: 0,
        lastOrderDate: null
      };
    }

    const now = new Date();
    if (customer.preferences.shoppingHabits.lastOrderDate) {
      const lastOrder = new Date(customer.preferences.shoppingHabits.lastOrderDate);
      const daysBetween = (now - lastOrder) / (1000 * 60 * 60 * 24);
      
      // Update typical order interval (moving average)
      if (customer.preferences.shoppingHabits.typicalOrderInterval) {
        customer.preferences.shoppingHabits.typicalOrderInterval = 
          (customer.preferences.shoppingHabits.typicalOrderInterval + daysBetween) / 2;
      } else {
        customer.preferences.shoppingHabits.typicalOrderInterval = daysBetween;
      }
    }
    customer.preferences.shoppingHabits.lastOrderDate = now;
    
    // Update average order value
    customer.preferences.shoppingHabits.averageOrderValue = 
      customer.totalSpent / customer.totalOrders;
    
    // Update favorite products
    products.forEach(product => {
      if (product.productId && !customer.preferences.shoppingHabits.favoriteProducts.includes(product.productId)) {
        customer.preferences.shoppingHabits.favoriteProducts.push(product.productId);
      }
    });

    // Update favorite categories
    const categoryCount = {};
    products.forEach(product => {
      if (product.category) {
        categoryCount[product.category] = (categoryCount[product.category] || 0) + 1;
      }
    });
    
    customer.preferences.favoriteCategories = Object.entries(categoryCount)
      .sort(([,a], [,b]) => b - a)
      .slice(0, 3)
      .map(([category]) => category);

    // Clear cart after successful order
    customer.cart = [];

    await customer.save();

    res.json({ 
      success: true, 
      message: 'Order added to history',
      orderCount: customer.totalOrders,
      totalSpent: customer.totalSpent
    });
  } catch (error) {
    console.error('Error adding order:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// GET ORDER HISTORY
router.get('/:id/orders', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    res.json({ 
      orders: customer.orderHistory.sort((a, b) => new Date(b.orderDate) - new Date(a.orderDate)),
      summary: {
        totalOrders: customer.totalOrders,
        totalSpent: customer.totalSpent,
        averageOrderValue: customer.totalOrders > 0 ? customer.totalSpent / customer.totalOrders : 0
      }
    });
  } catch (error) {
    console.error('Error getting orders:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// --------------------
// CART REMINDER ROUTES
// --------------------

// SET CART REMINDER
router.post('/:id/cart-reminder', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const { reminderType = 'day', isActive = true, customHours } = req.body;

    customer.cartReminder = {
      reminderType,
      isActive,
      lastSent: customer.cartReminder?.lastSent,
      nextReminder: calculateNextReminder(reminderType, customHours),
      customHours: customHours || customer.cartReminder?.customHours || 24
    };

    await customer.save();

    res.json({ 
      success: true, 
      message: 'Cart reminder settings updated',
      cartReminder: customer.cartReminder 
    });
  } catch (error) {
    console.error('Error setting cart reminder:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// SEND CART REMINDER MANUALLY
router.post('/:id/send-cart-reminder', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    if (customer.cart.length === 0) {
      return res.status(400).json({ error: 'Customer cart is empty' });
    }

    const client = await Client.findOne({ clientID: req.clientID });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    await sendCartReminderEmail(customer, client);

    // Update reminder tracking
    customer.cartReminder.lastSent = new Date();
    customer.cartReminder.nextReminder = calculateNextReminder(
      customer.cartReminder.reminderType, 
      customer.cartReminder.customHours
    );
    await customer.save();

    res.json({ 
      success: true, 
      message: 'Cart reminder sent successfully' 
    });
  } catch (error) {
    console.error('Error sending cart reminder:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// --------------------
// CUSTOMER ANALYTICS ROUTES
// --------------------

// GET CUSTOMER SHOPPING HABITS
router.get('/:id/shopping-habits', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const habits = analyzeShoppingHabits(customer);

    res.json({ 
      success: true, 
      shoppingHabits: habits 
    });
  } catch (error) {
    console.error('Error getting shopping habits:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// GET CUSTOMER ANALYTICS OVERVIEW
router.get('/:id/analytics', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const analytics = generateCustomerAnalytics(customer);

    res.json({ 
      success: true, 
      analytics 
    });
  } catch (error) {
    console.error('Error getting customer analytics:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// --------------------
// CLIENT-WIDE ANALYTICS ROUTES
// --------------------

// GET CUSTOMER BEHAVIOR INSIGHTS
router.get('/analytics/behavior', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const { period = 'monthly' } = req.query; // weekly, monthly, yearly
    
    const customers = await Customer.find({ clientID: req.clientID });
    const insights = generateCustomerBehaviorInsights(customers, period);

    res.json({ 
      success: true, 
      period,
      insights 
    });
  } catch (error) {
    console.error('Error getting behavior insights:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// GET PRODUCT POPULARITY ANALYTICS
router.get('/analytics/products/popular', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const { limit = 10, period = 'all' } = req.query;
    
    const customers = await Customer.find({ clientID: req.clientID });
    const popularProducts = await analyzePopularProducts(customers, parseInt(limit), period);

    res.json({ 
      success: true, 
      popularProducts 
    });
  } catch (error) {
    console.error('Error getting popular products:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// GET CUSTOMER PURCHASE PATTERNS
router.get('/analytics/purchase-patterns', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customers = await Customer.find({ clientID: req.clientID });
    const patterns = analyzePurchasePatterns(customers);

    res.json({ 
      success: true, 
      patterns 
    });
  } catch (error) {
    console.error('Error getting purchase patterns:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// GET CART ABANDONMENT ANALYTICS
router.get('/analytics/cart-abandonment', validateTokenAndExtractClientID, wrapRoute(async (req, res) => {
  try {
    const customers = await Customer.find({ 
      clientID: req.clientID,
      'cart.0': { $exists: true } // Customers with items in cart
    });

    const abandonmentStats = analyzeCartAbandonment(customers);

    res.json({ 
      success: true, 
      abandonmentStats 
    });
  } catch (error) {
    console.error('Error getting cart abandonment stats:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}));

// --------------------
// CUSTOMER AUTH ROUTES
// --------------------

// CREATE / REGISTER CUSTOMER
router.post('/', validateTokenAndExtractClientID, validateCustomerInput, async (req, res) => {
  try {
    const client = await Client.findOne({ clientID: req.clientID });
    if (!client) return res.status(400).json({ error: 'Client not found' });

    // Normalize email domain during registration
    const normalizedEmail = normalizeEmailDomain(req.body.emailAddress.toLowerCase());

    // Check if customer already exists
    const existingCustomer = await Customer.findOne({ 
      emailAddress: normalizedEmail, 
      clientID: req.clientID 
    });
    
    if (existingCustomer) {
      return res.status(409).json({ error: 'Customer with this email already exists' });
    }

    const newCustomer = new Customer({
      clientID: req.clientID,
      customerFirstName: req.body.customerFirstName,
      customerLastName: req.body.customerLastName,
      emailAddress: normalizedEmail, // Use normalized email
      phoneNumber: req.body.phoneNumber,
      passwordHash: bcrypt.hashSync(req.body.password, 10),
      address: req.body.street ? `${req.body.street}${req.body.apartment ? `, ${req.body.apartment}` : ''}` : undefined,
      city: req.body.city,
      postalCode: req.body.postalCode,
      preferences: {
        notificationPreferences: {
          cartReminders: true,
          promotions: true,
          restockAlerts: true
        },
        shoppingHabits: {
          favoriteProducts: [],
          averageOrderValue: 0,
          typicalOrderInterval: 0
        }
      },
      cartReminder: {
        reminderType: 'day',
        isActive: true,
        nextReminder: calculateNextReminder('day')
      }
    });

    const savedCustomer = await newCustomer.save();

    // Generate verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    savedCustomer.emailVerificationToken = verificationToken;
    savedCustomer.emailVerificationExpires = Date.now() + 3600000; // 1 hour
    await savedCustomer.save();

    const verifyUrl = `${client.return_url}/verify-email/${verificationToken}`;

    try {
      await sendVerificationEmail(
        savedCustomer.emailAddress, 
        verifyUrl, 
        client.businessEmail, 
        client.businessEmailPassword, 
        client.return_url, 
        client.companyName
      );
    } catch (emailError) {
      console.error('Email failed to send:', emailError.message);
      // Don't fail the request if email fails
    }

    // Return customer without sensitive data
    const customerResponse = savedCustomer.toObject();
    delete customerResponse.passwordHash;
    delete customerResponse.emailVerificationToken;
    delete customerResponse.resetPasswordToken;

    res.status(201).json({
      success: true,
      message: 'Customer registered successfully',
      customer: customerResponse
    });
  } catch (error) {
    console.error('Error registering customer:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// LOGIN CUSTOMER - UPDATED WITH EMAIL NORMALIZATION AND AUTO-RESEND VERIFICATION
router.post('/login', loginLimiter, validateTokenAndExtractClientID, async (req, res) => {
  try {
    const { emailAddress, password } = req.body;
    
    if (!emailAddress || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Normalize email domain for login
    const normalizedEmail = normalizeEmailDomain(emailAddress.toLowerCase());

    const customer = await Customer.findOne({ 
      emailAddress: normalizedEmail, 
      clientID: req.clientID 
    });

    if (!customer) {
      return res.status(401).json({ error: 'Invalid email address or password' });
    }

    const passwordMatch = bcrypt.compareSync(password, customer.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email address or password' });
    }

    // Check if email is verified
    if (!customer.isVerified) {
      // Auto-resend verification email if not verified
      const client = await Client.findOne({ clientID: req.clientID });
      if (client) {
        const verificationToken = crypto.randomBytes(32).toString('hex');
        customer.emailVerificationToken = verificationToken;
        customer.emailVerificationExpires = Date.now() + 3600000; // 1 hour
        await customer.save();

        const verifyUrl = `${client.return_url}/verify-email/${verificationToken}`;
        
        try {
          await sendVerificationEmail(
            customer.emailAddress, 
            verifyUrl, 
            client.businessEmail, 
            client.businessEmailPassword, 
            client.return_url, 
            client.companyName
          );
        } catch (emailError) {
          console.error('Verification email failed to send:', emailError.message);
        }
      }

      return res.status(403).json({ 
        error: 'Please verify your email address before logging in. A new verification email has been sent to your email address.' 
      });
    }

    const token = jwt.sign({ 
      customerID: customer._id, 
      clientID: customer.clientID, 
      isActive: true 
    }, process.env.JWT_SECRET || process.env.secret, { 
      expiresIn: '1d' 
    });

    // Update last activity
    customer.lastActivity = new Date();
    await customer.save();

    // Return customer without sensitive data
    const customerResponse = customer.toObject();
    delete customerResponse.passwordHash;
    delete customerResponse.emailVerificationToken;
    delete customerResponse.resetPasswordToken;

    res.json({ 
      success: true,
      message: 'Login successful',
      token, 
      customer: customerResponse 
    });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// VERIFY EMAIL
router.post('/verify/:token', async (req, res) => {
  try {
    const customer = await Customer.findOne({
      emailVerificationToken: req.params.token,
      emailVerificationExpires: { $gt: Date.now() }
    });
    
    if (!customer) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    customer.isVerified = true;
    customer.emailVerificationToken = undefined;
    customer.emailVerificationExpires = undefined;
    await customer.save();

    res.json({ 
      success: true,
      message: 'Email verification successful' 
    });
  } catch (err) {
    console.error('Error verifying email:', err);
    res.status(500).json({ error: 'Error verifying email' });
  }
});

// RESEND VERIFICATION EMAIL
router.post('/resend-verification', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const { emailAddress } = req.body;
    
    if (!emailAddress) {
      return res.status(400).json({ error: 'Email address is required' });
    }

    // Normalize email domain
    const normalizedEmail = normalizeEmailDomain(emailAddress.toLowerCase());

    const customer = await Customer.findOne({ 
      emailAddress: normalizedEmail, 
      clientID: req.clientID 
    });
    
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    if (customer.isVerified) {
      return res.status(400).json({ error: 'Email is already verified' });
    }

    const client = await Client.findOne({ clientID: req.clientID });
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Generate new verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    customer.emailVerificationToken = verificationToken;
    customer.emailVerificationExpires = Date.now() + 3600000; // 1 hour
    await customer.save();

    const verifyUrl = `${client.return_url}/verify-email/${verificationToken}`;

    try {
      await sendVerificationEmail(
        customer.emailAddress, 
        verifyUrl, 
        client.businessEmail, 
        client.businessEmailPassword, 
        client.return_url, 
        client.companyName
      );
    } catch (emailError) {
      console.error('Verification email failed to send:', emailError.message);
      return res.status(500).json({ error: 'Failed to send verification email' });
    }

    res.json({ 
      success: true,
      message: 'Verification email sent successfully' 
    });
  } catch (error) {
    console.error('Error resending verification:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// RESET PASSWORD REQUEST
router.post('/reset-password', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const { emailAddress } = req.body;
    
    if (!emailAddress) {
      return res.status(400).json({ error: 'Email address is required' });
    }

    // Normalize email domain
    const normalizedEmail = normalizeEmailDomain(emailAddress.toLowerCase());

    const customer = await Customer.findOne({ 
      emailAddress: normalizedEmail, 
      clientID: req.clientID 
    });
    
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found with this email address' });
    }

    const client = await Client.findOne({ clientID: req.clientID });
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    customer.resetPasswordToken = token;
    customer.resetPasswordExpires = Date.now() + 3600000; // 1 hour
    await customer.save();

    const resetUrl = `${client.return_url}/reset-password/${token}`;
    
    try {
      await sendResetPasswordEmail(
        customer.emailAddress, 
        `${customer.customerFirstName} ${customer.customerLastName}`, 
        client.return_url, 
        resetUrl, 
        client.businessEmail, 
        client.businessEmailPassword, 
        client.companyName
      );
    } catch (emailError) {
      console.error('Error sending reset password email:', emailError);
      return res.status(500).json({ error: 'Error sending reset email' });
    }

    res.json({ 
      success: true,
      message: 'Password reset link sent to your email' 
    });
  } catch (err) {
    console.error('Error in reset password request:', err);
    res.status(500).json({ error: 'Error processing reset request' });
  }
});

// RESET PASSWORD
router.post('/reset-password/:token', async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const customer = await Customer.findOne({ 
      resetPasswordToken: req.params.token, 
      resetPasswordExpires: { $gt: Date.now() } 
    });
    
    if (!customer) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    customer.passwordHash = bcrypt.hashSync(password, 10);
    customer.resetPasswordToken = undefined;
    customer.resetPasswordExpires = undefined;
    await customer.save();

    res.json({ 
      success: true,
      message: 'Password successfully updated' 
    });
  } catch (err) {
    console.error('Error resetting password:', err);
    res.status(500).json({ error: 'Error resetting password' });
  }
});

// --------------------
// CUSTOMER PROFILE ROUTES
// --------------------

// GET CUSTOMER BY ID
router.get('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID })
      .select('-passwordHash -emailVerificationToken -resetPasswordToken');
    
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    res.json({
      success: true,
      customer
    });
  } catch (error) {
    console.error('Error getting customer:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// GET ALL CUSTOMERS
router.get('/', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const customers = await Customer.find({ clientID: req.clientID })
      .select('-passwordHash -emailVerificationToken -resetPasswordToken');
    
    res.json({
      success: true,
      customers,
      count: customers.length
    });
  } catch (error) {
    console.error('Error getting customers:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// DELETE CUSTOMER
router.delete('/:id', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const customer = await Customer.findOne({ _id: req.params.id, clientID: req.clientID });
    if (!customer) {
      return res.status(404).json({ success: false, error: 'Customer not found' });
    }

    await Customer.findByIdAndDelete(req.params.id);
    
    res.json({ 
      success: true, 
      message: 'Customer deleted successfully' 
    });
  } catch (error) {
    console.error('Error deleting customer:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// CUSTOMER COUNT
router.get('/get/count', validateTokenAndExtractClientID, async (req, res) => {
  try {
    const customerCount = await Customer.countDocuments({ clientID: req.clientID });
    
    res.json({ 
      success: true, 
      count: customerCount 
    });
  } catch (error) {
    console.error('Error counting customers:', error);
    res.status(500).json({ success: false, error: 'Internal Server Error' });
  }
});

// --------------------
// HELPER FUNCTIONS
// --------------------

function calculateNextReminder(reminderType, customHours = null) {
  const now = new Date();
  switch (reminderType) {
    case 'hour':
      return new Date(now.getTime() + 60 * 60 * 1000);
    case 'day':
      return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    case 'week':
      return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    case 'month':
      return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    case 'custom':
      return new Date(now.getTime() + (customHours || 24) * 60 * 60 * 1000);
    default:
      return new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }
}

function analyzeShoppingHabits(customer) {
  const habits = {
    orderFrequency: customer.preferences.shoppingHabits?.typicalOrderInterval 
      ? `${customer.preferences.shoppingHabits.typicalOrderInterval.toFixed(1)} days` 
      : 'Not enough data',
    averageOrderValue: customer.preferences.shoppingHabits?.averageOrderValue || 0,
    favoriteCategories: customer.preferences.favoriteCategories || [],
    cartBehavior: {
      averageCartSize: customer.cart.length,
      cartValue: customer.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0),
      itemsInCart: customer.cart.length,
      frequentlyAdded: getFrequentlyAddedProducts(customer)
    },
    loyalty: {
      customerSince: customer.customerSince,
      totalOrders: customer.totalOrders,
      totalSpent: customer.totalSpent,
      customerValue: calculateCustomerValue(customer)
    },
    recentActivity: customer.lastActivity
  };

  return habits;
}

function generateCustomerAnalytics(customer) {
  return {
    basicInfo: {
      name: `${customer.customerFirstName} ${customer.customerLastName}`,
      email: customer.emailAddress,
      memberSince: customer.customerSince,
      lastActivity: customer.lastActivity,
      totalOrders: customer.totalOrders
    },
    spending: {
      totalSpent: customer.totalSpent,
      averageOrderValue: customer.totalOrders > 0 ? customer.totalSpent / customer.totalOrders : 0,
      lifetimeValue: customer.totalSpent,
      monthlyAverage: calculateMonthlyAverage(customer)
    },
    currentCart: {
      itemCount: customer.cart.length,
      totalValue: customer.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0),
      items: customer.cart,
      abandonedValue: customer.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0)
    },
    preferences: customer.preferences,
    shoppingHabits: analyzeShoppingHabits(customer)
  };
}

function generateCustomerBehaviorInsights(customers, period) {
  const now = new Date();
  let startDate;
  
  switch (period) {
    case 'weekly':
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      break;
    case 'monthly':
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      break;
    case 'yearly':
      startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
      break;
    default:
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  }

  const recentCustomers = customers.filter(c => c.lastActivity >= startDate);
  const activeCustomers = customers.filter(c => c.cart.length > 0 || (c.orderHistory && c.orderHistory.length > 0));

  return {
    totalCustomers: customers.length,
    activeCustomers: activeCustomers.length,
    recentActivity: recentCustomers.length,
    averageCartSize: activeCustomers.length > 0 ? activeCustomers.reduce((sum, c) => sum + c.cart.length, 0) / activeCustomers.length : 0,
    averageOrderValue: activeCustomers.length > 0 ? activeCustomers.reduce((sum, c) => sum + c.totalSpent, 0) / activeCustomers.length : 0,
    cartAbandonmentRate: activeCustomers.length > 0 ? (activeCustomers.filter(c => c.cart.length > 0 && c.totalOrders === 0).length / activeCustomers.length) * 100 : 0,
    topCategories: getTopCategories(activeCustomers),
    customerRetention: calculateRetentionRate(customers, period),
    repeatPurchaseRate: calculateRepeatPurchaseRate(customers)
  };
}

async function analyzePopularProducts(customers, limit, period) {
  const productStats = {};

  // Calculate date filter based on period
  let dateFilter = new Date(0); // all time
  if (period !== 'all') {
    const now = new Date();
    if (period === 'weekly') dateFilter = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    else if (period === 'monthly') dateFilter = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    else if (period === 'yearly') dateFilter = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  }

  for (const customer of customers) {
    // Count from order history (filtered by period)
    if (customer.orderHistory) {
      customer.orderHistory
        .filter(order => order.orderDate >= dateFilter)
        .forEach(order => {
          order.products.forEach(product => {
            if (!productStats[product.productId]) {
              productStats[product.productId] = {
                productId: product.productId,
                productName: product.productName,
                totalOrders: 0,
                totalQuantity: 0,
                totalRevenue: 0,
                inCarts: 0,
                uniqueCustomers: new Set()
              };
            }
            productStats[product.productId].totalOrders += 1;
            productStats[product.productId].totalQuantity += product.quantity;
            productStats[product.productId].totalRevenue += product.price * product.quantity;
            productStats[product.productId].uniqueCustomers.add(customer._id.toString());
          });
        });
    }

    // Count from current carts
    customer.cart.forEach(item => {
      if (!productStats[item.productId]) {
        productStats[item.productId] = {
          productId: item.productId,
          productName: item.productName,
          totalOrders: 0,
          totalQuantity: 0,
          totalRevenue: 0,
          inCarts: 0,
          uniqueCustomers: new Set()
        };
      }
      productStats[item.productId].inCarts += 1;
      productStats[item.productId].uniqueCustomers.add(customer._id.toString());
    });
  }

  // Convert sets to counts and fetch current product details
  const statsArray = Object.values(productStats).map(stat => ({
    ...stat,
    uniqueCustomerCount: stat.uniqueCustomers.size,
    uniqueCustomers: undefined // Remove the set from response
  }));

  // Sort by total revenue (most popular first)
  return statsArray
    .sort((a, b) => b.totalRevenue - a.totalRevenue)
    .slice(0, limit);
}

function analyzePurchasePatterns(customers) {
  const patterns = {
    frequentShoppers: customers.filter(c => c.totalOrders >= 5).length,
    highValueCustomers: customers.filter(c => c.totalSpent >= 1000).length,
    seasonalShoppers: analyzeSeasonalPatterns(customers),
    productAssociations: findProductAssociations(customers),
    timeBasedPatterns: analyzeTimeBasedPatterns(customers)
  };

  return patterns;
}

function analyzeCartAbandonment(customers) {
  const customersWithCart = customers.filter(c => c.cart.length > 0);
  const abandonedCarts = customersWithCart.filter(c => 
    c.cart.length > 0 && 
    (c.totalOrders === 0 || 
     new Date() - new Date(c.lastActivity) > 24 * 60 * 60 * 1000)
  );
  
  return {
    totalAbandonedCarts: abandonedCarts.length,
    abandonmentRate: customersWithCart.length > 0 ? (abandonedCarts.length / customersWithCart.length) * 100 : 0,
    averageAbandonedCartValue: abandonedCarts.length > 0 ? abandonedCarts.reduce((sum, c) => 
      sum + c.cart.reduce((cartSum, item) => cartSum + (item.price * item.quantity), 0), 0) / abandonedCarts.length : 0,
    potentialRevenue: abandonedCarts.reduce((sum, c) => 
      sum + c.cart.reduce((cartSum, item) => cartSum + (item.price * item.quantity), 0), 0),
    customersNeedingReminders: customersWithCart.filter(c => 
      c.cartReminder?.isActive && (!c.cartReminder.lastSent || 
      new Date() > c.cartReminder.nextReminder)
    ).length
  };
}

function getFrequentlyAddedProducts(customer) {
  const productCount = {};
  if (customer.orderHistory) {
    customer.orderHistory.forEach(order => {
      order.products.forEach(product => {
        productCount[product.productId] = (productCount[product.productId] || 0) + 1;
      });
    });
  }

  return Object.entries(productCount)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .map(([productId, count]) => ({ productId, count }));
}

function calculateCustomerValue(customer) {
  if (!customer.customerSince) return customer.totalSpent;
  const monthsAsCustomer = Math.max(1, (new Date() - new Date(customer.customerSince)) / (30 * 24 * 60 * 60 * 1000));
  return customer.totalSpent / monthsAsCustomer;
}

function calculateMonthlyAverage(customer) {
  if (!customer.customerSince) return customer.totalSpent;
  const monthsAsCustomer = Math.max(1, (new Date() - new Date(customer.customerSince)) / (30 * 24 * 60 * 60 * 1000));
  return customer.totalSpent / monthsAsCustomer;
}

function getTopCategories(customers) {
  const categoryCount = {};
  
  customers.forEach(customer => {
    if (customer.orderHistory) {
      customer.orderHistory.forEach(order => {
        order.products.forEach(product => {
          if (product.category) {
            categoryCount[product.category] = (categoryCount[product.category] || 0) + 1;
          }
        });
      });
    }
  });

  return Object.entries(categoryCount)
    .sort(([,a], [,b]) => b - a)
    .slice(0, 5)
    .map(([category, count]) => ({ category, count }));
}

function calculateRetentionRate(customers, period) {
  if (customers.length === 0) return 0;
  
  const now = new Date();
  let daysBack = 30;
  if (period === 'weekly') daysBack = 7;
  else if (period === 'yearly') daysBack = 365;

  const activeCustomers = customers.filter(c => 
    c.lastActivity > new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000)
  );
  return (activeCustomers.length / customers.length) * 100;
}

function calculateRepeatPurchaseRate(customers) {
  if (customers.length === 0) return 0;
  const repeatCustomers = customers.filter(c => c.totalOrders > 1);
  return (repeatCustomers.length / customers.length) * 100;
}

function analyzeSeasonalPatterns(customers) {
  // Simplified seasonal analysis
  const monthlySpending = Array(12).fill(0);
  customers.forEach(customer => {
    if (customer.orderHistory) {
      customer.orderHistory.forEach(order => {
        const month = new Date(order.orderDate).getMonth();
        monthlySpending[month] += order.totalAmount;
      });
    }
  });
  return monthlySpending;
}

function findProductAssociations(customers) {
  // Simplified product association analysis
  const associations = {};
  customers.forEach(customer => {
    if (customer.orderHistory) {
      customer.orderHistory.forEach(order => {
        if (order.products.length > 1) {
          order.products.forEach(product => {
            if (!associations[product.productId]) {
              associations[product.productId] = new Set();
            }
            order.products.forEach(otherProduct => {
              if (otherProduct.productId !== product.productId) {
                associations[product.productId].add(otherProduct.productId);
              }
            });
          });
        }
      });
    }
  });

  return Object.entries(associations)
    .map(([productId, associatedProducts]) => ({
      productId,
      frequentlyBoughtWith: Array.from(associatedProducts).slice(0, 3)
    }))
    .slice(0, 10);
}

function analyzeTimeBasedPatterns(customers) {
  const hourCount = Array(24).fill(0);
  customers.forEach(customer => {
    if (customer.orderHistory) {
      customer.orderHistory.forEach(order => {
        const hour = new Date(order.orderDate).getHours();
        hourCount[hour]++;
      });
    }
  });
  return hourCount;
}

module.exports = router;