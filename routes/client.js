const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const router = express.Router();
const authJwt = require('../helpers/jwt');
const rateLimit = require('express-rate-limit');
const { wrapRoute } = require('../helpers/failureEmail');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');

router.use(authJwt());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Helper function to generate a JWT token
function generateToken(client) {
  const secret = process.env.secret;
  const payload = {
    clientID: client.clientID,
    companyName: client.companyName,
    merchant_id: client.merchant_id,
    merchant_key: client.merchant_key,
    passphrase: client.passphrase,
  };
  return jwt.sign(payload, secret, { expiresIn: '1y' });
}

// Middleware to authenticate token
function authenticateToken(req, res, next) {
  try {
    const token = req.headers.authorization;
    const secret = process.env.secret;
    if (!token) return res.status(401).json({ error: 'Unauthorized - Token missing' });

    const tokenValue = token.split(' ')[1];
    jwt.verify(tokenValue, secret, (err, user) => {
      if (err) return res.status(403).json({ error: 'Forbidden - Invalid token' });
      req.user = user;
      next();
    });
  } catch (error) {
    next(error);
  }
}

// Dashboard permission middleware
function checkDashboardPermission(requiredPermission = 'view') {
  return async (req, res, next) => {
    try {
      const token = req.headers.authorization?.split(' ')[1];
      if (!token) return res.status(401).json({ error: 'Unauthorized' });

      jwt.verify(token, process.env.secret, async (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });

        const client = await Client.findOne({ clientID: decoded.clientID });
        if (!client) return res.status(404).json({ error: 'Client not found' });

        // Check if client has admin role (admins have all permissions)
        if (client.role === 'admin') {
          req.user = decoded;
          req.clientPermissions = {
            view: true,
            analytics: true,
            reports: true,
            sales: true,
            bookings: true,
            orders: true,
            staff: true,
            categories: true,
            preorder: true,
            voting: true
          };
          return next();
        }

        // Check dashboard permission from permissions object
        const hasDashboardAccess = client.permissions?.dashboard || false;
        
        if (!hasDashboardAccess) {
          return res.status(403).json({ error: 'Dashboard access denied' });
        }

        // For granular permissions, you can extend this
        if (requiredPermission === 'analytics' && !client.permissions?.sales) {
          return res.status(403).json({ error: 'No permission to view analytics' });
        }

        if (requiredPermission === 'reports' && !client.permissions?.sales) {
          return res.status(403).json({ error: 'No permission to view reports' });
        }

        req.user = decoded;
        req.clientPermissions = client.permissions;
        next();
      });
    } catch (error) {
      next(error);
    }
  };
}

// --------------------
// ANALYTICS FUNCTIONS
// --------------------

/**
 * Get Website Performance Data
 */
async function getWebsitePerformance(clientId, startDate = '7daysAgo', endDate = 'today') {
  try {
    const client = await Client.findOne({ clientID: clientId });
    if (!client || !client.analyticsConfig?.googleAnalytics?.isEnabled) {
      throw new Error('Google Analytics not configured for this client');
    }

    const { propertyId } = client.analyticsConfig.googleAnalytics;
    if (!propertyId) throw new Error('Google Analytics Property ID not configured');

    const analyticsDataClient = new BetaAnalyticsDataClient();
    
    const [response] = await analyticsDataClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: 'date' },
        { name: 'pageTitle' }
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'activeUsers' },
        { name: 'engagedSessions' },
        { name: 'engagementRate' },
        { name: 'averageSessionDuration' },
        { name: 'screenPageViews' }
      ]
    });

    return formatPerformanceData(response);
  } catch (error) {
    console.error(`Performance data error for ${clientId}:`, error.message);
    throw error;
  }
}

/**
 * Get Traffic Sources Data
 */
async function getTrafficSources(clientId, startDate = '7daysAgo', endDate = 'today') {
  try {
    const client = await Client.findOne({ clientID: clientId });
    if (!client || !client.analyticsConfig?.googleAnalytics?.isEnabled) {
      throw new Error('Google Analytics not configured for this client');
    }

    const { propertyId } = client.analyticsConfig.googleAnalytics;
    if (!propertyId) throw new Error('Google Analytics Property ID not configured');

    const analyticsDataClient = new BetaAnalyticsDataClient();
    
    const [response] = await analyticsDataClient.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: 'sessionSource' },
        { name: 'sessionMedium' }
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'engagedSessions' },
        { name: 'engagementRate' },
        { name: 'totalUsers' }
      ]
    });

    return formatTrafficSourcesData(response);
  } catch (error) {
    console.error(`Traffic sources error for ${clientId}:`, error.message);
    throw error;
  }
}

