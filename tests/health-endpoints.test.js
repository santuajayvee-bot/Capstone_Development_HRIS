'use strict';

const assert = require('assert');
const { createHealthHandlers } = require('../server/health-endpoints');

function response() {
  return {
    headers: {},
    statusCode: null,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

async function run() {
  let queried = 0;
  let released = 0;
  const handlers = createHealthHandlers({
    poolProvider: () => ({
      async getConnection() {
        return {
          async execute(sql) { queried += 1; assert.strictEqual(sql, 'SELECT 1 AS ok'); return [[{ ok: 1 }]]; },
          release() { released += 1; },
        };
      },
    }),
    encryptColumnValue: () => '0123456789abcdef0123456789abcdef:0123456789abcdef0123456789abcdef:abcd',
    isEncryptedValue: () => true,
    environment: { JWT_SECRET: 'configured', AES_ENCRYPTION_KEY: 'configured' },
    now: () => new Date('2026-07-21T00:00:00.000Z'),
    logger: { warn() {} },
  });

  const live = response();
  handlers.live({}, live);
  assert.strictEqual(live.statusCode, 200);
  assert.deepStrictEqual(live.body, { status: 'alive', timestamp: '2026-07-21T00:00:00.000Z' });
  assert.strictEqual(queried, 0, 'Liveness must not query critical dependencies.');

  const ready = response();
  await handlers.ready({}, ready);
  assert.strictEqual(ready.statusCode, 200);
  assert.deepStrictEqual(ready.body, { status: 'ready', timestamp: '2026-07-21T00:00:00.000Z' });
  assert.strictEqual(queried, 1);
  assert.strictEqual(released, 1);

  const unavailable = createHealthHandlers({
    poolProvider: () => ({ async getConnection() { throw new Error('connection string should not be exposed'); } }),
    encryptColumnValue: () => 'ignored',
    isEncryptedValue: () => true,
    environment: { JWT_SECRET: 'configured', AES_ENCRYPTION_KEY: 'configured' },
    logger: { warn() {} },
  });
  const unavailableResponse = response();
  await unavailable.ready({}, unavailableResponse);
  assert.strictEqual(unavailableResponse.statusCode, 503);
  assert.deepStrictEqual(unavailableResponse.body.status, 'not_ready');
  assert(!JSON.stringify(unavailableResponse.body).includes('connection string'));

  console.log('Public liveness/readiness endpoint tests: PASS');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
