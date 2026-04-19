const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const TrackingEvent = require('../models/TrackingEvent');
const router = express.Router();
const authJwt = require('../helpers/jwt');
const rateLimit = require('express-rate-limit');
const { wrapRoute } = require('../helpers/failureEmail');
const { getJwtSecret, verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { BetaAnalyticsDataClient } = require('@google-analytics/data');
const metaService = require('../services/metaService');
const googleService = require('../services/googleService');
const { encrypt, decrypt } = require('../helpers/encryption'); // ✅ Import from helper

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
  const secret = getJwtSecret();
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
    const secret = getJwtSecret();
    if (!token) return res.status(401).json({ error: 'Unauthorized - Token missing' });

    const tokenValue = token.split(' ')[1];
    const { decoded } = verifyJwtWithAnySecret(jwt, tokenValue);
    req.user = decoded;
    next();
  } catch (error) {
    next(error);
  }
}

// Admin check middleware
async function requireAdmin(req, res, next) {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    const { decoded } = verifyJwtWithAnySecret(jwt, token);
    const client = await Client.findOne({ clientID: decoded.clientID });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    if (client.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }

    req.user = decoded;
    next();
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

      const { decoded } = verifyJwtWithAnySecret(jwt, token);
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
    } catch (error) {
      next(error);
    }
  };
}

// --------------------
// KEY ROTATION MIGRATION (secret -> ENCRYPTION_KEY)
// --------------------

