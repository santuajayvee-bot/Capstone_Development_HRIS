process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-only-jwt-secret-that-is-longer-than-thirty-two-characters';

const assert = require('assert');
const {
  deviceMetadata,
  fingerprintHash,
} = require('../services/trustedDeviceService');

const req = {
  headers: {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
    'x-forwarded-for': '203.0.113.10',
  },
};

const fingerprintA = {
  timezone: 'Asia/Singapore',
  language: 'en-US',
  screenSize: '1920x1080x24',
  platform: 'Win32',
};

const fingerprintB = {
  platform: 'Win32',
  screenSize: '1920x1080x24',
  language: 'en-US',
  timezone: 'Asia/Singapore',
};

const hashA = fingerprintHash(7, fingerprintA, req);
const hashB = fingerprintHash(7, fingerprintB, req);

assert.match(hashA, /^[a-f0-9]{64}$/);
assert.strictEqual(hashA, hashB, 'fingerprint hash should be stable regardless of object key order');
assert.notStrictEqual(hashA, fingerprintA.screenSize, 'raw fingerprint values must not be returned as hashes');

const metadata = deviceMetadata(fingerprintA, req);
assert.strictEqual(metadata.browser, 'Chrome');
assert.strictEqual(metadata.operatingSystem, 'Windows');
assert.strictEqual(metadata.deviceType, 'Desktop');
assert.strictEqual(metadata.ipAddress, '203.0.113.10');

console.log('Trusted devices tests: PASS');
