const crypto = require('crypto');
const { encryptAES256, decryptAES256, encryptPII, decryptPII } = require('./crypto');

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || '').trim().toLowerCase())
    .digest('hex');
}

function nullableText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function encryptNullable(value) {
  const text = nullableText(value);
  return text ? encryptAES256(text) : null;
}

function decryptNullable(value) {
  if (!value) return null;
  return decryptAES256(value);
}

function isEncryptedValue(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 3
    && /^[0-9a-f]{32}$/i.test(parts[0])
    && /^[0-9a-f]{32}$/i.test(parts[1])
    && /^[0-9a-f]+$/i.test(parts[2]);
}

function encryptColumnValue(value) {
  const text = nullableText(value);
  if (!text) return null;
  return isEncryptedValue(text) ? text : encryptAES256(text);
}

function decryptColumnValue(value) {
  const text = nullableText(value);
  if (!text) return null;
  return isEncryptedValue(text) ? decryptAES256(text) : text;
}

function hashNullable(value) {
  const text = nullableText(value);
  return text ? sha256(text) : null;
}

module.exports = {
  decryptColumnValue,
  decryptNullable,
  decryptPII,
  encryptColumnValue,
  encryptNullable,
  encryptPII,
  hashNullable,
  isEncryptedValue,
  nullableText,
  sha256,
};
