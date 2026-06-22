/*
 * AES-256-GCM utility for sensitive off-chain communication.
 *
 * Objective supported:
 * "To safeguard employee, HR, and payroll data from unauthorized exposure by
 * using AES-256 encryption for off-chain communication between client, partner,
 * and system."
 *
 * The shared key is read only from the backend environment. Never expose
 * AES_256_SECRET_KEY to browser JavaScript or commit it to source control.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;
const KEY_ENV_NAME = 'AES_256_SECRET_KEY';

class EncryptionConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EncryptionConfigurationError';
  }
}

class EncryptedPayloadError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EncryptedPayloadError';
  }
}

function decodeBase64(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new EncryptedPayloadError(`${label} must be a non-empty base64 string.`);
  }

  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new EncryptedPayloadError(`${label} must be base64 encoded.`);
  }

  return Buffer.from(normalized, 'base64');
}

function getAes256Key() {
  const configuredKey = process.env[KEY_ENV_NAME];
  if (!configuredKey) {
    throw new EncryptionConfigurationError(`${KEY_ENV_NAME} is not configured.`);
  }

  const key = decodeBase64(configuredKey, KEY_ENV_NAME);
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new EncryptionConfigurationError(`${KEY_ENV_NAME} must decode to exactly 32 bytes / 256 bits.`);
  }

  return key;
}

function normalizePayload(encryptedPayload) {
  const payload = encryptedPayload?.encryptedPayload || encryptedPayload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new EncryptedPayloadError('Encrypted payload must be an object.');
  }

  return {
    iv: decodeBase64(payload.iv, 'iv'),
    encryptedData: decodeBase64(payload.encryptedData, 'encryptedData'),
    authTag: decodeBase64(payload.authTag, 'authTag'),
  };
}

function serializeSensitiveData(data) {
  return Buffer.from(JSON.stringify(data), 'utf8');
}

function parseSensitiveData(buffer) {
  const text = buffer.toString('utf8');
  return JSON.parse(text);
}

function encryptSensitiveData(data) {
  const key = getAes256Key();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });

  const encrypted = Buffer.concat([
    cipher.update(serializeSensitiveData(data)),
    cipher.final(),
  ]);

  return {
    iv: iv.toString('base64'),
    encryptedData: encrypted.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  };
}

function decryptSensitiveData(encryptedPayload) {
  const key = getAes256Key();
  const { iv, encryptedData, authTag } = normalizePayload(encryptedPayload);

  if (iv.length !== IV_LENGTH_BYTES) {
    throw new EncryptedPayloadError('AES-GCM iv must be 12 bytes.');
  }
  if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new EncryptedPayloadError('AES-GCM authTag must be 16 bytes.');
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encryptedData),
    decipher.final(),
  ]);

  return parseSensitiveData(decrypted);
}

module.exports = {
  ALGORITHM,
  AUTH_TAG_LENGTH_BYTES,
  IV_LENGTH_BYTES,
  KEY_ENV_NAME,
  encryptSensitiveData,
  decryptSensitiveData,
  EncryptionConfigurationError,
  EncryptedPayloadError,
};