router.post('/migrate/rotate-encryption-key', requireAdmin, wrapRoute(async (req, res) => {
  // Check if we have both keys
  if (!process.env.secret || !process.env.ENCRYPTION_KEY) {
    return res.status(400).json({
      success: false,
      error: 'Both secret (old key) and ENCRYPTION_KEY (new key) are required for migration'
    });
  }

  // Safety check for production
  if (process.env.NODE_ENV === 'production' && !req.query.confirm) {
    return res.status(400).json({
      success: false,
      error: 'This is a destructive operation. Add ?confirm=true to run in production'
    });
  }

  // Import crypto directly (not from encryption helper)
  const crypto = require('crypto');

  const migrationId = `key_rotation_${Date.now()}`;
  const startTime = new Date();

  // Get total count for progress tracking
  const totalCount = await Client.countDocuments({});
  
  const results = {
    migrationId,
    startTime,
    total: totalCount,
    processed: 0,
    reEncrypted: 0,
    failed: 0,
    skipped: 0,
    alreadyWithNewKey: 0,
    details: []
  };

  // Process in batches
  const batchSize = 50;
  let skip = 0;
  let hasMore = true;

  while (hasMore) {
    const clients = await Client.find({}).skip(skip).limit(batchSize);
    
    if (clients.length === 0) {
      hasMore = false;
      break;
    }

    // Process each client in the batch
    for (const client of clients) {
      try {
        console.log(`Processing client: ${client.clientID}`);
        
        let modified = false;
        const clientResult = {
          clientID: client.clientID,
          companyName: client.companyName,
          fieldsReEncrypted: [],
          fieldsAlreadyWithNewKey: [],
          fieldsFailed: [],
          fieldsSkipped: []
        };

        // Helper function to check and re-encrypt a field
        const reEncryptField = (currentValue, fieldName) => {
          if (!currentValue || typeof currentValue !== 'string') {
            clientResult.fieldsSkipped.push({ field: fieldName, reason: 'No value or not string' });
            return null;
          }

          if (!currentValue.includes(':')) {
            clientResult.fieldsSkipped.push({ field: fieldName, reason: 'Not encrypted (no colon)' });
            return null;
          }

          // Try to decrypt with old key
          try {
            const [ivHex, encryptedHex] = currentValue.split(':');
            const iv = Buffer.from(ivHex, 'hex');
            const oldKey = crypto.scryptSync(process.env.secret, 'salt', 32);
            const decipher = crypto.createDecipheriv('aes-256-cbc', oldKey, iv);
            let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            // Re-encrypt with new key
            const newIv = crypto.randomBytes(16);
            const newKey = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
            const cipher = crypto.createCipheriv('aes-256-cbc', newKey, newIv);
            let encrypted = cipher.update(decrypted, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            
            clientResult.fieldsReEncrypted.push(fieldName);
            return `${newIv.toString('hex')}:${encrypted}`;
          } catch (error) {
            // Try with new key (maybe already rotated)
            try {
              const [ivHex, encryptedHex] = currentValue.split(':');
              const iv = Buffer.from(ivHex, 'hex');
              const newKey = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
              const decipher = crypto.createDecipheriv('aes-256-cbc', newKey, iv);
              let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
              decrypted += decipher.final('utf8');
              
              clientResult.fieldsAlreadyWithNewKey.push(fieldName);
              return null; // No change needed
            } catch (secondError) {
              clientResult.fieldsFailed.push({ 
                field: fieldName, 
                error: 'Cannot decrypt with either key' 
              });
              return null;
            }
          }
        };

        // Process businessEmail
        if (client.businessEmail) {
          const newValue = reEncryptField(client.businessEmail, 'businessEmail');
          if (newValue) {
            client.businessEmail = newValue;
            modified = true;
          }
        }

        // Process businessEmailPassword
        if (client.businessEmailPassword) {
          const newValue = reEncryptField(client.businessEmailPassword, 'businessEmailPassword');
          if (newValue) {
            client.businessEmailPassword = newValue;
            modified = true;
          }
        }

        // Save if modified
        if (modified) {
          try {
            await client.save();
            results.reEncrypted++;
            clientResult.status = 're-encrypted';
          } catch (saveError) {
            console.error(`❌ Failed to save client ${client.clientID}:`, saveError);
            clientResult.status = 'save-failed';
            clientResult.saveError = saveError.message;
            results.failed++;
          }
        } else {
          if (clientResult.fieldsAlreadyWithNewKey.length > 0) {
            results.alreadyWithNewKey++;
            clientResult.status = 'already-with-new-key';
          } else if (clientResult.fieldsFailed.length > 0) {
            results.failed++;
            clientResult.status = 'failed';
          } else {
            results.skipped++;
            clientResult.status = 'skipped';
          }
        }

        results.processed++;
        results.details.push(clientResult);

      } catch (clientError) {
        console.error(`❌ Critical error processing client ${client.clientID}:`, clientError);
        results.failed++;
        results.details.push({
          clientID: client.clientID,
          companyName: client.companyName,
          status: 'failed',
          error: clientError.message
        });
      }
    }

    skip += batchSize;
    
    // Log progress
    console.log(`Key rotation progress: ${results.processed}/${totalCount} (${Math.round(results.processed/totalCount*100)}%)`);
    
    // Small delay to reduce load
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  const endTime = new Date();
  results.endTime = endTime;
  results.duration = `${(endTime - startTime) / 1000}s`;

  res.json({
    success: true,
    message: 'Key rotation migration completed',
    summary: {
      total: results.total,
      reEncrypted: results.reEncrypted,
      alreadyWithNewKey: results.alreadyWithNewKey,
      failed: results.failed,
      skipped: results.skipped,
      duration: results.duration
    },
    migrationId
  });
}));

// Add this debug endpoint to see raw encrypted data
router.get('/debug/raw-encrypted-data', requireAdmin, wrapRoute(async (req, res) => {
  const clients = await Client.find({}).lean(); // Use lean() to bypass getters
  
  const result = clients.map(client => ({
    clientID: client.clientID,
    businessEmail: client.businessEmail ? {
      value: client.businessEmail,
      type: typeof client.businessEmail,
      isEncrypted: client.businessEmail.includes ? client.businessEmail.includes(':') : false,
      length: client.businessEmail.length
    } : null,
    businessEmailPassword: client.businessEmailPassword ? {
      value: client.businessEmailPassword,
      type: typeof client.businessEmailPassword,
      isEncrypted: client.businessEmailPassword.includes ? client.businessEmailPassword.includes(':') : false,
      length: client.businessEmailPassword.length
    } : null
  }));
  
  res.json({
    success: true,
    data: result
  });
}));

// Migration to encrypt merchant_key and passphrase with ENCRYPTION_KEY
router.post('/migrate/encrypt-merchant-fields', requireAdmin, wrapRoute(async (req, res) => {
  // Safety check for production
  if (process.env.NODE_ENV === 'production' && !req.query.confirm) {
    return res.status(400).json({
      success: false,
      error: 'This is a destructive operation. Add ?confirm=true to run in production'
    });
  }

  // Check if we have the new encryption key
  if (!process.env.ENCRYPTION_KEY) {
    return res.status(400).json({
      success: false,
      error: 'ENCRYPTION_KEY environment variable is required for encryption'
    });
  }

  const crypto = require('crypto');
  
  // Setup new encryption key
  const newKey = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');

  const clients = await Client.find({});
  const results = {
    total: clients.length,
    encrypted: 0,
    failed: 0,
    skipped: 0,
    details: []
  };

  for (const client of clients) {
    try {
      let modified = false;
      const clientResult = {
        clientID: client.clientID,
        companyName: client.companyName,
        encryptedFields: [],
        skippedFields: []
      };

      // Helper function to encrypt with NEW key
      const encryptWithNewKey = (text, fieldName) => {
        if (!text) return null;
        
        // Skip if already encrypted (has colon)
        if (typeof text === 'string' && text.includes(':')) {
          clientResult.skippedFields.push({ field: fieldName, reason: 'Already encrypted' });
          return null;
        }

        try {
          const iv = crypto.randomBytes(16);
          const cipher = crypto.createCipheriv('aes-256-cbc', newKey, iv);
          let encrypted = cipher.update(text.toString(), 'utf8', 'hex');
          encrypted += cipher.final('hex');
          
          clientResult.encryptedFields.push(fieldName);
          return `${iv.toString('hex')}:${encrypted}`;
        } catch (error) {
          console.error(`Failed to encrypt ${fieldName}:`, error.message);
          return null;
        }
      };

      // ===========================================
      // merchant_id - SKIP (keeping as Number)
      // ===========================================
      clientResult.skippedFields.push({ 
        field: 'merchant_id', 
        reason: 'Field kept as Number type, not encrypted' 
      });

      // ===========================================
      // Encrypt merchant_key (String field)
      // ===========================================
      if (client.merchant_key) {
        // Check if already encrypted
        if (typeof client.merchant_key === 'string' && client.merchant_key.includes(':')) {
          clientResult.skippedFields.push({ field: 'merchant_key', reason: 'Already encrypted' });
        } else {
          const encryptedValue = encryptWithNewKey(client.merchant_key, 'merchant_key');
          if (encryptedValue) {
            client.merchant_key = encryptedValue;
            modified = true;
          }
        }
      } else {
        clientResult.skippedFields.push({ field: 'merchant_key', reason: 'No value' });
      }

      // ===========================================
      // Encrypt passphrase (String field)
      // ===========================================
      if (client.passphrase) {
        // Check if already encrypted
        if (typeof client.passphrase === 'string' && client.passphrase.includes(':')) {
          clientResult.skippedFields.push({ field: 'passphrase', reason: 'Already encrypted' });
        } else {
          const encryptedValue = encryptWithNewKey(client.passphrase, 'passphrase');
          if (encryptedValue) {
            client.passphrase = encryptedValue;
            modified = true;
          }
        }
      } else {
        clientResult.skippedFields.push({ field: 'passphrase', reason: 'No value' });
      }

      // Save if modified
      if (modified) {
        // Mark fields as modified
        client.markModified('merchant_key');
        client.markModified('passphrase');
        
        await client.save();
        results.encrypted++;
        clientResult.status = 'encrypted';
        clientResult.fieldsCount = clientResult.encryptedFields.length;
      } else {
        results.skipped++;
        clientResult.status = 'skipped';
      }

      results.details.push(clientResult);

    } catch (error) {
      console.error(`Failed to process client ${client.clientID}:`, error);
      results.failed++;
      results.details.push({
        clientID: client.clientID,
        companyName: client.companyName,
        status: 'failed',
        error: error.message
      });
    }
  }

  res.json({
    success: true,
    message: 'Merchant fields encryption completed',
    summary: {
      total: results.total,
      encrypted: results.encrypted,
      skipped: results.skipped,
      failed: results.failed,
      note: 'merchant_id was skipped (remains as Number type)'
    },
    details: results.details
  });
}));

// Updated verification endpoint
router.get('/debug/merchant-encryption-status', requireAdmin, wrapRoute(async (req, res) => {
  const clients = await Client.find({}).lean();
  
  const status = clients.map(client => ({
    clientID: client.clientID,
    merchant_id: {
      value: client.merchant_id,
      type: typeof client.merchant_id,
      note: 'Number type - not encrypted'
    },
    merchant_key: {
      value: client.merchant_key ? (client.merchant_key.substring(0, 30) + '...') : null,
      isEncrypted: client.merchant_key && typeof client.merchant_key === 'string' ? client.merchant_key.includes(':') : false,
      type: typeof client.merchant_key
    },
    passphrase: {
      value: client.passphrase ? (client.passphrase.substring(0, 30) + '...') : null,
      isEncrypted: client.passphrase && typeof client.passphrase === 'string' ? client.passphrase.includes(':') : false,
      type: typeof client.passphrase
    }
  }));

  res.json({
    success: true,
    encryptionKey: {
      present: !!process.env.ENCRYPTION_KEY,
      valid: process.env.ENCRYPTION_KEY ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex').length === 32 : false
    },
    clients: status
  });
}));

// Verification endpoint to check encryption status
router.get('/debug/encryption-status', requireAdmin, wrapRoute(async (req, res) => {
  const clients = await Client.find({}).lean();
  
  const status = clients.map(client => ({
    clientID: client.clientID,
    merchant_id: {
      value: client.merchant_id,
      isEncrypted: client.merchant_id && typeof client.merchant_id === 'string' ? client.merchant_id.includes(':') : false,
      type: typeof client.merchant_id
    },
    merchant_key: {
      value: client.merchant_key ? (client.merchant_key.substring(0, 20) + '...') : null,
      isEncrypted: client.merchant_key && typeof client.merchant_key === 'string' ? client.merchant_key.includes(':') : false
    },
    passphrase: {
      value: client.passphrase ? (client.passphrase.substring(0, 20) + '...') : null,
      isEncrypted: client.passphrase && typeof client.passphrase === 'string' ? client.passphrase.includes(':') : false
    },
    businessEmail: {
      isEncrypted: client.businessEmail && typeof client.businessEmail === 'string' ? client.businessEmail.includes(':') : false
    }
  }));

  res.json({
    success: true,
    encryptionKey: {
      present: !!process.env.ENCRYPTION_KEY,
      valid: process.env.ENCRYPTION_KEY ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex').length === 32 : false
    },
    clients: status
  });
}));

// Migration to switch encryption from ENCRYPTION_KEY back to secret
// AND update all JWT tokens
router.post('/migrate/switch-to-secret-encryption', requireAdmin, wrapRoute(async (req, res) => {
  // Safety check for production
  if (process.env.NODE_ENV === 'production' && !req.query.confirm) {
    return res.status(400).json({
      success: false,
      error: 'This is a destructive operation. Add ?confirm=true to run in production'
    });
  }

  const crypto = require('crypto');
  const jwt = require('jsonwebtoken');
  
  // Setup keys
  const newKey = Buffer.from(process.env.ENCRYPTION_KEY, 'hex'); // Current encryption key
  const oldKey = crypto.scryptSync(process.env.secret, 'salt', 32); // Target encryption key

  const clients = await Client.find({});
  const results = {
    total: clients.length,
    dataReEncrypted: 0,
    tokensUpdated: 0,
    failed: 0,
    details: []
  };

  for (const client of clients) {
    try {
      let dataModified = false;
      const clientResult = {
        clientID: client.clientID,
        companyName: client.companyName,
        dataFields: [],
        tokenUpdated: false
      };

      // STEP 1: Re-encrypt all encrypted fields from NEW key to OLD key
      
      // Helper to re-encrypt a field
      const reEncryptField = (currentValue, fieldName) => {
        if (!currentValue || typeof currentValue !== 'string' || !currentValue.includes(':')) {
          return null;
        }

        try {
          // Decrypt with NEW key (current encryption)
          const [ivHex, encryptedHex] = currentValue.split(':');
          const iv = Buffer.from(ivHex, 'hex');
          const decipher = crypto.createDecipheriv('aes-256-cbc', newKey, iv);
          let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
          decrypted += decipher.final('utf8');

          // Re-encrypt with OLD key
          const newIv = crypto.randomBytes(16);
          const cipher = crypto.createCipheriv('aes-256-cbc', oldKey, newIv);
          let encrypted = cipher.update(decrypted, 'utf8', 'hex');
          encrypted += cipher.final('hex');
          
          clientResult.dataFields.push(fieldName);
          return `${newIv.toString('hex')}:${encrypted}`;
        } catch (error) {
          console.error(`Failed to re-encrypt ${fieldName} for ${client.clientID}:`, error.message);
          return null;
        }
      };

      // Re-encrypt businessEmail
      if (client.businessEmail) {
        const newValue = reEncryptField(client.businessEmail, 'businessEmail');
        if (newValue) {
          client.businessEmail = newValue;
          dataModified = true;
        }
      }

      // Re-encrypt businessEmailPassword
      if (client.businessEmailPassword) {
        const newValue = reEncryptField(client.businessEmailPassword, 'businessEmailPassword');
        if (newValue) {
          client.businessEmailPassword = newValue;
          dataModified = true;
        }
      }

      // Re-encrypt ga4PropertyId if it exists and is encrypted
      if (client.ga4PropertyId && client.ga4PropertyId.includes(':')) {
        const newValue = reEncryptField(client.ga4PropertyId, 'ga4PropertyId');
        if (newValue) {
          client.ga4PropertyId = newValue;
          dataModified = true;
        }
      }

      // Re-encrypt Meta Ads fields
      if (client.metaAds) {
        if (client.metaAds.pixelId && client.metaAds.pixelId.includes(':')) {
          const newValue = reEncryptField(client.metaAds.pixelId, 'metaAds.pixelId');
          if (newValue) {
            client.metaAds.pixelId = newValue;
            dataModified = true;
          }
        }
        if (client.metaAds.accessToken && client.metaAds.accessToken.includes(':')) {
          const newValue = reEncryptField(client.metaAds.accessToken, 'metaAds.accessToken');
          if (newValue) {
            client.metaAds.accessToken = newValue;
            dataModified = true;
          }
        }
      }

      // Re-encrypt Google Ads fields
      if (client.googleAds) {
        const googleFields = ['conversionId', 'apiKey', 'developerToken', 'clientId', 'clientSecret', 'refreshToken', 'customerId', 'conversionActionId'];
        googleFields.forEach(field => {
          if (client.googleAds[field] && client.googleAds[field].includes(':')) {
            const newValue = reEncryptField(client.googleAds[field], `googleAds.${field}`);
            if (newValue) {
              client.googleAds[field] = newValue;
              dataModified = true;
            }
          }
        });
      }

      // STEP 2: Generate new JWT token using the secret
      const newToken = jwt.sign(
        {
          clientID: client.clientID,
          companyName: client.companyName,
          merchant_id: client.merchant_id,
          merchant_key: client.merchant_key,
          passphrase: client.passphrase
        },
        getJwtSecret(),
        { expiresIn: '1y' }
      );

      // Update token if it's different
      if (client.token !== newToken) {
        client.token = newToken;
        clientResult.tokenUpdated = true;
        
        // Also update session token if exists
        if (client.sessionToken) {
          const newSessionToken = jwt.sign(
            {
              clientID: client.clientID,
              merchant_id: client.merchant_id,
              isActive: true
            },
            getJwtSecret(),
            { expiresIn: '1d' }
          );
          client.sessionToken = newSessionToken;
          client.sessionExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
        }
      }

      // Save the client if anything changed
      if (dataModified || clientResult.tokenUpdated) {
        // Mark all modified paths
        if (dataModified) {
          client.markModified('businessEmail');
          client.markModified('businessEmailPassword');
          client.markModified('ga4PropertyId');
          client.markModified('metaAds');
          client.markModified('googleAds');
        }
        
        await client.save();
        
        if (dataModified) results.dataReEncrypted++;
        if (clientResult.tokenUpdated) results.tokensUpdated++;
        
        clientResult.status = 'updated';
      } else {
        clientResult.status = 'skipped';
        results.skipped = (results.skipped || 0) + 1;
      }

      results.details.push(clientResult);

    } catch (error) {
      console.error(`Failed to process client ${client.clientID}:`, error);
      results.failed++;
      results.details.push({
        clientID: client.clientID,
        companyName: client.companyName,
        status: 'failed',
        error: error.message
      });
    }
  }

  res.json({
    success: true,
    message: 'Migration completed - Data re-encrypted with secret and tokens updated',
    summary: {
      total: results.total,
      dataReEncrypted: results.dataReEncrypted,
      tokensUpdated: results.tokensUpdated,
      failed: results.failed,
      skipped: results.skipped || 0
    },
    details: results.details
  });
}));

// Verify the migration worked
router.get('/debug/verify-migration', requireAdmin, wrapRoute(async (req, res) => {
  const crypto = require('crypto');
  const jwt = require('jsonwebtoken');
  
  const clients = await Client.find({});
  
  const oldKey = crypto.scryptSync(process.env.secret, 'salt', 32);
  const newKey = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  
  const results = [];

  for (const client of clients) {
    const clientResult = {
      clientID: client.clientID,
      tokenValid: false,
      dataDecryptable: {}
    };

    // Verify token
    try {
      verifyJwtWithAnySecret(jwt, client.token);
      clientResult.tokenValid = true;
    } catch (error) {
      clientResult.tokenValid = false;
      clientResult.tokenError = error.message;
    }

    // Verify businessEmail can be decrypted with OLD key
    if (client.businessEmail && client.businessEmail.includes(':')) {
      try {
        const [ivHex, encryptedHex] = client.businessEmail.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', oldKey, iv);
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        clientResult.dataDecryptable.businessEmail = true;
      } catch (error) {
        clientResult.dataDecryptable.businessEmail = false;
      }

      // Try with new key (should fail)
      try {
        const [ivHex, encryptedHex] = client.businessEmail.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', newKey, iv);
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        clientResult.dataDecryptable.businessEmailWithNew = true; // This should be false
      } catch (error) {
        clientResult.dataDecryptable.businessEmailWithNew = false; // This should be true
      }
    }

    results.push(clientResult);
  }

  res.json({
    success: true,
    message: 'Verification results - After migration, data should ONLY decrypt with OLD key',
    results
  });
}));


// Combined migration - encrypts plaintext AND rotates keys
router.post('/migrate/full-encryption-setup', requireAdmin, wrapRoute(async (req, res) => {
  // Safety check for production
  if (process.env.NODE_ENV === 'production' && !req.query.confirm) {
    return res.status(400).json({
      success: false,
      error: 'Add ?confirm=true to run in production'
    });
  }

  const clients = await Client.find({});
  const results = {
    total: clients.length,
    encrypted: 0,
    rotated: 0,
    failed: 0,
    details: []
  };

  for (const client of clients) {
    try {
      let modified = false;
      const clientResult = {
        clientID: client.clientID,
        companyName: client.companyName,
        actions: []
      };

      // STEP 1: Encrypt any plaintext fields
      if (client.businessEmail && !client.businessEmail.includes(':')) {
        client.businessEmail = client.businessEmail; // Triggers encryption with OLD key via schema
        modified = true;
        clientResult.actions.push('encrypted:businessEmail');
      }

      if (client.businessEmailPassword && !client.businessEmailPassword.includes(':')) {
        client.businessEmailPassword = client.businessEmailPassword; // Triggers encryption with OLD key via schema
        modified = true;
        clientResult.actions.push('encrypted:businessEmailPassword');
      }

      // Save first encryption
      if (modified) {
        await client.save();
        results.encrypted++;
      }

      // STEP 2: Now rotate keys (if both keys exist)
      if (process.env.secret && process.env.ENCRYPTION_KEY) {
        const crypto = require('crypto');
        let rotated = false;

        // Check and rotate businessEmail
        if (client.businessEmail && client.businessEmail.includes(':')) {
          try {
            // Decrypt with old key
            const [ivHex, encryptedHex] = client.businessEmail.split(':');
            const iv = Buffer.from(ivHex, 'hex');
            const oldKey = crypto.scryptSync(process.env.secret, 'salt', 32);
            const decipher = crypto.createDecipheriv('aes-256-cbc', oldKey, iv);
            let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            // Encrypt with new key
            const newIv = crypto.randomBytes(16);
            const newKey = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
            const cipher = crypto.createCipheriv('aes-256-cbc', newKey, newIv);
            let encrypted = cipher.update(decrypted, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            
            client.businessEmail = `${newIv.toString('hex')}:${encrypted}`;
            rotated = true;
            clientResult.actions.push('rotated:businessEmail');
          } catch (error) {
            console.error('Failed to rotate businessEmail:', error);
          }
        }

        // Check and rotate businessEmailPassword
        if (client.businessEmailPassword && client.businessEmailPassword.includes(':')) {
          try {
            const [ivHex, encryptedHex] = client.businessEmailPassword.split(':');
            const iv = Buffer.from(ivHex, 'hex');
            const oldKey = crypto.scryptSync(process.env.secret, 'salt', 32);
            const decipher = crypto.createDecipheriv('aes-256-cbc', oldKey, iv);
            let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
            decrypted += decipher.final('utf8');

            const newIv = crypto.randomBytes(16);
            const newKey = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
            const cipher = crypto.createCipheriv('aes-256-cbc', newKey, newIv);
            let encrypted = cipher.update(decrypted, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            
            client.businessEmailPassword = `${newIv.toString('hex')}:${encrypted}`;
            rotated = true;
            clientResult.actions.push('rotated:businessEmailPassword');
          } catch (error) {
            console.error('Failed to rotate businessEmailPassword:', error);
          }
        }

        if (rotated) {
          await client.save();
          results.rotated++;
        }
      }

      clientResult.status = 'success';
      results.details.push(clientResult);

    } catch (error) {
      results.failed++;
      results.details.push({
        clientID: client.clientID,
        companyName: client.companyName,
        status: 'failed',
        error: error.message
      });
    }
  }

  res.json({
    success: true,
    message: 'Full encryption setup completed',
    summary: {
      total: results.total,
      encrypted: results.encrypted,
      rotated: results.rotated,
      failed: results.failed
    },
    details: results.details
  });
}));

// Simple test to see what needs encryption
router.get('/debug/needs-encryption', requireAdmin, wrapRoute(async (req, res) => {
  const clients = await Client.find({});
  
  const needsEncryption = {
    total: clients.length,
    fieldsToEncrypt: {}
  };

  const fieldPaths = [
    'businessEmail',
    'businessEmailPassword',
    'ga4PropertyId',
    'analyticsConfig.googleAnalytics.measurementId',
    'analyticsConfig.googleAnalytics.apiSecret',
    'analyticsConfig.googleAnalytics.propertyId',
    'metaAds.pixelId',
    'metaAds.accessToken',
    'metaAds.testEventCode',
    'googleAds.conversionId',
    'googleAds.apiKey',
    'googleAds.developerToken',
    'googleAds.clientId',
    'googleAds.clientSecret',
    'googleAds.refreshToken',
    'googleAds.customerId',
    'googleAds.conversionActionId',
    'tiktokAds.pixelId',
    'tiktokAds.accessToken',
    'pinterestAds.adAccountId',
    'pinterestAds.accessToken'
  ];

  // Initialize counters
  fieldPaths.forEach(path => {
    needsEncryption.fieldsToEncrypt[path] = {
      total: 0,
      plaintext: 0,
      encrypted: 0,
      empty: 0,
      samples: []
    };
  });

  const getNestedValue = (obj, path) => {
    return path.split('.').reduce((current, key) => {
      return current && current[key] !== undefined ? current[key] : undefined;
    }, obj);
  };

  for (const client of clients) {
    for (const path of fieldPaths) {
      const value = getNestedValue(client, path);
      needsEncryption.fieldsToEncrypt[path].total++;
      
      if (!value) {
        needsEncryption.fieldsToEncrypt[path].empty++;
      } else if (typeof value === 'string' && value.includes(':')) {
        needsEncryption.fieldsToEncrypt[path].encrypted++;
      } else {
        needsEncryption.fieldsToEncrypt[path].plaintext++;
        if (needsEncryption.fieldsToEncrypt[path].samples.length < 3) {
          needsEncryption.fieldsToEncrypt[path].samples.push({
            client: client.clientID,
            value: String(value).substring(0, 20) + '...'
          });
        }
      }
    }
  }

  res.json({
    success: true,
    needsEncryption
  });
}));



/**
 * Verify encryption key status
 */
router.get('/debug/encryption-status', requireAdmin, wrapRoute(async (req, res) => {
  const { keys } = require('../helpers/encryption');
  
  // Test a sample client
  const sampleClient = await Client.findOne({
    $or: [
      { businessEmail: { $regex: /:/ } },
      { ga4PropertyId: { $regex: /:/ } }
    ]
  });

  let sampleTest = null;
  if (sampleClient) {
    const { canDecryptWithOldKey, canDecryptWithNewKey } = require('../helpers/encryption');
    
    sampleTest = {
      clientID: sampleClient.clientID,
      fields: {}
    };

    // Test businessEmail
    if (sampleClient.businessEmail && sampleClient.businessEmail.includes(':')) {
      sampleTest.fields.businessEmail = {
        canDecryptWithOld: canDecryptWithOldKey(sampleClient.businessEmail),
        canDecryptWithNew: canDecryptWithNewKey(sampleClient.businessEmail)
      };
    }
    
    // Test ga4PropertyId
    if (sampleClient.ga4PropertyId && sampleClient.ga4PropertyId.includes(':')) {
      sampleTest.fields.ga4PropertyId = {
        canDecryptWithOld: canDecryptWithOldKey(sampleClient.ga4PropertyId),
        canDecryptWithNew: canDecryptWithNewKey(sampleClient.ga4PropertyId)
      };
    }
  }

  res.json({
    success: true,
    encryptionKeys: keys,
    sampleTest,
    note: keys.migrationMode ? 'Migration mode active - both keys present' : 'Normal mode - only new key present'
  });
}));

/**
 * Test decryption with old key specifically
 */
router.post('/debug/test-old-key', requireAdmin, wrapRoute(async (req, res) => {
  const { encryptedValue } = req.body;
  
  if (!encryptedValue) {
    return res.status(400).json({ error: 'encryptedValue is required' });
  }

  const crypto = require('crypto');
  
  try {
    // Derive key from old secret
    const oldKeyBuffer = crypto.scryptSync(process.env.secret, 'salt', 32);
    
    const [ivHex, encryptedHex] = encryptedValue.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', oldKeyBuffer, iv);
    
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    res.json({
      success: true,
      message: 'Successfully decrypted with old key',
      decrypted
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Failed to decrypt with old key',
      details: error.message
    });
  }
}));

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
    ga4PropertyId,
    imapHost,
    imapPort,
    smtpHost,
    smtpPort,
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
      dashboard: false
    },
    deliveryOptions: deliveryOptions || [],
    emailSignature: emailSignature || '',
    imapHost: imapHost || '',
    imapPort: imapPort != null && imapPort !== '' ? Number(imapPort) : 993,
    smtpHost: smtpHost || '',
    smtpPort: smtpPort != null && smtpPort !== '' ? Number(smtpPort) : 587,
    ga4PropertyId: ga4PropertyId || '',
    analyticsConfig: {
      googleAnalytics: {
        measurementId: '',
        apiSecret: '',
        propertyId: ga4PropertyId || '',
        isEnabled: false
      }
    },
    // Initialize ad platforms with default values
    metaAds: {
      pixelId: '',
      accessToken: '',
      testEventCode: '',
      apiVersion: 'v18.0',
      enabled: false,
      status: 'inactive',
      errorMessage: ''
    },
    googleAds: {
      conversionId: '',
      apiKey: '',
      developerToken: '',
      clientId: '',
      clientSecret: '',
      refreshToken: '',
      customerId: '',
      conversionActionId: '',
      enabled: false,
      status: 'inactive',
      errorMessage: ''
    },
    tiktokAds: {
      pixelId: '',
      accessToken: '',
      enabled: false
    },
    pinterestAds: {
      adAccountId: '',
      accessToken: '',
      enabled: false
    },
    trackingSettings: {
      batchSize: 50,
      retryAttempts: 3,
      retryDelayMs: 5000,
      sendAnonymousEvents: true,
      sendAuthenticatedEvents: true,
      eventTypes: ['PAGE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART', 'INITIATE_CHECKOUT', 'PURCHASE', 'LEAD']
    },
    trackingStats: {
      eventsSent: 0,
      eventsFailed: 0,
      dailyQuota: 10000,
      monthlyQuota: 300000
    }
  });

  const savedClient = await newClient.save();
  
  // Remove sensitive data from response
  const clientResponse = savedClient.toObject();
  delete clientResponse.password;
  
  res.json({ client: clientResponse, token });
}));

