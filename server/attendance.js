/* ============================================================
   Attendance Management Controller

   Secure attendance boundary for:
   - Fingerprint device webhook and pull synchronization
   - Privacy-preserving biometric employee mapping
   - Employee self-service attendance
   - HR verification, manual correction, and outage recovery
   - Payroll-ready validated summaries
   - Permissioned-ledger integrity anchoring
   ============================================================ */

const crypto = require('crypto');
const express = require('express');
const pool = require('../config/db');
const { encryptAES256 } = require('./crypto');
const { decryptColumnValue } = require('./data-protection');
const { requireAuth, requireRole, ROLES } = require('./middleware');
const {
  anchorIntegrityEntry,
  appendIntegrityEntry,
  getDeviceSecret,
  ingestBiometricEvents,
  ensureAttendanceLogMetricColumns,
  ensureAttendanceSummaryPolicyColumns,
  pullDeviceLogs,
  refreshSummary,
  sha256,
  timingSafeEqualText,
} = require('./attendance-service');
const { emitAttendanceCreated } = require('./realtime');
const { auditSecurityEvent } = require('./security-controls');
const { isStrictDateOnly } = require('./utils/dateValidation');
const {
  ensureAttendancePolicySettings,
  computeAttendanceMetrics,
  getActiveAttendancePolicy,
  getAttendanceStatusForTimeIn,
  saveAttendancePolicyValues,
} = require('./attendance-policy-engine');
const { missingDtrPunches } = require('./dtr-punch');
const { absenceDateKeys, loadSyntheticAbsenceRows } = require('./attendance-absence');
const { todayManilaDateKey } = require('./utils/dateValidation');

const router = express.Router();

const HR_ROLES = ['hr_admin', 'hr_manager', 'admin'];
const SYSTEM_ADMIN_ROLES = ['system_admin', 'admin'];
const PAYROLL_OFFICER_ROLES = ['payroll_officer'];
const PAYROLL_MANAGER_ROLES = ['payroll_manager'];
const ATTENDANCE_RECORD_VIEW_ROLES = [...HR_ROLES, ...PAYROLL_OFFICER_ROLES, ...PAYROLL_MANAGER_ROLES];
const BIOMETRIC_ADMIN_ROLES = [...HR_ROLES, ...SYSTEM_ADMIN_ROLES];
const SUMMARY_ROLES = [...HR_ROLES, ...PAYROLL_OFFICER_ROLES, ...PAYROLL_MANAGER_ROLES];
const AUDIT_ROLES = [...HR_ROLES, ...SYSTEM_ADMIN_ROLES];
const BIOMETRIC_DEVICE_ALLOWED_FIELDS = new Set([
  'device_reference', 'device_name', 'vendor', 'api_base_url', 'logs_endpoint',
  'auth_type', 'auth_header_name', 'auth_secret', 'is_active',
]);
const BIOMETRIC_MAPPING_ALLOWED_FIELDS = new Set(['device_id', 'employee_id', 'biometric_user_id']);
const ATTENDANCE_POLICY_ALLOWED_FIELDS = new Set([
  'effective_date', 'work_schedule', 'work_start_time', 'work_end_time',
  'break_start_time', 'break_end_time', 'standard_work_hours', 'grace_period_minutes',
  'duplicate_scan_window_seconds', 'hr_validation_required', 'require_hr_validation',
  'auto_payroll_ready',
  'overtime_threshold_hours', 'overtime_threshold_minutes', 'missing_timeout_handling',
  'payroll_attendance_source', 'payroll_ready_rules', 'allow_manual_attendance',
  'allow_hr_correction', 'enable_overtime', 'minimum_overtime_minutes',
  'enable_holiday_rules', 'regular_holiday_multiplier', 'special_holiday_multiplier',
  'rest_day_multiplier', 'holiday_overtime_multiplier',
  'multiple_scan_handling', 'overtime_handling',
]);
const MANUAL_ATTENDANCE_ALLOWED_FIELDS = new Set(['employee_id', 'date', 'time_in', 'time_out', 'am_time_in', 'am_time_out', 'pm_time_in', 'pm_time_out', 'reason']);
const ATTENDANCE_OVERRIDE_ALLOWED_FIELDS = new Set(['time_in', 'time_out', 'am_time_in', 'am_time_out', 'pm_time_in', 'pm_time_out', 'reason']);
const ATTENDANCE_VERIFY_ALLOWED_FIELDS = new Set(['verification_status', 'reason']);
const ATTENDANCE_OVERTIME_ALLOWED_FIELDS = new Set(['overtime_hours', 'reason']);
const ATTENDANCE_OVERTIME_REVIEW_ALLOWED_FIELDS = new Set(['decision', 'reason']);
const GEOFENCE_ALLOWED_FIELDS = new Set(['site_name', 'latitude', 'longitude', 'radius_meters', 'is_active']);

function includesRole(roles, req) {
  return roles.includes(req.user?.role);
}

function normalizeAttendanceRole(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/_*\([^)]*\)/g, '')
    .replace(/_level_?\d+/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function requireAttendanceAuditAccess(req, res, next) {
  const role = normalizeAttendanceRole(req.user?.role);
  const roleLabel = normalizeAttendanceRole(req.user?.roleLabel || req.user?.role_label);
  const allowedRoles = new Set([
    'admin',
    'system_admin',
    'system_administrator',
    'hr',
    'hradmin',
    'hr_admin',
    'hr_manager',
    'human_resources',
    'manager',
  ]);

  if (allowedRoles.has(role) || allowedRoles.has(roleLabel) || roleLabel.includes('hr_manager')) {
    return next();
  }

  auditSecurityEvent(req, {
    action: 'failed_attendance_audit_access_attempt',
    module: 'ATTENDANCE_SECURITY',
    targetTable: req.originalUrl || null,
    newValue: {
      method: req.method,
      path: req.originalUrl,
      actual_role: req.user?.role || 'anonymous',
      actual_role_label: req.user?.roleLabel || req.user?.role_label || null,
    },
    result: 'blocked',
  }).catch(() => {});

  return res.status(403).json({
    error: 'Access denied.',
    role: req.user?.role || null,
    roleLabel: req.user?.roleLabel || req.user?.role_label || null,
  });
}

function safeAttendanceText(value) {
  try {
    return decryptColumnValue(value) || '';
  } catch (_error) {
    return '';
  }
}

function attendanceEmployeeName(row) {
  const first = safeAttendanceText(row?.first_name);
  const middle = safeAttendanceText(row?.middle_name);
  const last = safeAttendanceText(row?.last_name);
  const name = [first, middle, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return name || row?.employee_code || (row?.employee_id ? `Employee #${row.employee_id}` : 'Employee');
}

function withAttendanceEmployeeName(row) {
  return {
    ...row,
    first_name: undefined,
    middle_name: undefined,
    last_name: undefined,
    employee_name: attendanceEmployeeName(row),
  };
}

function removeAttendanceSecurityMetadata(record) {
  const {
    source,
    integrity_hash,
    device_id,
    ...safeRecord
  } = record || {};
  return safeRecord;
}

function attendanceRecordForRole(req, row) {
  const record = withAttendanceEmployeeName(row);
  return includesRole(HR_ROLES, req) ? record : removeAttendanceSecurityMetadata(record);
}

function rejectUnsupportedFields(req, res, allowedFields, module = 'ATTENDANCE_SECURITY') {
  const unknownFields = Object.keys(req.body || {}).filter(field => !allowedFields.has(field));
  if (!unknownFields.length) return false;
  auditSecurityEvent(req, {
    action: 'blocked_unsupported_attendance_fields',
    module,
    targetTable: req.originalUrl || null,
    targetRecord: req.params?.id || req.body?.employee_id || null,
    newValue: { fields: unknownFields, path: req.originalUrl },
    result: 'blocked',
  }).catch(() => {});
  res.status(400).json({ error: 'Request contains unsupported field(s).', fields: unknownFields });
  return true;
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 45);
}

function cleanText(value, maxLength = 500) {
  return String(value ?? '').trim().replace(/[<>]/g, '').slice(0, maxLength);
}

function positiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${fieldName} must be a positive integer.`);
  return number;
}

function isTime(value) {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
}

function isDate(value) {
  return typeof value === 'string' && isStrictDateOnly(value);
}

function normalizeDtrTimes(body, fallback = {}) {
  const cleanTime = (field, aliases = []) => {
    if (body[field] !== undefined) return cleanText(body[field], 8) || null;
    for (const alias of aliases) {
      if (body[alias] !== undefined) return cleanText(body[alias], 8) || null;
    }
    return fallback[field] || null;
  };
  const timeIn = cleanTime('time_in', ['am_time_in', 'pm_time_in'])
    || fallback.am_time_in
    || fallback.pm_time_in
    || null;
  const timeOut = cleanTime('time_out', ['pm_time_out', 'am_time_out'])
    || fallback.pm_time_out
    || fallback.am_time_out
    || null;

  return {
    time_in: timeIn,
    time_out: timeOut,
    am_time_in: timeIn,
    am_time_out: null,
    pm_time_in: null,
    pm_time_out: timeOut,
  };
}

function requestBool(value, fallback = false) {
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  const text = String(value ?? '').trim().toLowerCase();
  if (['true', 'yes', 'on'].includes(text)) return true;
  if (['false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function requireReason(value) {
  const reason = cleanText(value, 500);
  if (reason.length < 8) throw new Error('A correction reason of at least 8 characters is required.');
  return reason;
}

function safeClientError(err, fallback = 'Unable to process request.') {
  const message = String(err?.message || '').trim();
  const code = String(err?.code || '');
  if (
    err?.sqlMessage ||
    err?.sqlState ||
    code.startsWith('ER_') ||
    /\b(sql|mysql|database|table|column|constraint|syntax|foreign key|select|insert|update|delete)\b/i.test(message)
  ) {
    return fallback;
  }
  return message || fallback;
}

function safeJson(value) {
  return value == null ? null : JSON.stringify(value);
}

function maskReference(value) {
  const text = String(value || '');
  if (text.length <= 4) return '*'.repeat(text.length);
  return `${text.slice(0, 2)}${'*'.repeat(Math.min(8, text.length - 4))}${text.slice(-2)}`;
}

function validateIntegrationUrl(value) {
  if (!value) return null;
  const url = new URL(value);
  const allowDevHttp = process.env.ALLOW_INSECURE_BIOMETRIC_API === 'true' && process.env.NODE_ENV !== 'production';
  if (url.protocol !== 'https:' && !allowDevHttp) {
    throw new Error('Biometric integration URL must use HTTPS with TLS 1.3.');
  }
  return url.toString();
}

async function writeAuditLog(userId, employeeId, action, oldValue, newValue, req, module = 'ATTENDANCE') {
  await pool.execute(
    `INSERT INTO system_audit_log
       (user_id, employee_id, target_employee_id, action_performed, module,
        old_value, new_value, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      req.user?.employeeId || null,
      employeeId || null,
      action,
      module,
      oldValue,
      newValue,
      clientIp(req),
      cleanText(req.headers['user-agent'], 500),
    ]
  );
}

