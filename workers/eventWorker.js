// workers/eventWorker.js
const { Worker } = require('bullmq');
const redis = require('../config/redis');
const TrackingEvent = require('../models/TrackingEvent');
const Client = require('../models/client');
const failureEmail = require('../helpers/failureEmail');
const { decrypt } = require('../helpers/encryption');

// Create worker for processing events
const eventWorker = new Worker('event-processing', async job => {
  const { events, clientId } = job.data;
  
  console.log(`Processing batch of ${events.length} events for client ${clientId}, attempt ${job.attemptsMade + 1}`);

  try {
    // Get client with Meta configuration
    const clientDoc = await Client.findOne({ clientID: clientId });
    
    if (!clientDoc) {
      throw new Error(`No client found for clientID ${clientId}`);
    }

    // Manually decrypt Meta fields
    const raw = clientDoc.toObject();
    const client = { ...raw };
    
    // Decrypt Meta fields if they're encrypted
    if (raw.metaAds) {
      client.metaAds = { ...raw.metaAds };
      
      if (raw.metaAds.pixelId && raw.metaAds.pixelId.includes(':')) {
        try {
          client.metaAds.pixelId = decrypt(raw.metaAds.pixelId);
          console.log(`🔓 Decrypted pixelId: ${client.metaAds.pixelId.substring(0, 5)}...`);
        } catch (e) {
          console.error('Failed to decrypt pixelId:', e.message);
        }
      }
      
      if (raw.metaAds.accessToken && raw.metaAds.accessToken.includes(':')) {
        try {
          client.metaAds.accessToken = decrypt(raw.metaAds.accessToken);
        } catch (e) {
          console.error('Failed to decrypt accessToken:', e.message);
        }
      }
      
      if (raw.metaAds.testEventCode && raw.metaAds.testEventCode.includes(':')) {
        try {
          client.metaAds.testEventCode = decrypt(raw.metaAds.testEventCode);
        } catch (e) {
          console.error('Failed to decrypt testEventCode:', e.message);
        }
      }
    }

    // Check if Meta is enabled and configured
    if (!client.metaAds?.enabled) {
      console.log(`Meta not enabled for client ${clientId}`);
      return { skipped: true, reason: 'Meta not enabled' };
    }

    if (!client.metaAds?.pixelId || !client.metaAds?.accessToken) {
      console.log(`Meta not configured for client ${clientId}`);
      return { skipped: true, reason: 'Meta not configured' };
    }

    // Send events to Meta
    const results = await sendToMeta(events, client);
    
    // Update event statuses (only for real events, not test ones)
    const realEvents = events.filter(e => !e._id || !e._id.toString().startsWith('test_'));
    if (realEvents.length > 0) {
      await updateEventsStatus(realEvents, results);
    }
    
    // Update client stats
    await updateClientStats(client, realEvents.length, results);

    return {
      clientId,
      eventsProcessed: events.length,
      results,
      processedAt: new Date().toISOString()
    };

  } catch (error) {
    console.error(`Error processing batch for client ${clientId}:`, error);
    throw error;
  }
}, {
  connection: redis,
  concurrency: 5,
  limiter: {
    max: 100,
    duration: 1000
  }
});

/**
 * Send events to Meta
 */