// Get all clients
router.get('/', wrapRoute(async (req, res) => {
  const clients = await Client.find().select('-password -token -sessionToken');
  res.json({
    success: true,
    count: clients.length,
    clients
  });
}));

// Get client by ID
router.get('/:clientId', wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.params.clientId })
    .select('-password -token -sessionToken');
  
  if (!client) return res.status(404).json({ error: 'Client not found' });
  
  res.json({
    success: true,
    client
  });
}));

// Edit client details
router.put('/:clientId', wrapRoute(async (req, res) => {
  const updates = { ...req.body };
  
  // Hash password if provided
  if (updates.password) {
    updates.password = bcrypt.hashSync(updates.password, 10);
  }
  
  // Remove fields that shouldn't be updated directly
  delete updates._id;
  delete updates.clientID; // Don't allow changing clientID
  delete updates.token;
  delete updates.sessionToken;
  
  const updatedClient = await Client.findOneAndUpdate(
    { clientID: req.params.clientId }, 
    { $set: updates }, 
    { new: true }
  ).select('-password -token -sessionToken');
  
  if (!updatedClient) return res.status(404).json({ error: 'Client not found' });
  
  res.json({
    success: true,
    message: 'Client updated successfully',
    client: updatedClient
  });
}));

// Delete client
router.delete('/:clientId', wrapRoute(async (req, res) => {
  const client = await Client.findOneAndDelete({ clientID: req.params.clientId });
  
  if (!client) return res.status(404).json({ error: 'Client not found' });
  
  // Also delete related tracking events? Optional - depends on requirements
  // await TrackingEvent.deleteMany({ clientID: req.params.clientId });
  
  res.json({
    success: true,
    message: 'Client deleted successfully'
  });
}));

