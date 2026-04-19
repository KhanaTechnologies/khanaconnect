const express = require('express');
const router = express.Router();
const TrackingEvent = require('../models/TrackingEvent');
const Client = require('../models/client');
const eventProcessor = require('../services/eventProcessor');
const { validateBatchEvents } = require('../middleware/validation');
const sizeLimiter = require('../middleware/sizeLimiter');
const asyncHandler = require('../middleware/errorHandler');
const failureEmail = require('../helpers/failureEmail');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');

// Middleware to extract client and session info
const extractTrackingInfo = (req, res, next) => {
  try {
    // Try to extract from multiple sources
    let clientID = null;
    
    // 1. Check Authorization header (JWT token)
    const token = req.headers.authorization;
    if (token && token.startsWith('Bearer ')) {
      try {
        const tokenValue = token.split(' ')[1];
        const { decoded } = verifyJwtWithAnySecret(jwt, tokenValue);
        clientID = decoded.clientID || decoded.clientId;
      } catch (jwtError) {
        // Invalid token, just continue
      }
    }
    
    // 2. Check custom headers
    if (!clientID) {
      clientID = req.headers['x-client-id'] || req.headers['client-id'];
    }
    
    // 3. Check body for clientID
    if (!clientID && req.body && req.body.events && req.body.events[0]) {
      clientID = req.body.events[0].clientId || req.body.events[0].clientID;
    }
    
    // 4. Generate temporary ID if none found
    if (!clientID) {
      clientID = `temp_${crypto.randomBytes(8).toString('hex')}`;
    }
    
    req.trackingInfo = {
      clientID,
      sessionId: req.headers['x-session-id'] || `sess_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`,
      anonymousId: req.headers['x-anonymous-id'],
      userAgent: req.headers['user-agent'],
      ip: req.ip || req.connection.remoteAddress
    };
    
    next();
  } catch (error) {
    console.error('Error extracting tracking info:', error);
    req.trackingInfo = {
      clientID: `error_${Date.now()}`,
      sessionId: `sess_${Date.now()}`,
      ip: req.ip
    };
    next();
  }
};