async function emitAttendanceRealtimeById(attendanceId, scanType = 'AUTO') {
  try {
    const [rows] = await pool.execute(
      `SELECT al.employee_id, al.date, al.time_in, al.time_out,
              al.am_time_in, al.am_time_out, al.pm_time_in, al.pm_time_out, al.verification_status,
              al.device_id, ats.payroll_eligible,
              e.employee_code, e.department_id, e.first_name, e.middle_name, e.last_name,
              bd.device_reference
         FROM attendance_log al
         JOIN employees e ON e.id = al.employee_id
         LEFT JOIN attendance_summary ats ON ats.attendance_id = al.attendance_id
         LEFT JOIN biometric_device bd ON bd.device_id = al.device_id
        WHERE al.attendance_id = ?
        LIMIT 1`,
      [attendanceId]
    );
    if (!rows.length) return;
    const row = rows[0] ? withAttendanceEmployeeName(rows[0]) : null;
    emitAttendanceCreated({
      employee_id: row.employee_id,
      employee_name: row.employee_name,
      employee_code: row.employee_code,
      department_id: row.department_id,
      scan_type: scanType,
      scan_time: `${row.date} ${row.time_out || row.time_in || ''}`.trim(),
      attendance_status: row.verification_status,
      payroll_ready: Number(row.payroll_eligible || 0) === 1,
      device_id: row.device_reference || row.device_id || null,
    });
  } catch (err) {
    console.warn('[attendance/realtime]', err.message);
  }
}

async function authenticateBiometricWebhook(req, res, next) {
  try {
    const reference = cleanText(req.params.deviceReference, 120);
    if (!/^[a-zA-Z0-9._:-]+$/.test(reference)) {
      return res.status(400).json({ error: 'Invalid device reference.' });
    }

    const [devices] = await pool.execute(
      'SELECT * FROM biometric_device WHERE device_reference = ? AND is_active = 1 LIMIT 1',
      [reference]
    );
    if (!devices.length) return res.status(404).json({ error: 'Active biometric device not found.' });

    const device = devices[0];
    const secret = getDeviceSecret(device);
    let authenticated = false;

    if (device.auth_type === 'API_KEY') {
      authenticated = timingSafeEqualText(req.headers[String(device.auth_header_name || 'x-biometric-api-key').toLowerCase()], secret);
    } else if (device.auth_type === 'BEARER' || device.auth_type === 'OAUTH2') {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      authenticated = timingSafeEqualText(token, secret);
    } else if (device.auth_type === 'HMAC') {
      const timestamp = String(req.headers['x-biometric-timestamp'] || '');
      const signature = String(req.headers['x-biometric-signature'] || '').replace(/^sha256=/i, '');
      const timestampSeconds = Number(timestamp);
      const fresh = Number.isFinite(timestampSeconds) && Math.abs(Date.now() / 1000 - timestampSeconds) <= 300;
      const payload = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
      const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
      authenticated = fresh && timingSafeEqualText(signature, expected);
    } else if (device.auth_type === 'MTLS') {
      authenticated = req.socket.authorized === true;
    } else if (device.auth_type === 'NONE') {
      authenticated = process.env.NODE_ENV !== 'production'
        && process.env.ALLOW_UNAUTHENTICATED_BIOMETRIC_WEBHOOK === 'true';
    }

    if (!authenticated) {
      return res.status(401).json({ error: 'Biometric API authentication failed.' });
    }

    req.biometricDevice = device;
    next();
  } catch (err) {
    console.error('[attendance/biometric-auth]', err.message);
    res.status(500).json({ error: 'Biometric API authentication could not be completed.' });
  }
}

async function createSyncLog(deviceId, mode, initiatedBy = null) {
  const [result] = await pool.execute(
    `INSERT INTO biometric_sync_log (device_id, sync_mode, status, initiated_by)
     VALUES (?, ?, 'STARTED', ?)`,
    [deviceId, mode, initiatedBy]
  );
  return result.insertId;
}

async function finishSyncLog(syncLogId, deviceId, summary, error = null) {
  const status = error ? 'FAILED' : summary.rejected ? 'PARTIAL' : 'SUCCESS';
  await pool.execute(
    `UPDATE biometric_sync_log
        SET status = ?, received_count = ?, accepted_count = ?, duplicate_count = ?,
            rejected_count = ?, error_message = ?, completed_at = NOW()
      WHERE sync_log_id = ?`,
    [
      status,
      summary.received || 0,
      summary.accepted || 0,
      summary.duplicates || 0,
      summary.rejected || 0,
      error ? cleanText(error.message, 500) : null,
      syncLogId,
    ]
  );

  await pool.execute(
    `UPDATE biometric_device
        SET last_sync_at = NOW(),
            last_success_at = CASE WHEN ? IN ('SUCCESS','PARTIAL') THEN NOW() ELSE last_success_at END,
            last_error_at = CASE WHEN ? = 'FAILED' THEN NOW() ELSE last_error_at END,
            last_error_message = ?
      WHERE device_id = ?`,
    [status, status, error ? cleanText(error.message, 500) : null, deviceId]
  );
}

/* ============================================================
   Biometric webhook and synchronization
   ============================================================ */

router.post('/biometric/webhook/:deviceReference', authenticateBiometricWebhook, async (req, res) => {
  const device = req.biometricDevice;
  const syncLogId = await createSyncLog(device.device_id, 'WEBHOOK');
  try {
    const events = Array.isArray(req.body) ? req.body : req.body?.events || [req.body];
    const summary = await ingestBiometricEvents(device, events);
    await finishSyncLog(syncLogId, device.device_id, summary);
    res.status(summary.rejected ? 207 : 200).json({ message: 'Biometric events processed.', ...summary });
  } catch (err) {
    console.error('[attendance/biometric-webhook]', err.message);
    const summary = { received: 0, accepted: 0, duplicates: 0, rejected: 0 };
    await finishSyncLog(syncLogId, device.device_id, summary, err);
    res.status(400).json({ error: safeClientError(err, 'Failed to process biometric events.') });
  }
});