// Update client permissions including dashboard
router.put('/:clientId/permissions', wrapRoute(async (req, res) => {
  const { permissions } = req.body;
  
  const updatedClient = await Client.findOneAndUpdate(
    { clientID: req.params.clientId },
    { $set: { permissions } },
    { new: true }
  ).select('permissions');

  if (!updatedClient) return res.status(404).json({ error: 'Client not found' });

  res.json({ 
    success: true, 
    message: 'Permissions updated',
    permissions: updatedClient.permissions
  });
}));

// Get client permissions
router.get('/:clientId/permissions', wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.params.clientId })
    .select('permissions role');
  
  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({
    success: true,
    role: client.role,
    permissions: client.permissions,
    isAdmin: client.role === 'admin'
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
  ).select('analyticsConfig ga4PropertyId');

  if (!updatedClient) return res.status(404).json({ error: 'Client not found' });

  res.json({ 
    success: true, 
    message: 'Analytics configuration updated',
    analyticsConfig: updatedClient.analyticsConfig
  });
}));

// Get client analytics configuration
router.get('/:clientId/analytics/config', wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.params.clientId })
    .select('analyticsConfig ga4PropertyId');
  
  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({
    success: true,
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
    }, getJwtSecret(), { expiresIn: '1d' });

    if (client.isLoggedIn) {
      client.sessionToken = null;
      client.sessionExpires = null;
    }
    client.sessionToken = token;
    client.sessionExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    client.isLoggedIn = true;
    await client.save();

    // Remove sensitive data
    const clientResponse = client.toObject();
    delete clientResponse.password;
    delete clientResponse.token;

    res.status(200).send({
      success: true,
      client: clientResponse,
      token,
      permissions: {
        ...client.permissions,
        hasDashboardAccess: client.permissions?.dashboard || false
      },
      role: client.role,
      tier: client.tier,
      hasAdPlatforms: client.hasEnabledAdPlatforms,
      enabledAdPlatforms: client.getEnabledAdPlatforms()
    });
  } else {
    res.status(400).send('The user email and password are incorrect!');
  }
}));

