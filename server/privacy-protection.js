const { encryptColumnValue, decryptColumnValue, isEncryptedValue } = require('./data-protection');

const ENCRYPTED_STORAGE_KEY = /(^|_)(encrypted|ciphertext)(_|$)|encrypted_(file_)?path/i;

function maskSensitiveValue(value, visibleEnd = 4) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (text.length <= visibleEnd) return '*'.repeat(Math.max(text.length, 4));
  return `${'*'.repeat(Math.max(text.length - visibleEnd, 4))}${text.slice(-visibleEnd)}`;
}

function encryptAuditValue(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return encryptColumnValue(text);
}

function decryptAuditValue(value) {
  return value ? decryptColumnValue(value) : null;
}

function sanitizeStorageCiphertext(value, state, key = '') {
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value) || value instanceof Date) return value;
  if (typeof value === 'string') {
    if (isEncryptedValue(value)) {
      state.blocked += 1;
      return null;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeStorageCiphertext(item, state));
  if (typeof value !== 'object') return value;

  const safe = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (ENCRYPTED_STORAGE_KEY.test(entryKey)) {
      state.blocked += entryValue == null ? 0 : 1;
      continue;
    }
    safe[entryKey] = sanitizeStorageCiphertext(entryValue, state, entryKey);
  }
  return safe;
}

function preventStorageCiphertextResponses(req, res, next) {
  if (!req.originalUrl.startsWith('/api/')) return next();
  const originalJson = res.json.bind(res);
  res.json = body => {
    const state = { blocked: 0 };
    const safeBody = sanitizeStorageCiphertext(body, state);
    if (state.blocked) {
      console.warn('[privacy] Blocked encrypted storage values from API response.', {
        path: req.originalUrl.split('?')[0],
        count: state.blocked,
      });
    }
    return originalJson(safeBody);
  };
  next();
}

module.exports = {
  decryptAuditValue,
  encryptAuditValue,
  maskSensitiveValue,
  preventStorageCiphertextResponses,
  sanitizeStorageCiphertext,
};