router.post('/biometric/sync/:deviceId', requireAuth, requireRole(SYSTEM_ADMIN_ROLES), async (req, res) => {
  let syncLogId;
  try {
    const deviceId = positiveInteger(req.params.deviceId, 'deviceId');
    const [devices] = await pool.execute(
      'SELECT * FROM biometric_device WHERE device_id = ? AND is_active = 1',
      [deviceId]
    );
    if (!devices.length) return res.status(404).json({ error: 'Active biometric device not found.' });

    const device = devices[0];
    syncLogId = await createSyncLog(deviceId, 'PULL', req.user.id);
    const events = await pullDeviceLogs(device);
    const summary = await ingestBiometricEvents(device, events || []);
    await finishSyncLog(syncLogId, deviceId, summary);
    await writeAuditLog(req.user.id, null, `BIOMETRIC PULL SYNC [DEVICE:${deviceId}]`, null, safeJson(summary), req);
    res.json({ message: 'Biometric synchronization completed.', ...summary });
  } catch (err) {
    console.error('[attendance/biometric-sync]', err.message);
    if (syncLogId) {
      const deviceId = Number(req.params.deviceId);
      await finishSyncLog(syncLogId, deviceId, { received: 0, accepted: 0, duplicates: 0, rejected: 0 }, err);
    }
    res.status(502).json({ error: safeClientError(err, 'Failed to synchronize biometric device.') });
  }
});

router.get('/biometric/devices', requireAuth, requireRole(BIOMETRIC_ADMIN_ROLES), async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT device_id, device_reference, device_name, vendor, api_base_url, logs_endpoint,
              auth_type, auth_header_name, is_active, last_sync_at, last_success_at,
              last_error_at, last_error_message, created_at, updated_at
         FROM biometric_device
        ORDER BY device_name`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch biometric devices.' });
  }
});

router.post('/biometric/devices', requireAuth, requireRole(SYSTEM_ADMIN_ROLES), async (req, res) => {
  try {
    if (rejectUnsupportedFields(req, res, BIOMETRIC_DEVICE_ALLOWED_FIELDS, 'BIOMETRIC_SECURITY')) return;
    const reference = cleanText(req.body.device_reference, 120);
    const name = cleanText(req.body.device_name, 160);
    const vendor = cleanText(req.body.vendor, 120) || null;
    const apiBaseUrl = validateIntegrationUrl(cleanText(req.body.api_base_url, 500) || null);
    const logsEndpoint = cleanText(req.body.logs_endpoint, 255) || '/attendance/logs';
    const authType = cleanText(req.body.auth_type, 20).toUpperCase() || 'API_KEY';
    const authHeader = cleanText(req.body.auth_header_name, 100) || 'x-biometric-api-key';
    const authSecret = String(req.body.auth_secret || '');

    if (!/^[a-zA-Z0-9._:-]+$/.test(reference) || name.length < 2) {
      return res.status(400).json({ error: 'Valid device_reference and device_name are required.' });
    }
    if (!['API_KEY', 'BEARER', 'HMAC', 'OAUTH2', 'MTLS', 'NONE'].includes(authType)) {
      return res.status(400).json({ error: 'Unsupported biometric authentication type.' });
    }
    if (process.env.NODE_ENV === 'production' && authType === 'NONE') {
      return res.status(400).json({ error: 'Biometric device authentication is required in production.' });
    }
    if (!['MTLS', 'NONE'].includes(authType) && authSecret.length < 8) {
      return res.status(400).json({ error: 'Authentication secret must be at least 8 characters.' });
    }

    const encryptedSecret = authSecret ? encryptAES256(authSecret) : null;
    const [result] = await pool.execute(
      `INSERT INTO biometric_device
         (device_reference, device_name, vendor, api_base_url, logs_endpoint,
          auth_type, auth_header_name, auth_secret_encrypted, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reference, name, vendor, apiBaseUrl, logsEndpoint, authType, authHeader, encryptedSecret, req.user.id, req.user.id]
    );
    await writeAuditLog(req.user.id, null, `BIOMETRIC DEVICE CREATED [ID:${result.insertId}]`, null, safeJson({ reference, name, vendor, authType }), req);
    res.status(201).json({ message: 'Biometric device created.', device_id: result.insertId });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Device reference already exists.' });
    res.status(400).json({ error: safeClientError(err, 'Failed to create biometric device.') });
  }
});

router.put('/biometric/devices/:deviceId', requireAuth, requireRole(SYSTEM_ADMIN_ROLES), async (req, res) => {
  try {
    if (rejectUnsupportedFields(req, res, BIOMETRIC_DEVICE_ALLOWED_FIELDS, 'BIOMETRIC_SECURITY')) return;
    const deviceId = positiveInteger(req.params.deviceId, 'deviceId');
    const [rows] = await pool.execute('SELECT * FROM biometric_device WHERE device_id = ?', [deviceId]);
    if (!rows.length) return res.status(404).json({ error: 'Biometric device not found.' });
    const oldDevice = rows[0];

    const name = cleanText(req.body.device_name ?? oldDevice.device_name, 160);
    const vendor = cleanText(req.body.vendor ?? oldDevice.vendor, 120) || null;
    const apiBaseUrl = validateIntegrationUrl(cleanText(req.body.api_base_url ?? oldDevice.api_base_url, 500) || null);
    const logsEndpoint = cleanText(req.body.logs_endpoint ?? oldDevice.logs_endpoint, 255) || '/attendance/logs';
    const authType = cleanText(req.body.auth_type ?? oldDevice.auth_type, 20).toUpperCase();
    const authHeader = cleanText(req.body.auth_header_name ?? oldDevice.auth_header_name, 100) || 'x-biometric-api-key';
    const isActive = req.body.is_active === false || req.body.is_active === 0 ? 0 : 1;
    const encryptedSecret = req.body.auth_secret
      ? encryptAES256(String(req.body.auth_secret))
      : oldDevice.auth_secret_encrypted;

    if (!['API_KEY', 'BEARER', 'HMAC', 'OAUTH2', 'MTLS', 'NONE'].includes(authType)) {
      return res.status(400).json({ error: 'Unsupported biometric authentication type.' });
    }
    if (process.env.NODE_ENV === 'production' && authType === 'NONE') {
      return res.status(400).json({ error: 'Biometric device authentication is required in production.' });
    }
    if (!['MTLS', 'NONE'].includes(authType) && !encryptedSecret) {
      return res.status(400).json({ error: 'Authentication secret must be configured.' });
    }

    await pool.execute(
      `UPDATE biometric_device
          SET device_name = ?, vendor = ?, api_base_url = ?, logs_endpoint = ?,
              auth_type = ?, auth_header_name = ?, auth_secret_encrypted = ?,
              is_active = ?, updated_by = ?
        WHERE device_id = ?`,
      [name, vendor, apiBaseUrl, logsEndpoint, authType, authHeader, encryptedSecret, isActive, req.user.id, deviceId]
    );
    await writeAuditLog(req.user.id, null, `BIOMETRIC DEVICE UPDATED [ID:${deviceId}]`, safeJson({ name: oldDevice.device_name, active: oldDevice.is_active }), safeJson({ name, active: isActive }), req);
    res.json({ message: 'Biometric device updated.' });
  } catch (err) {
    res.status(400).json({ error: safeClientError(err, 'Failed to update biometric device.') });
  }
});

router.get('/biometric/mappings', requireAuth, requireRole(BIOMETRIC_ADMIN_ROLES), async (req, res) => {
  try {
    const deviceId = req.query.device_id ? positiveInteger(req.query.device_id, 'device_id') : null;
    const [rows] = await pool.execute(
      `SELECT bem.mapping_id, bem.device_id, bd.device_name, bem.employee_id,
              e.employee_code, e.first_name, e.middle_name, e.last_name,
              bem.biometric_user_id_encrypted, bem.is_active, bem.created_at, bem.updated_at
         FROM biometric_employee_mapping bem
         JOIN biometric_device bd ON bd.device_id = bem.device_id
         JOIN employees e ON e.id = bem.employee_id
        ${deviceId ? 'WHERE bem.device_id = ?' : ''}
        ORDER BY bd.device_name, e.last_name, e.first_name`,
      deviceId ? [deviceId] : []
    );
    res.json(rows.map(row => ({
      ...row,
      ...withAttendanceEmployeeName(row),
      biometric_user_id_encrypted: undefined,
      biometric_user_reference: 'Encrypted reference',
    })));
  } catch (err) {
    res.status(400).json({ error: safeClientError(err, 'Failed to save biometric mapping.') });
  }
});

