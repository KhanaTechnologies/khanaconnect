// scripts/rotate-encryption-key.js
const mongoose = require('mongoose');
const Client = require('../models/client');
const { encrypt, decrypt } = require('../helpers/encryption');
require('dotenv').config();

// Store the OLD key temporarily
const OLD_ENCRYPTION_KEY = process.env.OLD_ENCRYPTION_KEY;
// The NEW key should already be set in ENCRYPTION_KEY

async function rotateEncryptionKey() {
  if (!OLD_ENCRYPTION_KEY) {
    console.error('OLD_ENCRYPTION_KEY environment variable is required');
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Temporarily override the encryption helper to use old key for decryption
    process.env.ENCRYPTION_KEY = OLD_ENCRYPTION_KEY;
    
    const clients = await Client.find({});
    console.log(`Found ${clients.length} clients to process`);

    for (const client of clients) {
      let modified = false;
      const updates = {};

      // Function to check if field is encrypted and decrypt with old key
      const processField = (fieldValue) => {
        if (fieldValue && typeof fieldValue === 'string' && fieldValue.includes(':')) {
          // This will use the old key (currently in ENCRYPTION_KEY)
          return decrypt(fieldValue);
        }
        return fieldValue;
      };

      // Process each encrypted field
      if (client.businessEmail) {
        const decrypted = processField(client.businessEmail);
        if (decrypted !== client.businessEmail) {
          updates.businessEmail = decrypted;
          modified = true;
        }
      }

      if (client.businessEmailPassword) {
        const decrypted = processField(client.businessEmailPassword);
        if (decrypted !== client.businessEmailPassword) {
          updates.businessEmailPassword = decrypted;
          modified = true;
        }
      }

      if (client.ga4PropertyId) {
        const decrypted = processField(client.ga4PropertyId);
        if (decrypted !== client.ga4PropertyId) {
          updates.ga4PropertyId = decrypted;
          modified = true;
        }
      }

      // Process nested fields similarly...

      if (modified) {
        // Now switch to new key for encryption
        process.env.ENCRYPTION_KEY = process.env.NEW_ENCRYPTION_KEY;
        
        // Update the client with decrypted values (they'll be re-encrypted with new key on save)
        Object.assign(client, updates);
        await client.save();
        
        console.log(`Rotated encryption key for client: ${client.clientID}`);
      }
    }

    console.log('Key rotation completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('Key rotation failed:', error);
    process.exit(1);
  }
}

rotateEncryptionKey();