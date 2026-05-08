/* ============================================================
   server/crypto.js — AES-256-GCM Encryption Utility
   ISO/IEC 27001 Compliant PII Protection Layer
   ============================================================
   
   Uses AES-256-GCM (Galois/Counter Mode) for authenticated
   encryption. Each encryption produces a unique IV and auth tag,
   ensuring semantic security (identical plaintexts produce 
   different ciphertexts).
   
   Environment Variable Required:
     AES_ENCRYPTION_KEY — 64-character hex string (256 bits)
     If not set, a deterministic key is derived from JWT_SECRET
     using PBKDF2 (for development convenience only).
   ============================================================ */

const crypto = require('crypto');

const ALGORITHM   = 'aes-256-gcm';
const IV_LENGTH   = 16;   // 128-bit IV for GCM
const TAG_LENGTH  = 16;   // 128-bit authentication tag
const ENCODING    = 'hex';

/**
 * Derive the 256-bit encryption key.
 * Priority: AES_ENCRYPTION_KEY env var > derived from JWT_SECRET.
 * @returns {Buffer} 32-byte key
 */
function getEncryptionKey() {
  if (process.env.AES_ENCRYPTION_KEY) {
    const key = Buffer.from(process.env.AES_ENCRYPTION_KEY, 'hex');
    if (key.length !== 32) {
      throw new Error('AES_ENCRYPTION_KEY must be exactly 64 hex characters (256 bits).');
    }
    return key;
  }

  // Fallback: derive from JWT_SECRET using PBKDF2 (development only)
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('Neither AES_ENCRYPTION_KEY nor JWT_SECRET is set. Cannot derive encryption key.');
  }

  return crypto.pbkdf2Sync(secret, 'lgsv-hr-pii-salt', 100000, 32, 'sha512');
}

/**
 * Encrypt plaintext using AES-256-GCM.
 * Returns: iv:authTag:ciphertext (hex-encoded, colon-delimited)
 * @param {string} plaintext — the data to encrypt
 * @returns {string} encrypted payload
 */
function encryptAES256(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('encryptAES256: plaintext must be a non-empty string.');
  }

  const key = getEncryptionKey();
  const iv  = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  let encrypted = cipher.update(plaintext, 'utf8', ENCODING);
  encrypted += cipher.final(ENCODING);

  const authTag = cipher.getAuthTag().toString(ENCODING);

  // Format: iv:authTag:ciphertext
  return `${iv.toString(ENCODING)}:${authTag}:${encrypted}`;
}

/**
 * Decrypt an AES-256-GCM payload.
 * @param {string} encryptedPayload — iv:authTag:ciphertext
 * @returns {string} decrypted plaintext
 */
function decryptAES256(encryptedPayload) {
  if (!encryptedPayload || typeof encryptedPayload !== 'string') {
    throw new Error('decryptAES256: encryptedPayload must be a non-empty string.');
  }

  const parts = encryptedPayload.split(':');
  if (parts.length !== 3) {
    throw new Error('decryptAES256: Invalid payload format. Expected iv:authTag:ciphertext.');
  }

  const [ivHex, authTagHex, ciphertext] = parts;
  const key     = getEncryptionKey();
  const iv      = Buffer.from(ivHex, ENCODING);
  const authTag = Buffer.from(authTagHex, ENCODING);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(ciphertext, ENCODING, 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Encrypt a JSON object containing PII fields.
 * @param {object} piiData — e.g. { sss_number, tin, bank_account, ... }
 * @returns {string} encrypted payload string
 */
function encryptPII(piiData) {
  const jsonString = JSON.stringify(piiData);
  return encryptAES256(jsonString);
}

/**
 * Decrypt an encrypted PII payload back to a JSON object.
 * @param {string} encryptedPayload 
 * @returns {object} decrypted PII fields
 */
function decryptPII(encryptedPayload) {
  const jsonString = decryptAES256(encryptedPayload);
  return JSON.parse(jsonString);
}

module.exports = {
  encryptAES256,
  decryptAES256,
  encryptPII,
  decryptPII,
};
