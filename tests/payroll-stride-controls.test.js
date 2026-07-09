const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const payrollApi = read('server/payroll.js');
const payrollUi = read('public/js/payroll.js');
const payrollStrideDoc = read('docs/stride/payroll-management-stride.md');
const server = read('server.js');
const { PAYROLL_ROUTE_RATE_LIMITS, findPayrollRateLimit } = require('../server/payroll-rate-limits');

assert(
  payrollApi.includes("const { verifyPassword } = require('../services/passwordService');"),
  'Payroll step-up authentication must use the shared Argon2id password verifier.'
);
assert(
  /const PAYROLL_STEP_UP_STATUSES = new Set\(\['Approved', 'Released', 'Locked', 'Paid'\]\)/.test(payrollApi),
  'Payroll approval, release, lock, and paid actions must require step-up authentication.'
);
assert(
  /router\.post\('\/salary-calculation', requireAuth, requireRole\(ROLES\.payroll_any\)/.test(payrollApi)
    && /router\.post\('\/generate', requireAuth, requireRole\(ROLES\.payroll_any\)/.test(payrollApi),
  'Payroll Officer and Payroll Manager must both be allowed to process/compute payroll through payroll_any routes.'
);
assert(
  payrollApi.indexOf('verifyPayrollStepUpPassword(pool, req)') < payrollApi.indexOf('connection = await pool.getConnection();'),
  'Payroll step-up authentication must run before status-changing transaction work starts.'
);
assert(
  payrollApi.includes('blocked_payroll_step_up_authentication_failed'),
  'Failed payroll step-up authentication must be audited as a blocked security event.'
);
assert(
  payrollApi.includes('payroll_step_up_authentication_verified'),
  'Successful payroll step-up authentication must be represented in the payroll audit trail.'
);
assert(
  payrollUi.includes('type="password"') && payrollUi.includes('body.currentPassword = currentPassword;'),
  'Payroll UI must collect a masked current password and submit it as currentPassword.'
);
assert(
  payrollStrideDoc.includes('| Spoofing |') && payrollStrideDoc.includes('Backend step-up authentication'),
  'Payroll STRIDE evidence must document the Spoofing mitigation.'
);
assert(
  payrollStrideDoc.includes('Payroll Manager may process or compute payroll'),
  'Payroll STRIDE evidence must state that Payroll Manager can process/compute before final approval.'
);
assert(
  /const \{ createPayrollRouteRateLimiter \}\s*=/.test(server)
    && /const PAYROLL_ROUTE_RATE_LIMIT = createPayrollRouteRateLimiter\(\)/.test(server),
  'Payroll module must use the dedicated audited route rate limiter.'
);
assert(
  /app\.use\(\['\/api\/payroll', '\/api\/blockchain\/payroll'\], PAYROLL_ROUTE_RATE_LIMIT\)/.test(server),
  'Payroll and blockchain payroll APIs must be protected by the dedicated payroll limiter.'
);
assert(
  PAYROLL_ROUTE_RATE_LIMITS.length >= 50
    && PAYROLL_ROUTE_RATE_LIMITS.every(limit => /^\/api\/(?:payroll|blockchain\/payroll)\//.test(limit.path)),
  'Payroll limiter table must explicitly cover payroll and blockchain payroll routes only.'
);

[
  ['GET', '/api/payroll/dashboard'],
  ['POST', '/api/payroll/generate'],
  ['PATCH', '/api/payroll/salary-calculations/:id/status'],
  ['PATCH', '/api/payroll/runs/:id/approve'],
  ['POST', '/api/payroll/employees/:id/government-contributions/reveal'],
  ['GET', '/api/payroll/reports/:report.:format'],
  ['POST', '/api/blockchain/payroll/finalize/:payrollId'],
  ['GET', '/api/blockchain/payroll/verify/:payrollId'],
].forEach(([method, routePath]) => {
  assert(
    PAYROLL_ROUTE_RATE_LIMITS.some(limit => limit.method === method && limit.path === routePath),
    `${method} ${routePath} must have an explicit payroll route rate limit.`
  );
});

const dashboardLimit = findPayrollRateLimit({ method: 'GET', originalUrl: '/api/payroll/dashboard', headers: {}, socket: {} });
const generateLimit = findPayrollRateLimit({ method: 'POST', originalUrl: '/api/payroll/generate', headers: {}, socket: {} });
const approveLimit = findPayrollRateLimit({ method: 'PATCH', originalUrl: '/api/payroll/runs/12/approve', headers: {}, socket: {} });
const blockchainFinalizeLimit = findPayrollRateLimit({ method: 'POST', originalUrl: '/api/blockchain/payroll/finalize/12', headers: {}, socket: {} });
assert(
  dashboardLimit.max > generateLimit.max && generateLimit.max > approveLimit.max && approveLimit.max > blockchainFinalizeLimit.max,
  'Payroll limits must become stricter as endpoint criticality increases.'
);

console.log('Payroll STRIDE controls: PASS');