router.post('/biometric/mappings', requireAuth, requireRole(BIOMETRIC_ADMIN_ROLES), async (req, res) => {
  try {
    if (rejectUnsupportedFields(req, res, BIOMETRIC_MAPPING_ALLOWED_FIELDS, 'BIOMETRIC_SECURITY')) return;
    const deviceId = positiveInteger(req.body.device_id, 'device_id');
    const employeeId = positiveInteger(req.body.employee_id, 'employee_id');
    const biometricUserId = cleanText(req.body.biometric_user_id, 190);
    if (!biometricUserId) return res.status(400).json({ error: 'biometric_user_id is required.' });

    const [validRows] = await pool.execute(
      `SELECT
         EXISTS(SELECT 1 FROM biometric_device WHERE device_id = ? AND is_active = 1) AS valid_device,
         EXISTS(SELECT 1 FROM employees WHERE id = ? AND status = 'Active') AS valid_employee`,
      [deviceId, employeeId]
    );
    if (!validRows[0].valid_device || !validRows[0].valid_employee) {
      return res.status(400).json({ error: 'An active device and active employee are required.' });
    }

    const userHash = sha256(biometricUserId);
    const encryptedId = encryptAES256(biometricUserId);
    const [result] = await pool.execute(
      `INSERT INTO biometric_employee_mapping
         (device_id, employee_id, biometric_user_hash, biometric_user_id_encrypted, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         employee_id = VALUES(employee_id),
         biometric_user_id_encrypted = VALUES(biometric_user_id_encrypted),
         is_active = 1,
         updated_by = VALUES(updated_by)`,
      [deviceId, employeeId, userHash, encryptedId, req.user.id, req.user.id]
    );
    await writeAuditLog(req.user.id, employeeId, `BIOMETRIC MAPPING SAVED [DEVICE:${deviceId}]`, null, safeJson({ biometric_reference: maskReference(biometricUserId) }), req);
    res.status(result.insertId ? 201 : 200).json({ message: 'Encrypted biometric mapping saved.' });
  } catch (err) {
    res.status(400).json({ error: safeClientError(err, 'Failed to save biometric mapping.') });
  }
});

router.delete('/biometric/mappings/:mappingId', requireAuth, requireRole(BIOMETRIC_ADMIN_ROLES), async (req, res) => {
  try {
    const mappingId = positiveInteger(req.params.mappingId, 'mappingId');
    const [rows] = await pool.execute('SELECT employee_id FROM biometric_employee_mapping WHERE mapping_id = ?', [mappingId]);
    if (!rows.length) return res.status(404).json({ error: 'Biometric mapping not found.' });
    await pool.execute('UPDATE biometric_employee_mapping SET is_active = 0, updated_by = ? WHERE mapping_id = ?', [req.user.id, mappingId]);
    await writeAuditLog(req.user.id, rows[0].employee_id, `BIOMETRIC MAPPING DISABLED [ID:${mappingId}]`, null, null, req);
    res.json({ message: 'Biometric mapping disabled.' });
  } catch (err) {
    res.status(400).json({ error: safeClientError(err, 'Failed to disable biometric mapping.') });
  }
});

router.get('/biometric/health', requireAuth, requireRole(BIOMETRIC_ADMIN_ROLES), async (_req, res) => {
  try {
    const [devices] = await pool.execute(
      `SELECT bd.device_id, bd.device_reference, bd.device_name, bd.vendor, bd.is_active,
              bd.last_sync_at, bd.last_success_at, bd.last_error_at, bd.last_error_message,
              (SELECT COUNT(*) FROM biometric_employee_mapping bem WHERE bem.device_id = bd.device_id AND bem.is_active = 1) AS mapped_employees,
              (SELECT COUNT(*) FROM biometric_scan_event bse WHERE bse.device_id = bd.device_id AND bse.verification_status IN ('UNMAPPED','MALFORMED','REJECTED','NEEDS_REVIEW')) AS exceptions
         FROM biometric_device bd
        ORDER BY bd.device_name`
    );
    const [syncLogs] = await pool.execute(
      `SELECT bsl.*, bd.device_name
         FROM biometric_sync_log bsl
         JOIN biometric_device bd ON bd.device_id = bsl.device_id
        ORDER BY bsl.started_at DESC
        LIMIT 100`
    );
    res.json({ devices, sync_logs: syncLogs });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load biometric synchronization health.' });
  }
});

router.get('/biometric/exceptions', requireAuth, requireRole(HR_ROLES), async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT bse.scan_event_id, bse.external_event_id, bse.device_id, bd.device_name,
              bse.employee_id, e.employee_code, e.first_name, e.middle_name, e.last_name,
              bse.scan_timestamp, bse.attendance_type, bse.verification_status,
              bse.error_message, bse.created_at
         FROM biometric_scan_event bse
         JOIN biometric_device bd ON bd.device_id = bse.device_id
         LEFT JOIN employees e ON e.id = bse.employee_id
        WHERE bse.verification_status IN ('UNMAPPED','MALFORMED','REJECTED','NEEDS_REVIEW')
        ORDER BY bse.created_at DESC
        LIMIT 200`
    );
    res.json(rows.map(withAttendanceEmployeeName));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch biometric exceptions.' });
  }
});

router.get('/biometric/events', requireAuth, requireRole(BIOMETRIC_ADMIN_ROLES), async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT bse.scan_event_id, bse.employee_id, e.employee_code, e.first_name, e.middle_name, e.last_name,
              bse.scan_timestamp, bse.attendance_type, bse.verification_status,
              bse.error_message, bse.created_at
         FROM biometric_scan_event bse
         LEFT JOIN employees e ON e.id = bse.employee_id
        ORDER BY bse.created_at DESC
        LIMIT 50`
    );
    res.json(rows.map(withAttendanceEmployeeName));
  } catch (err) {
    console.error('[attendance/biometric-events]', err.message);
    res.status(500).json({ error: 'Failed to fetch recent fingerprint attendance activity.' });
  }
});

/* ============================================================
   Employee self-service and role-scoped attendance views
   ============================================================ */

router.get('/my-records', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    if (!req.user.employeeId) return res.status(400).json({ error: 'Account is not linked to an employee record.' });
    await ensureAttendanceLogMetricColumns(pool);
    await ensureAttendanceSummaryPolicyColumns(pool);
    const [rows] = await pool.execute(
      `SELECT al.attendance_id, al.employee_id, al.date, al.time_in, al.time_out,
              al.am_time_in, al.am_time_out, al.pm_time_in, al.pm_time_out, al.overtime_hours,
              al.late_minutes, al.undertime_minutes, al.overtime_minutes,
              al.overtime_status, al.overtime_reviewed_at, al.overtime_review_reason,
              al.absences, al.status, al.verification_status,
              ats.regular_minutes, ats.overtime_minutes AS summary_overtime_minutes,
              ats.overtime_status AS summary_overtime_status,
              ats.late_minutes AS summary_late_minutes,
              ats.undertime_minutes AS summary_undertime_minutes,
              ats.attendance_status, ats.payroll_eligible,
              COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(ats.policy_snapshot_json, '$.minimum_overtime_minutes')) AS UNSIGNED), 30) AS minimum_overtime_minutes
         FROM attendance_log al
         LEFT JOIN attendance_summary ats ON ats.attendance_id = al.attendance_id
        WHERE al.employee_id = ?
        ORDER BY al.updated_at DESC, al.date DESC
        LIMIT 200`,
      [req.user.employeeId]
    );
    res.json(rows.map(removeAttendanceSecurityMetadata));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch personal attendance records.' });
  }
});

router.get('/my-summary', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    if (!req.user.employeeId) {
	return res.json ({
		total_days: 0,
		present_days: 0,
		late_days: 0,
		absent_days: 0,
		total_overtime: 0,
		total_hours: 0
	});
}
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS total_days,
              SUM(CASE WHEN attendance_status IN ('Present','Late') THEN 1 ELSE 0 END) AS present_days,
              SUM(CASE WHEN attendance_status = 'Late' THEN 1 ELSE 0 END) AS late_days,
              SUM(CASE WHEN attendance_status = 'Absent' THEN 1 ELSE 0 END) AS absent_days,
              COALESCE(SUM(overtime_minutes), 0) / 60 AS total_overtime,
              COALESCE(SUM(regular_minutes), 0) / 60 AS total_hours
         FROM attendance_summary
        WHERE employee_id = ?
          AND MONTH(attendance_date) = MONTH(CURDATE())
          AND YEAR(attendance_date) = YEAR(CURDATE())`,
      [req.user.employeeId]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch personal attendance summary.' });
  }
});

router.get('/status', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    if (!req.user.employeeId) return res.json({ clocked_in: false, clocked_out: false });
    const today = new Date().toISOString().slice(0, 10);
    const [rows] = await pool.execute(
      `SELECT attendance_id, date, time_in, time_out, am_time_in, am_time_out, pm_time_in, pm_time_out,
              status, verification_status
         FROM attendance_log
        WHERE employee_id = ? AND date = ?`,
      [req.user.employeeId, today]
    );
    if (!rows.length) return res.json({ clocked_in: false, clocked_out: false });
    res.json({ clocked_in: !!rows[0].time_in, clocked_out: !!rows[0].time_out, record: rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get attendance status.' });
  }
});

router.get('/employees', requireAuth, requireRole([...HR_ROLES, ...PAYROLL_OFFICER_ROLES, ...PAYROLL_MANAGER_ROLES]), async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT e.id, e.employee_code, e.first_name, e.middle_name, e.last_name,
              e.position, d.name AS department
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
        WHERE LOWER(COALESCE(e.status, 'Active')) NOT IN ('inactive', 'resigned', 'terminated', 'separated', 'offboarded')
        ORDER BY e.employee_code, e.last_name, e.first_name
        LIMIT 1000`
    );
    res.json(rows.map(row => {
      const employee = withAttendanceEmployeeName(row);
      return {
        id: employee.id,
        employee_code: employee.employee_code,
        employee_name: employee.employee_name,
        department: employee.department,
        position: employee.position,
      };
    }));
  } catch (err) {
    console.error('[attendance/employees]', err.message);
    res.status(500).json({ error: 'Failed to fetch attendance employee dropdown.' });
  }
});

