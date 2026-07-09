const assert = require('assert');
const fs = require('fs');
const path = require('path');

const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const biometric = fs.readFileSync(path.join(__dirname, '..', 'server', 'biometric.js'), 'utf8');
const attendance = fs.readFileSync(path.join(__dirname, '..', 'server', 'attendance.js'), 'utf8');
const attendanceUi = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'attendance.js'), 'utf8');
const { ATTENDANCE_ROUTE_RATE_LIMITS, findAttendanceRateLimit } = require('../server/attendance-rate-limits');

assert(
  /const \{ createAttendanceRouteRateLimiter \}\s*=/.test(server)
    && /const ATTENDANCE_ROUTE_RATE_LIMIT = createAttendanceRouteRateLimiter\(\)/.test(server),
  'Attendance module must use the dedicated per-route audited rate limiter.'
);
assert(
  /app\.set\('trust proxy', process\.env\.TRUST_PROXY \|\| 'loopback'\)/.test(server),
  'AWS reverse-proxy deployments must use trusted proxy handling for rate-limit client identity.'
);
assert(
  /function rateLimitPrincipal\(req\)[\s\S]*createHash\('sha256'\)/.test(server),
  'Rate limiting must bucket authenticated users by a safe token hash instead of one shared proxy IP.'
);
assert(
  ATTENDANCE_ROUTE_RATE_LIMITS.length >= 35
    && ATTENDANCE_ROUTE_RATE_LIMITS.every(limit => /^\/api\/(?:attendance|biometric)\//.test(limit.path)),
  'Every dedicated attendance limiter must target only /api/attendance or /api/biometric routes.'
);
assert(
  /app\.use\(\['\/api\/attendance', '\/api\/biometric'\], ATTENDANCE_ROUTE_RATE_LIMIT\)/.test(server),
  'Attendance and biometric routes must use the dedicated per-route attendance limiter.'
);
assert(
  !ATTENDANCE_ROUTE_RATE_LIMITS.some(limit => limit.path.startsWith('/api/holidays')),
  'Holiday APIs must not be included in the dedicated attendance route limit table.'
);

[
  ['POST', '/api/attendance/biometric/webhook/:deviceReference'],
  ['POST', '/api/attendance/biometric/sync/:deviceId'],
  ['GET', '/api/attendance/biometric/devices'],
  ['POST', '/api/attendance/biometric/devices'],
  ['PUT', '/api/attendance/biometric/devices/:deviceId'],
  ['GET', '/api/attendance/biometric/mappings'],
  ['POST', '/api/attendance/biometric/mappings'],
  ['DELETE', '/api/attendance/biometric/mappings/:mappingId'],
  ['GET', '/api/attendance/biometric/health'],
  ['GET', '/api/attendance/biometric/exceptions'],
  ['GET', '/api/attendance/biometric/events'],
  ['GET', '/api/attendance/my-records'],
  ['GET', '/api/attendance/my-summary'],
  ['GET', '/api/attendance/status'],
  ['GET', '/api/attendance/employees'],
  ['GET', '/api/attendance/all'],
  ['GET', '/api/attendance/policies'],
  ['PUT', '/api/attendance/policies'],
  ['GET', '/api/attendance/summaries'],
  ['GET', '/api/attendance/overview'],
  ['POST', '/api/attendance/manual'],
  ['PATCH', '/api/attendance/:id/override'],
  ['PATCH', '/api/attendance/:id/verify'],
  ['PATCH', '/api/attendance/:id/overtime'],
  ['PATCH', '/api/attendance/:id/overtime-review'],
  ['GET', '/api/attendance/audit-log'],
  ['GET', '/api/attendance/integrity/:attendanceId'],
  ['POST', '/api/attendance/integrity/anchor-pending'],
  ['GET', '/api/attendance/geofence'],
  ['PUT', '/api/attendance/geofence/:id'],
  ['GET', '/api/biometric/status'],
  ['GET', '/api/biometric/station-status'],
  ['POST', '/api/biometric/attendance'],
  ['POST', '/api/biometric/bridge-commands'],
  ['GET', '/api/biometric/bridge-commands/:commandId'],
  ['POST', '/api/biometric/station-command/next'],
  ['POST', '/api/biometric/station-command/:commandId/complete'],
  ['POST', '/api/biometric/station-attendance'],
].forEach(([method, routePath]) => {
  assert(
    ATTENDANCE_ROUTE_RATE_LIMITS.some(limit => limit.method === method && limit.path === routePath),
    `${method} ${routePath} must have an explicit attendance route rate limit.`
  );
});

assert.strictEqual(
  findAttendanceRateLimit({ method: 'GET', originalUrl: '/api/holidays?year=2026', headers: {}, socket: {} }),
  undefined,
  'Holiday API requests must not resolve to the attendance-specific limiter.'
);
assert(
  /router\.get\('\/biometric\/health', requireAuth, requireRole\(BIOMETRIC_ADMIN_ROLES\)/.test(attendance),
  'Attendance module must expose protected biometric health evidence.'
);
assert(
  /biometric station is busy with another enrollment, verification, or removal/i.test(biometric),
  'Biometric command handling must reject concurrent station commands.'
);
assert(
  /res\.status === 429[\s\S]*Retry-After/.test(attendanceUi),
  'Attendance UI must honor retry timing for rate-limited biometric polling.'
);

console.log('Attendance DoS STRIDE controls: PASS');
