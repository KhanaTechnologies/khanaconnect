const crypto = require('crypto');

// Get encryption keys from environment variables
const OLD_ENCRYPTION_KEY = process.env.secret; // Old key (might not be 32 bytes)
const NEW_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY; // New key (should be 32 bytes hex)

const IV_LENGTH = 16; // For AES, this is always 16

if (!NEW_ENCRYPTION_KEY) {
  console.error('ENCRYPTION_KEY environment variable is required');
  process.exit(1);
}

// Ensure the new key is the correct length (32 bytes for AES-256)
const newKeyBuffer = Buffer.from(NEW_ENCRYPTION_KEY, 'hex');
if (newKeyBuffer.length !== 32) {
  console.error('ENCRYPTION_KEY must be 32 bytes (64 hex characters)');
  process.exit(1);
}

// Derive a proper 32-byte key from the old secret using scrypt
let oldKeyBuffer = null;
if (OLD_ENCRYPTION_KEY) {
  // Derive a 32-byte key from the old secret
  oldKeyBuffer = crypto.scryptSync(OLD_ENCRYPTION_KEY, 'salt', 32);
}

/**
 * Check if a value appears to be encrypted (has the : delimiter)
 */
function isEncrypted(value) {
  return value && typeof value === 'string' && value.includes(':');
}

/**
 * Encrypt text using AES-256-CBC with the new key
 * @param {string} text - Text to encrypt
 * @returns {string} Encrypted text in format: iv:encrypted
 */
function encrypt(text) {
  if (!text) return text;
  
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', newKeyBuffer, iv);
  
  let encrypted = cipher.update(text.toString(), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  return `${iv.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt text using either old or new key
 * @param {string} text - Encrypted text in format: iv:encrypted
 * @returns {string} Decrypted text
 */
function decrypt(text) {
  if (!text || typeof text !== 'string') return text;
  
  // Check if the text is in encrypted format (contains iv:encrypted)
  if (!text.includes(':')) return text;
  
  const [ivHex, encryptedHex] = text.split(':');
  
  // Try with new key first
  try {
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', newKeyBuffer, iv);
    
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    // If new key fails and old key exists, try with old key
    if (oldKeyBuffer) {
      try {
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', oldKeyBuffer, iv);
        
        let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
      } catch (oldError) {
        // If both fail, log and return original
        console.error('Decryption error with both keys:', error.message);
        return text;
      }
    }
    
    console.error('Decryption error with new key:', error.message);
    return text;
  }
}

/**
 * Re-encrypt a value from old key to new key
 */
function reEncrypt(encryptedValue) {
  if (!encryptedValue || !isEncrypted(encryptedValue)) {
    return encrypt(encryptedValue); // Encrypt if not already encrypted
  }
  
  try {
    // First try to decrypt with old key (for existing encrypted data)
    let decrypted = null;
    
    if (oldKeyBuffer) {
      try {
        const [ivHex, encryptedHex] = encryptedValue.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', oldKeyBuffer, iv);
        
        decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
      } catch (oldError) {
        // If old key fails, try with new key (might already be encrypted with new key)
        decrypted = decrypt(encryptedValue);
      }
    } else {
      // If no old key, just decrypt normally
      decrypted = decrypt(encryptedValue);
    }
    
    // If decryption succeeded, re-encrypt with new key
    if (decrypted && decrypted !== encryptedValue) {
      return encrypt(decrypted);
    }
    
    return encryptedValue; // Return original if decryption failed
  } catch (error) {
    console.error('Re-encryption failed:', error);
    return encryptedValue; // Return original on failure
  }
}

/**
 * Verify that a value can be decrypted with the new key
 */
function canDecryptWithNewKey(encryptedValue) {
  if (!encryptedValue || !isEncrypted(encryptedValue)) return false;
  
  try {
    const [ivHex, encryptedHex] = encryptedValue.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', newKeyBuffer, iv);
    
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Verify that a value can be decrypted with the old key
 */
function canDecryptWithOldKey(encryptedValue) {
  if (!encryptedValue || !isEncrypted(encryptedValue) || !oldKeyBuffer) return false;
  
  try {
    const [ivHex, encryptedHex] = encryptedValue.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-cbc', oldKeyBuffer, iv);
    
    let decrypted = decipher.update(encryptedHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Check if we're in migration mode (both keys present)
 */
function isMigrationMode() {
  return !!OLD_ENCRYPTION_KEY && !!NEW_ENCRYPTION_KEY;
}

module.exports = { 
  encrypt, 
  decrypt, 
  reEncrypt,
  isEncrypted,
  canDecryptWithNewKey,
  canDecryptWithOldKey,
  isMigrationMode,
  // Export key status for debugging
  keys: {
    oldKeyPresent: !!OLD_ENCRYPTION_KEY,
    newKeyPresent: !!NEW_ENCRYPTION_KEY,
    migrationMode: !!(OLD_ENCRYPTION_KEY && NEW_ENCRYPTION_KEY)
  }
};