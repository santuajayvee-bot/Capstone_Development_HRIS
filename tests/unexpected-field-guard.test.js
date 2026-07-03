const assert = require('assert');
process.env.NODE_ENV = 'test';
const pool = require('../config/db');
pool.execute = async () => [{ insertId: 1 }];
const { rejectUnexpectedFields } = require('../server/security-controls');

const middleware = rejectUnexpectedFields(new Set(['role', 'base_rate']), {
  action: 'test_unexpected_field',
  module: 'TEST_SECURITY',
});

let nextCalled = false;
middleware({ body: { role: 'Driver', base_rate: '750.00' } }, {}, () => {
  nextCalled = true;
});
assert.strictEqual(nextCalled, true, 'Allowed fields must reach the route handler.');

let statusCode = null;
let responseBody = null;
middleware({
  body: { role: 'Driver', gross_pay: '999999' },
  params: {},
  originalUrl: '/api/payroll/logistics/rates',
  method: 'POST',
  headers: {},
}, {
  status(code) {
    statusCode = code;
    return this;
  },
  json(body) {
    responseBody = body;
    return this;
  },
}, () => {
  throw new Error('Unexpected fields must not reach the route handler.');
});

assert.strictEqual(statusCode, 403);
assert.deepStrictEqual(responseBody, { error: 'Request contains unauthorized fields.' });

console.log('Unexpected request field guard tests: PASS');
