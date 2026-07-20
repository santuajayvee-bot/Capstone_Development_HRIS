'use strict';

const assert = require('assert');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const path = require('path');
const vm = require('vm');
const { generateSessionBindingSecret, hashSessionBindingSecret } = require('../services/tokenService');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'performance-session-binding-test-secret-with-sufficient-length';

function installModule(relativePath, exports) {
  const resolved = require.resolve(relativePath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

let activeRole = 'hr_manager';
let revokeCount = 0;
const securityEvents = [];
const databaseCalls = [];
const activeBinding = generateSessionBindingSecret();
const sessionJwtId = 'performance-session-test-jti';

const mockPool = {
  async execute(sql) {
    databaseCalls.push(sql);
    if (sql.startsWith('SHOW COLUMNS FROM users')) return [[{ Field: 'present' }]];
    if (sql.includes('FROM users u') && sql.includes('LEFT JOIN USER_SESSION s')) {
      return [[{
        user_id: 71,
        username: 'performance-test-user',
        employee_table_id: 51,
        Employee_ID: 5101,
        is_active: 1,
        role_id: 2,
        role_name: activeRole,
        role_label: activeRole,
        access_level: activeRole === 'employee' ? 1 : 3,
        employee_status: 'Active',
        account_status: 'Active',
        token_version: 0,
        force_password_change: 0,
        password_changed_at: null,
        Session_ID: 901,
        Session_Binding_Hash: hashSessionBindingSecret(activeBinding),
        Revoked_At: null,
        Expires_At: new Date(Date.now() + 60 * 60 * 1000),
      }]];
    }
    if (sql.includes('SELECT password_hash FROM users')) return [[{ password_hash: 'not-a-valid-argon2-hash' }]];
    if (sql.includes('FROM performance_reviews') && sql.includes('SUM(status =')) {
      return [[{ total: 0, in_progress: 0, finalized: 0, passed: 0, needs_follow_up: 0 }]];
    }
    if (sql.includes('FROM performance_cycles')) return [[]];
    throw new Error(`Unexpected test query: ${sql}`);
  },
};

installModule('../config/db', mockPool);
installModule('../db/authQueries', {
  async revokeSessionByJwtId() { revokeCount += 1; },
});
installModule('../server/security-controls', {
  async auditSecurityEvent(_req, event) { securityEvents.push(event); },
});
installModule('../server/users', {
  async getUserPermissions() { return []; },
  async getLinkedEmployeeProfile() { return null; },
});
installModule('../server/dpa-service', {
  async hasAcceptedCurrentDpa() { return true; },
  getCurrentDpaVersion() { return 'test'; },
  async auditDpaEvent() {},
});

const { requireAuth } = require('../server/middleware');
const performanceRouter = require('../server/performance-management');

function accessToken() {
  return jwt.sign({
    id: 71,
    username: 'performance-test-user',
    employeeId: 51,
    tokenVersion: 0,
    jti: sessionJwtId,
  }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' });
}

function invokeAuth(binding) {
  return new Promise(resolve => {
    const req = {
      method: 'GET',
      originalUrl: '/api/performance/overview',
      headers: { authorization: `Bearer ${accessToken()}` },
      get(name) { return this.headers[String(name).toLowerCase()]; },
    };
    if (binding !== undefined) req.headers['x-session-binding'] = binding;
    const result = { next: false, statusCode: null, body: null, req };
    const res = {
      status(code) { result.statusCode = code; return this; },
      json(body) { result.body = body; resolve(result); return this; },
    };
    requireAuth(req, res, () => {
      result.next = true;
      resolve(result);
    });
  });
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    clone() { return this; },
  };
}

function createPerformanceClient() {
  const nodes = new Map();
  const node = () => ({
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    disabled: false,
    classList: { contains() { return false; } },
    toggleAttribute(name, force) { if (name === 'hidden') this.hidden = Boolean(force); },
    setAttribute() {},
    removeAttribute() {},
    replaceChildren(...children) { this.children = children; this.textContent = children.map(child => child?.textContent || '').join(''); },
  });
  const requests = [];
  let clearAuthCalls = 0;
  let directFetchCalls = 0;
  const context = {
    console,
    Promise,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    alert() {},
    confirm() { return true; },
    URL: {
      createObjectURL() { return 'blob:performance-test'; },
      revokeObjectURL() {},
    },
    document: {
      body: { dataset: { activePage: 'performance' } },
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, node());
        return nodes.get(id);
      },
      createTextNode(text) { return { textContent: String(text) }; },
      createElement() { return { src: '', alt: '' }; },
    },
    getUser: () => ({ role: context.role }),
    clearAuth: () => { clearAuthCalls += 1; },
    fetch: async () => { directFetchCalls += 1; throw new Error('Direct fetch must not be used by Performance.'); },
    apiFetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url.includes('/photo')) {
        return { ok: true, status: 200, async blob() { return { type: 'image/png' }; } };
      }
      if (url.endsWith('/overview')) return response({ summary: {}, cycles: [] });
      if (url.startsWith('/api/performance/reviews')) return response({ items: [], pagination: { page: 1, page_size: 10, total_items: 0, total_pages: 1 } });
      return response([]);
    },
    role: 'hr_manager',
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public/js/performance.js'), 'utf8'), context, { filename: 'performance.js' });
  return { context, requests, nodes, clearAuthCalls: () => clearAuthCalls, directFetchCalls: () => directFetchCalls };
}