// Client logout
router.post('/logout', wrapRoute(async (req, res) => {
  const token = req.headers.authorization.split(' ')[1];
  const { decoded } = verifyJwtWithAnySecret(jwt, token);
  const client = await Client.findOne({ clientID: decoded.clientID });
  if (!client) return res.status(400).send('Client not found');

  client.sessionToken = null;
  client.sessionExpires = null;
  client.isLoggedIn = false;
  await client.save();

  res.status(200).send({
    success: true,
    message: 'Logout successful'
  });
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

// --------------------
// AD INTEGRATION ROUTES
// --------------------

// Get client ad integration settings
router.get('/:clientId/ad-integrations', authenticateToken, wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.params.clientId })
    .select('metaAds googleAds tiktokAds pinterestAds trackingSettings trackingStats')
    .lean({ getters: true });
  
  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({
    success: true,
    metaAds: client.metaAds,
    googleAds: client.googleAds,
    tiktokAds: client.tiktokAds,
    pinterestAds: client.pinterestAds,
    trackingSettings: client.trackingSettings,
    trackingStats: client.trackingStats,
    hasEnabledPlatforms: client.hasEnabledAdPlatforms,
    enabledPlatforms: client.getEnabledAdPlatforms()
  });
}));

// Add this to your routes file temporarily
router.get('/debug/decrypted-values/:clientId', requireAdmin, wrapRoute(async (req, res) => {
  const crypto = require('crypto');
  const { decrypt } = require('../helpers/encryption');
  
  // Get the client document (not lean)
  const client = await Client.findOne({ clientID: req.params.clientId });
  
  if (!client) {
    return res.status(404).json({ error: 'Client not found' });
  }

  // Get raw data (without any transformations)
  const raw = client.toObject({ getters: false, virtuals: false });
  
  // Manually decrypt each field to see actual values
  const manuallyDecrypted = {};
  
  // Helper to decrypt a field
  const decryptField = (value) => {
    if (!value || typeof value !== 'string') return value;
    if (!value.includes(':')) return value; // Not encrypted
    
    try {
      return decrypt(value);
    } catch (e) {
      return `[DECRYPTION FAILED: ${e.message}]`;
    }
  };

  // Decrypt Meta fields
  if (raw.metaAds) {
    manuallyDecrypted.metaAds = {
      pixelId: decryptField(raw.metaAds.pixelId),
      accessToken: raw.metaAds.accessToken ? '[DECRYPTED - HIDDEN]' : null,
      testEventCode: decryptField(raw.metaAds.testEventCode),
      enabled: raw.metaAds.enabled,
      status: raw.metaAds.status
    };
  }

  // Decrypt Google fields
  if (raw.googleAds) {
    manuallyDecrypted.googleAds = {
      conversionId: decryptField(raw.googleAds.conversionId),
      apiKey: raw.googleAds.apiKey ? '[DECRYPTED - HIDDEN]' : null,
      customerId: decryptField(raw.googleAds.customerId)
    };
  }

  // Decrypt other fields
  manuallyDecrypted.businessEmail = decryptField(raw.businessEmail);
  manuallyDecrypted.businessEmailPassword = raw.businessEmailPassword ? '[DECRYPTED - HIDDEN]' : null;
  manuallyDecrypted.ga4PropertyId = decryptField(raw.ga4PropertyId);

  res.json({
    success: true,
    raw_encrypted: {
      metaAds: {
        pixelId: raw.metaAds?.pixelId ? 
          raw.metaAds.pixelId.substring(0, 20) + '...' : null,
        accessToken: raw.metaAds?.accessToken ? 'exists (encrypted)' : null,
        testEventCode: raw.metaAds?.testEventCode ? 
          raw.metaAds.testEventCode.substring(0, 20) + '...' : null,
        enabled: raw.metaAds?.enabled
      },
      googleAds: {
        conversionId: raw.googleAds?.conversionId ? 
          raw.googleAds.conversionId.substring(0, 20) + '...' : null,
        customerId: raw.googleAds?.customerId ? 
          raw.googleAds.customerId.substring(0, 20) + '...' : null
      },
      businessEmail: raw.businessEmail ? 
        raw.businessEmail.substring(0, 20) + '...' : null
    },
    manually_decrypted: manuallyDecrypted,
    what_you_should_see: {
      metaPixelId: "Should be just numbers (e.g., '1234567890') not containing ':'",
      testEventCode: "Should be 'TEST59103' or similar, not containing ':'",
      businessEmail: "Should be actual email like 'test@example.com'"
    },
    note: "If raw_encrypted shows values with ':' and manually_decrypted shows readable values, decryption is working. If manually_decrypted still shows ':', then decryption is failing."
  });
}));


