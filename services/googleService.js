const axios = require('axios');

class GoogleService {
  constructor() {
    this.baseUrl = 'https://www.googleadservices.com/pagead/conversion';
    this.apiUrl = 'https://googleads.googleapis.com/v15';
    this.timeout = 10000;
  }

  /**
   * Send event to Google Ads Conversions
   */
  async sendEvent(eventData, googleConfig) {
    const { conversionId, apiKey, conversionActionId, customerId } = googleConfig;
    
    if (!conversionId || !apiKey) {
      throw new Error('Google conversion ID and API key are required');
    }

    try {
      // Prepare the payload
      const payload = this.preparePayload(eventData, googleConfig);
      
      // For Google Ads API (preferred method)
      if (conversionActionId && customerId) {
        return await this.sendViaGoogleAdsApi(payload, googleConfig);
      }
      
      // Fallback to conversion tracking URL
      return await this.sendViaConversionUrl(payload, googleConfig);

    } catch (error) {
      throw this.handleError(error);
    }
  }

  /**
   * Send via Google Ads API (recommended)
   */
  async sendViaGoogleAdsApi(payload, googleConfig) {
    const { customerId, developerToken, clientId, clientSecret, refreshToken } = googleConfig;
    
    // Get access token if we have refresh token
    let accessToken = googleConfig.accessToken;
    if (refreshToken && clientId && clientSecret) {
      accessToken = await this.refreshAccessToken(clientId, clientSecret, refreshToken);
    }

    if (!accessToken) {
      throw new Error('Google Ads API requires access token or refresh token');
    }

    const response = await axios.post(
      `${this.apiUrl}/customers/${customerId}/conversionActions:upload`,
      {
        conversions: [{
          conversion_action: `customers/${customerId}/conversionActions/${googleConfig.conversionActionId}`,
          conversion_time: payload.conversion_time,
          conversion_value: payload.conversion_value,
          conversion_currency: payload.conversion_currency,
          gclid: payload.gclid,
          order_id: payload.order_id
        }],
        partial_failure: true
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'developer-token': developerToken,
          'Content-Type': 'application/json'
        },
        timeout: this.timeout
      }
    );

    return {
      success: true,
      method: 'api',
      data: response.data
    };
  }

  /**
   * Send via conversion tracking URL (simpler method)
   */
  async sendViaConversionUrl(payload, googleConfig) {
    const { conversionId } = googleConfig;
    
    const params = new URLSearchParams({
      cv: payload.conversion_value.toString(),
      'conversion_time': payload.conversion_time,
      'conversion_currency': payload.conversion_currency,
      'conversion_action': payload.conversion_action,
      'order_id': payload.order_id || '',
      'gclid': payload.gclid || '',
      'user_agent': payload.user_agent || ''
    });

    const response = await axios.get(
      `${this.baseUrl}/${conversionId}/`,
      { params },
      { timeout: this.timeout }
    );

    return {
      success: true,
      method: 'url',
      status: response.status
    };
  }

  /**
   * Prepare event payload for Google
   */
  preparePayload(eventData, googleConfig) {
    const { original, google } = eventData;
    
    return {
      conversion_action: google.conversion_action,
      conversion_time: google.conversion_time || new Date().toISOString(),
      conversion_value: google.conversion_value || original.metadata?.price || 0,
      conversion_currency: google.conversion_currency || original.metadata?.currency || 'ZAR',
      order_id: original.metadata?.orderId,
      gclid: original.metadata?.gclid,
      user_identifiers: google.user_identifiers || [],
      user_agent: original.metadata?.userAgent
    };
  }

  /**
   * Refresh OAuth access token
   */
  async refreshAccessToken(clientId, clientSecret, refreshToken) {
    try {
      const response = await axios.post('https://oauth2.googleapis.com/token', {
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });

      return response.data.access_token;
    } catch (error) {
      console.error('Failed to refresh Google access token:', error);
      throw new Error('Failed to refresh Google access token');
    }
  }

  /**
   * Validate Google conversion tracking
   */
  async validateConversion(conversionId, apiKey) {
    try {
      // Simple validation - check if conversion ID format is valid
      const isValidFormat = /^AW-[0-9]+$|^[0-9]+$/.test(conversionId);
      
      return {
        valid: isValidFormat,
        format: isValidFormat ? 'valid' : 'invalid'
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message
      };
    }
  }

  /**
   * Handle and format errors
   */
  handleError(error) {
    if (error.response) {
      // Google API error
      const googleError = error.response.data?.error;
      return new Error(
        googleError?.message || 
        `Google API error: ${error.response.status}`
      );
    } else if (error.request) {
      return new Error('Network error: Unable to reach Google Ads API');
    } else {
      return error;
    }
  }
}

module.exports = new GoogleService();