router.get('/all', requireAuth, requireRole(ATTENDANCE_RECORD_VIEW_ROLES), async (req, res) => {
  try {
    await ensureAttendanceLogMetricColumns(pool);
    await ensureAttendanceSummaryPolicyColumns(pool);
    const { date, month, year } = req.query;
    const search = cleanText(req.query.search, 80);
    const department = cleanText(req.query.department, 80);
    const status = cleanText(req.query.status, 40);
    const validationStatus = cleanText(req.query.validation_status, 40).toUpperCase();
    const payrollReady = cleanText(req.query.payroll_ready, 1);
    const dateFrom = cleanText(req.query.date_from, 10);
    const dateTo = cleanText(req.query.date_to, 10);
    const normalizedStatus = status.toLowerCase();
    const absenceDates = normalizedStatus === 'absent'
      ? absenceDateKeys({ date, dateFrom, dateTo, month, year }, todayManilaDateKey())
      : [];
    const conditions = [];
    const values = [];
    if (normalizedStatus === 'absent') {
      if (!absenceDates.length) return res.json([]);
      conditions.push(`al.date IN (${absenceDates.map(() => '?').join(',')})`);
      values.push(...absenceDates);
    } else if (date) {
      if (!isDate(date)) return res.status(400).json({ error: 'date must use YYYY-MM-DD format.' });
      conditions.push('al.date = ?');
      values.push(date);
    }
    if (dateFrom) {
      if (!isDate(dateFrom)) return res.status(400).json({ error: 'date_from must use YYYY-MM-DD format.' });
      conditions.push('al.date >= ?');
      values.push(dateFrom);
    }
    if (dateTo) {
      if (!isDate(dateTo)) return res.status(400).json({ error: 'date_to must use YYYY-MM-DD format.' });
      conditions.push('al.date <= ?');
      values.push(dateTo);
    }
    if (month && year) {
      conditions.push('MONTH(al.date) = ? AND YEAR(al.date) = ?');
      values.push(Number(month), Number(year));
    }
    if (search) {
      conditions.push("(e.employee_code LIKE ? OR e.first_name LIKE ? OR e.last_name LIKE ?)");
      values.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (department) {
      conditions.push('d.name = ?');
      values.push(department);
    }
    if (status) {
      if (normalizedStatus === 'late') {
        conditions.push('COALESCE(ats.late_minutes, al.late_minutes, 0) > 0');
      } else if (normalizedStatus === 'undertime') {
        conditions.push('COALESCE(ats.undertime_minutes, al.undertime_minutes, 0) > 0');
      } else if (normalizedStatus === 'overtime') {
        conditions.push('COALESCE(ats.overtime_minutes, al.overtime_minutes, 0) > 0');
      } else {
        conditions.push('COALESCE(ats.attendance_status, al.status) = ?');
        values.push(status);
      }
    }
    if (validationStatus) {
      conditions.push('al.verification_status = ?');
      values.push(validationStatus === 'VALIDATED' ? 'PAYROLL_READY' : validationStatus);
    }
    if (payrollReady === '1') conditions.push("al.verification_status = 'PAYROLL_READY'");
    if (payrollReady === '0') conditions.push("COALESCE(al.verification_status, '') <> 'PAYROLL_READY'");

    const [rows] = await pool.execute(
      `SELECT al.attendance_id, al.employee_id, al.date, al.time_in, al.time_out,
              al.am_time_in, al.am_time_out, al.pm_time_in, al.pm_time_out,
              al.overtime_hours, al.late_minutes, al.undertime_minutes, al.overtime_minutes,
              al.overtime_status, al.overtime_reviewed_at, al.overtime_review_reason,
              al.status, al.verification_status,
              al.source, al.integrity_hash, al.device_id,
              ats.regular_minutes, ats.overtime_minutes AS summary_overtime_minutes,
              ats.overtime_status AS summary_overtime_status,
              ats.late_minutes AS summary_late_minutes,
              ats.undertime_minutes AS summary_undertime_minutes,
              ats.attendance_status, ats.payroll_eligible,
              COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(ats.policy_snapshot_json, '$.minimum_overtime_minutes')) AS UNSIGNED), 30) AS minimum_overtime_minutes,
              e.first_name, e.middle_name, e.last_name,
              e.employee_code, d.name AS department, e.position
         FROM attendance_log al
         JOIN employees e ON e.id = al.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN attendance_summary ats ON ats.attendance_id = al.attendance_id
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY al.updated_at DESC, al.date DESC, al.time_in DESC
        LIMIT 500`,
      values
    );
    const syntheticAbsences = normalizedStatus === 'absent' && !validationStatus && payrollReady === ''
      ? await loadSyntheticAbsenceRows(pool, { dates: absenceDates, search, department })
      : [];
    const records = [...rows, ...syntheticAbsences]
      .sort((left, right) => String(right.date || '').localeCompare(String(left.date || ''))
        || String(left.employee_code || '').localeCompare(String(right.employee_code || '')))
      .slice(0, 500);
    res.json(records.map(row => attendanceRecordForRole(req, row)));
  } catch (err) {
    console.error('[attendance/all]', err.message);
    res.status(err.statusCode === 400 ? 400 : 500).json({
      error: err.statusCode === 400 ? err.message : 'Failed to fetch attendance records.',
    });
  }
});

router.get('/policies', requireAuth, requireRole([...HR_ROLES, ...SYSTEM_ADMIN_ROLES]), async (req, res) => {
  try {
    const policy = await getActiveAttendancePolicy(pool, req.query.as_of || null);
    res.json(policy);
  } catch (err) {
    console.error('[attendance/policies:get]', err.message);
    res.status(500).json({ error: 'Failed to fetch attendance policies.' });
  }
});

router.put('/policies', requireAuth, requireRole([...HR_ROLES, ...SYSTEM_ADMIN_ROLES]), async (req, res) => {
  try {
    if (rejectUnsupportedFields(req, res, ATTENDANCE_POLICY_ALLOWED_FIELDS)) return;
    await ensureAttendancePolicySettings(pool);
    const body = req.body || {};
    const lateDeductionMethod = 'auto_compute';
    const undertimeDeductionMethod = 'auto_compute';
    const [startTime, endTime] = cleanText(body.work_schedule, 50).split('-');
    const normalized = {
      ...body,
      work_start_time: body.work_start_time || startTime || '08:00',
      work_end_time: body.work_end_time || endTime || '17:00',
      grace_period_minutes: String(Math.max(0, Number(body.grace_period_minutes || 0))),
      duplicate_scan_window_seconds: String(Math.max(0, Number(body.duplicate_scan_window_seconds || 0))),
      require_hr_validation: String(requestBool(body.hr_validation_required ?? body.require_hr_validation, true)),
      overtime_threshold_minutes: String(Math.max(0, Math.round(Number(body.overtime_threshold_hours || 0) * 60) || Number(body.overtime_threshold_minutes || 0))),
      missing_timeout_handling: cleanText(body.missing_timeout_handling, 80) || 'Needs Review',
      payroll_attendance_source: body.payroll_attendance_source || (String(body.payroll_ready_rules || '').toLowerCase().includes('validated') ? 'validated' : 'payroll_ready'),
      late_deduction_method: lateDeductionMethod,
      undertime_deduction_method: undertimeDeductionMethod,
      enable_holiday_rules: String(requestBool(body.enable_holiday_rules, false)),
      regular_holiday_multiplier: String(Math.max(0, Number(body.regular_holiday_multiplier || 2))),
      special_holiday_multiplier: String(Math.max(0, Number(body.special_holiday_multiplier || 1.3))),
      rest_day_multiplier: String(Math.max(0, Number(body.rest_day_multiplier || 1.3))),
      holiday_overtime_multiplier: String(Math.max(0, Number(body.holiday_overtime_multiplier || 1.3))),
    };
    const { changes, policy } = await saveAttendancePolicyValues(pool, normalized, req.user.id);
    await writeAuditLog(
      req.user.id,
      req.user.employeeId || null,
      changes.length ? 'ATTENDANCE POLICY UPDATED' : 'ATTENDANCE POLICY SAVED',
      null,
      safeJson(changes),
      req
    );
    res.json({ message: 'Attendance policies saved.', changes, policy });
  } catch (err) {
    console.error('[attendance/policies:put]', err.message);
    res.status(500).json({ error: 'Failed to save attendance policies.' });
  }
});

router.get('/summaries', requireAuth, requireRole(SUMMARY_ROLES), async (req, res) => {
  try {
    const { date, month, year } = req.query;
    const conditions = [];
    const values = [];
    if (date) {
      if (!isDate(date)) return res.status(400).json({ error: 'date must use YYYY-MM-DD format.' });
      conditions.push('ats.attendance_date = ?');
      values.push(date);
    }
    if (month && year) {
      conditions.push('MONTH(ats.attendance_date) = ? AND YEAR(ats.attendance_date) = ?');
      values.push(Number(month), Number(year));
    }

    const [rows] = await pool.execute(
      `SELECT ats.*, e.employee_code, e.first_name, e.middle_name, e.last_name,
              d.name AS department
         FROM attendance_summary ats
         JOIN employees e ON e.id = ats.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
        ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
        ORDER BY ats.attendance_date DESC, e.last_name, e.first_name
        LIMIT 500`,
      values
    );
    res.json(rows.map(withAttendanceEmployeeName));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch payroll attendance summaries.' });
  }
});

router.get('/overview', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const [[todayRow]] = await pool.execute("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today");
    const today = todayRow?.today || new Date().toISOString().slice(0, 10);
    const conditions = ['attendance_date = ?'];
    const values = [today];
    const leaveSummaryConditions = ['attendance_date = ?', "attendance_status = 'On Leave'"];
    const leaveSummaryValues = [today];
    const leaveRequestConditions = ["status = 'Approved'", '? BETWEEN date_from AND date_to'];
    const leaveRequestValues = [today];
    if (req.user.role === 'employee') {
      if (!req.user.employeeId) return res.status(400).json({ error: 'Account is not linked to an employee record.' });
      conditions.push('employee_id = ?');
      values.push(req.user.employeeId);
      leaveSummaryConditions.push('employee_id = ?');
      leaveSummaryValues.push(req.user.employeeId);
      leaveRequestConditions.push('employee_id = ?');
      leaveRequestValues.push(req.user.employeeId);
    } else if (!SUMMARY_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Attendance overview is not available for this role.' });
    }

    const [[stats], [leaveRows]] = await Promise.all([
      pool.execute(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN attendance_status = 'Present' THEN 1 ELSE 0 END) AS present,
              SUM(CASE WHEN attendance_status = 'Late' THEN 1 ELSE 0 END) AS late,
              SUM(CASE WHEN attendance_status = 'Absent' THEN 1 ELSE 0 END) AS absent,
              COALESCE(SUM(regular_minutes), 0) / 60 AS total_hours,
              COALESCE(SUM(overtime_minutes), 0) / 60 AS total_overtime
         FROM attendance_summary
        WHERE ${conditions.join(' AND ')}`,
      values
      ),
      pool.execute(
        `SELECT COUNT(DISTINCT employee_id) AS approved_on_leave
           FROM (
             SELECT employee_id
               FROM attendance_summary
              WHERE ${leaveSummaryConditions.join(' AND ')}
             UNION
             SELECT employee_id
               FROM leave_requests
              WHERE ${leaveRequestConditions.join(' AND ')}
           ) leave_today`,
        [...leaveSummaryValues, ...leaveRequestValues]
      ),
    ]);
    res.json({ date: today, ...stats[0], on_leave: leaveRows[0]?.approved_on_leave || 0 });
  } catch (err) {
    console.error('[attendance/overview]', err);
    res.status(500).json({ error: 'Failed to fetch attendance overview.' });
  }
});

/* ============================================================
   HR-only manual correction and verification
   ============================================================ */

router.post('/manual', requireAuth, requireRole(HR_ROLES), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (rejectUnsupportedFields(req, res, MANUAL_ATTENDANCE_ALLOWED_FIELDS)) return;
    const employeeId = positiveInteger(req.body.employee_id, 'employee_id');
    const date = cleanText(req.body.date, 10);
    if (!isDate(date)) {
      return res.status(400).json({ error: 'Manual attendance date must be a valid date using YYYY-MM-DD format.' });
    }
    const policy = await getActiveAttendancePolicy(pool, date || null, { employee_id: employeeId });
    if (!policy.allow_manual_attendance) {
      return res.status(403).json({ error: 'Manual attendance is disabled by the active attendance policy.' });
    }
    const dtrTimes = normalizeDtrTimes(req.body);
    const timeIn = dtrTimes.time_in;
    const timeOut = dtrTimes.time_out;
    const reason = requireReason(req.body.reason);
    const suppliedTimes = [timeIn, timeOut].filter(Boolean);
    if (suppliedTimes.some(value => !isTime(value))) {
      return res.status(400).json({ error: 'Valid time values are required.' });
    }
    if (!suppliedTimes.length) return res.status(400).json({ error: 'At least one manual punch is required.' });
    const [employeeRows] = await pool.execute('SELECT status FROM employees WHERE id = ? LIMIT 1', [employeeId]);
    if (!employeeRows.length || String(employeeRows[0].status || 'Active') !== 'Active') {
      return res.status(400).json({ error: 'Attendance can only be recorded for active employees.' });
    }

    await conn.beginTransaction();
    const [existing] = await conn.execute('SELECT * FROM attendance_log WHERE employee_id = ? AND date = ? FOR UPDATE', [employeeId, date]);
    if (existing.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'Attendance already exists. Use correction instead.' });
    }

    const verificationStatus = timeIn && timeOut && !policy.require_hr_validation && policy.auto_payroll_ready ? 'PAYROLL_READY' : (timeIn && timeOut ? 'PENDING_VALIDATION' : 'NEEDS_REVIEW');
    const status = timeIn && timeOut ? getAttendanceStatusForTimeIn(timeIn, policy) : 'Incomplete';
    const [result] = await conn.execute(
      `INSERT INTO attendance_log
         (employee_id, date, time_in, time_out, am_time_in, am_time_out, pm_time_in, pm_time_out, status, verification_status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'HR_MANUAL_ADJUSTMENT')`,
      [
        employeeId,
        date,
        timeIn,
        timeOut,
        dtrTimes.am_time_in,
        dtrTimes.am_time_out,
        dtrTimes.pm_time_in,
        dtrTimes.pm_time_out,
        status,
        verificationStatus,
      ]
    );
    await conn.execute(
      `INSERT INTO attendance_adjustment
         (attendance_id, employee_id, adjustment_type, reason, new_value,
          requested_by, approved_by, approved_at)
       VALUES (?, ?, 'MANUAL_ATTENDANCE', ?, ?, ?, ?, NOW())`,
      [result.insertId, employeeId, reason, safeJson({ date, ...dtrTimes }), req.user.id, req.user.id]
    );
    await appendIntegrityEntry(conn, result.insertId, 'HR_MANUAL_ATTENDANCE');
    await conn.commit();
    await writeAuditLog(req.user.id, employeeId, `MANUAL ATTENDANCE CREATED [ID:${result.insertId}] Reason:${reason}`, null, safeJson({ date, timeIn, timeOut }), req);
    await emitAttendanceRealtimeById(result.insertId, timeOut ? 'TIME_OUT' : 'TIME_IN');
    res.status(201).json({ message: 'Manual attendance created and audited.', attendance_id: result.insertId });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: safeClientError(err, 'Failed to create manual attendance.') });
  } finally {
    conn.release();
  }
});

router.patch('/:id/override', requireAuth, requireRole(HR_ROLES), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (rejectUnsupportedFields(req, res, ATTENDANCE_OVERRIDE_ALLOWED_FIELDS)) return;
    const attendanceId = positiveInteger(req.params.id, 'id');
    const reason = requireReason(req.body.reason);
    const hasTimeChange = ['time_in', 'time_out', 'am_time_in', 'am_time_out', 'pm_time_in', 'pm_time_out']
      .some(field => Object.prototype.hasOwnProperty.call(req.body || {}, field));
    if (!hasTimeChange) return res.status(400).json({ error: 'Provide at least one DTR time to correct.' });

    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT * FROM attendance_log WHERE attendance_id = ? FOR UPDATE', [attendanceId]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Attendance record not found.' });
    }
    const record = rows[0];
    const policy = await getActiveAttendancePolicy(pool, record.date || null, { employee_id: record.employee_id });
    if (!policy.allow_hr_correction) {
      await conn.rollback();
      return res.status(403).json({ error: 'HR attendance correction is disabled by the active attendance policy.' });
    }
    const dtrTimes = normalizeDtrTimes(req.body, record);
    const suppliedTimes = [dtrTimes.time_in, dtrTimes.time_out].filter(Boolean);
    if (suppliedTimes.some(value => !isTime(value))) {
      await conn.rollback();
      return res.status(400).json({ error: 'Times must use HH:MM or HH:MM:SS format.' });
    }
    const oldValue = {
      time_in: record.time_in,
      time_out: record.time_out,
      am_time_in: record.am_time_in,
      am_time_out: record.am_time_out,
      pm_time_in: record.pm_time_in,
      pm_time_out: record.pm_time_out,
      status: record.status,
      verification_status: record.verification_status,
    };
    const newTimeIn = dtrTimes.time_in;
    const newTimeOut = dtrTimes.time_out;
    const status = newTimeIn && newTimeOut
      ? getAttendanceStatusForTimeIn(newTimeIn, policy)
      : 'Incomplete';
    const verificationStatus = newTimeIn && newTimeOut ? 'CORRECTED_BY_HR' : 'NEEDS_REVIEW';

    await conn.execute(
      `UPDATE attendance_log
          SET time_in = ?, time_out = ?,
              am_time_in = ?, am_time_out = ?, pm_time_in = ?, pm_time_out = ?,
              status = ?, verification_status = ?,
              source = 'HR_MANUAL_ADJUSTMENT'
        WHERE attendance_id = ?`,
      [
        newTimeIn,
        newTimeOut,
        dtrTimes.am_time_in,
        dtrTimes.am_time_out,
        dtrTimes.pm_time_in,
        dtrTimes.pm_time_out,
        status,
        verificationStatus,
        attendanceId,
      ]
    );
    const newValue = { ...dtrTimes, status, verification_status: verificationStatus };
    await conn.execute(
      `INSERT INTO attendance_adjustment
         (attendance_id, employee_id, adjustment_type, reason, old_value, new_value,
          requested_by, approved_by, approved_at)
       VALUES (?, ?, 'MANUAL_CORRECTION', ?, ?, ?, ?, ?, NOW())`,
      [attendanceId, record.employee_id, reason, safeJson(oldValue), safeJson(newValue), req.user.id, req.user.id]
    );
    await appendIntegrityEntry(conn, attendanceId, 'HR_MANUAL_CORRECTION');
    await conn.commit();
    await writeAuditLog(req.user.id, record.employee_id, `ATTENDANCE CORRECTED [ID:${attendanceId}] Reason:${reason}`, safeJson(oldValue), safeJson(newValue), req);
    await emitAttendanceRealtimeById(attendanceId, 'CORRECTED_BY_HR');
    res.json({ message: 'Attendance correction saved and audited.' });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: safeClientError(err, 'Failed to save attendance correction.') });
  } finally {
    conn.release();
  }
});

router.patch('/:id/verify', requireAuth, requireRole(HR_ROLES), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (rejectUnsupportedFields(req, res, ATTENDANCE_VERIFY_ALLOWED_FIELDS)) return;
    const attendanceId = positiveInteger(req.params.id, 'id');
    const requestedStatus = cleanText(req.body.verification_status, 30).toUpperCase();
    if (!['VALIDATED', 'PAYROLL_READY', 'REJECTED', 'NEEDS_REVIEW'].includes(requestedStatus)) {
      return res.status(400).json({ error: 'verification_status must be PAYROLL_READY, REJECTED, or NEEDS_REVIEW.' });
    }
    const verificationStatus = requestedStatus === 'VALIDATED' ? 'PAYROLL_READY' : requestedStatus;
    const reason = verificationStatus === 'PAYROLL_READY'
      ? (cleanText(req.body.reason, 500) || 'Attendance validated by HR.')
      : requireReason(req.body.reason);

    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT * FROM attendance_log WHERE attendance_id = ? FOR UPDATE', [attendanceId]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Attendance record not found.' });
    }
    const record = rows[0];
    const policy = await getActiveAttendancePolicy(pool, record.date || null, { employee_id: record.employee_id });
    if (!policy.require_hr_validation && verificationStatus !== 'REJECTED' && verificationStatus !== 'NEEDS_REVIEW') {
      await conn.rollback();
      return res.status(400).json({ error: 'HR validation is not required by the active attendance policy.' });
    }
    const missingPunches = missingDtrPunches(record);
    if (verificationStatus === 'PAYROLL_READY' && (!record.time_in || !record.time_out || missingPunches.length)) {
      await conn.rollback();
      return res.status(400).json({
        error: 'Incomplete DTR cannot be marked payroll ready until HR correction is completed.',
        missing_punches: missingPunches,
      });
    }
    await conn.execute('UPDATE attendance_log SET verification_status = ? WHERE attendance_id = ?', [verificationStatus, attendanceId]);
    await conn.execute(
      `INSERT INTO attendance_adjustment
         (attendance_id, employee_id, adjustment_type, reason, old_value, new_value,
          requested_by, approved_by, approved_at)
       VALUES (?, ?, 'VERIFICATION', ?, ?, ?, ?, ?, NOW())`,
      [attendanceId, record.employee_id, reason, safeJson({ verification_status: record.verification_status }), safeJson({ verification_status: verificationStatus }), req.user.id, req.user.id]
    );
    await appendIntegrityEntry(conn, attendanceId, `HR_VERIFICATION_${verificationStatus}`);
    await conn.commit();
    await writeAuditLog(req.user.id, record.employee_id, `ATTENDANCE ${verificationStatus} [ID:${attendanceId}] Reason:${reason}`, record.verification_status, verificationStatus, req);
    await emitAttendanceRealtimeById(attendanceId, verificationStatus);
    res.json({ message: `Attendance marked ${verificationStatus}.` });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: safeClientError(err, 'Failed to update attendance verification.') });
  } finally {
    conn.release();
  }
});

router.patch('/:id/overtime', requireAuth, requireRole(HR_ROLES), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (rejectUnsupportedFields(req, res, ATTENDANCE_OVERTIME_ALLOWED_FIELDS)) return;
    const attendanceId = positiveInteger(req.params.id, 'id');
    const hours = Number(req.body.overtime_hours);
    const reason = requireReason(req.body.reason);
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) {
      return res.status(400).json({ error: 'overtime_hours must be between 0 and 24.' });
    }
    await ensureAttendanceLogMetricColumns(conn);
    await ensureAttendanceSummaryPolicyColumns(conn);
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT * FROM attendance_log WHERE attendance_id = ? FOR UPDATE', [attendanceId]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Attendance record not found.' });
    }
    const record = rows[0];
    const policy = await getActiveAttendancePolicy(pool, record.date || null, { employee_id: record.employee_id });
    if (!policy.enable_overtime) {
      await conn.rollback();
      return res.status(403).json({ error: 'Overtime is disabled by the active attendance policy.' });
    }
    if (hours > 0 && Math.round(hours * 60) < policy.minimum_overtime_minutes) {
      await conn.rollback();
      return res.status(400).json({ error: `Overtime must be at least ${policy.minimum_overtime_minutes} minutes.` });
    }
    const overtimeStatus = hours <= 0
      ? 'NONE'
      : policy.overtime_approval_required ? 'PENDING' : 'APPROVED';
    await conn.execute(
      `UPDATE attendance_log
          SET overtime_hours = ?,
              overtime_status = ?,
              overtime_reviewed_by = NULL,
              overtime_reviewed_at = NULL,
              overtime_review_reason = NULL
        WHERE attendance_id = ?`,
      [hours, overtimeStatus, attendanceId]
    );
    await conn.execute(
      `INSERT INTO attendance_adjustment
         (attendance_id, employee_id, adjustment_type, reason, old_value, new_value,
          requested_by, approved_by, approved_at)
       VALUES (?, ?, 'OVERTIME', ?, ?, ?, ?, ?, NOW())`,
      [
        attendanceId,
        record.employee_id,
        reason,
        safeJson({ overtime_hours: record.overtime_hours, overtime_status: record.overtime_status }),
        safeJson({ overtime_hours: hours, overtime_status: overtimeStatus }),
        req.user.id,
        req.user.id,
      ]
    );
    await appendIntegrityEntry(conn, attendanceId, 'HR_OVERTIME_ADJUSTMENT');
    await conn.commit();
    await writeAuditLog(req.user.id, record.employee_id, `OVERTIME UPDATED [ID:${attendanceId}] Reason:${reason}`, String(record.overtime_hours), String(hours), req);
    await emitAttendanceRealtimeById(attendanceId, 'OVERTIME_UPDATED');
    res.json({ message: `Overtime updated to ${hours} hours with audit trail.` });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: safeClientError(err, 'Failed to update overtime.') });
  } finally {
    conn.release();
  }
});

router.patch('/:id/overtime-review', requireAuth, requireRole(HR_ROLES), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (rejectUnsupportedFields(req, res, ATTENDANCE_OVERTIME_REVIEW_ALLOWED_FIELDS)) return;
    const attendanceId = positiveInteger(req.params.id, 'id');
    const decision = cleanText(req.body.decision, 20).toUpperCase();
    if (!['APPROVED', 'REJECTED'].includes(decision)) {
      return res.status(400).json({ error: 'decision must be APPROVED or REJECTED.' });
    }
    const reason = decision === 'APPROVED'
      ? (cleanText(req.body.reason, 500) || 'Overtime approved by HR.')
      : requireReason(req.body.reason);

    await ensureAttendanceLogMetricColumns(conn);
    await ensureAttendanceSummaryPolicyColumns(conn);
    await conn.beginTransaction();
    const [rows] = await conn.execute('SELECT * FROM attendance_log WHERE attendance_id = ? FOR UPDATE', [attendanceId]);
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Attendance record not found.' });
    }
    const record = rows[0];
    const policy = await getActiveAttendancePolicy(pool, record.date || null, { employee_id: record.employee_id });
    if (!policy.enable_overtime) {
      await conn.rollback();
      return res.status(403).json({ error: 'Overtime is disabled by the active attendance policy.' });
    }

    const detectedOvertimeMinutes = Math.max(0, Math.round(Number(computeAttendanceMetrics(record, policy).overtimeMinutes || 0)));
    const minimumOvertimeMinutes = Math.max(0, Math.round(Number(policy.minimum_overtime_minutes || 0)));
    if (detectedOvertimeMinutes <= 0 || detectedOvertimeMinutes < minimumOvertimeMinutes) {
      await conn.rollback();
      return res.status(400).json({ error: `Overtime must reach at least ${minimumOvertimeMinutes} minutes before HR review.` });
    }

    await conn.execute(
      `UPDATE attendance_log
          SET overtime_status = ?,
              overtime_reviewed_by = ?,
              overtime_reviewed_at = NOW(),
              overtime_review_reason = ?
        WHERE attendance_id = ?`,
      [decision, req.user.id, reason, attendanceId]
    );
    await conn.execute(
      `INSERT INTO attendance_adjustment
         (attendance_id, employee_id, adjustment_type, reason, old_value, new_value,
          requested_by, approved_by, approved_at)
       VALUES (?, ?, 'OVERTIME_REVIEW', ?, ?, ?, ?, ?, NOW())`,
      [
        attendanceId,
        record.employee_id,
        reason,
        safeJson({ overtime_status: record.overtime_status, overtime_minutes: detectedOvertimeMinutes }),
        safeJson({ overtime_status: decision, overtime_minutes: detectedOvertimeMinutes }),
        req.user.id,
        req.user.id,
      ]
    );
    await appendIntegrityEntry(conn, attendanceId, `HR_OVERTIME_${decision}`);
    await conn.commit();
    await writeAuditLog(req.user.id, record.employee_id, `OVERTIME ${decision} [ID:${attendanceId}] Reason:${reason}`, record.overtime_status, decision, req);
    await emitAttendanceRealtimeById(attendanceId, `OVERTIME_${decision}`);
    res.json({
      message: decision === 'APPROVED'
        ? 'Overtime approved. Standard working hours were not changed.'
        : 'Overtime rejected. Standard working hours were not changed.',
      overtime_status: decision,
    });
  } catch (err) {
    await conn.rollback();
    res.status(400).json({ error: safeClientError(err, 'Failed to review overtime.') });
  } finally {
    conn.release();
  }
});

router.get('/audit-log', requireAuth, requireAttendanceAuditAccess, async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT sal.*, u.username AS performed_by,
              e.employee_code, e.first_name, e.middle_name, e.last_name
         FROM system_audit_log sal
         LEFT JOIN users u ON u.id = sal.user_id
         LEFT JOIN employees e ON e.id = COALESCE(sal.target_employee_id, sal.employee_id)
        WHERE sal.module = 'ATTENDANCE'
        ORDER BY sal.timestamp DESC
        LIMIT 250`
    );
    res.json(rows.map(row => ({
      ...withAttendanceEmployeeName(row),
      performed_by: row.performed_by || 'System',
    })));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch attendance audit log.' });
  }
});

