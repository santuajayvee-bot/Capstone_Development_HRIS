'use strict';

const PROBE_TYPES = new Set([
  'DATABASE',
  'SERVICE',
  'HTTP',
  'CONFIGURATION',
  'EXTERNAL_DEPENDENCY',
  'INTEGRITY',
]);

const STATUSES = new Set(['ONLINE', 'WARNING', 'OFFLINE', 'MAINTENANCE']);

function safeText(value, fallback = '', maxLength = 300) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  if (!text) return fallback;
  return text
    .replace(/(?:password|passwd|pwd|token|secret|authorization|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(?:mysql|postgres(?:ql)?):\/\/[^\s]+/gi, '[connection-string-redacted]')
    .slice(0, maxLength);
}

function normalizeStatus(value, fallback = 'WARNING') {
  const status = String(value || '').toUpperCase();
  return STATUSES.has(status) ? status : fallback;
}

function normalizeProbeType(value, fallback = 'SERVICE') {
  const type = String(value || '').toUpperCase();
  return PROBE_TYPES.has(type) ? type : fallback;
}

function normalizeChecks(checks = {}) {
  return Object.fromEntries(Object.entries(checks || {}).map(([key, value]) => {
    const entry = typeof value === 'object' && value !== null ? value : { passed: Boolean(value) };
    return [String(key).replace(/[^a-z0-9_]/gi, '_').slice(0, 80), {
      passed: Boolean(entry.passed),
      message: safeText(entry.message, entry.passed ? 'Passed.' : 'Failed.'),
    }];
  }));
}

function validationPassed(checks, explicit) {
  if (typeof explicit === 'boolean') return explicit;
  const values = Object.values(checks || {});
  return values.length > 0 && values.every(check => check.passed);
}

function createProbeResult({
  status = 'ONLINE',
  remarks = 'Read-only diagnostic completed.',
  probeType = 'SERVICE',
  probeTarget = 'internal-service',
  responseTimeMs = null,
  httpStatus = null,
  checks = {},
  dependencies = {},
  validationPassed: explicitValidationPassed,
  failureCode = null,
  errorMessage = null,
} = {}) {
  const normalizedChecks = normalizeChecks(checks);
  const normalizedStatus = normalizeStatus(status);
  return {
    status: normalizedStatus,
    remarks: safeText(remarks, 'Read-only diagnostic completed.', 500),
    probe_type: normalizeProbeType(probeType),
    probe_target: safeText(probeTarget, 'internal-service', 180),
    response_time_ms: Number.isFinite(Number(responseTimeMs)) ? Math.max(0, Math.round(Number(responseTimeMs))) : null,
    http_status: Number.isInteger(httpStatus) ? httpStatus : null,
    validation_passed: validationPassed(normalizedChecks, explicitValidationPassed),
    checks: normalizedChecks,
    dependencies: dependencies && typeof dependencies === 'object' ? dependencies : {},
    failure_code: failureCode ? safeText(failureCode, 'PROBE_FAILED', 80).replace(/[^A-Z0-9_:-]/gi, '_').toUpperCase() : null,
    error_message: errorMessage ? safeText(errorMessage, 'Read-only diagnostic failed.', 300) : null,
  };
}

class ProbeFailure extends Error {
  constructor(code, message, { status = 'OFFLINE', cause } = {}) {
    super(message || 'Read-only diagnostic failed.', cause ? { cause } : undefined);
    this.name = 'ProbeFailure';
    this.code = String(code || 'PROBE_FAILED').replace(/[^A-Z0-9_:-]/gi, '_').toUpperCase();
    this.status = normalizeStatus(status, 'OFFLINE');
  }
}

module.exports = {
  PROBE_TYPES,
  ProbeFailure,
  createProbeResult,
  normalizeProbeType,
  normalizeStatus,
  safeText,
};