async function invokeStepUpRoute(pathname, body) {
  const routeLayer = performanceRouter.stack.find(layer => layer.route?.path === pathname);
  assert(routeLayer, `Expected ${pathname} route.`);
  const handler = routeLayer.route.stack.at(-1).handle;
  const result = { statusCode: null, body: null };
  const req = {
    params: { reviewId: '44' },
    body,
    user: { id: 71, sourceRole: 'hr_manager' },
    headers: {},
    originalUrl: `/api/performance${pathname.replace(':reviewId', '44')}`,
  };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(payload) { result.body = payload; return this; },
  };
  await handler(req, res);
  return result;
}

async function invokeOverview(req) {
  const routeLayer = performanceRouter.stack.find(layer => layer.route?.path === '/overview');
  assert(routeLayer, 'Expected Performance overview route.');
  const handler = routeLayer.route.stack.at(-1).handle;
  const result = { statusCode: null, body: null };
  const res = {
    status(code) { result.statusCode = code; return this; },
    json(payload) { result.statusCode = result.statusCode || 200; result.body = payload; return this; },
  };
  await handler(req, res);
  return result;
}

(async () => {
  // Real requireAuth execution: the Performance route's first middleware sees
  // a valid bound session and forwards the request instead of returning 401.
  activeRole = 'hr_manager';
  revokeCount = 0;
  let result = await invokeAuth(activeBinding);
  assert.strictEqual(result.next, true);
  assert.strictEqual(result.statusCode, null);
  assert.strictEqual(result.req.user.sourceRole, 'hr_manager');
  assert.strictEqual(revokeCount, 0, 'A valid Performance request must keep the session active.');
  const managerOverview = await invokeOverview(result.req);
  assert.strictEqual(managerOverview.statusCode, 200, 'A valid bound request must reach the real Performance overview handler.');

  result = await invokeAuth();
  assert.strictEqual(result.statusCode, 401);
  assert.strictEqual(result.body.code, 'SESSION_BINDING_MISMATCH');
  assert.strictEqual(revokeCount, 1, 'Missing binding must retain the existing revocation policy.');

  result = await invokeAuth('wrong-performance-session-binding');
  assert.strictEqual(result.statusCode, 401);
  assert.strictEqual(result.body.code, 'SESSION_BINDING_MISMATCH');
  assert.strictEqual(revokeCount, 2, 'Incorrect binding must retain the existing revocation policy.');
  assert(securityEvents.some(event => event.action === 'blocked_session_binding_mismatch'));

  activeRole = 'employee';
  result = await invokeAuth(activeBinding);
  assert.strictEqual(result.next, true, 'A valid regular-employee session must reach Performance access checks.');
  assert.strictEqual(result.req.user.sourceRole, 'employee');
  const employeeOverview = await invokeOverview(result.req);
  assert.strictEqual(employeeOverview.statusCode, 200, 'A valid employee request must reach the real Performance overview handler.');

  // A wrong step-up password is operation denial, not primary-session expiry.
  revokeCount = 0;
  const finalize = await invokeStepUpRoute('/reviews/:reviewId/finalize', { currentPassword: 'WrongPassword!1', version: 1 });
  assert.strictEqual(finalize.statusCode, 403);
  assert.strictEqual(finalize.body.code, 'PERFORMANCE_STEP_UP_FAILED');
  const reopen = await invokeStepUpRoute('/reviews/:reviewId/reopen', { reason: 'Correct data entry', currentPassword: 'WrongPassword!1', version: 1 });
  assert.strictEqual(reopen.statusCode, 403);
  assert.strictEqual(reopen.body.code, 'PERFORMANCE_STEP_UP_FAILED');
  assert.strictEqual(revokeCount, 0, 'Wrong step-up passwords must not revoke the primary session.');
  assert(securityEvents.some(event => event.action === 'performance_step_up_authentication_failed'));
  assert(securityEvents.some(event => event.action === 'performance_reopen_step_up_authentication_failed'));
  assert(!databaseCalls.some(sql => /UPDATE performance_reviews/i.test(sql)), 'Wrong step-up passwords must not finalize or reopen a review.');

  // Browser behavior: all initial protected requests use apiFetch, which owns
  // both the bearer token and X-Session-Binding header, and no logout happens.
  const client = createPerformanceClient();
  const firstInit = client.context.initPerformanceManagement();
  const secondInit = client.context.initPerformanceManagement();
  await Promise.all([firstInit, secondInit]);
  const managerPaths = client.requests.map(item => item.url);
  for (const expected of ['/api/performance/overview', '/api/performance/eligible-employees', '/api/performance/departments']) {
    assert(managerPaths.includes(expected), `Expected initial Performance request: ${expected}`);
  }
  assert(managerPaths.some(url => url.startsWith('/api/performance/reviews?')));
  assert.strictEqual(managerPaths.length, 4, 'Concurrent initialization must not duplicate initial requests.');
  assert(client.requests.every(item => item.options.cache === 'no-store'));
  assert.strictEqual(client.directFetchCalls(), 0);
  assert.strictEqual(client.clearAuthCalls(), 0);

  await client.context.hydratePerformanceEmployeePhoto({ employee_record_id: 77, employee_name: 'Regular Employee' });
  assert(client.requests.some(item => item.url === '/api/employees/77/photo'));
  assert.strictEqual(client.directFetchCalls(), 0);
  assert.strictEqual(client.clearAuthCalls(), 0);

  client.context.role = 'employee';
  client.requests.length = 0;
  await client.context.initPerformanceManagement();
  const employeePaths = client.requests.map(item => item.url);
  assert(employeePaths.includes('/api/performance/overview'));
  assert(employeePaths.some(url => url.startsWith('/api/performance/reviews?')));
  assert(!employeePaths.includes('/api/performance/eligible-employees'));
  assert(!employeePaths.includes('/api/performance/departments'));

  client.context.apiFetch = async () => response({ error: 'Current password verification failed.', code: 'PERFORMANCE_STEP_UP_FAILED' }, 403);
  await assert.rejects(
    () => client.context.performanceApi('/reviews/44/finalize'),
    error => error.code === 'PERFORMANCE_STEP_UP_FAILED' && error.status === 403
  );
  assert.strictEqual(client.clearAuthCalls(), 0, 'A 403 step-up failure must not clear browser authentication.');

  console.log('Performance session-binding and step-up regression tests: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
