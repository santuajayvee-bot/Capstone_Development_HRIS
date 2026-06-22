const assert = require('assert');

process.env.NODE_ENV = 'test';

const payrollRouter = require('../server/payroll');
const { requireAuth } = require('../server/middleware');

function runMiddleware(middleware, req) {
  let response = null;
  let nextCalled = false;
  const res = {
    status(code) {
      response = { code };
      return this;
    },
    json(payload) {
      response = response || {};
      response.payload = payload;
      return payload;
    },
  };

  return Promise.resolve(middleware(req, res, () => { nextCalled = true; }))
    .then(() => ({ response, nextCalled }));
}

function findRoute(router, method, path) {
  return router.stack.find(layer => layer.route
    && layer.route.path === path
    && layer.route.methods[method]);
}

(async () => {
  const unauthenticated = await runMiddleware(requireAuth, {
    headers: {},
    originalUrl: '/api/payroll/piece-rates',
    socket: {},
  });

  assert.strictEqual(unauthenticated.nextCalled, false);
  assert.strictEqual(unauthenticated.response.code, 401);
  assert.strictEqual(unauthenticated.response.payload.error, 'No token provided.');

  const route = findRoute(payrollRouter, 'post', '/piece-rates');
  assert.ok(route, 'POST /piece-rates route should exist.');

  const handlers = route.route.stack.map(layer => layer.handle);
  assert.strictEqual(handlers[0], requireAuth, 'POST /piece-rates must authenticate before any handler runs.');
  assert.ok(handlers.length >= 4, 'POST /piece-rates should include auth, role, tamper guard, and handler.');

  console.log('Payroll piece-rate auth tests: PASS');
})()
  .finally(() => require('../config/db').end());
