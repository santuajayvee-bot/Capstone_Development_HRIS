const assert = require('assert');
const crypto = require('crypto');

const {
  decryptAES256,
  encryptAES256,
} = require('../server/crypto');

const originalEnv = {
  AES_ENCRYPTION_KEY: process.env.AES_ENCRYPTION_KEY,
  AES_256_SECRET_KEY: process.env.AES_256_SECRET_KEY,
  JWT_SECRET: process.env.JWT_SECRET,
};

function restoreEnv() {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

try {
  const primaryHexKey = crypto.randomBytes(32).toString('hex');
  const legacyBase64Key = crypto.randomBytes(32).toString('base64');

  delete process.env.AES_ENCRYPTION_KEY;
  delete process.env.AES_256_SECRET_KEY;
  process.env.JWT_SECRET = 'legacy-jwt-secret-used-before-dedicated-aes-key';
  const jwtEncrypted = encryptAES256('JWT legacy employee name');

  delete process.env.AES_ENCRYPTION_KEY;
  process.env.AES_256_SECRET_KEY = legacyBase64Key;
  process.env.JWT_SECRET = 'different-jwt-secret-after-key-rotation';
  const base64Encrypted = encryptAES256('Base64 legacy employee name');

  process.env.AES_ENCRYPTION_KEY = primaryHexKey;
  process.env.AES_256_SECRET_KEY = legacyBase64Key;
  process.env.JWT_SECRET = 'legacy-jwt-secret-used-before-dedicated-aes-key';

  assert.strictEqual(decryptAES256(jwtEncrypted), 'JWT legacy employee name');
  assert.strictEqual(decryptAES256(base64Encrypted), 'Base64 legacy employee name');

  const primaryEncrypted = encryptAES256('Primary employee name');
  assert.strictEqual(decryptAES256(primaryEncrypted), 'Primary employee name');

  console.log('Crypto key fallback checks passed.');
} finally {
  restoreEnv();
}
