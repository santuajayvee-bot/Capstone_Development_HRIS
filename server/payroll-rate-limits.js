const crypto = require('crypto');

const ONE_MINUTE = 60_000;
const FIVE_MINUTES = 5 * ONE_MINUTE;
const TEN_MINUTES = 10 * ONE_MINUTE;

function escapeRegexSegment(segment) {
  return String(segment).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function routePattern(path) {
  const pattern = String(path).split('/').map(segment => {
    if (segment === '*') return '.*';
    if (segment.startsWith(':')) return '[^/]+';
    return escapeRegexSegment(segment);
  }).join('/');
  return new RegExp(`^${pattern}$`);
}

function routeLimit(method, path, max, options = {}) {
  return {
    id: `${method} ${path}`,
    method,
    path,
    pattern: routePattern(path),
    max,
    windowMs: options.windowMs || ONE_MINUTE,
    criticality: options.criticality || 'standard',
    description: options.description || '',
  };
}

const PAYROLL_ROUTE_RATE_LIMITS = [
  routeLimit('GET', '/api/payroll/dashboard', 180, { criticality: 'view', description: 'Payroll dashboard metrics' }),
  routeLimit('GET', '/api/payroll/runs', 120, { criticality: 'view', description: 'Payroll run list' }),
  routeLimit('GET', '/api/payroll/registry', 120, { criticality: 'view', description: 'Payroll registry list' }),
  routeLimit('GET', '/api/payroll/salary-calculations', 120, { criticality: 'view', description: 'Salary calculation list' }),
  routeLimit('GET', '/api/payroll/payroll-records/:monthYear', 90, { criticality: 'view', description: 'Payroll records by period' }),
  routeLimit('GET', '/api/payroll/audit', 60, { criticality: 'audit-view', description: 'Payroll audit trail' }),
  routeLimit('GET', '/api/payroll/payslips', 60, { criticality: 'sensitive-view', description: 'Payslip list' }),
  routeLimit('GET', '/api/payroll/salary-calculations/:id/payslip', 30, { criticality: 'sensitive-view', description: 'Payslip detail' }),
  routeLimit('GET', '/api/payroll/salary-calculations/:id/payslip.pdf', 20, { criticality: 'sensitive-view', description: 'Payslip PDF download' }),
  routeLimit('GET', '/api/payroll/employees/:id/readonly', 60, { criticality: 'sensitive-view', description: 'Payroll employee profile view' }),
  routeLimit('GET', '/api/payroll/employees/:id/government-contributions', 40, { criticality: 'sensitive-view', description: 'Masked government contribution view' }),
  routeLimit('GET', '/api/payroll/employee-deductions', 60, { criticality: 'sensitive-view', description: 'Employee deduction list' }),

  routeLimit('POST', '/api/payroll/employees/:id/government-contributions/reveal', 8, { windowMs: FIVE_MINUTES, criticality: 'secret-reveal', description: 'Reveal encrypted government identifiers' }),
  routeLimit('POST', '/api/payroll/employee-deductions/:id/reveal-remarks', 8, { windowMs: FIVE_MINUTES, criticality: 'secret-reveal', description: 'Reveal encrypted deduction remarks' }),

  routeLimit('POST', '/api/payroll/runs', 15, { windowMs: FIVE_MINUTES, criticality: 'compute-write', description: 'Create payroll run' }),
  routeLimit('POST', '/api/payroll/salary-calculation', 20, { windowMs: FIVE_MINUTES, criticality: 'compute-write', description: 'Draft salary calculation' }),
  routeLimit('POST', '/api/payroll/generate/preview', 20, { windowMs: FIVE_MINUTES, criticality: 'compute-write', description: 'Payroll generation preview' }),
  routeLimit('POST', '/api/payroll/generate', 12, { windowMs: FIVE_MINUTES, criticality: 'compute-write', description: 'Generate payroll records' }),
  routeLimit('POST', '/api/payroll/salary-calculations/:id/recalculate', 10, { windowMs: FIVE_MINUTES, criticality: 'compute-write', description: 'Recalculate salary calculation' }),
  routeLimit('POST', '/api/payroll/piece-payroll-register/generate', 12, { windowMs: FIVE_MINUTES, criticality: 'compute-write', description: 'Generate piece payroll register' }),
  routeLimit('POST', '/api/payroll/swr-fxr-sum/generate', 10, { windowMs: FIVE_MINUTES, criticality: 'compute-write', description: 'Generate SWR-FXR-SUM registry' }),

  routeLimit('PATCH', '/api/payroll/runs/:id/approve', 6, { windowMs: FIVE_MINUTES, criticality: 'approval', description: 'Approve payroll run' }),
  routeLimit('PATCH', '/api/payroll/salary-calculations/:id/status', 8, { windowMs: FIVE_MINUTES, criticality: 'approval', description: 'Update salary calculation status' }),
  routeLimit('POST', '/api/payroll/convert-calculations-to-payslips', 6, { windowMs: FIVE_MINUTES, criticality: 'approval', description: 'Release payslips from calculations' }),
  routeLimit('PATCH', '/api/payroll/final-pay-approval/:id', 6, { windowMs: FIVE_MINUTES, criticality: 'approval', description: 'Approve or release final pay' }),
  routeLimit('PATCH', '/api/payroll/offboarding-clearance/:id', 10, { windowMs: FIVE_MINUTES, criticality: 'approval', description: 'Update payroll offboarding clearance' }),

  routeLimit('POST', '/api/payroll/transactions/production', 45, { windowMs: FIVE_MINUTES, criticality: 'encoding-write', description: 'Encode production payroll log' }),
  routeLimit('POST', '/api/payroll/transactions/logistics', 45, { windowMs: FIVE_MINUTES, criticality: 'encoding-write', description: 'Encode logistics payroll log' }),
  routeLimit('POST', '/api/payroll/production-output', 45, { windowMs: FIVE_MINUTES, criticality: 'encoding-write', description: 'Encode production output' }),
  routeLimit('POST', '/api/payroll/production-pairs', 45, { windowMs: FIVE_MINUTES, criticality: 'encoding-write', description: 'Encode production pair' }),
  routeLimit('POST', '/api/payroll/piece-rate-outputs', 45, { windowMs: FIVE_MINUTES, criticality: 'encoding-write', description: 'Create piece-rate output' }),
  routeLimit('PATCH', '/api/payroll/piece-rate-outputs/:id', 45, { windowMs: FIVE_MINUTES, criticality: 'encoding-write', description: 'Update piece-rate output' }),
  routeLimit('POST', '/api/payroll/piece-rate-outputs/:id/submit', 30, { windowMs: FIVE_MINUTES, criticality: 'workflow-write', description: 'Submit piece-rate output' }),
  routeLimit('POST', '/api/payroll/piece-rate-outputs/:id/approve', 12, { windowMs: FIVE_MINUTES, criticality: 'approval', description: 'Approve piece-rate output' }),
  routeLimit('POST', '/api/payroll/piece-rate-outputs/:id/reject', 12, { windowMs: FIVE_MINUTES, criticality: 'approval', description: 'Reject piece-rate output' }),
  routeLimit('POST', '/api/payroll/logistics/trips', 45, { windowMs: FIVE_MINUTES, criticality: 'encoding-write', description: 'Create logistics trip' }),
  routeLimit('PUT', '/api/payroll/logistics/trips/:id', 45, { windowMs: FIVE_MINUTES, criticality: 'encoding-write', description: 'Update logistics trip' }),
  routeLimit('POST', '/api/payroll/logistics/trips/:id/submit', 30, { windowMs: FIVE_MINUTES, criticality: 'workflow-write', description: 'Submit logistics trip' }),
  routeLimit('POST', '/api/payroll/logistics/trips/:id/approve', 12, { windowMs: FIVE_MINUTES, criticality: 'approval', description: 'Approve logistics trip' }),
  routeLimit('POST', '/api/payroll/logistics/trips/:id/reject', 12, { windowMs: FIVE_MINUTES, criticality: 'approval', description: 'Reject logistics trip' }),

  routeLimit('POST', '/api/payroll/policy-settings', 15, { windowMs: FIVE_MINUTES, criticality: 'settings-write', description: 'Payroll policy settings update' }),
  routeLimit('POST', '/api/payroll/attendance-configurations', 15, { windowMs: FIVE_MINUTES, criticality: 'settings-write', description: 'Payroll attendance configuration save' }),
  routeLimit('DELETE', '/api/payroll/attendance-configurations/:id', 15, { windowMs: FIVE_MINUTES, criticality: 'settings-write', description: 'Payroll attendance configuration removal' }),
  routeLimit('POST', '/api/payroll/employees/:id/wage-config', 15, { windowMs: FIVE_MINUTES, criticality: 'settings-write', description: 'Employee wage configuration save' }),
  routeLimit('POST', '/api/payroll/logistics/rates', 15, { windowMs: FIVE_MINUTES, criticality: 'settings-write', description: 'Logistics rate save' }),
  routeLimit('PUT', '/api/payroll/logistics/rates/:id', 15, { windowMs: FIVE_MINUTES, criticality: 'settings-write', description: 'Logistics rate update' }),
  routeLimit('DELETE', '/api/payroll/logistics/rates/:id', 15, { windowMs: FIVE_MINUTES, criticality: 'settings-write', description: 'Logistics rate delete' }),
  routeLimit('POST', '/api/payroll/sss-tables/preview', 10, { windowMs: FIVE_MINUTES, criticality: 'settings-import', description: 'SSS table import preview' }),
  routeLimit('POST', '/api/payroll/sss-tables', 8, { windowMs: FIVE_MINUTES, criticality: 'settings-import', description: 'SSS table import commit' }),
  routeLimit('POST', '/api/payroll/sss-tables/:id/activate', 8, { windowMs: FIVE_MINUTES, criticality: 'settings-import', description: 'Activate SSS table' }),
  routeLimit('POST', '/api/payroll/deduction-settings', 15, { windowMs: FIVE_MINUTES, criticality: 'settings-write', description: 'Deduction setting save' }),
  routeLimit('POST', '/api/payroll/employee-cash-advances', 15, { windowMs: FIVE_MINUTES, criticality: 'settings-write', description: 'Cash advance save' }),
  routeLimit('POST', '/api/payroll/employee-loans', 15, { windowMs: FIVE_MINUTES, criticality: 'settings-write', description: 'Employee loan save' }),
  routeLimit('PATCH', '/api/payroll/employee-deductions/:id/status', 15, { windowMs: FIVE_MINUTES, criticality: 'settings-write', description: 'Employee deduction status update' }),
  routeLimit('POST', '/api/payroll/allowance-settings', 15, { windowMs: FIVE_MINUTES, criticality: 'settings-write', description: 'Allowance setting save' }),
  routeLimit('POST', '/api/payroll/reports/:report.:format', 10, { windowMs: FIVE_MINUTES, criticality: 'report-export', description: 'Payroll report export' }),
  routeLimit('GET', '/api/payroll/reports/:report.:format', 10, { windowMs: FIVE_MINUTES, criticality: 'report-export', description: 'Payroll report download' }),

  routeLimit('GET', '/api/blockchain/payroll/finalized', 40, { windowMs: FIVE_MINUTES, criticality: 'blockchain-view', description: 'Finalized payroll ledger records' }),
  routeLimit('POST', '/api/blockchain/payroll/finalize/:payrollId', 4, { windowMs: TEN_MINUTES, criticality: 'blockchain-finalize', description: 'Record finalized payroll on-chain' }),
  routeLimit('POST', '/api/blockchain/payroll/adjustment/:payrollId', 4, { windowMs: TEN_MINUTES, criticality: 'blockchain-finalize', description: 'Record payroll adjustment on-chain' }),
  routeLimit('GET', '/api/blockchain/payroll/verify/:payrollId', 20, { windowMs: FIVE_MINUTES, criticality: 'blockchain-verify', description: 'Verify payroll integrity' }),
  routeLimit('GET', '/api/blockchain/payroll/audit/:payrollId', 20, { windowMs: FIVE_MINUTES, criticality: 'blockchain-verify', description: 'Blockchain payroll audit trail' }),
  routeLimit('GET', '/api/blockchain/payroll/ledger/:payrollId', 20, { windowMs: FIVE_MINUTES, criticality: 'blockchain-verify', description: 'Read payroll ledger record' }),
  routeLimit('GET', '/api/blockchain/payroll/ledger/:payrollId/history', 20, { windowMs: FIVE_MINUTES, criticality: 'blockchain-verify', description: 'Read payroll ledger history' }),

  routeLimit('GET', '/api/payroll/*', 120, { criticality: 'fallback-view', description: 'Fallback for future payroll read endpoints' }),
  routeLimit('ALL', '/api/payroll/*', 30, { criticality: 'fallback-write', description: 'Fallback for future payroll write endpoints' }),
  routeLimit('ALL', '/api/blockchain/payroll/*', 12, { windowMs: FIVE_MINUTES, criticality: 'blockchain-fallback', description: 'Fallback for future blockchain payroll endpoints' }),
];

function normalizeRequestPath(req) {
  return String(req.originalUrl || req.url || '').split('?')[0] || '/';
}

function clientIp(req) {
  return String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
    || req.ip
    || req.socket?.remoteAddress
    || 'unknown';
}

function rateLimitPrincipal(req) {
  const authHeader = String(req.headers?.authorization || '').trim();
  if (authHeader) {
    return `auth:${crypto.createHash('sha256').update(authHeader).digest('hex').slice(0, 24)}`;
  }
  return `ip:${clientIp(req)}`;
}

function findPayrollRateLimit(req) {
  const method = String(req.method || '').toUpperCase();
  const path = normalizeRequestPath(req);
  return PAYROLL_ROUTE_RATE_LIMITS.find(limit => (
    (limit.method === method || limit.method === 'ALL') && limit.pattern.test(path)
  ));
}

function createPayrollRouteRateLimiter() {
  const { createRateLimiter } = require('./security-controls');
  const limiters = new Map(PAYROLL_ROUTE_RATE_LIMITS.map(limit => [
    limit.id,
    createRateLimiter({
      windowMs: limit.windowMs,
      max: Number(process.env[`RATE_LIMIT_${limit.id.replace(/[^A-Z0-9]+/gi, '_').toUpperCase()}_MAX`] || limit.max),
      keyGenerator: req => `${limit.id}:${rateLimitPrincipal(req)}`,
      auditAction: 'blocked_payroll_rate_limit_exceeded',
      module: 'PAYROLL_SECURITY',
    }),
  ]));

  return (req, res, next) => {
    const limit = findPayrollRateLimit(req);
    if (!limit) return next();
    return limiters.get(limit.id)(req, res, next);
  };
}

module.exports = {
  PAYROLL_ROUTE_RATE_LIMITS,
  createPayrollRouteRateLimiter,
  findPayrollRateLimit,
  rateLimitPrincipal,
};