/* ============================================================
   Integrity verification and permissioned-ledger anchor queue
   ============================================================ */

router.get('/integrity/:attendanceId', requireAuth, requireRole(AUDIT_ROLES), async (req, res) => {
  try {
    const attendanceId = positiveInteger(req.params.attendanceId, 'attendanceId');
    const [records] = await pool.execute('SELECT employee_id, integrity_hash FROM attendance_log WHERE attendance_id = ?', [attendanceId]);
    if (!records.length) return res.status(404).json({ error: 'Attendance record not found.' });

    const [chain] = await pool.execute(
      'SELECT * FROM attendance_integrity_chain WHERE attendance_id = ? ORDER BY chain_id',
      [attendanceId]
    );
    let chainValid = true;
    for (let index = 0; index < chain.length; index += 1) {
      const expected = sha256(`${chain[index].payload_hash}:${chain[index].previous_hash}:${chain[index].event_type}`);
      if (expected !== chain[index].chain_hash) chainValid = false;
    }
    const latest = chain[chain.length - 1] || null;
    res.json({
      attendance_id: attendanceId,
      chain_valid: chainValid && (!latest || latest.chain_hash === records[0].integrity_hash),
      integrity_hash: records[0].integrity_hash,
      latest_anchor_status: latest?.anchor_status || null,
      latest_anchor_reference: latest?.anchor_reference || null,
      versions: chain.length,
    });
  } catch (err) {
    res.status(400).json({ error: safeClientError(err, 'Failed to verify attendance integrity.') });
  }
});

