const axios = require('axios');
const crypto = require('crypto');

class MetaService {
  constructor() {
    this.baseUrl = 'https://graph.facebook.com';
    this.timeout = 10000; // 10 seconds
  }

  /**
   * Send event to Meta Conversions API
   */
  async sendEvent(eventData, metaConfig) {
    const { pixelId, accessToken, apiVersion = 'v18.0', testEventCode } = metaConfig;
    
    if (!pixelId || !accessToken) {
      throw new Error('Meta pixel ID and access token are required');
    }

    try {
      // Prepare the payload
      const payload = this.preparePayload(eventData, metaConfig);
      
      // Add test event code if provided (for testing)
      if (testEventCode) {
        payload.test_event_code = testEventCode;
      }

      // Make API request
      const response = await axios.post(
        `${this.baseUrl}/${apiVersion}/${pixelId}/events`,
        {
          data: [payload],
          access_token: accessToken,
          ...(testEventCode ? { test_event_code: testEventCode } : {})
        },
        {
          timeout: this.timeout,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      // Check response
      if (response.data?.events_received === 0) {
        throw new Error('Meta API accepted request but no events were processed');
      }

      return {
        success: true,
        eventId: response.data?.events_received?.[0]?.event_id,
        received: response.data?.events_received,
        messages: response.data?.messages,
        fbtraceId: response.data?.fbtrace_id
      };

    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Send multiple events in batch
   */
  async sendBatchEvents(events, metaConfig) {
    const { pixelId, accessToken, apiVersion = 'v18.0' } = metaConfig;
    
    if (!pixelId || !accessToken) {
      throw new Error('Meta pixel ID and access token are required');
    }

    try {
      // Prepare batch payload
      const payloads = events.map(event => this.preparePayload(event, metaConfig));

      const response = await axios.post(
        `${this.baseUrl}/${apiVersion}/${pixelId}/events`,
        {
          data: payloads,
          access_token: accessToken
        },
        {
          timeout: this.timeout * 2, // Double timeout for batches
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      return {
        success: true,
        results: response.data,
        eventsReceived: response.data?.events_received?.length || 0
      };

    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Prepare event payload according to Meta format
   */
  preparePayload(eventData, metaConfig) {
    const { original, meta } = eventData;
    
    // Hash PII data if not already hashed
    const userData = {
      client_user_agent: meta.user_data?.client_user_agent || original.metadata?.userAgent,
      client_ip_address: meta.user_data?.client_ip_address || original.metadata?.ip,
      em: meta.user_data?.em || this.hashEmail(original.metadata?.email),
      ph: meta.user_data?.ph || this.hashPhone(original.metadata?.phone),
      external_id: original.customer ? this.hashId(original.customer.toString()) : 
                   original.anonymousId ? this.hashId(original.anonymousId) : undefined,
      fb_login_id: original.customer ? this.hashId(original.customer.toString()) : undefined
    };

    // Remove undefined values
    Object.keys(userData).forEach(key => 
      userData[key] === undefined && delete userData[key]
    );

    // Build custom data
    const customData = {
      ...meta.custom_data,
      currency: meta.custom_data?.currency || 'ZAR',
      value: meta.custom_data?.value || 0,
      content_ids: original.productId ? [original.productId] : undefined,
      content_type: original.productId ? 'product' : undefined,
      contents: original.productId ? [{
        id: original.productId,
        quantity: original.metadata?.quantity || 1,
        item_price: original.metadata?.price || 0
      }] : undefined
    };

    // Remove undefined values from custom data
    Object.keys(customData).forEach(key => 
      customData[key] === undefined && delete customData[key]
    );

    return {
      event_name: meta.event_name,
      event_time: meta.event_time || Math.floor(Date.now() / 1000),
      event_source_url: meta.event_source_url || original.metadata?.url,
      action_source: meta.action_source || 'website',
      user_data: userData,
      custom_data: customData,
      event_id: original._id?.toString() || crypto.randomBytes(16).toString('hex'),
      event_source: original.source || 'web'
    };
  }

  /**
   * Hash email for Meta
   */
  hashEmail(email) {
    if (!email) return undefined;
    return crypto.createHash('sha256')
      .update(email.toLowerCase().trim())
      .digest('hex');
  }

  /**
   * Hash phone for Meta
   */
  hashPhone(phone) {
    if (!phone) return undefined;
    const cleanPhone = phone.replace(/\D/g, '');
    return crypto.createHash('sha256')
      .update(cleanPhone)
      .digest('hex');
  }

  /**
   * Hash ID for Meta
   */
  hashId(id) {
    if (!id) return undefined;
    return crypto.createHash('sha256')
      .update(id.toString())
      .digest('hex');
  }

  /**
   * Validate Meta pixel
   */
  async validatePixel(pixelId, accessToken) {
    try {
      const response = await axios.get(
        `${this.baseUrl}/v18.0/${pixelId}`,
        {
          params: { access_token: accessToken },
          timeout: 5000
        }
      );
      
      return {
        valid: true,
        data: response.data
      };
    } catch (error) {
      return {
        valid: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Handle and format errors
   */
  handleError(error) {
    if (error.response) {
      // Meta API error response
      const metaError = error.response.data?.error;
      return new Error(
        metaError?.message || 
        `Meta API error: ${error.response.status}`
      );
    } else if (error.request) {
      // Network error
      return new Error('Network error: Unable to reach Meta API');
    } else {
      // Other errors
      return error;
    }
  }
}

module.exports = new MetaService();