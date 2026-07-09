const { ATTENDANCE_ROUTE_RATE_LIMITS } = require('../server/attendance-rate-limits');

console.table(ATTENDANCE_ROUTE_RATE_LIMITS.map(limit => ({
  method: limit.method,
  api: limit.path,
  max_requests: limit.max,
  window_seconds: Math.round(limit.windowMs / 1000),
  key_scope: limit.keyScope,
  description: limit.description,
})));
