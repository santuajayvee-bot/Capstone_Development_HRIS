const crypto = require('crypto');

const ONE_MINUTE = 60_000;

function routeLimit(method, path, max, options = {}) {
  const pattern = new RegExp(`^${path.replace(/:[A-Za-z0-9_]+/g, '[^/]+')}$`);
  return {
    id: `${method} ${path}`,
    method,
    path,
    pattern,
    max,
    windowMs: options.windowMs || ONE_MINUTE,
    keyScope: options.keyScope || 'principal',
    description: options.description || '',
  };
}

const ATTENDANCE_ROUTE_RATE_LIMITS = [
  routeLimit('POST', '/api/attendance/biometric/webhook/:deviceReference', 300, { keyScope: 'device', description: 'Biometric device webhook ingestion' }),
  routeLimit('POST', '/api/attendance/biometric/sync/:deviceId', 5, { keyScope: 'principal', description: 'Manual device sync' }),
  routeLimit('GET', '/api/attendance/biometric/devices', 30, { description: 'Biometric device list' }),
  routeLimit('POST', '/api/attendance/biometric/devices', 10, { description: 'Biometric device creation' }),
  routeLimit('PUT', '/api/attendance/biometric/devices/:deviceId', 10, { description: 'Biometric device update' }),
  routeLimit('GET', '/api/attendance/biometric/mappings', 30, { description: 'Biometric employee mappings' }),
  routeLimit('POST', '/api/attendance/biometric/mappings', 20, { description: 'Biometric employee mapping creation' }),
  routeLimit('DELETE', '/api/attendance/biometric/mappings/:mappingId', 20, { description: 'Biometric employee mapping removal' }),
  routeLimit('GET', '/api/attendance/biometric/health', 30, { description: 'Biometric health diagnostics' }),
  routeLimit('GET', '/api/attendance/biometric/exceptions', 30, { description: 'Biometric exceptions' }),
  routeLimit('GET', '/api/attendance/biometric/events', 60, { description: 'Biometric event log' }),
  routeLimit('GET', '/api/attendance/my-records', 60, { description: 'Employee attendance records' }),
  routeLimit('GET', '/api/attendance/my-summary', 60, { description: 'Employee attendance summary' }),
  routeLimit('GET', '/api/attendance/status', 60, { description: 'Attendance status metadata' }),
  routeLimit('GET', '/api/attendance/employees', 30, { description: 'Attendance employee selector' }),
  routeLimit('GET', '/api/attendance/all', 60, { description: 'HR/payroll attendance records' }),
  routeLimit('GET', '/api/attendance/policies', 30, { description: 'Attendance policy settings' }),
  routeLimit('PUT', '/api/attendance/policies', 10, { description: 'Attendance policy update' }),
  routeLimit('GET', '/api/attendance/summaries', 30, { description: 'Attendance summaries' }),
  routeLimit('GET', '/api/attendance/overview', 60, { description: 'Attendance overview metrics' }),
  routeLimit('POST', '/api/attendance/manual', 10, { description: 'Manual attendance encoding' }),
  routeLimit('PATCH', '/api/attendance/:id/override', 10, { description: 'HR attendance correction' }),
  routeLimit('PATCH', '/api/attendance/:id/verify', 20, { description: 'HR attendance validation/rejection' }),
  routeLimit('PATCH', '/api/attendance/:id/overtime', 20, { description: 'Overtime adjustment' }),
  routeLimit('PATCH', '/api/attendance/:id/overtime-review', 20, { description: 'Overtime approval/rejection' }),
  routeLimit('GET', '/api/attendance/audit-log', 30, { description: 'Attendance audit trail' }),
  routeLimit('GET', '/api/attendance/integrity/:attendanceId', 30, { description: 'Attendance integrity check' }),
  routeLimit('POST', '/api/attendance/integrity/anchor-pending', 5, { description: 'Attendance blockchain anchor queue' }),
  routeLimit('GET', '/api/attendance/geofence', 30, { description: 'Attendance geofence settings' }),
  routeLimit('PUT', '/api/attendance/geofence/:id', 10, { description: 'Attendance geofence update' }),
  routeLimit('GET', '/api/biometric/status', 60, { description: 'Biometric integration status' }),
  routeLimit('GET', '/api/biometric/station-status', 120, { keyScope: 'station', description: 'Local biometric station status' }),
  routeLimit('POST', '/api/biometric/attendance', 120, { keyScope: 'device', description: 'Biometric attendance submission' }),
  routeLimit('POST', '/api/biometric/bridge-commands', 20, { description: 'Create biometric bridge command' }),
  routeLimit('GET', '/api/biometric/bridge-commands/:commandId', 120, { description: 'Poll biometric bridge command' }),
  routeLimit('POST', '/api/biometric/station-command/next', 120, { keyScope: 'station', description: 'Station command polling' }),
  routeLimit('POST', '/api/biometric/station-command/:commandId/complete', 120, { keyScope: 'station', description: 'Station command completion' }),
  routeLimit('POST', '/api/biometric/station-attendance', 300, { keyScope: 'station', description: 'Station attendance relay' }),
  routeLimit('ALL', '/api/attendance/:unmatched', 120, { description: 'Fallback for future attendance endpoints' }),
  routeLimit('ALL', '/api/biometric/:unmatched', 120, { keyScope: 'station', description: 'Fallback for future biometric endpoints' }),
];

function normalizeRequestPath(req) {
  return String(req.originalUrl || req.url || '').split('?')[0] || '/';
}

function clientIp(req) {
  return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
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

function stationOrDevicePrincipal(req) {
  const path = normalizeRequestPath(req);
  const pathDevice = path.match(/\/webhook\/([^/]+)|\/sync\/([^/]+)|\/station-command\/([^/]+)\/complete/)?.slice(1).find(Boolean);
  const deviceValue = req.headers?.['x-device-reference']
    || req.headers?.['x-station-id']
    || req.body?.device_reference
    || req.body?.station_id
    || req.body?.device_id
    || pathDevice;
  return `device:${String(deviceValue || clientIp(req)).slice(0, 80)}`;
}

function keyForScope(req, scope) {
  if (scope === 'device' || scope === 'station') return stationOrDevicePrincipal(req);
  return rateLimitPrincipal(req);
}

function findAttendanceRateLimit(req) {
  const method = String(req.method || '').toUpperCase();
  const path = normalizeRequestPath(req);
  return ATTENDANCE_ROUTE_RATE_LIMITS.find(limit => (
    (limit.method === method || limit.method === 'ALL') && limit.pattern.test(path)
  ));
}

function createAttendanceRouteRateLimiter() {
  const { createRateLimiter } = require('./security-controls');
  const limiters = new Map(ATTENDANCE_ROUTE_RATE_LIMITS.map(limit => [
    limit.id,
    createRateLimiter({
      windowMs: limit.windowMs,
      max: Number(process.env[`RATE_LIMIT_${limit.id.replace(/[^A-Z0-9]+/gi, '_').toUpperCase()}_MAX`] || limit.max),
      keyGenerator: req => `${limit.id}:${keyForScope(req, limit.keyScope)}`,
      auditAction: 'blocked_attendance_rate_limit_exceeded',
      module: 'ATTENDANCE_SECURITY',
    }),
  ]));

  return (req, res, next) => {
    const limit = findAttendanceRateLimit(req);
    if (!limit) return next();
    return limiters.get(limit.id)(req, res, next);
  };
}

module.exports = {
  ATTENDANCE_ROUTE_RATE_LIMITS,
  createAttendanceRouteRateLimiter,
  findAttendanceRateLimit,
  rateLimitPrincipal,
};
