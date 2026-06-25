const TrackingEvent = require('../../models/TrackingEvent');
const Client = require('../../models/client');
const { decrypt } = require('../../helpers/encryption');

async function processEventBatch({ events, clientId }) {
  if (!events || !events.length) {
    throw new Error('processEventBatch: events array is required');
  }
  if (!clientId) {
    throw new Error('processEventBatch: clientId is required');
  }

  console.log(`Processing batch of ${events.length} events for client ${clientId}`);

  const clientDoc = await Client.findOne({ clientID: clientId });
  if (!clientDoc) {
    throw new Error(`No client found for clientID ${clientId}`);
  }

  const raw = clientDoc.toObject();
  const client = { ...raw };

  if (raw.metaAds) {
    client.metaAds = { ...raw.metaAds };

    if (raw.metaAds.pixelId && raw.metaAds.pixelId.includes(':')) {
      try {
        client.metaAds.pixelId = decrypt(raw.metaAds.pixelId);
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

  if (!client.metaAds?.enabled) {
    console.log(`Meta not enabled for client ${clientId}`);
    return { skipped: true, reason: 'Meta not enabled' };
  }

  if (!client.metaAds?.pixelId || !client.metaAds?.accessToken) {
    console.log(`Meta not configured for client ${clientId}`);
    return { skipped: true, reason: 'Meta not configured' };
  }

  const results = await sendToMeta(events, client);

  const realEvents = events.filter((e) => !e._id || !e._id.toString().startsWith('test_'));
  if (realEvents.length > 0) {
    await updateEventsStatus(realEvents, results);
  }

  await updateClientStats(client, realEvents.length, results);

  return {
    clientId,
    eventsProcessed: events.length,
    results,
    processedAt: new Date().toISOString(),
  };
}

async function sendToMeta(events, client) {
  const { pixelId, accessToken, testEventCode, apiVersion = 'v18.0' } = client.metaAds;
  const metaEvents = events.map((event) => formatMetaEvent(event, client));

  const requestBody = {
    data: metaEvents,
    access_token: accessToken,
  };

  if (testEventCode) {
    requestBody.test_event_code = testEventCode;
  }

  const baseUrl = `https://graph.facebook.com/${apiVersion}`;

  const fetch = require('node-fetch');
  const response = await fetch(`${baseUrl}/${pixelId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      `Meta API Error: ${data.error?.message || 'Unknown error'} (Code: ${data.error?.code})`
    );
  }

  return {
    success: true,
    sent: metaEvents.length,
    response: data,
    testMode: !!testEventCode,
  };
}

function formatMetaEvent(event, client) {
  const crypto = require('crypto');

  const hashData = (value) => {
    if (!value) return null;
    return crypto.createHash('sha256').update(value.toString().trim().toLowerCase()).digest('hex');
  };

  const metadata = event.metadata || {};
  let eventTime;

  try {
    if (event.timestamp instanceof Date) {
      eventTime = Math.floor(event.timestamp.getTime() / 1000);
    } else if (typeof event.timestamp === 'string') {
      eventTime = Math.floor(new Date(event.timestamp).getTime() / 1000);
    } else if (typeof event.timestamp === 'number') {
      eventTime = Math.floor(event.timestamp / 1000);
    } else {
      eventTime = Math.floor(Date.now() / 1000);
    }
  } catch {
    eventTime = Math.floor(Date.now() / 1000);
  }

  if (Number.isNaN(eventTime) || eventTime < 0) {
    eventTime = Math.floor(Date.now() / 1000);
  }

  const userData = {
    client_ip_address: metadata.ip || '127.0.0.1',
    client_user_agent: metadata.userAgent || 'Unknown',
  };

  if (event.email) {
    const hashed = hashData(event.email);
    if (hashed) userData.em = [hashed];
  }
  if (event.phone) {
    const hashed = hashData(event.phone);
    if (hashed) userData.ph = [hashed];
  }
  if (metadata.fbp) userData.fbp = metadata.fbp;
  if (metadata.fbc) userData.fbc = metadata.fbc;

  if (!userData.em && !userData.ph && !userData.fbp) {
    userData.em = [hashData('test@example.com')];
  }

  const eventMap = {
    PAGE_VIEW: 'PageView',
    PRODUCT_VIEW: 'ViewContent',
    ADD_TO_CART: 'AddToCart',
    PURCHASE: 'Purchase',
    INITIATE_CHECKOUT: 'InitiateCheckout',
    LEAD: 'Lead',
    page_view: 'PageView',
    view_content: 'ViewContent',
    add_to_cart: 'AddToCart',
    purchase: 'Purchase',
    initiate_checkout: 'InitiateCheckout',
    lead: 'Lead',
  };

  const eventName = eventMap[event.eventType] || 'PageView';
  const customData = {
    ...event.properties,
    currency: event.currency || metadata.currency || 'ZAR',
  };

  if (event.value !== undefined && event.value !== null) {
    customData.value = parseFloat(event.value);
  } else if (metadata.price !== undefined && metadata.price !== null) {
    customData.value = parseFloat(metadata.price);
  }

  return {
    event_name: eventName,
    event_time: eventTime,
    event_id: event._id?.toString() || event.eventHash || `test_${Date.now()}_${Math.random()}`,
    action_source: 'website',
    event_source_url: metadata.url || event.url || 'http://localhost:3000',
    user_data: userData,
    custom_data: customData,
  };
}

async function updateEventsStatus(events, results) {
  const eventIds = events.map((e) => e._id).filter((id) => id && typeof id === 'object');

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
          'metadata.deliveryResults': results,
        },
      }
    );
  }
}

async function updateClientStats(client, eventCount, results) {
  if (eventCount === 0) return;

  await Client.updateOne(
    { clientID: client.clientID },
    {
      $inc: { 'trackingStats.eventsSent': eventCount },
      $set: {
        'trackingStats.lastEventSent': new Date(),
        'metaAds.lastSync': new Date(),
        'metaAds.status': results.success ? 'active' : 'error',
        'metaAds.errorMessage': results.success ? '' : 'Recent delivery failures',
      },
    }
  );
}

module.exports = { processEventBatch };