// Update Meta Ads configuration
router.put('/:clientId/ad-integrations/meta', authenticateToken, wrapRoute(async (req, res) => {
  const { 
    pixelId, 
    accessToken, 
    testEventCode, 
    apiVersion,
    enabled,
    adAccountId,
    ownershipType,
    metaBusinessId,
    partnerRequestId,
  } = req.body;

  const updateData = {
    'metaAds.pixelId': pixelId || '',
    'metaAds.accessToken': accessToken || '',
    'metaAds.testEventCode': testEventCode || '',
    'metaAds.apiVersion': apiVersion || 'v18.0',
    'metaAds.enabled': enabled === true,
    'metaAds.lastSync': new Date(),
    'metaAds.status': enabled ? 'active' : 'inactive',
    'metaAds.errorMessage': ''
  };

  if (adAccountId !== undefined) {
    updateData['metaAds.adAccountId'] = String(adAccountId).trim().replace(/^act_/i, '');
  }
  if (ownershipType !== undefined) {
    updateData['metaAds.ownershipType'] = ownershipType === 'client' ? 'client' : 'agency';
  }
  if (metaBusinessId !== undefined) {
    updateData['metaAds.metaBusinessId'] = String(metaBusinessId || '').trim();
  }
  if (partnerRequestId !== undefined) {
    updateData['metaAds.partnerRequestId'] = String(partnerRequestId || '').trim();
  }

  // Validate configuration if enabling
  if (enabled && pixelId && accessToken) {
    try {
      const validation = await metaService.validatePixel(pixelId, accessToken);
      if (!validation.valid) {
        updateData['metaAds.status'] = 'error';
        updateData['metaAds.errorMessage'] = validation.error || 'Invalid configuration';
      }
    } catch (error) {
      updateData['metaAds.status'] = 'error';
      updateData['metaAds.errorMessage'] = error.message;
    }
  }

  const client = await Client.findOneAndUpdate(
    { clientID: req.params.clientId },
    { $set: updateData },
    { new: true }
  ).select('metaAds');

  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({
    success: true,
    message: 'Meta Ads configuration updated',
    metaAds: client.metaAds
  });
}));