async function sendToMeta(events, client) {
  const { pixelId, accessToken, testEventCode, apiVersion = 'v18.0' } = client.metaAds;
  
  // Format events for Meta
  const metaEvents = events.map(event => formatMetaEvent(event, client));
  
  // Build the request body - test_event_code at ROOT level, NOT inside each event
  const requestBody = {
    data: metaEvents,
    access_token: accessToken
  };
  
  // Add test_event_code at the root level if present
  if (testEventCode) {
    requestBody.test_event_code = testEventCode;
    console.log(`🔬 Using test event code at ROOT level: ${testEventCode}`);
  }

  // LOG THE EXACT PAYLOAD for debugging
  console.log('📦 Meta API Request Payload:', JSON.stringify({
    data: metaEvents,
    test_event_code: testEventCode || 'not set',
    access_token: '***HIDDEN***'
  }, null, 2));

  const baseUrl = `https://graph.facebook.com/${apiVersion}`;
  
  console.log(`📤 Sending ${metaEvents.length} events to Meta for client ${client.clientID}`, {
    pixelId: pixelId ? '****' + pixelId.slice(-4) : 'not set',
    testMode: !!testEventCode,
    testCode: testEventCode || 'none',
    url: `${baseUrl}/${pixelId}/events`
  });

  try {
    const fetch = require('node-fetch');
    
    const response = await fetch(`${baseUrl}/${pixelId}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ Meta API Error Details:', {
        status: response.status,
        statusText: response.statusText,
        error: data.error,
        fullResponse: data
      });
      
      throw new Error(`Meta API Error: ${data.error?.message || 'Unknown error'} (Code: ${data.error?.code})`);
    }

    console.log('✅ Meta API response:', {
      eventsReceived: data.events_received,
      fbtraceId: data.fbtrace_id,
      testMode: !!testEventCode
    });

    return {
      success: true,
      sent: metaEvents.length,
      response: data,
      testMode: !!testEventCode
    };

  } catch (error) {
    console.error('❌ Meta API Error:', {
      message: error.message,
      pixelId: pixelId ? '****' + pixelId.slice(-4) : 'not set'
    });
    throw error;
  }
}

/**
 * Format event for Meta
 */
function formatMetaEvent(event, client) {
  const crypto = require('crypto');
  
  const hashData = (data) => {
    if (!data) return null;
    return crypto.createHash('sha256').update(data.toString().trim().toLowerCase()).digest('hex');
  };

  const metadata = event.metadata || {};
  
  // Handle timestamp safely
  let eventTime;
  try {
    if (event.timestamp) {
      if (event.timestamp instanceof Date) {
        eventTime = Math.floor(event.timestamp.getTime() / 1000);
      } else if (typeof event.timestamp === 'string') {
        eventTime = Math.floor(new Date(event.timestamp).getTime() / 1000);
      } else if (typeof event.timestamp === 'number') {
        eventTime = Math.floor(event.timestamp / 1000);
      } else {
        eventTime = Math.floor(Date.now() / 1000);
      }
    } else {
      eventTime = Math.floor(Date.now() / 1000);
    }
  } catch (e) {
    console.error('Timestamp error:', e);
    eventTime = Math.floor(Date.now() / 1000);
  }

  // Validate eventTime is a valid number
  if (isNaN(eventTime) || eventTime < 0) {
    eventTime = Math.floor(Date.now() / 1000);
  }

  const userData = {
    client_ip_address: metadata.ip || '127.0.0.1',
    client_user_agent: metadata.userAgent || 'Unknown',
  };

  // Add hashed PII if available
  if (event.email) {
    const hashed = hashData(event.email);
    if (hashed) userData.em = [hashed];
  }
  if (event.phone) {
    const hashed = hashData(event.phone);
    if (hashed) userData.ph = [hashed];
  }
  if (metadata.fbp) {
    userData.fbp = metadata.fbp;
  }
  if (metadata.fbc) {
    userData.fbc = metadata.fbc;
  }

  // Ensure we have at least one identifier
  if (!userData.em && !userData.ph && !userData.fbp) {
    userData.em = [hashData('test@example.com')];
  }

  // Map event types
  const eventMap = {
    'PAGE_VIEW': 'PageView',
    'PRODUCT_VIEW': 'ViewContent',
    'ADD_TO_CART': 'AddToCart',
    'PURCHASE': 'Purchase',
    'INITIATE_CHECKOUT': 'InitiateCheckout',
    'LEAD': 'Lead',
    'page_view': 'PageView',
    'view_content': 'ViewContent',
    'add_to_cart': 'AddToCart',
    'purchase': 'Purchase',
    'initiate_checkout': 'InitiateCheckout',
    'lead': 'Lead'
  };

  const eventName = eventMap[event.eventType] || 'PageView';
  
  // Build custom data
  const customData = {
    ...event.properties,
    currency: event.currency || metadata.currency || 'ZAR',
  };
  
  // Only add value if it exists and is a number
  if (event.value !== undefined && event.value !== null) {
    customData.value = parseFloat(event.value);
  } else if (metadata.price !== undefined && metadata.price !== null) {
    customData.value = parseFloat(metadata.price);
  }

  // Return the event WITHOUT test_event_code inside it
  return {
    event_name: eventName,
    event_time: eventTime,
    event_id: event._id?.toString() || event.eventHash || `test_${Date.now()}_${Math.random()}`,
    action_source: 'website',
    event_source_url: metadata.url || event.url || 'http://localhost:3000',
    user_data: userData,
    custom_data: customData
  };
}

/**
 * Update status for multiple events
 */
async function updateEventsStatus(events, results) {
  const eventIds = events.map(e => e._id).filter(id => id && typeof id === 'object');
  
  if (eventIds.length > 0) {
    await TrackingEvent.updateMany(
      { _id: { $in: eventIds } },
      {
        $set: {
          processed: true,
          deliveryStatus: 'delivered',
          processedAt: new Date(),
          'metadata.deliveredAt': new Date(),
          'metadata.metaResponse': results.response,
          'metadata.deliveryResults': results
        }
      }
    );
    console.log(`✅ Updated status for ${eventIds.length} events`);
  }
}

/**
 * Update client statistics
 */
async function updateClientStats(client, eventCount, results) {
  if (eventCount === 0) return;
  
  await Client.updateOne(
    { clientID: client.clientID },
    {
      $inc: {
        'trackingStats.eventsSent': eventCount
      },
      $set: {
        'trackingStats.lastEventSent': new Date(),
        'metaAds.lastSync': new Date(),
        'metaAds.status': results.success ? 'active' : 'error',
        'metaAds.errorMessage': results.success ? '' : 'Recent delivery failures'
      }
    }
  );
}

// Worker events
eventWorker.on('completed', job => {
  console.log(`✅ Job ${job.id} completed for client ${job.data.clientId}`);
});

eventWorker.on('failed', (job, err) => {
  console.error(`❌ Job ${job.id} failed for client ${job.data?.clientId}:`, err.message);
});

eventWorker.on('error', err => {
  console.error('Worker error:', err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing worker...');
  await eventWorker.close();
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing worker...');
  await eventWorker.close();
});

module.exports = eventWorker;