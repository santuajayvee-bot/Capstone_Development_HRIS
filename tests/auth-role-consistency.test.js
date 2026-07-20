'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { normalizeRole } = require('../server/utils/role-normalization');
const { normalizeRole: middlewareNormalizeRole } = require('../server/middleware');
const { normalizeRoleName } = require('../controllers/authController');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function makeResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
    clone() { return this; },
  };
}

function createClient() {
  const storage = new Map();
  const nodes = new Map();
  const classNames = new Set();
  const node = () => ({
    innerHTML: '',
    textContent: '',
    className: '',
    style: {},
    hidden: false,
    children: [],
    classList: { contains() { return false; } },
    replaceChildren(...children) { this.children = children; },
    setAttribute() {},
    removeAttribute() {},
  });
  const document = {
    body: {
      dataset: {},
      classList: {
        add(value) { classNames.add(value); },
        remove(value) { classNames.delete(value); },
        forEach(callback) { [...classNames].forEach(callback); },
      },
    },
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node());
      return nodes.get(id);
    },
    createElement() { return node(); },
    addEventListener() {},
  };
  let identity = null;
  const context = {
    console,
    Promise,
    FormData: class FormData {},
    URL,
    setTimeout() { return 1; },
    clearTimeout() {},
    setInterval() { return 1; },
    clearInterval() {},
    document,
    sessionStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    fetch: async url => {
      if (String(url).includes('/api/auth/me')) return makeResponse({ user: identity });
      return makeResponse({}, 404);
    },
  };
  context.window = {
    ...context,
    location: { hostname: 'localhost', port: '3000', protocol: 'http:' },
  };
  vm.runInNewContext(read('public/js/auth.js'), context, { filename: 'auth.js' });
  return {
    context,
    nodes,
    setIdentity(value) { identity = value; },
    storedUser() { return JSON.parse(storage.get('vp_user')); },
  };
}

for (const [input, expected] of [
  ['hr_admin', 'hr_manager'],
  ['hradmin', 'hr_manager'],
  ['hr', 'hr_manager'],
  ['hr_manager', 'hr_manager'],
  ['manager', 'hr_manager'],
  ['employee', 'employee'],
]) {
  assert.strictEqual(normalizeRole(input), expected, 'Canonical role mismatch for ' + input);
  assert.strictEqual(middlewareNormalizeRole(input), expected, 'Middleware role mismatch for ' + input);
  assert.strictEqual(normalizeRoleName(input), expected, 'Login role mismatch for ' + input);
}

const client = createClient();
assert.strictEqual(client.context.normalizeClientRole('hr_admin'), 'hr_manager');
assert.strictEqual(client.context.normalizeClientRole('hradmin'), 'hr_manager');
assert.strictEqual(client.context.normalizeClientRole('hr'), 'hr_manager');
assert.strictEqual(client.context.normalizeClientRole('hr_manager'), 'hr_manager');
assert.strictEqual(client.context.normalizeClientRole('manager'), 'hr_manager');

const hrAdmin = client.context.saveAuth('token', {
  id: 11,
  username: 'hr-admin',
  role: 'hr_admin',
  sourceRole: 'hr_admin',
  roleLabel: 'HR Admin (Level 2)',
}, 'session-binding');
assert.strictEqual(hrAdmin.role, 'hr_manager');
assert.strictEqual(client.context.getUser().role, 'hr_manager');
assert.strictEqual(client.context.canAccess('performance'), true);
client.context.buildSidebar(hrAdmin);
assert(client.nodes.get('nav-items').innerHTML.includes('Performance'));
assert.strictEqual(client.nodes.get('role-badge').textContent, 'HR Admin (Level 2)');

client.setIdentity({
  id: 11,
  username: 'hr-admin',
  role: 'hr_admin',
  sourceRole: 'hr_admin',
  roleLabel: 'HR Admin (Level 2)',
});
(async () => {
  const refreshedHrAdmin = await client.context.refreshAuthenticatedIdentity();
  assert.strictEqual(refreshedHrAdmin.role, 'hr_manager');
  assert.strictEqual(refreshedHrAdmin.sourceRole, 'hr_manager');
  assert.strictEqual(client.storedUser().role, 'hr_manager');
  client.context.buildSidebar(refreshedHrAdmin);
  assert(client.nodes.get('nav-items').innerHTML.includes('Performance'), 'HR Admin must see Performance immediately and after identity refresh.');

  const hrManager = client.context.saveAuth('token', {
    id: 12,
    username: 'hr-manager',
    role: 'hr_manager',
    sourceRole: 'hr_manager',
    roleLabel: 'HR Manager (Level 2)',
  }, 'session-binding');
  client.context.buildSidebar(hrManager);
  assert.strictEqual(client.context.canAccess('performance'), true);
  assert(client.nodes.get('nav-items').innerHTML.includes('Performance'));
  assert.strictEqual(client.nodes.get('role-badge').textContent, 'HR Manager (Level 2)');

  const employee = client.context.saveAuth('token', {
    id: 13,
    username: 'employee',
    role: 'employee',
    sourceRole: 'employee',
    roleLabel: 'Regular Employee (Level 1)',
  }, 'session-binding');
  client.context.buildSidebar(employee);
  assert.strictEqual(client.context.getUser().role, 'employee');
  assert.strictEqual(client.context.canAccess('performance'), true);
  assert(client.nodes.get('nav-items').innerHTML.includes('My Performance'));

  const server = read('server.js');
  const legacyAuth = read('server/auth.js');
  assert(server.includes("app.use('/api/auth', authRoutes)"), 'Active login routes must use authController.');
  assert(server.includes("app.get('/api/auth/me', requireAuth, me)"), 'Authenticated identity must use database-backed middleware.');
  assert(legacyAuth.includes("require('./utils/role-normalization')"), 'Legacy auth must use the canonical normalizer if it is ever mounted.');
  assert(legacyAuth.includes('const effectiveRole = normalizeRole(user.role || user.role_name);'), 'Legacy auth must use the shared HR-role equivalence policy.');

  console.log('Authentication role consistency tests: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