/**
 * Format Performance Data
 */
function formatPerformanceData(response) {
  if (!response.rows || response.rows.length === 0) {
    return { summary: {}, pages: [] };
  }

  const summary = {
    totalSessions: 0,
    totalUsers: 0,
    totalPageViews: 0,
    avgEngagementRate: 0,
    avgSessionDuration: 0
  };

  const pages = [];

  response.rows.forEach(row => {
    const sessions = parseInt(row.metricValues[0].value);
    const users = parseInt(row.metricValues[1].value);
    const engagementRate = parseFloat(row.metricValues[3].value);
    const sessionDuration = parseFloat(row.metricValues[4].value);
    const pageViews = parseInt(row.metricValues[5].value);

    summary.totalSessions += sessions;
    summary.totalUsers += users;
    summary.totalPageViews += pageViews;
    summary.avgEngagementRate += engagementRate;
    summary.avgSessionDuration += sessionDuration;

    const pageTitle = row.dimensionValues[1].value;
    if (pageTitle && pageTitle !== '(not set)') {
      pages.push({
        pageTitle,
        sessions,
        users,
        pageViews,
        engagementRate: (engagementRate * 100).toFixed(1) + '%',
        avgTimeOnPage: formatDuration(sessionDuration)
      });
    }
  });

  // Calculate averages
  const rowCount = response.rows.length;
  summary.avgEngagementRate = (summary.avgEngagementRate / rowCount * 100).toFixed(1) + '%';
  summary.avgSessionDuration = formatDuration(summary.avgSessionDuration / rowCount);

  // Sort pages by sessions
  pages.sort((a, b) => b.sessions - a.sessions);

  return {
    summary,
    topPages: pages.slice(0, 10)
  };
}

/**
 * Format Traffic Sources Data
 */
function formatTrafficSourcesData(response) {
  if (!response.rows || response.rows.length === 0) {
    return { summary: {}, sources: [] };
  }

  const summary = {
    totalSessions: 0,
    totalSources: 0
  };

  const sources = [];
  const sourceMap = new Map();

  response.rows.forEach(row => {
    const source = row.dimensionValues[0].value || '(direct)';
    const medium = row.dimensionValues[1].value || '(none)';
    
    const sessions = parseInt(row.metricValues[0].value);
    const engagedSessions = parseInt(row.metricValues[1].value);
    const engagementRate = parseFloat(row.metricValues[2].value);
    const users = parseInt(row.metricValues[3].value);

    summary.totalSessions += sessions;

    const sourceKey = `${source} / ${medium}`;
    if (sourceMap.has(sourceKey)) {
      const existing = sourceMap.get(sourceKey);
      existing.sessions += sessions;
      existing.engagedSessions += engagedSessions;
      existing.users += users;
    } else {
      sourceMap.set(sourceKey, {
        source: source,
        medium: medium,
        sessions: sessions,
        engagedSessions: engagedSessions,
        engagementRate: engagementRate,
        users: users
      });
    }
  });

  // Convert map to array
  sources.push(...Array.from(sourceMap.values()).map(item => ({
    ...item,
    engagementRate: (item.engagementRate * 100).toFixed(1) + '%'
  })));

  // Sort and set summary
  sources.sort((a, b) => b.sessions - a.sessions);
  summary.totalSources = sources.length;

  return {
    summary,
    sources: sources.slice(0, 15)
  };
}

/**
 * Helper function to format duration
 */
