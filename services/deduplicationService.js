const crypto = require('crypto');
const TrackingEvent = require('../models/TrackingEvent');

class DeduplicationService {
  /**
   * Generate a unique hash for an event
   */
  generateEventHash(event) {
    const data = `${event.clientId}-${event.sessionId}-${event.eventType}-${event.productId || ''}-${event.timestamp || Date.now()}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Filter out duplicate events
   */
  async filterDuplicates(events) {
    const hashes = events.map(e => e.eventHash);
    
    // Find existing events with these hashes
    const existingEvents = await TrackingEvent.find(
      { eventHash: { $in: hashes } },
      { eventHash: 1 }
    );

    const existingHashes = new Set(existingEvents.map(e => e.eventHash));
    
    // Return only unique events
    return events.filter(event => !existingHashes.has(event.eventHash));
  }
}

module.exports = new DeduplicationService();