// Update Google Ads configuration
router.put('/:clientId/ad-integrations/google', authenticateToken, wrapRoute(async (req, res) => {
  const { 
    conversionId,
    apiKey,
    developerToken,
    clientId,
    clientSecret,
    refreshToken,
    customerId,
    conversionActionId,
    enabled 
  } = req.body;

  const updateData = {
    'googleAds.conversionId': conversionId || '',
    'googleAds.apiKey': apiKey || '',
    'googleAds.developerToken': developerToken || '',
    'googleAds.clientId': clientId || '',
    'googleAds.clientSecret': clientSecret || '',
    'googleAds.refreshToken': refreshToken || '',
    'googleAds.customerId': customerId || '',
    'googleAds.conversionActionId': conversionActionId || '',
    'googleAds.enabled': enabled === true,
    'googleAds.lastSync': new Date(),
    'googleAds.status': enabled ? 'active' : 'inactive',
    'googleAds.errorMessage': ''
  };

  // Validate configuration if enabling
  if (enabled && conversionId) {
    try {
      const validation = await googleService.validateConversion(conversionId, apiKey);
      if (!validation.valid) {
        updateData['googleAds.status'] = 'error';
        updateData['googleAds.errorMessage'] = validation.error || 'Invalid configuration';
      }
    } catch (error) {
      updateData['googleAds.status'] = 'error';
      updateData['googleAds.errorMessage'] = error.message;
    }
  }

  const client = await Client.findOneAndUpdate(
    { clientID: req.params.clientId },
    { $set: updateData },
    { new: true }
  ).select('googleAds');

  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({
    success: true,
    message: 'Google Ads configuration updated',
    googleAds: client.googleAds
  });
}));

// Update TikTok Ads configuration (for future expansion)
router.put('/:clientId/ad-integrations/tiktok', authenticateToken, wrapRoute(async (req, res) => {
  const { pixelId, accessToken, enabled } = req.body;

  const updateData = {
    'tiktokAds.pixelId': pixelId || '',
    'tiktokAds.accessToken': accessToken || '',
    'tiktokAds.enabled': enabled === true
  };

  const client = await Client.findOneAndUpdate(
    { clientID: req.params.clientId },
    { $set: updateData },
    { new: true }
  ).select('tiktokAds');

  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({
    success: true,
    message: 'TikTok Ads configuration updated',
    tiktokAds: client.tiktokAds
  });
}));

// Update Pinterest Ads configuration (for future expansion)
router.put('/:clientId/ad-integrations/pinterest', authenticateToken, wrapRoute(async (req, res) => {
  const { adAccountId, accessToken, enabled } = req.body;

  const updateData = {
    'pinterestAds.adAccountId': adAccountId || '',
    'pinterestAds.accessToken': accessToken || '',
    'pinterestAds.enabled': enabled === true
  };

  const client = await Client.findOneAndUpdate(
    { clientID: req.params.clientId },
    { $set: updateData },
    { new: true }
  ).select('pinterestAds');

  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({
    success: true,
    message: 'Pinterest Ads configuration updated',
    pinterestAds: client.pinterestAds
  });
}));

// Update tracking settings
router.put('/:clientId/tracking-settings', authenticateToken, wrapRoute(async (req, res) => {
  const { 
    batchSize,
    retryAttempts,
    retryDelayMs,
    sendAnonymousEvents,
    sendAuthenticatedEvents,
    eventTypes 
  } = req.body;

  // Validate inputs
  if (batchSize && (batchSize < 1 || batchSize > 100)) {
    return res.status(400).json({ error: 'batchSize must be between 1 and 100' });
  }
  
  if (retryAttempts && (retryAttempts < 1 || retryAttempts > 10)) {
    return res.status(400).json({ error: 'retryAttempts must be between 1 and 10' });
  }
  
  if (retryDelayMs && (retryDelayMs < 1000 || retryDelayMs > 60000)) {
    return res.status(400).json({ error: 'retryDelayMs must be between 1000 and 60000' });
  }

  const updateData = {};
  if (batchSize !== undefined) updateData['trackingSettings.batchSize'] = batchSize;
  if (retryAttempts !== undefined) updateData['trackingSettings.retryAttempts'] = retryAttempts;
  if (retryDelayMs !== undefined) updateData['trackingSettings.retryDelayMs'] = retryDelayMs;
  if (sendAnonymousEvents !== undefined) updateData['trackingSettings.sendAnonymousEvents'] = sendAnonymousEvents;
  if (sendAuthenticatedEvents !== undefined) updateData['trackingSettings.sendAuthenticatedEvents'] = sendAuthenticatedEvents;
  if (eventTypes !== undefined) updateData['trackingSettings.eventTypes'] = eventTypes;

  const client = await Client.findOneAndUpdate(
    { clientID: req.params.clientId },
    { $set: updateData },
    { new: true }
  ).select('trackingSettings');

  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({
    success: true,
    message: 'Tracking settings updated',
    trackingSettings: client.trackingSettings
  });
}));

// Test Meta connection
router.post('/:clientId/ad-integrations/meta/test', authenticateToken, wrapRoute(async (req, res) => {
  const { pixelId, accessToken } = req.body;
  
  if (!pixelId || !accessToken) {
    return res.status(400).json({ 
      success: false, 
      error: 'pixelId and accessToken are required' 
    });
  }
  
  try {
    const result = await metaService.validatePixel(pixelId, accessToken);
    
    res.json({
      success: result.valid,
      ...result
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}));

// Test Google connection
router.post('/:clientId/ad-integrations/google/test', authenticateToken, wrapRoute(async (req, res) => {
  const { conversionId, apiKey } = req.body;
  
  if (!conversionId) {
    return res.status(400).json({ 
      success: false, 
      error: 'conversionId is required' 
    });
  }
  
  try {
    const result = await googleService.validateConversion(conversionId, apiKey);
    
    res.json({
      success: result.valid,
      ...result
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
}));

// Get ad integration stats and performance
router.get('/:clientId/ad-integrations/stats', authenticateToken, wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.params.clientId });
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Get recent event stats (last 7 days)
  const last7Days = new Date();
  last7Days.setDate(last7Days.getDate() - 7);

  const eventStats = await TrackingEvent.aggregate([
    {
      $match: {
        clientID: req.params.clientId,
        timestamp: { $gte: last7Days }
      }
    },
    {
      $group: {
        _id: {
          deliveryStatus: '$deliveryStatus',
          eventType: '$eventType'
        },
        count: { $sum: 1 },
        avgProcessingTime: { 
          $avg: { 
            $cond: [
              { $and: ['$processedAt', '$timestamp'] },
              { $subtract: ['$processedAt', '$timestamp'] },
              null
            ]
          }
        }
      }
    },
    {
      $sort: { '_id.deliveryStatus': 1, '_id.eventType': 1 }
    }
  ]);

  // Get daily breakdown
  const dailyStats = await TrackingEvent.aggregate([
    {
      $match: {
        clientID: req.params.clientId,
        timestamp: { $gte: last7Days }
      }
    },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          platform: '$deliveryStatus'
        },
        count: { $sum: 1 }
      }
    },
    {
      $sort: { '_id.date': -1 }
    }
  ]);

  const platformStats = {
    meta: {
      configured: !!(client.metaAds?.pixelId && client.metaAds?.accessToken),
      enabled: client.metaAds?.enabled || false,
      status: client.metaAds?.status || 'inactive',
      lastSync: client.metaAds?.lastSync,
      errorMessage: client.metaAds?.errorMessage
    },
    google: {
      configured: !!(client.googleAds?.conversionId),
      enabled: client.googleAds?.enabled || false,
      status: client.googleAds?.status || 'inactive',
      lastSync: client.googleAds?.lastSync,
      errorMessage: client.googleAds?.errorMessage
    }
  };

  res.json({
    success: true,
    trackingStats: client.trackingStats,
    platformStats,
    eventStats,
    dailyStats,
    hasEnabledPlatforms: client.hasEnabledAdPlatforms,
    enabledPlatforms: client.getEnabledAdPlatforms()
  });
}));