function formatDuration(seconds) {
  if (!seconds) return '0s';
  
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  
  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${remainingSeconds}s`;
}

// --------------------
// CLIENT ROUTES
// --------------------

// Create a new client
router.post('/', wrapRoute(async (req, res) => {
  const { 
    clientID, 
    companyName, 
    merchant_id, 
    merchant_key, 
    password, 
    passphrase, 
    return_url, 
    cancel_url, 
    notify_url, 
    businessEmail, 
    businessEmailPassword, 
    tier, 
    role, 
    permissions, 
    deliveryOptions,
    emailSignature,
    ga4PropertyId
  } = req.body;
  
  const hashedPassword = bcrypt.hashSync(password, 10);
  const token = generateToken({ clientID, companyName, merchant_id });

  const newClient = new Client({
    clientID,
    companyName,
    password: hashedPassword,
    merchant_id,
    merchant_key,
    passphrase,
    token,
    return_url,
    cancel_url,
    notify_url,
    businessEmail,
    businessEmailPassword,
    tier,
    role: role || 'client',
    permissions: permissions || {
      bookings: false,
      orders: false,
      staff: false,
      categories: false,
      preorder: false,
      voting: false,
      sales: false,
      dashboard: false // Add dashboard permission
    },
    deliveryOptions: deliveryOptions || [],
    emailSignature: emailSignature || '',
    ga4PropertyId: ga4PropertyId || '',
    analyticsConfig: {
      googleAnalytics: {
        measurementId: '',
        apiSecret: '',
        propertyId: ga4PropertyId || '',
        isEnabled: false
      }
    }
  });

  const savedClient = await newClient.save();
  res.json({ client: savedClient, token });
}));

// Get all clients
router.get('/', wrapRoute(async (req, res) => {
  const clients = await Client.find();
  res.json(clients);
}));

// Get client by ID
router.get('/:clientId', wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.params.clientId });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
}));

// Edit client details
router.put('/:clientId', wrapRoute(async (req, res) => {
  const updates = req.body;
  if (updates.password) updates.password = bcrypt.hashSync(updates.password, 10);
  
  const updatedClient = await Client.findOneAndUpdate(
    { clientID: req.params.clientId }, 
    updates, 
    { new: true }
  );
  
  if (!updatedClient) return res.status(404).json({ error: 'Client not found' });
  res.json(updatedClient);
}));

// Update client permissions including dashboard
router.put('/:clientId/permissions', wrapRoute(async (req, res) => {
  const { permissions } = req.body;
  console.log(req.body)
  const updatedClient = await Client.findOneAndUpdate(
    { clientID: req.params.clientId },
    { $set: { permissions } },
    { new: true }
  );

  if (!updatedClient) return res.status(404).json({ error: 'Client not found' });

  res.json({ 
    success: true, 
    message: 'Permissions updated',
    permissions: updatedClient.permissions
  });
}));

// Get client permissions
router.get('/:clientId/permissions', wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.params.clientId });
  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({
    permissions: client.permissions
  });
}));

// Update client analytics configuration
router.put('/:clientId/analytics/config', wrapRoute(async (req, res) => {
  const { googleAnalytics } = req.body;
  
  const updatedClient = await Client.findOneAndUpdate(
    { clientID: req.params.clientId },
    { 
      $set: { 
        'analyticsConfig.googleAnalytics': googleAnalytics,
        ga4PropertyId: googleAnalytics.propertyId // Also update the legacy field
      } 
    },
    { new: true }
  );

  if (!updatedClient) return res.status(404).json({ error: 'Client not found' });

  res.json({ 
    success: true, 
    message: 'Analytics configuration updated',
    analyticsConfig: updatedClient.analyticsConfig
  });
}));

// Get client analytics configuration
router.get('/:clientId/analytics/config', wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.params.clientId });
  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({
    analyticsConfig: client.analyticsConfig
  });
}));

// Get Website Performance Data - Requires analytics permission (sales permission used for analytics)
router.get('/:clientId/analytics/performance', 
  checkDashboardPermission('analytics'),
  wrapRoute(async (req, res) => {
    try {
      const { startDate = '7daysAgo', endDate = 'today' } = req.query;
      
      const performanceData = await getWebsitePerformance(
        req.params.clientId, 
        startDate, 
        endDate
      );

      res.json({ 
        success: true, 
        period: { startDate, endDate },
        performance: performanceData 
      });
    } catch (error) {
      res.status(400).json({ 
        success: false, 
        error: error.message 
      });
    }
}));

// Get Traffic Sources Data - Requires analytics permission
router.get('/:clientId/analytics/traffic-sources',
  checkDashboardPermission('analytics'),
  wrapRoute(async (req, res) => {
    try {
      const { startDate = '7daysAgo', endDate = 'today' } = req.query;
      
      const trafficData = await getTrafficSources(
        req.params.clientId, 
        startDate, 
        endDate
      );

      res.json({ 
        success: true, 
        period: { startDate, endDate },
        traffic: trafficData 
      });
    } catch (error) {
      res.status(400).json({ 
        success: false, 
        error: error.message 
      });
    }
}));

// Get Analytics Dashboard - Requires dashboard view permission
router.get('/:clientId/analytics/dashboard',
  checkDashboardPermission('view'),
  wrapRoute(async (req, res) => {
    try {
      const { startDate = '7daysAgo', endDate = 'today' } = req.query;
      const client = await Client.findOne({ clientID: req.params.clientId });
      
      if (!client) return res.status(404).json({ error: 'Client not found' });

      const dashboardData = {
        clientInfo: {
          companyName: client.companyName,
          clientID: client.clientID,
          analyticsEnabled: client.analyticsConfig?.googleAnalytics?.isEnabled || false,
          tier: client.tier,
          role: client.role
        },
        period: { startDate, endDate },
        permissions: {
          ...client.permissions,
          hasDashboardAccess: client.permissions?.dashboard || false
        }
      };

      // Only fetch analytics if user has sales permission (for analytics) and GA is enabled
      if (client.permissions?.sales && client.analyticsConfig?.googleAnalytics?.isEnabled) {
        try {
          const [performance, traffic] = await Promise.all([
            getWebsitePerformance(client.clientID, startDate, endDate),
            getTrafficSources(client.clientID, startDate, endDate)
          ]);

          dashboardData.performance = performance;
          dashboardData.trafficSources = traffic;
          
        } catch (gaError) {
          dashboardData.analyticsError = `Analytics data unavailable: ${gaError.message}`;
        }
      } else if (!client.permissions?.sales) {
        dashboardData.analyticsMessage = 'Analytics access requires sales permission';
      }

      res.json({ success: true, dashboard: dashboardData });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
}));

// Client login
router.post('/login', loginLimiter, wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.body.clientID });
  if (!client) return res.status(400).send('The client could not be found');

  if (bcrypt.compareSync(req.body.password, client.password)) {
    const token = jwt.sign({ 
      clientID: client.clientID, 
      merchant_id: client.merchant_id, 
      isActive: true 
    }, process.env.secret, { expiresIn: '1d' });

    if (client.isLoggedIn) {
      client.sessionToken = null;
      client.sessionExpires = null;
    }
    client.sessionToken = token;
    client.sessionExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    client.isLoggedIn = true;
    await client.save();

    res.status(200).send({
      ID: client.clientID,
      merchant_id: client.merchant_id,
      token,
      permissions: {
        ...client.permissions,
        hasDashboardAccess: client.permissions?.dashboard || false
      },
      role: client.role,
      tier: client.tier
    });
  } else {
    res.status(400).send('The user email and password are incorrect!');
  }
}));

// Client logout
router.post('/logout', wrapRoute(async (req, res) => {
  const token = req.headers.authorization.split(' ')[1];
  const decoded = jwt.verify(token, process.env.secret);
  const client = await Client.findOne({ clientID: decoded.clientID });
  if (!client) return res.status(400).send('Client not found');

  client.sessionToken = null;
  client.sessionExpires = null;
  client.isLoggedIn = false;
  await client.save();

  res.status(200).send('Logout successful');
}));

// Test Google Analytics connection
router.post('/:clientId/analytics/test-connection', 
  checkDashboardPermission('analytics'),
  wrapRoute(async (req, res) => {
    try {
      const client = await Client.findOne({ clientID: req.params.clientId });
      if (!client) return res.status(404).json({ error: 'Client not found' });

      const { propertyId, measurementId, isEnabled } = client.analyticsConfig?.googleAnalytics || {};
      
      if (!isEnabled) {
        return res.json({
          success: false,
          message: 'Google Analytics is not enabled for this client',
          config: { propertyId, measurementId, isEnabled }
        });
      }

      if (!propertyId) {
        return res.json({
          success: false,
          message: 'Property ID is not configured',
          config: { propertyId, measurementId, isEnabled }
        });
      }

      // Test minimal API call
      const analyticsDataClient = new BetaAnalyticsDataClient();
      
      const [response] = await analyticsDataClient.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: 'today', endDate: 'today' }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }],
        limit: 1
      });

      const hasData = response.rows && response.rows.length > 0;
      
      res.json({
        success: true,
        message: hasData ? 'Connected successfully with data' : 'Connected but no data available',
        config: { propertyId, measurementId, isEnabled },
        testResult: {
          connected: true,
          hasData: hasData,
          sampleData: hasData ? {
            date: response.rows[0].dimensionValues[0].value,
            sessions: response.rows[0].metricValues[0].value
          } : null
        }
      });

    } catch (error) {
      console.error('GA Test Connection Error:', error);
      
      // Parse error for better messaging
      let errorMessage = error.message;
      let errorType = 'Unknown';
      
      if (error.message.includes('PERMISSION_DENIED')) {
        errorType = 'Authentication Error';
        errorMessage = 'Service account lacks permission to access this GA4 property';
      } else if (error.message.includes('NOT_FOUND')) {
        errorType = 'Property Not Found';
        errorMessage = 'GA4 property not found. Check Property ID';
      } else if (error.message.includes('invalid property')) {
        errorType = 'Invalid Property';
        errorMessage = 'Invalid Property ID format';
      }

      res.status(400).json({
        success: false,
        errorType,
        error: errorMessage,
        config: client?.analyticsConfig?.googleAnalytics || {}
      });
    }
}));

module.exports = router;