// Validation middleware with enhanced error tracking
const validateWithTracking = (req, res, next) => {
  try {
    validateBatchEvents(req, res, (err) => {
      if (err) {
        trackValidationError(req, err).catch(e => 
          console.error('Failed to track validation error:', e)
        );
        return next(err);
      }
      
      // Add tracking info to each event if not present
      if (req.body && req.body.events) {
        req.body.events = req.body.events.map(event => ({
          ...event,
          clientID: event.clientID || event.clientId || req.trackingInfo.clientID,
          sessionId: event.sessionId || req.trackingInfo.sessionId,
          anonymousId: event.anonymousId || req.trackingInfo.anonymousId,
          metadata: {
            ...event.metadata,
            ip: req.trackingInfo.ip,
            userAgent: req.trackingInfo.userAgent
          }
        }));
      }
      
      next();
    });
  } catch (error) {
    console.error('Validation middleware error:', error);
    failureEmail.sendErrorEmail({
      subject: 'Tracking Validation Middleware Error',
      html: `<h3>Validation Error</h3><pre>${error.stack}</pre>`
    }).catch(e => console.error('Failed to send error email:', e));
    
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

// Track validation errors
const trackValidationError = async (req, error) => {
  try {
    await TrackingEvent.create({
      clientID: req.trackingInfo?.clientID || 'unknown',
      sessionId: req.trackingInfo?.sessionId || 'unknown',
      eventType: 'VALIDATION_ERROR',
      metadata: {
        error: error.message,
        requestBody: req.body,
        url: req.originalUrl,
        method: req.method,
        ip: req.trackingInfo?.ip
      },
      source: 'api'
    });
  } catch (trackError) {
    console.error('Failed to track validation error:', trackError);
  }
};

// Response tracker middleware
const trackResponse = (req, res, next) => {
  const originalJson = res.json;
  const startTime = Date.now();
  
  res.json = function(data) {
    const duration = Date.now() - startTime;
    
    if (res.statusCode >= 400) {
      trackFailedResponse(req, res, data, duration).catch(e => 
        console.error('Failed to track error response:', e)
      );
    }
    
    return originalJson.call(this, data);
  };
  
  next();
};

// Track failed responses
const trackFailedResponse = async (req, res, data, duration) => {
  try {
    await TrackingEvent.create({
      clientID: req.trackingInfo?.clientID || 'unknown',
      sessionId: req.trackingInfo?.sessionId || 'unknown',
      eventType: 'API_ERROR',
      metadata: {
        statusCode: res.statusCode,
        error: data.error || 'Unknown error',
        duration,
        url: req.originalUrl,
        method: req.method,
        ip: req.trackingInfo?.ip
      },
      source: 'api'
    });
  } catch (error) {
    console.error('Failed to track failed response:', error);
  }
};

// Health check endpoint
router.get('/health', async (req, res) => {
  try {
    // Test database connectivity
    const dbStatus = await TrackingEvent.db.db.admin().ping();
    
    // Get queue stats from event processor
    const processorStats = eventProcessor.getStats();
    
    res.json({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      database: dbStatus.ok === 1 ? 'connected' : 'error',
      processor: processorStats,
      environment: process.env.NODE_ENV || 'development'
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({ 
      status: 'error', 
      error: error.message,
      timestamp: new Date().toISOString() 
    });
  }
});

// Debug endpoints (development only)
if (process.env.NODE_ENV === 'development') {
  router.get('/debug/queue', async (req, res) => {
    try {
      const queueStats = {
        ...eventProcessor.getStats(),
        recentEvents: await TrackingEvent.find()
          .sort({ timestamp: -1 })
          .limit(10)
          .select('eventType clientID timestamp processed deliveryStatus')
      };
      
      res.json(queueStats);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
  router.post('/debug/test-error', (req, res) => {
    throw new Error('Test error for tracking system');
  });
}

// POST /api/events/batch - Main endpoint for event tracking
router.post('/batch', 
  extractTrackingInfo,
  sizeLimiter(500), // Limit to 500 events per request
  validateWithTracking,
  trackResponse,
  asyncHandler(async (req, res) => {
    const { events } = req.body;
    
    console.log(`📊 Received batch of ${events.length} events from client ${req.trackingInfo.clientID}`);

    // Generate event hashes for deduplication
    const eventsWithHashes = events.map(event => ({
      ...event,
      eventHash: TrackingEvent.generateEventHash(event)
    }));

    // Check for duplicates by hash
    const existingHashes = await TrackingEvent.find(
      { eventHash: { $in: eventsWithHashes.map(e => e.eventHash) } },
      { eventHash: 1 }
    );
    
    const existingHashSet = new Set(existingHashes.map(e => e.eventHash));
    const uniqueEvents = eventsWithHashes.filter(e => !existingHashSet.has(e.eventHash));

    if (uniqueEvents.length === 0) {
      return res.status(200).json({
        success: true,
        stored: 0,
        duplicates: events.length,
        message: 'All events were duplicates'
      });
    }

    // Insert unique events
    const insertedEvents = await TrackingEvent.insertMany(uniqueEvents, { 
      ordered: false // Continue on duplicate errors
    });

    console.log(`✅ Stored ${insertedEvents.length} unique events out of ${events.length} total`);

    // Group events by client for processing
    const eventsByClient = {};
    insertedEvents.forEach(event => {
      const clientId = event.clientID;
      if (!eventsByClient[clientId]) {
        eventsByClient[clientId] = [];
      }
      eventsByClient[clientId].push(event);
    });

    // Queue events for ad platform delivery (async)
    Object.entries(eventsByClient).forEach(([clientId, clientEvents]) => {
      console.log(`🔍 Processing client ${clientId} with ${clientEvents.length} events...`);
      
      // Check if client has ad platforms enabled
      Client.findOne({ clientID: clientId })
        .then(clientDoc => {
          if (!clientDoc) {
            console.log(`❌ Client ${clientId} not found`);
            return { queued: 0 };
          }

          // Convert to object with getters
          const client = clientDoc.toObject({ getters: true });
          
          // Log raw vs decrypted values for debugging
          console.log(`📋 Client ${clientId} - Raw encrypted values:`, {
            pixelId: clientDoc.metaAds?.pixelId ? 
              clientDoc.metaAds.pixelId.substring(0, 20) + '...' : 'missing',
            accessToken: clientDoc.metaAds?.accessToken ? 'exists (encrypted)' : 'missing'
          });
          
          // MANUALLY DECRYPT nested fields if they're still encrypted
          if (client.metaAds) {
            const crypto = require('crypto');
            const { decrypt } = require('../helpers/encryption');
            
            // Manually decrypt pixelId if it's still encrypted
            if (client.metaAds.pixelId && typeof client.metaAds.pixelId === 'string' && client.metaAds.pixelId.includes(':')) {
              try {
                const decrypted = decrypt(client.metaAds.pixelId);
                console.log(`🔓 Decrypted pixelId: ${decrypted.substring(0, 5)}...`);
                client.metaAds.pixelId = decrypted;
              } catch (e) {
                console.error(`❌ Failed to decrypt pixelId:`, e.message);
              }
            }
            
            // Manually decrypt accessToken if it's still encrypted
            if (client.metaAds.accessToken && typeof client.metaAds.accessToken === 'string' && client.metaAds.accessToken.includes(':')) {
              try {
                const decrypted = decrypt(client.metaAds.accessToken);
                console.log(`🔓 Decrypted accessToken: ${decrypted.substring(0, 5)}...`);
                client.metaAds.accessToken = decrypted;
              } catch (e) {
                console.error(`❌ Failed to decrypt accessToken:`, e.message);
              }
            }
            
            // Manually decrypt testEventCode if it's still encrypted
            if (client.metaAds.testEventCode && typeof client.metaAds.testEventCode === 'string' && client.metaAds.testEventCode.includes(':')) {
              try {
                const decrypted = decrypt(client.metaAds.testEventCode);
                console.log(`🔓 Decrypted testEventCode: ${decrypted}`);
                client.metaAds.testEventCode = decrypted;
              } catch (e) {
                console.error(`❌ Failed to decrypt testEventCode:`, e.message);
              }
            }
          }

          // Check Meta directly (don't rely on virtual)
          const metaEnabled = client.metaAds?.enabled === true;
          const hasPixelId = client.metaAds?.pixelId && client.metaAds.pixelId.length > 0;
          const hasAccessToken = client.metaAds?.accessToken && client.metaAds.accessToken.length > 0;
          
          console.log(`📋 Client ${clientId} - After decryption:`, {
            enabled: metaEnabled,
            hasPixelId,
            pixelIdPreview: client.metaAds?.pixelId ? 
              client.metaAds.pixelId.substring(0, 5) + '...' : 'none',
            hasAccessToken,
            testEventCode: client.metaAds?.testEventCode || 'none'
          });

          if (metaEnabled && hasPixelId && hasAccessToken) {
            console.log(`✅ Meta is enabled and configured for ${clientId}, sending ${clientEvents.length} events to processor`);
            
            // Make sure eventProcessor.processEvents exists and is called
            if (typeof eventProcessor.processEvents === 'function') {
              return eventProcessor.processEvents(clientEvents, client)
                .then(result => {
                  console.log(`✅ Successfully queued events for ${clientId}:`, result);
                  return result;
                })
                .catch(err => {
                  console.error(`❌ Error in eventProcessor for ${clientId}:`, err);
                  throw err;
                });
            } else {
              console.error(`❌ eventProcessor.processEvents is not a function`);
              return { queued: 0, error: 'Processor not available' };
            }
          } else {
            console.log(`⏭️ Meta not enabled/configured for ${clientId}, skipping:`, {
              enabled: metaEnabled,
              hasPixelId,
              hasAccessToken
            });
          }
          return { queued: 0 };
        })
        .catch(err => {
          console.error(`❌ Error processing events for client ${clientId}:`, err);
          failureEmail.sendErrorEmail({
            subject: `Event Processing Error - Client ${clientId}`,
            html: `<h3>Event Processing Error</h3><pre>${err.stack}</pre>`
          }).catch(e => console.error('Failed to send error email:', e));
        });
    });

    // Update client tracking stats
    await Client.updateOne(
      { clientID: req.trackingInfo.clientID },
      { 
        $inc: { 'trackingStats.eventsSent': insertedEvents.length },
        $set: { 'trackingStats.lastEventSent': new Date() }
      }
    );

    res.status(201).json({
      success: true,
      stored: insertedEvents.length,
      duplicates: events.length - uniqueEvents.length,
      message: `Successfully stored ${insertedEvents.length} events`
    });
  })
);

// Endpoint to convert anonymous user to authenticated
router.post('/convert-anonymous', 
  extractTrackingInfo,
  asyncHandler(async (req, res) => {
    const { anonymousId, customerId } = req.body;
    
    if (!anonymousId || !customerId) {
      return res.status(400).json({ 
        error: 'anonymousId and customerId are required' 
      });
    }

    const result = await TrackingEvent.convertAnonymousToAuthenticated(
      anonymousId,
      customerId,
      req.trackingInfo.clientID
    );

    res.json({
      success: true,
      converted: result.converted,
      message: `Converted ${result.converted} anonymous events`
    });
  })
);

// Get event statistics for a client
router.get('/stats/:clientId', asyncHandler(async (req, res) => {
  const { clientId } = req.params;
  const { days = 7 } = req.query;
  
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  const stats = await TrackingEvent.aggregate([
    {
      $match: {
        clientID: clientId,
        timestamp: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: {
          eventType: '$eventType',
          date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }
        },
        count: { $sum: 1 }
      }
    },
    {
      $sort: { '_id.date': -1 }
    }
  ]);

  const deliveryStats = await TrackingEvent.aggregate([
    {
      $match: {
        clientID: clientId,
        timestamp: { $gte: startDate }
      }
    },
    {
      $group: {
        _id: '$deliveryStatus',
        count: { $sum: 1 }
      }
    }
  ]);

  res.json({
    success: true,
    period: `${days} days`,
    events: stats,
    delivery: deliveryStats
  });
}));

// Helper function to decrypt client data
const decryptClientData = (client) => {
  if (!client) return client;
  
  const crypto = require('crypto');
  const { decrypt } = require('../helpers/encryption');
  
  // Create a deep copy
  const decrypted = JSON.parse(JSON.stringify(client));
  
  // Helper to decrypt a field
  const decryptField = (obj, field) => {
    if (!obj) return;
    const value = obj[field];
    if (value && typeof value === 'string' && value.includes(':')) {
      try {
        obj[field] = decrypt(value);
        return true;
      } catch (e) {
        console.error(`Failed to decrypt ${field}:`, e.message);
        return false;
      }
    }
    return false;
  };
  
  // Decrypt Meta Ads fields
  if (decrypted.metaAds) {
    decryptField(decrypted.metaAds, 'pixelId');
    decryptField(decrypted.metaAds, 'accessToken');
    decryptField(decrypted.metaAds, 'testEventCode');
  }
  
  // Decrypt Google Ads fields
  if (decrypted.googleAds) {
    decryptField(decrypted.googleAds, 'conversionId');
    decryptField(decrypted.googleAds, 'apiKey');
    decryptField(decrypted.googleAds, 'developerToken');
    decryptField(decrypted.googleAds, 'clientId');
    decryptField(decrypted.googleAds, 'clientSecret');
    decryptField(decrypted.googleAds, 'refreshToken');
    decryptField(decrypted.googleAds, 'customerId');
    decryptField(decrypted.googleAds, 'conversionActionId');
  }
  
  // Decrypt other fields
  decryptField(decrypted, 'businessEmail');
  decryptField(decrypted, 'businessEmailPassword');
  decryptField(decrypted, 'ga4PropertyId');
  
  return decrypted;
};


// Add this to your trackingEvents.js - WITHOUT authentication for debugging
router.get('/debug/queue-status', async (req, res) => {
  try {
    // Try to load the queue
    let eventQueue;
    try {
      const queueModule = require('../queues/eventQueue');
      eventQueue = queueModule.eventQueue;
    } catch (e) {
      return res.json({
        success: false,
        error: 'Queue module not found',
        details: e.message
      });
    }

    // Try to check Redis
    let redisStatus = 'unknown';
    try {
      const redis = require('../config/redis');
      await redis.ping();
      redisStatus = 'connected';
    } catch (e) {
      redisStatus = 'disconnected: ' + e.message;
    }

    // Get queue counts
    let counts = {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0
    };
    
    let jobs = [];
    
    try {
      const [waiting, active, completed, failed, delayed] = await Promise.all([
        eventQueue.getWaitingCount().catch(() => 0),
        eventQueue.getActiveCount().catch(() => 0),
        eventQueue.getCompletedCount().catch(() => 0),
        eventQueue.getFailedCount().catch(() => 0),
        eventQueue.getDelayedCount().catch(() => 0)
      ]);
      
      counts = { waiting, active, completed, failed, delayed };
      
      // Get recent jobs
      const recentJobs = await eventQueue.getJobs(['waiting', 'active', 'failed', 'completed'], 0, 10).catch(() => []);
      jobs = recentJobs.map(job => ({
        id: job.id,
        name: job.name,
        data: {
          clientId: job.data?.clientId,
          eventCount: job.data?.events?.length || (job.data?.event ? 1 : 0)
        },
        attempts: job.attemptsMade,
        timestamp: new Date(job.timestamp).toISOString(),
        failedReason: job.failedReason || null
      }));
    } catch (e) {
      console.error('Error getting queue stats:', e);
    }

    res.json({
      success: true,
      redis: {
        status: redisStatus
      },
      queue: {
        name: 'event-processing',
        counts,
        total: counts.waiting + counts.active + counts.completed + counts.failed + counts.delayed
      },
      recentJobs: jobs,
      workerStatus: 'Check your terminal for "Workers: Running" in the logs'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

// Simple test endpoint to check if events are being queued
router.post('/debug/test-simple/:clientId', async (req, res) => {
  const { clientId } = req.params;
  
  console.log(`🔍 Testing queue for client: ${clientId}`);
  
  try {
    // Check if client exists
    const Client = require('../models/client');
    const client = await Client.findOne({ clientID: clientId });
    
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Check Meta config
    const raw = client.toObject();
    console.log('Client Meta config:', {
      enabled: raw.metaAds?.enabled,
      hasPixelId: !!raw.metaAds?.pixelId,
      pixelIdPreview: raw.metaAds?.pixelId?.substring(0, 20) + '...',
      hasToken: !!raw.metaAds?.accessToken
    });

    // Try to queue a test event
    try {
      const { queueBatchEvents } = require('../queues/eventQueue');
      
      const testEvent = {
        _id: `test_${Date.now()}`,
        eventType: 'PAGE_VIEW',
        timestamp: new Date(),
        clientID: clientId,
        metadata: {
          ip: req.ip || '127.0.0.1',
          userAgent: req.headers['user-agent'] || 'test-agent',
          url: 'http://localhost:3000/test'
        }
      };

      const jobs = await queueBatchEvents([testEvent], clientId);
      
      res.json({
        success: true,
        message: 'Test event queued',
        clientId,
        metaConfig: {
          enabled: raw.metaAds?.enabled,
          hasPixelId: !!raw.metaAds?.pixelId,
          hasToken: !!raw.metaAds?.accessToken
        },
        jobs: jobs.map(j => ({ id: j.id })),
        nextStep: 'Check your terminal logs for queue processing messages'
      });
    } catch (queueError) {
      res.status(500).json({
        success: false,
        error: 'Failed to queue event',
        details: queueError.message,
        stack: queueError.stack
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      stack: error.stack
    });
  }
});

module.exports = router;