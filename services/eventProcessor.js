// services/eventProcessor.js
const { queueBatchEvents } = require('../queues/eventQueue');
const Client = require('../models/client');
const TrackingEvent = require('../models/TrackingEvent');

class EventProcessor {
  constructor() {
    this.processing = false;
    this.stats = {
      processed: 0,
      failed: 0,
      queued: 0
    };
  }

  /**
   * Process events by queueing them for delivery to ad platforms
   */
  async processEvents(events) {
    if (!events || events.length === 0) {
      return { queued: 0 };
    }

    try {
      // Group events by clientID
      const eventsByClient = this.groupEventsByClient(events);
      
      let totalQueued = 0;
      
      // Process each client's events
      for (const [clientId, clientEvents] of Object.entries(eventsByClient)) {
        try {
          // Get client with Meta configuration
          const client = await Client.findOne({ clientID: clientId });
          
          if (!client) {
            console.log(`Client ${clientId} not found, skipping`);
            continue;
          }

          // Check if Meta is enabled
          if (!client.metaAds?.enabled) {
            console.log(`Meta not enabled for client ${clientId}, skipping`);
            continue;
          }

          // Check if Meta is configured
          if (!client.metaAds?.pixelId || !client.metaAds?.accessToken) {
            console.log(`Meta not configured for client ${clientId}, skipping`);
            continue;
          }

          // Filter events if needed
          const filteredEvents = this.filterEventsBySettings(clientEvents, client);
          
          if (filteredEvents.length === 0) {
            console.log(`No events to process for client ${clientId} after filtering`);
            continue;
          }

          // Queue events for processing
          console.log(`📦 Queueing ${filteredEvents.length} events for client ${clientId}`);
          const jobs = await queueBatchEvents(filteredEvents, clientId);
          totalQueued += jobs.length;

          // Update stats
          this.stats.queued += filteredEvents.length;

          // Mark events as queued
          await this.markEventsAsQueued(filteredEvents);

        } catch (clientError) {
          console.error(`Error processing client ${clientId}:`, clientError);
          this.stats.failed += clientEvents.length;
          
          // Mark events as failed
          await this.markEventsFailed(clientEvents, clientError.message);
        }
      }

      return { queued: totalQueued };

    } catch (error) {
      console.error('Error in event processor:', error);
      throw error;
    }
  }

  /**
   * Group events by client ID
   */
  groupEventsByClient(events) {
    return events.reduce((acc, event) => {
      const clientId = event.clientID || event.clientId;
      if (!acc[clientId]) {
        acc[clientId] = [];
      }
      acc[clientId].push(event);
      return acc;
    }, {});
  }

  /**
   * Filter events based on client settings
   */
  filterEventsBySettings(events, client) {
    const settings = client.trackingSettings || {};
    
    return events.filter(event => {
      // Check if event type is enabled
      if (settings.eventTypes && !settings.eventTypes.includes(event.eventType)) {
        return false;
      }

      // Check anonymous vs authenticated settings
      if (event.customerId && !settings.sendAuthenticatedEvents) {
        return false;
      }
      
      if (event.anonymousId && !settings.sendAnonymousEvents) {
        return false;
      }

      return true;
    });
  }

  /**
   * Mark events as queued
   */
  async markEventsAsQueued(events) {
    const eventIds = events.map(e => e._id).filter(id => id);
    
    if (eventIds.length > 0) {
      await TrackingEvent.updateMany(
        { _id: { $in: eventIds } },
        {
          $set: {
            processed: false,
            deliveryStatus: 'queued',
            'metadata.queuedAt': new Date()
          }
        }
      );
    }
  }

  /**
   * Mark events as failed
   */
  async markEventsFailed(events, errorMessage) {
    const eventIds = events.map(e => e._id).filter(id => id);
    
    if (eventIds.length > 0) {
      await TrackingEvent.updateMany(
        { _id: { $in: eventIds } },
        {
          $set: {
            processed: false,
            deliveryStatus: 'failed',
            'metadata.processingError': errorMessage,
            'metadata.failedAt': new Date()
          }
        }
      );
      
      this.stats.failed += eventIds.length;
    }
  }

  /**
   * Get processor statistics
   */
  getStats() {
    return {
      ...this.stats,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      processed: 0,
      failed: 0,
      queued: 0
    };
  }
}

// Create singleton instance
const eventProcessor = new EventProcessor();

module.exports = eventProcessor;