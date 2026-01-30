// config/security.js
module.exports = {
  // CORS Whitelist - Jason's specific domains
  allowedOrigins: [
    'https://herbeauty.co.za',
    'https://www.herbeauty.co.za',
    'https://khanatechnologies.co.za',
    'https://www.khanatechnologies.co.za',
    'https://www.gratiiam.co.za',
    'https://gratiiam.co.za',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001'
  ],

  // IP Whitelist (optional - for sensitive endpoints)
  allowedIPs: [
    '127.0.0.1',
    '::1',
    'localhost'
  ],

  // Rate limiting configuration
  rateLimits: {
    general: {
      windowMs: 15 * 60 * 1000,
      max: 100
    },
    auth: {
      windowMs: 15 * 60 * 1000,
      max: 5
    },
    api: {
      windowMs: 15 * 60 * 1000,
      max: 200
    }
  },

  // Security headers
  securityHeaders: {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:", "blob:"],
        connectSrc: ["'self'", "https:"]
      }
    }
  },

  // Domains for logging purposes
  domains: {
    herbeauty: ['herbeauty.co.za', 'www.herbeauty.co.za'],
    khana: ['khanatechnologies.co.za', 'www.khanatechnologies.co.za'],
    gratiiam: ['gratiiam.co.za', 'www.gratiiam.co.za']
  }
};