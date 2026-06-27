const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const pool = require('../config/db');

const EXECUTABLE_EXTENSIONS = new Set([
  '.asp', '.aspx', '.bat', '.cmd', '.com', '.exe', '.html', '.htm', '.jar',
  '.js', '.jsp', '.msi', '.php', '.ps1', '.py', '.sh', '.svg', '.vb', '.vbs',
]);

const ALLOWED_UPLOAD_TYPES = {
  '.pdf': {
    mimes: new Set(['application/pdf']),
    matches: buffer => buffer.subarray(0, 4).toString('ascii') === '%PDF',
  },
  '.png': {
    mimes: new Set(['image/png']),
    matches: buffer => buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  '.jpg': {
    mimes: new Set(['image/jpeg']),
    matches: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  '.jpeg': {
    mimes: new Set(['image/jpeg']),
    matches: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  '.docx': {
    mimes: new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
    matches: buffer => buffer.subarray(0, 4).toString('binary') === 'PK\u0003\u0004',
  },
};

const COMPUTED_PAYROLL_FIELDS = new Set([
  'base_pay',
  'gross_pay',
  'net_pay',
  'total_deductions',
  'sss_deduction',
  'philhealth_deduction',
  'pagibig_deduction',
  'employee_deduction_total',
  'overtime_amount',
  'regular_pay',
  'payroll_status',
]);

const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requestIp(req) {
  return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || req.ip
    || 'unknown';
}

function currentUserId(req) {
  return req.user?.id || req.user?.userId || req.user?.sub || null;
}

function safeJson(value) {
  if (value === undefined) return null;
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

async function auditSecurityEvent(req, {
  action,
  module = 'SECURITY_CONTROL',
  targetTable = null,
  targetRecord = null,
  oldValue = null,
  newValue = null,
  result = 'blocked',
} = {}) {
  if (process.env.NODE_ENV === 'test') return;
  try {
    await pool.execute(
      `INSERT INTO system_audit_log
         (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        currentUserId(req) || 0,
        req.user?.employeeId || null,
        targetRecord || null,
        `${result.toUpperCase()}: ${action}`,
        module,
        safeJson(oldValue),
        safeJson({ targetTable, targetRecord, role: req.user?.role || 'anonymous', ...newValue }),
        requestIp(req),
        req.headers?.['user-agent'] || 'unknown',
      ]
    );
  } catch (error) {
    console.warn('Security audit logging skipped:', error.message);
  }
}

function rejectWithAudit(req, res, status, message, audit) {
  auditSecurityEvent(req, audit).catch(() => {});
  return res.status(status).json({ error: message });
}

function createRateLimiter({
  windowMs = 60 * 1000,
  max = 60,
  keyGenerator = req => requestIp(req),
  auditAction = 'blocked_rate_limit_exceeded',
  module = 'RATE_LIMIT_SECURITY',
} = {}) {
  const buckets = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = String(keyGenerator(req) || 'unknown');
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;
    if (bucket.count <= max) return next();

    const retryAfterSeconds = Math.max(Math.ceil((bucket.resetAt - now) / 1000), 1);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    return rejectWithAudit(req, res, 429, 'Too many requests. Please try again later.', {
      action: auditAction,
      module,
      targetTable: req.originalUrl || null,
      newValue: { key, path: req.originalUrl, method: req.method, retryAfterSeconds },
      result: 'blocked',
    });
  };
}

function normalizeOrigin(value) {
  try {
    return new URL(String(value || '').trim()).origin;
  } catch (_) {
    return null;
  }
}

function allowedRequestOrigins(req) {
  const allowed = new Set();
  const forwardedProto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || (req.secure ? 'https' : 'http');
  const host = String(req.headers?.host || '').trim();
  if (host) allowed.add(`${protocol}://${host}`);

  for (const configured of [
    process.env.APP_PUBLIC_URL,
    ...String(process.env.CSRF_ALLOWED_ORIGINS || '').split(','),
  ]) {
    const origin = normalizeOrigin(configured);
    if (origin) allowed.add(origin);
  }
  return allowed;
}

function requireSameOriginForBrowserWrites(req, res, next) {
  if (CSRF_SAFE_METHODS.has(String(req.method || 'GET').toUpperCase())) return next();

  const fetchSite = String(req.headers?.['sec-fetch-site'] || '').trim().toLowerCase();
  const originHeader = req.headers?.origin;
  const requestOrigin = normalizeOrigin(originHeader);
  const allowedOrigins = allowedRequestOrigins(req);
  const isCrossSiteFetch = fetchSite === 'cross-site';
  const hasInvalidOrigin = Boolean(originHeader) && (!requestOrigin || !allowedOrigins.has(requestOrigin));

  // Browser writes must be same-origin. Requests without browser origin
  // headers remain available to trusted server-to-server and device clients.
  if (!isCrossSiteFetch && !hasInvalidOrigin) return next();

  return rejectWithAudit(req, res, 403, 'Cross-site request blocked.', {
    action: 'blocked_cross_site_request',
    module: 'CSRF_PROTECTION',
    targetTable: req.originalUrl || null,
    newValue: {
      method: req.method,
      origin: requestOrigin || 'invalid-or-missing',
      fetchSite: fetchSite || null,
    },
    result: 'blocked',
  });
}

function findForbiddenBodyFields(body, forbiddenFields = COMPUTED_PAYROLL_FIELDS) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  return Object.keys(body).filter(key => forbiddenFields.has(String(key).toLowerCase()));
}

function rejectForbiddenFields(forbiddenFields, options = {}) {
  const forbidden = new Set([...forbiddenFields].map(field => String(field).toLowerCase()));
  return (req, res, next) => {
    const found = findForbiddenBodyFields(req.body, forbidden);
    if (!found.length) return next();
    return rejectWithAudit(req, res, 403, 'Request contains unauthorized fields.', {
      action: options.action || 'blocked_parameter_tampering_attempt',
      module: options.module || 'PARAMETER_TAMPERING',
      targetTable: options.targetTable || null,
      targetRecord: req.params?.id || req.body?.id || null,
      newValue: { fields: found, path: req.originalUrl },
      result: 'blocked',
    });
  };
}

function randomSafeFilename(originalName) {
  const extension = path.extname(String(originalName || '')).toLowerCase();
  return `${crypto.randomUUID()}${extension}`;
}

function uploadExtensionError(originalName) {
  const lowerName = String(originalName || '').toLowerCase();
  const extension = path.extname(lowerName);
  const stem = path.basename(lowerName, extension);
  if (!extension || !ALLOWED_UPLOAD_TYPES[extension]) {
    return 'File type is not allowed.';
  }
  if ([...EXECUTABLE_EXTENSIONS].some(ext => lowerName.endsWith(ext) || stem.includes(ext))) {
    return 'Executable or double-extension files are not allowed.';
  }
  return null;
}

function multerFileFilter(req, file, cb) {
  const extensionError = uploadExtensionError(file.originalname);
  if (extensionError) return cb(new Error(extensionError));
  const extension = path.extname(file.originalname).toLowerCase();
  const allowed = ALLOWED_UPLOAD_TYPES[extension];
  if (!allowed.mimes.has(String(file.mimetype || '').toLowerCase())) {
    return cb(new Error('File MIME type does not match the allowed document type.'));
  }
  return cb(null, true);
}

function validateStoredUpload(file) {
  if (!file) return { ok: false, error: 'No file uploaded.' };
  const extensionError = uploadExtensionError(file.originalname);
  if (extensionError) return { ok: false, error: extensionError };
  const extension = path.extname(file.originalname).toLowerCase();
  const allowed = ALLOWED_UPLOAD_TYPES[extension];
  if (!allowed) return { ok: false, error: 'File type is not allowed.' };

  const buffer = fs.readFileSync(file.path);
  if (!allowed.matches(buffer)) {
    return { ok: false, error: 'File content does not match its extension.' };
  }

  return { ok: true };
}

function deleteUploadedFile(file) {
  if (file?.path && fs.existsSync(file.path)) {
    fs.unlinkSync(file.path);
  }
}

function secureUploadedFile(req, res, next) {
  const result = validateStoredUpload(req.file);
  if (result.ok) return next();
  deleteUploadedFile(req.file);
  return rejectWithAudit(req, res, 400, result.error, {
    action: 'blocked_file_upload_tampering_attempt',
    module: 'FILE_UPLOAD_SECURITY',
    targetTable: 'documents',
    newValue: {
      originalname: req.file?.originalname,
      mimetype: req.file?.mimetype,
      size: req.file?.size,
      path: req.originalUrl,
    },
    result: 'blocked',
  });
}

module.exports = {
  ALLOWED_UPLOAD_TYPES,
  COMPUTED_PAYROLL_FIELDS,
  auditSecurityEvent,
  createRateLimiter,
  deleteUploadedFile,
  multerFileFilter,
  randomSafeFilename,
  rejectForbiddenFields,
  rejectWithAudit,
  requireSameOriginForBrowserWrites,
  secureUploadedFile,
  uploadExtensionError,
  validateStoredUpload,
};