// Bulk enable/disable ad platforms
router.post('/:clientId/ad-integrations/bulk-update', authenticateToken, wrapRoute(async (req, res) => {
  const { platforms } = req.body; // e.g., { meta: true, google: false }

  const updateData = {};
  const validationErrors = [];
  
  // Get current client to validate before updating
  const client = await Client.findOne({ clientID: req.params.clientId });
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Process Meta
  if (platforms.meta !== undefined) {
    if (platforms.meta && !client.metaAds?.pixelId) {
      validationErrors.push('Cannot enable Meta Ads: pixelId not configured');
    } else {
      updateData['metaAds.enabled'] = platforms.meta;
      updateData['metaAds.status'] = platforms.meta ? 'active' : 'inactive';
      updateData['metaAds.lastSync'] = new Date();
    }
  }
  
  // Process Google
  if (platforms.google !== undefined) {
    if (platforms.google && !client.googleAds?.conversionId) {
      validationErrors.push('Cannot enable Google Ads: conversionId not configured');
    } else {
      updateData['googleAds.enabled'] = platforms.google;
      updateData['googleAds.status'] = platforms.google ? 'active' : 'inactive';
      updateData['googleAds.lastSync'] = new Date();
    }
  }

  // If there are validation errors, return them
  if (validationErrors.length > 0) {
    return res.status(400).json({
      success: false,
      errors: validationErrors
    });
  }

  // Only update if there are changes
  if (Object.keys(updateData).length === 0) {
    return res.json({
      success: true,
      message: 'No changes to apply',
      metaEnabled: client.metaAds.enabled,
      googleEnabled: client.googleAds.enabled
    });
  }

  const updatedClient = await Client.findOneAndUpdate(
    { clientID: req.params.clientId },
    { $set: updateData },
    { new: true }
  );

  res.json({
    success: true,
    message: 'Ad platforms updated',
    metaEnabled: updatedClient.metaAds.enabled,
    googleEnabled: updatedClient.googleAds.enabled,
    metaStatus: updatedClient.metaAds.status,
    googleStatus: updatedClient.googleAds.status
  });
}));

// Get event delivery logs for a client
router.get('/:clientId/event-logs', authenticateToken, wrapRoute(async (req, res) => {
  const { 
    limit = 100, 
    page = 1,
    status,
    eventType,
    startDate,
    endDate 
  } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  
  // Build query
  const query = { clientID: req.params.clientId };
  
  if (status) {
    query.deliveryStatus = status;
  }
  
  if (eventType) {
    query.eventType = eventType;
  }
  
  if (startDate || endDate) {
    query.timestamp = {};
    if (startDate) query.timestamp.$gte = new Date(startDate);
    if (endDate) query.timestamp.$lte = new Date(endDate);
  }

  const [events, total] = await Promise.all([
    TrackingEvent.find(query)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .select('eventType timestamp deliveryStatus deliveryErrors metadata processedAt'),
    TrackingEvent.countDocuments(query)
  ]);

  res.json({
    success: true,
    events,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  });
}));

// Reset tracking stats for a client
router.post('/:clientId/reset-stats', authenticateToken, wrapRoute(async (req, res) => {
  // Check if user is admin
  const token = req.headers.authorization?.split(' ')[1];
  const { decoded } = verifyJwtWithAnySecret(jwt, token);
  const adminClient = await Client.findOne({ clientID: decoded.clientID });
  
  if (adminClient.role !== 'admin') {
    return res.status(403).json({ error: 'Only admins can reset stats' });
  }

  const client = await Client.findOneAndUpdate(
    { clientID: req.params.clientId },
    {
      $set: {
        'trackingStats.eventsSent': 0,
        'trackingStats.eventsFailed': 0,
        'trackingStats.lastEventSent': null
      }
    },
    { new: true }
  ).select('trackingStats');

  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({
    success: true,
    message: 'Tracking stats reset successfully',
    trackingStats: client.trackingStats
  });
}));

// --------------------
// ENCRYPTION TESTING ENDPOINTS (Admin only)
// --------------------

// Test encryption (admin only)
router.get('/:clientId/test-encryption', requireAdmin, wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.params.clientId })
    .lean(); // Use lean() to bypass getters and see raw data

  const clientWithGetters = await Client.findOne({ clientID: req.params.clientId });

  if (!client) return res.status(404).json({ error: 'Client not found' });

  res.json({
    success: true,
    raw_data: {
      businessEmail: client.businessEmail,
      businessEmailPassword: client.businessEmailPassword,
      ga4PropertyId: client.ga4PropertyId,
      metaPixelId: client.metaAds?.pixelId,
      metaAccessToken: client.metaAds?.accessToken,
      googleConversionId: client.googleAds?.conversionId,
      googleApiKey: client.googleAds?.apiKey,
      googleRefreshToken: client.googleAds?.refreshToken
    },
    decrypted_data: {
      businessEmail: clientWithGetters.businessEmail,
      businessEmailPassword: clientWithGetters.businessEmailPassword,
      ga4PropertyId: clientWithGetters.ga4PropertyId,
      metaPixelId: clientWithGetters.metaAds?.pixelId,
      metaAccessToken: clientWithGetters.metaAds?.accessToken,
      googleConversionId: clientWithGetters.googleAds?.conversionId,
      googleApiKey: clientWithGetters.googleAds?.apiKey,
      googleRefreshToken: clientWithGetters.googleAds?.refreshToken
    }
  });
}));

// Manual decrypt endpoint (admin only) - for debugging
router.post('/debug/decrypt', requireAdmin, wrapRoute(async (req, res) => {
  const { encryptedValue } = req.body;
  
  if (!encryptedValue) {
    return res.status(400).json({ error: 'encryptedValue is required' });
  }

  try {
    const decrypted = decrypt(encryptedValue);
    res.json({
      success: true,
      encrypted: encryptedValue,
      decrypted: decrypted
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Decryption failed',
      details: error.message
    });
  }
}));

// Manual encrypt endpoint (admin only) - for debugging
router.post('/debug/encrypt', requireAdmin, wrapRoute(async (req, res) => {
  const { value } = req.body;
  
  if (!value) {
    return res.status(400).json({ error: 'value is required' });
  }

  try {
    const encrypted = encrypt(value);
    res.json({
      success: true,
      original: value,
      encrypted: encrypted
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Encryption failed',
      details: error.message
    });
  }
}));

module.exports = router;