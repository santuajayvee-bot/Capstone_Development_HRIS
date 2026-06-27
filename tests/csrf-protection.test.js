const assert = require('assert');

process.env.NODE_ENV = 'test';
process.env.APP_PUBLIC_URL = 'https://lgsvhr.com';

const { requireSameOriginForBrowserWrites } = require('../server/security-controls');

function runRequest({ method = 'POST', headers = {} } = {}) {
  let nextCalled = false;
  let response = null;
  const req = {
    method,
    headers,
    protocol: 'https',
    secure: true,
    originalUrl: '/api/employees',
  };
  const res = {
    status(code) {
      response = { code };
      return this;
    },
    json(payload) {
      response.payload = payload;
      return payload;
    },
  };

  requireSameOriginForBrowserWrites(req, res, () => { nextCalled = true; });
  return { nextCalled, response };
}

assert.strictEqual(runRequest({
  headers: { host: 'lgsvhr.com', origin: 'https://lgsvhr.com', 'sec-fetch-site': 'same-origin' },
}).nextCalled, true);

assert.strictEqual(runRequest({
  headers: { host: 'internal:3000', origin: 'https://lgsvhr.com', 'x-forwarded-proto': 'https' },
}).nextCalled, true);

const crossOrigin = runRequest({
  headers: { host: 'lgsvhr.com', origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
});
assert.strictEqual(crossOrigin.response.code, 403);
assert.strictEqual(crossOrigin.response.payload.error, 'Cross-site request blocked.');

assert.strictEqual(runRequest({
  headers: { host: 'lgsvhr.com', 'sec-fetch-site': 'cross-site' },
}).response.code, 403);

assert.strictEqual(runRequest({
  headers: { host: 'lgsvhr.com' },
}).nextCalled, true);

assert.strictEqual(runRequest({
  method: 'GET',
  headers: { host: 'lgsvhr.com', origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
}).nextCalled, true);

console.log('CSRF origin protection tests: PASS');

require('../config/db').end();