router.post('/integrity/anchor-pending', requireAuth, requireRole(SYSTEM_ADMIN_ROLES), async (req, res) => {
  try {
    const [entries] = await pool.execute(
      `SELECT * FROM attendance_integrity_chain
        WHERE anchor_status IN ('PENDING','FAILED')
        ORDER BY chain_id
        LIMIT 100`
    );
    if (!process.env.BLOCKCHAIN_API_URL) {
      return res.status(503).json({ error: 'BLOCKCHAIN_API_URL is not configured. Integrity entries remain queued locally.' });
    }

    let anchored = 0;
    let failed = 0;
    for (const entry of entries) {
      try {
        const result = await anchorIntegrityEntry(entry);
        await pool.execute(
          `UPDATE attendance_integrity_chain
              SET anchor_status = 'ANCHORED', anchor_reference = ?, anchor_error = NULL, anchored_at = NOW()
            WHERE chain_id = ?`,
          [result.reference || null, entry.chain_id]
        );
        anchored += 1;
      } catch (err) {
        await pool.execute(
          `UPDATE attendance_integrity_chain
              SET anchor_status = 'FAILED', anchor_error = ?
            WHERE chain_id = ?`,
          [cleanText(err.message, 500), entry.chain_id]
        );
        failed += 1;
      }
    }
    await writeAuditLog(req.user.id, null, 'ATTENDANCE INTEGRITY ANCHOR RUN', null, safeJson({ queued: entries.length, anchored, failed }), req);
    res.json({ message: 'Integrity anchor run completed.', queued: entries.length, anchored, failed });
  } catch (err) {
    res.status(502).json({ error: safeClientError(err, 'Failed to anchor attendance integrity entries.') });
  }
});

/* ============================================================
   Geofence fallback administration
   ============================================================ */

router.get('/geofence', requireAuth, requireRole(HR_ROLES), async (_req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, site_name, latitude, longitude, radius_meters, is_active FROM geofence_config');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch geofence configuration.' });
  }
});

router.put('/geofence/:id', requireAuth, requireRole(HR_ROLES), async (req, res) => {
  try {
    if (rejectUnsupportedFields(req, res, GEOFENCE_ALLOWED_FIELDS)) return;
    const id = positiveInteger(req.params.id, 'id');
    const siteName = cleanText(req.body.site_name, 100);
    const latitude = Number(req.body.latitude);
    const longitude = Number(req.body.longitude);
    const radiusMeters = Number(req.body.radius_meters);
    if (!siteName || !Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(radiusMeters) || radiusMeters <= 0) {
      return res.status(400).json({ error: 'Valid site name, coordinates, and radius are required.' });
    }
    await pool.execute(
      'UPDATE geofence_config SET site_name = ?, latitude = ?, longitude = ?, radius_meters = ? WHERE id = ?',
      [siteName, latitude, longitude, radiusMeters, id]
    );
    await writeAuditLog(req.user.id, null, `GEOFENCE UPDATED [ID:${id}]`, null, safeJson({ siteName, latitude, longitude, radiusMeters }), req);
    res.json({ message: 'Geofence configuration updated.' });
  } catch (err) {
    res.status(400).json({ error: safeClientError(err, 'Failed to update geofence configuration.') });
  }
});

module.exports = router;
