const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../config/db');
const { requireAuth, requireRole, ROLES } = require('./middleware');
const {
  appendIntegrityEntry,
  canonicalJson,
  refreshSummary,
  sha256,
  timingSafeEqualText,
  getDeviceSecret,
} = require('./attendance-service');
const { encryptAES256 } = require('./crypto');
const { decryptColumnValue } = require('./data-protection');
const { emitAttendanceCreated } = require('./realtime');
const {
  getActiveAttendancePolicy,
  getAttendanceStatusForTimeIn,
  getInitialVerificationStatus,
} = require('./attendance-policy-engine');
const { classifyDtrPunch, dtrUpdateValues } = require('./dtr-punch');

const router = express.Router();

const HR_ROLES = ['hr_admin', 'hr_manager', 'admin', 'system_admin'];
const BIOMETRIC_ADMIN_ROLES = HR_ROLES;
const BRIDGE_DEVICE_REFERENCE = 'ZK9500-LOCAL-001';
const BIOMETRIC_ATTENDANCE_STATUSES = "ENUM('PENDING_VALIDATION','VALIDATED','REJECTED','CORRECTED_BY_HR','NEEDS_REVIEW','PAYROLL_READY','INCOMPLETE') NOT NULL DEFAULT 'PENDING_VALIDATION'";
const BRIDGE_COMMAND_TYPES = new Set(['VERIFY', 'ENROLL', 'DELETE']);
const BRIDGE_COMMAND_STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'EXPIRED']);

function cleanText(value, maxLength = 500) {
  return String(value ?? '').trim().replace(/[<>]/g, '').slice(0, maxLength);
}

function safeBiometricText(value) {
  try {
    return decryptColumnValue(value) || '';
  } catch (_error) {
    return '';
  }
}

function biometricEmployeeName(row) {
  const first = safeBiometricText(row?.first_name);
  const middle = safeBiometricText(row?.middle_name);
  const last = safeBiometricText(row?.last_name);
  return [first, middle, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    || row?.employee_code
    || (row?.employee_id ? `Employee #${row.employee_id}` : 'Employee');
}

function withBiometricEmployeeName(row) {
  return row ? {
    ...row,
    first_name: undefined,
    middle_name: undefined,
    last_name: undefined,
    employee_name: biometricEmployeeName(row),
  } : row;
}

function biometricStep(step, message, meta = {}) {
  const line = `[${new Date().toISOString()}] [BIOMETRIC_DIAG] STEP ${step}: ${message} ${JSON.stringify(meta)}\n`;
  console.log(line.trim());
  try {
    const logDir = path.join(__dirname, '..', 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'biometric-diagnostic.log'), line);
  } catch (error) {
    console.error('[BIOMETRIC_DIAG] Failed to write diagnostic log:', error.message);
  }
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim()
    .slice(0, 45);
}

function getManilaParts(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error('scan_time is invalid.');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    dateTime: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`,
    hour: Number(parts.hour),
  };
}

function minutesFromTime(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isLaterTime(candidate, current) {
  return minutesFromTime(candidate) > minutesFromTime(current);
}

function isAutoTimeOutEligible(scanTime, policy) {
  return minutesFromTime(scanTime) >= minutesFromTime(policy.work_end_time || '17:00');
}

function normalizeScanType(value) {
  const normalized = cleanText(value, 20).toUpperCase().replace(/[\s-]+/g, '_');
  if (!normalized || normalized === 'AUTO') return 'AUTO';
  if (['TIME_IN', 'IN', 'CLOCK_IN'].includes(normalized)) return 'TIME_IN';
  if (['TIME_OUT', 'OUT', 'CLOCK_OUT'].includes(normalized)) return 'TIME_OUT';
  throw new Error('scan_type must be TIME_IN, TIME_OUT, or AUTO.');
}

async function ensureBiometricAttendanceSchema() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS attendance_log (
      attendance_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      date DATE NOT NULL,
      time_in TIME NULL,
      time_out TIME NULL,
      am_time_in TIME NULL,
      am_time_out TIME NULL,
      pm_time_in TIME NULL,
      pm_time_out TIME NULL,
      overtime_hours DECIMAL(10,2) DEFAULT 0.00,
      late_minutes INT NOT NULL DEFAULT 0,
      undertime_minutes INT NOT NULL DEFAULT 0,
      overtime_minutes INT NOT NULL DEFAULT 0,
      absences TINYINT(1) DEFAULT 0,
      status ENUM('Present','Late','Absent','On Leave','Half Day','Incomplete','Needs Review') NOT NULL DEFAULT 'Present',
      device_fingerprint VARCHAR(255) NULL,
      clock_in_lat_encrypted TEXT NULL,
      clock_in_lng_encrypted TEXT NULL,
      clock_out_lat_encrypted TEXT NULL,
      clock_out_lng_encrypted TEXT NULL,
      biometric_user_hash CHAR(64) NULL,
      biometric_user_id_encrypted TEXT NULL,
      device_id INT NULL,
      verification_status ENUM('VALIDATED','INCOMPLETE','NEEDS_REVIEW','REJECTED') NOT NULL DEFAULT 'VALIDATED',
      source ENUM('BIOMETRIC_API','QR_GEOFENCE','HR_MANUAL_ADJUSTMENT') NOT NULL DEFAULT 'BIOMETRIC_API',
      first_scan_at DATETIME NULL,
      last_scan_at DATETIME NULL,
      integrity_hash CHAR(64) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
      UNIQUE KEY unique_emp_date (employee_id, date),
      INDEX idx_attendance_verification (verification_status, date),
      INDEX idx_attendance_device (device_id, date)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS biometric_device (
      device_id INT AUTO_INCREMENT PRIMARY KEY,
      device_reference VARCHAR(120) NOT NULL UNIQUE,
      device_name VARCHAR(160) NOT NULL,
      vendor VARCHAR(120) NULL,
      api_base_url VARCHAR(500) NULL,
      logs_endpoint VARCHAR(255) NOT NULL DEFAULT '/attendance/logs',
      auth_type ENUM('API_KEY','BEARER','HMAC','OAUTH2','MTLS','NONE') NOT NULL DEFAULT 'API_KEY',
      auth_header_name VARCHAR(100) NOT NULL DEFAULT 'x-biometric-api-key',
      auth_secret_encrypted TEXT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      last_sync_at DATETIME NULL,
      last_success_at DATETIME NULL,
      last_error_at DATETIME NULL,
      last_error_message VARCHAR(500) NULL,
      created_by INT NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_biometric_device_active (is_active)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS biometric_employee_mapping (
      mapping_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      device_id INT NOT NULL,
      employee_id INT NOT NULL,
      biometric_user_hash CHAR(64) NOT NULL,
      biometric_user_id_encrypted TEXT NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES biometric_device(device_id) ON DELETE CASCADE,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
      UNIQUE KEY unique_biometric_mapping (device_id, biometric_user_hash),
      INDEX idx_biometric_mapping_employee (employee_id, is_active)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS biometric_scan_event (
      scan_event_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      external_event_id VARCHAR(190) NULL,
      idempotency_key CHAR(64) NOT NULL UNIQUE,
      device_id INT NOT NULL,
      employee_id INT NULL,
      biometric_user_hash CHAR(64) NULL,
      biometric_user_id_encrypted TEXT NULL,
      scan_timestamp DATETIME NULL,
      attendance_type ENUM('TIME_IN','TIME_OUT','AUTO') NOT NULL,
      verification_status ENUM('VALIDATED','DUPLICATE','UNMAPPED','MALFORMED','REJECTED','NEEDS_REVIEW') NOT NULL,
      attendance_id BIGINT NULL,
      payload_hash CHAR(64) NOT NULL,
      error_message VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES biometric_device(device_id) ON DELETE RESTRICT,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
      INDEX idx_scan_event_device_time (device_id, scan_timestamp),
      INDEX idx_scan_event_employee_time (employee_id, scan_timestamp),
      INDEX idx_scan_event_status (verification_status, created_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS biometric_bridge_command (
      command_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      device_id INT NOT NULL,
      employee_id INT NULL,
      command_type ENUM('VERIFY','ENROLL','DELETE') NOT NULL,
      command_status ENUM('PENDING','IN_PROGRESS','COMPLETED','FAILED','EXPIRED') NOT NULL DEFAULT 'PENDING',
      requested_by INT NULL,
      claimed_at DATETIME NULL,
      completed_at DATETIME NULL,
      expires_at DATETIME NOT NULL,
      result_json TEXT NULL,
      error_message VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (device_id) REFERENCES biometric_device(device_id) ON DELETE CASCADE,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL,
      INDEX idx_bridge_command_device_status (device_id, command_status, expires_at),
      INDEX idx_bridge_command_requested_by (requested_by, created_at),
      INDEX idx_bridge_command_employee (employee_id, created_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS attendance_summary (
      summary_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      attendance_date DATE NOT NULL,
      attendance_id BIGINT NULL,
      regular_minutes INT NOT NULL DEFAULT 0,
      overtime_minutes INT NOT NULL DEFAULT 0,
      late_minutes INT NOT NULL DEFAULT 0,
      undertime_minutes INT NOT NULL DEFAULT 0,
      attendance_status VARCHAR(40) NOT NULL,
      verification_status VARCHAR(40) NOT NULL,
      payroll_eligible TINYINT(1) NOT NULL DEFAULT 0,
      integrity_hash CHAR(64) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
      UNIQUE KEY unique_attendance_summary (employee_id, attendance_date),
      INDEX idx_summary_payroll (attendance_date, payroll_eligible)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS attendance_integrity_chain (
      chain_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      attendance_id BIGINT NOT NULL,
      event_type VARCHAR(80) NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      previous_hash CHAR(64) NOT NULL,
      chain_hash CHAR(64) NOT NULL UNIQUE,
      anchor_status ENUM('PENDING','ANCHORED','FAILED') NOT NULL DEFAULT 'PENDING',
      anchor_reference VARCHAR(255) NULL,
      anchor_error VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      anchored_at DATETIME NULL,
      INDEX idx_integrity_attendance (attendance_id, chain_id),
      INDEX idx_integrity_anchor (anchor_status, created_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS attendance_policy_settings (
      setting_key VARCHAR(100) PRIMARY KEY,
      setting_value VARCHAR(255) NOT NULL,
      description VARCHAR(255) NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await pool.execute(`
    INSERT INTO attendance_policy_settings (setting_key, setting_value, description)
    VALUES
      ('duplicate_scan_window_seconds', '60', 'Seconds to ignore repeated fingerprint scans for the same employee/device.'),
      ('hr_validation_required', 'true', 'Biometric attendance requires HR validation before payroll readiness.'),
      ('multiple_scan_handling', 'reject_after_time_out', 'Policy after time-in and time-out are already recorded.'),
      ('missing_timeout_handling', 'needs_review', 'Policy for missing time-out records.'),
      ('overtime_handling', 'manual_approval', 'Policy for overtime approval.')
    ON DUPLICATE KEY UPDATE setting_value = setting_value
  `);

  const [scoreColumns] = await pool.execute(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'biometric_scan_event' AND COLUMN_NAME = 'verification_score'`
  );
  if (!scoreColumns.length) {
    await pool.execute('ALTER TABLE biometric_scan_event ADD COLUMN verification_score DECIMAL(8,2) NULL AFTER attendance_type');
  }

  await ensureAttendanceLogColumn('biometric_user_hash', 'CHAR(64) NULL');
  await ensureAttendanceLogColumn('biometric_user_id_encrypted', 'TEXT NULL');
  await ensureAttendanceLogColumn('am_time_in', 'TIME NULL');
  await ensureAttendanceLogColumn('am_time_out', 'TIME NULL');
  await ensureAttendanceLogColumn('pm_time_in', 'TIME NULL');
  await ensureAttendanceLogColumn('pm_time_out', 'TIME NULL');
  await ensureAttendanceLogColumn('device_id', 'INT NULL');
  await ensureAttendanceLogColumn(
    'verification_status',
    BIOMETRIC_ATTENDANCE_STATUSES
  );
  await ensureAttendanceLogColumn(
    'source',
    "ENUM('BIOMETRIC_API','QR_GEOFENCE','HR_MANUAL_ADJUSTMENT') NOT NULL DEFAULT 'BIOMETRIC_API'"
  );
  await ensureAttendanceLogColumn('first_scan_at', 'DATETIME NULL');
  await ensureAttendanceLogColumn('last_scan_at', 'DATETIME NULL');
  await ensureAttendanceLogColumn('integrity_hash', 'CHAR(64) NULL');

  try {
    await pool.execute(`
      ALTER TABLE attendance_log
      MODIFY COLUMN verification_status
      ${BIOMETRIC_ATTENDANCE_STATUSES}
    `);
    await pool.execute(`
      ALTER TABLE attendance_log
      MODIFY COLUMN status
      ENUM('Present','Late','Absent','On Leave','Half Day','Incomplete','Needs Review')
      NOT NULL DEFAULT 'Present'
    `);
    await pool.execute(`
      ALTER TABLE attendance_log
      MODIFY COLUMN source
      ENUM('BIOMETRIC_API','QR_GEOFENCE','HR_MANUAL_ADJUSTMENT')
      NOT NULL DEFAULT 'BIOMETRIC_API'
    `);
  } catch (err) {
    console.warn('[biometric/schema] attendance_log enum check:', err.message);
  }

  try {
    await pool.execute(`
      ALTER TABLE biometric_bridge_command
      MODIFY command_type ENUM('VERIFY','ENROLL','DELETE') NOT NULL
    `);
  } catch (err) {
    console.warn('[biometric/schema] bridge command enum check:', err.message);
  }
}

async function ensureAttendanceLogColumn(column, definition) {
  const [rows] = await pool.execute(
    `SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'attendance_log' AND COLUMN_NAME = ?`,
    [column]
  );
  if (!rows.length) {
    await pool.execute(`ALTER TABLE attendance_log ADD COLUMN \`${column}\` ${definition}`);
  }
}

async function writeBiometricAudit(req, employeeId, action, oldValue = null, newValue = null) {
  try {
    await pool.execute(
      `INSERT INTO system_audit_log
         (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent)
       VALUES (?, ?, ?, ?, 'ATTENDANCE', ?, ?, ?, ?)`,
      [
        req.user?.id || null,
        req.user?.employeeId || null,
        employeeId || null,
        action,
        oldValue == null ? null : JSON.stringify(oldValue),
        newValue == null ? null : JSON.stringify(newValue),
        clientIp(req),
        cleanText(req.headers['user-agent'], 500),
      ]
    );
  } catch (err) {
    console.warn('[biometric/audit]', err.message);
  }
}

function parseCommandResult(row) {
  if (!row) return row;
  let result = null;
  if (row.result_json) {
    try {
      result = JSON.parse(row.result_json);
    } catch (_) {
      result = null;
    }
  }
  return {
    command_id: row.command_id,
    device_id: row.device_id,
    employee_id: row.employee_id,
    command_type: row.command_type,
    command_status: row.command_status,
    error_message: row.error_message,
    result,
    expires_at: row.expires_at,
    claimed_at: row.claimed_at,
    completed_at: row.completed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function validateDeviceAuth(req, device) {
  const secret = getDeviceSecret(device);
  const allowUnauthenticatedDevice = process.env.NODE_ENV !== 'production'
    && process.env.ALLOW_UNAUTHENTICATED_BIOMETRIC_WEBHOOK === 'true';

  if (device.auth_type === 'NONE') return allowUnauthenticatedDevice;
  if (device.auth_type === 'MTLS') return req.socket.authorized === true;
  if (!secret) return allowUnauthenticatedDevice;
  if (device.auth_type === 'API_KEY') {
    const headerName = String(device.auth_header_name || 'x-biometric-api-key').toLowerCase();
    return timingSafeEqualText(req.headers[headerName], secret);
  }
  if (device.auth_type === 'BEARER' || device.auth_type === 'OAUTH2') {
    return timingSafeEqualText(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''), secret);
  }
  if (device.auth_type === 'HMAC') {
    const timestamp = String(req.headers['x-biometric-timestamp'] || '');
    const signature = String(req.headers['x-biometric-signature'] || '').replace(/^sha256=/i, '');
    const timestampSeconds = Number(timestamp);
    const fresh = Number.isFinite(timestampSeconds) && Math.abs(Date.now() / 1000 - timestampSeconds) <= 300;
    const payload = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
    const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
    return fresh && timingSafeEqualText(signature, expected);
  }
  return false;
}

router.get('/status', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    await ensureBiometricAttendanceSchema();
    const [devices] = await pool.execute(
      `SELECT device_id, device_reference, device_name, vendor, is_active, last_success_at, last_error_at, last_error_message
         FROM biometric_device
        WHERE device_reference = ? OR is_active = 1
        ORDER BY device_reference = ? DESC, device_name
        LIMIT 10`,
      [BRIDGE_DEVICE_REFERENCE, BRIDGE_DEVICE_REFERENCE]
    );
    const [latest] = await pool.execute(
      `SELECT bse.scan_timestamp, bse.attendance_type, bse.verification_status, bse.verification_score,
              bse.error_message, e.employee_code, e.first_name, e.middle_name, e.last_name
         FROM biometric_scan_event bse
         LEFT JOIN employees e ON e.id = bse.employee_id
        ${req.user.employeeId ? 'WHERE bse.employee_id = ?' : ''}
        ORDER BY bse.created_at DESC
        LIMIT 1`,
      req.user.employeeId ? [req.user.employeeId] : []
    );
    res.json({
      device: devices[0] || null,
      devices,
      latest_scan: withBiometricEmployeeName(latest[0]) || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load biometric status.' });
  }
});

router.get('/station-status', async (_req, res) => {
  try {
    await ensureBiometricAttendanceSchema();
    const [devices] = await pool.execute(
      `SELECT device_id, device_reference, device_name, vendor, is_active, last_success_at, last_error_at, last_error_message
         FROM biometric_device
        WHERE device_reference = ? OR is_active = 1
        ORDER BY device_reference = ? DESC, device_name
        LIMIT 1`,
      [BRIDGE_DEVICE_REFERENCE, BRIDGE_DEVICE_REFERENCE]
    );
    const [latest] = await pool.execute(
      `SELECT bse.scan_timestamp, bse.attendance_type, bse.verification_status, bse.verification_score,
              bse.error_message, e.employee_code, e.first_name, e.middle_name, e.last_name
         FROM biometric_scan_event bse
         LEFT JOIN employees e ON e.id = bse.employee_id
        ORDER BY bse.created_at DESC
        LIMIT 1`
    );
    res.json({ device: devices[0] || null, latest_scan: withBiometricEmployeeName(latest[0]) || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load attendance station status.' });
  }
});

async function recordBiometricAttendance(req, res, options = {}) {
  const conn = await pool.getConnection();
  try {
    await ensureBiometricAttendanceSchema();
    biometricStep(4, 'Backend received request', {
      route: req.originalUrl,
      body: {
        employee_id: req.body.employee_id,
        device_id: req.body.device_id,
        scan_time: req.body.scan_time,
        verification_score: req.body.verification_score,
        scan_type: req.body.scan_type || 'AUTO',
      },
    });
    const employeeId = Number(req.body.employee_id);
    const deviceReference = cleanText(req.body.device_id || BRIDGE_DEVICE_REFERENCE, 120);
    let scanType = normalizeScanType(req.body.scan_type || (options.autoScanType ? 'AUTO' : 'TIME_IN'));
    const scan = getManilaParts(req.body.scan_time || new Date());
    const score = req.body.verification_score == null ? null : Number(req.body.verification_score);

    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return res.status(400).json({ error: 'employee_id is required.' });
    }
    if (!options.publicStation && req.user?.employeeId && Number(req.user.employeeId) !== employeeId && !HR_ROLES.includes(req.user.role)) {
      return res.status(403).json({ error: 'Logged-in employee does not match the biometric attendance employee.' });
    }
    if (score != null && (!Number.isFinite(score) || score < 0)) {
      return res.status(400).json({ error: 'verification_score must be a valid number.' });
    }

    const [devices] = await pool.execute(
      'SELECT * FROM biometric_device WHERE device_reference = ? AND is_active = 1 LIMIT 1',
      [deviceReference]
    );
    if (!devices.length) {
      biometricStep(4, 'Device validation failed', { employeeId, deviceReference });
      await writeBiometricAudit(req, employeeId, 'BIOMETRIC ATTENDANCE REJECTED', null, { reason: 'Device not registered', deviceReference });
      return res.status(404).json({ error: 'Registered active biometric device not found.' });
    }
    const device = devices[0];
    if (!(await validateDeviceAuth(req, device))) {
      biometricStep(4, 'Device authentication failed', { employeeId, deviceReference, deviceId: device.device_id });
      await writeBiometricAudit(req, employeeId, 'BIOMETRIC ATTENDANCE REJECTED', null, { reason: 'Device authentication failed', deviceReference });
      return res.status(401).json({ error: 'Biometric device authentication failed.' });
    }
    biometricStep(4, 'Device validation passed', { employeeId, deviceReference, deviceId: device.device_id });

    const [employees] = await pool.execute(
      'SELECT id, employee_code, first_name, last_name, status FROM employees WHERE id = ? LIMIT 1',
      [employeeId]
    );
    if (!employees.length) {
      biometricStep(4, 'Employee validation failed: not found', { employeeId });
      await writeBiometricAudit(req, employeeId, 'BIOMETRIC ATTENDANCE REJECTED', null, { reason: 'Employee not found' });
      return res.status(404).json({ error: 'Employee not found.' });
    }
    const employee = employees[0];
    if (String(employee.status || '').toLowerCase() !== 'active') {
      biometricStep(4, 'Employee validation failed: inactive', { employeeId, status: employee.status });
      await writeBiometricAudit(req, employeeId, 'BIOMETRIC ATTENDANCE REJECTED', null, { reason: 'Inactive employee' });
      return res.status(403).json({ error: 'Employee must be active to record attendance.' });
    }
    biometricStep(4, 'Employee validation passed', { employeeId, employee_code: employee.employee_code });

    const [mappings] = await pool.execute(
      `SELECT mapping_id, biometric_user_hash, biometric_user_id_encrypted
         FROM biometric_employee_mapping
        WHERE employee_id = ? AND device_id = ? AND is_active = 1
        LIMIT 1`,
      [employeeId, device.device_id]
    );
    if (!mappings.length) {
      biometricStep(4, 'Fingerprint mapping validation failed', { employeeId, deviceId: device.device_id });
      await writeBiometricAudit(req, employeeId, 'BIOMETRIC ATTENDANCE REJECTED', null, { reason: 'Fingerprint not enrolled', deviceReference });
      return res.status(403).json({ error: 'Fingerprint is not enrolled or active for this device.' });
    }
    const mapping = mappings[0];

    const attendancePolicy = await getActiveAttendancePolicy(pool, scan.date, { employee_id: employeeId });
    const duplicateWindowSeconds = attendancePolicy.duplicate_scan_window_seconds;
    const [recent] = await pool.execute(
      `SELECT scan_event_id
         FROM biometric_scan_event
        WHERE employee_id = ?
          AND device_id = ?
          AND scan_timestamp BETWEEN DATE_SUB(?, INTERVAL ${duplicateWindowSeconds} SECOND) AND DATE_ADD(?, INTERVAL ${duplicateWindowSeconds} SECOND)
        LIMIT 1`,
      [employeeId, device.device_id, scan.dateTime, scan.dateTime]
    );
    if (recent.length) {
      await pool.execute(
        `UPDATE biometric_device
            SET last_error_at = NOW(), last_error_message = ?
          WHERE device_id = ?`,
        [`Duplicate biometric scan within ${duplicateWindowSeconds} seconds.`, device.device_id]
      );
      biometricStep(5, 'Duplicate scan rejected', { employeeId, deviceId: device.device_id, scanTime: scan.dateTime, duplicateWindowSeconds });
      await writeBiometricAudit(req, employeeId, 'DUPLICATE BIOMETRIC SCAN REJECTED', null, { scanType, scanTime: scan.dateTime });
      return res.status(409).json({ error: `Duplicate biometric scan within ${duplicateWindowSeconds} seconds.` });
    }

    await conn.beginTransaction();
    const [records] = await conn.execute(
      'SELECT * FROM attendance_log WHERE employee_id = ? AND date = ? FOR UPDATE',
      [employeeId, scan.date]
    );
    const record = records[0] || null;
    const punch = classifyDtrPunch(record, scan.time, attendancePolicy, scanType);
    scanType = punch.attendanceType || scanType;
    let attendanceId = record?.attendance_id || null;
    biometricStep(5, 'Attendance action determined', {
      employeeId,
      attendanceId: attendanceId || null,
      scanType,
      existingRecord: !!record,
      dtrSlot: punch.slot || null,
      punchStatus: punch.status,
    });

    if (punch.status === 'intermediate') {
      const payload = {
        employee_id: employeeId,
        device_id: deviceReference,
        scan_type: 'AUTO',
        scan_time: scan.dateTime,
        verification_score: score,
      };
      const payloadHash = sha256(canonicalJson(payload));
      const idempotencyKey = sha256(`${device.device_id}:${employeeId}:${scan.dateTime}:AUTO:${payloadHash}`);
      await conn.execute(
        `INSERT INTO biometric_scan_event
           (external_event_id, idempotency_key, device_id, employee_id, biometric_user_hash,
            biometric_user_id_encrypted, scan_timestamp, attendance_type, verification_score,
            verification_status, attendance_id, payload_hash, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'AUTO', ?, 'VALIDATED', ?, ?, ?)`,
        [
          cleanText(req.body.external_event_id, 190) || null,
          idempotencyKey,
          device.device_id,
          employeeId,
          mapping.biometric_user_hash,
          mapping.biometric_user_id_encrypted,
          scan.dateTime,
          score,
          attendanceId,
          payloadHash,
          'Intermediate biometric scan; DTR attendance unchanged.',
        ]
      );
      await conn.execute(
        `UPDATE biometric_device
            SET last_sync_at = NOW(), last_success_at = NOW(), last_error_message = NULL
          WHERE device_id = ?`,
        [device.device_id]
      );
      await conn.commit();
      biometricStep(5, 'Intermediate AUTO scan accepted without changing attendance', {
        employeeId,
        attendanceId,
        scanTime: scan.dateTime,
      });
      await writeBiometricAudit(req, employeeId, 'INTERMEDIATE BIOMETRIC SCAN IGNORED', null, {
        scanType: 'AUTO',
        scanTime: scan.dateTime,
        deviceReference,
        attendanceId,
      });
      return res.json({
        message: 'Intermediate biometric scan recorded; DTR unchanged.',
        action: 'INTERMEDIATE_SCAN',
        attendance_id: attendanceId,
        employee: {
          id: employee.id,
          employee_code: employee.employee_code,
          name: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
        },
        device_id: deviceReference,
        scan_time: scan.dateTime,
        verification_score: score,
        result: record?.verification_status || 'PENDING_VALIDATION',
      });
    }

    if (punch.status === 'duplicate') {
      await conn.rollback();
      biometricStep(5, 'Duplicate DTR punch rejected', { employeeId, attendanceId: record?.attendance_id, slot: punch.slot });
      await writeBiometricAudit(req, employeeId, 'DUPLICATE BIOMETRIC SCAN REJECTED', null, { scanTime: scan.dateTime, reason: 'DTR punch already exists.', slot: punch.slot });
      return res.status(409).json({ error: 'DTR punch already exists for this employee today.' });
    }

    if (!record) {
      const next = dtrUpdateValues(null, punch.slot, scan.time);
      const status = next.time_in ? getAttendanceStatusForTimeIn(next.time_in, attendancePolicy) : 'Incomplete';
      const verificationStatus = getInitialVerificationStatus(scanType, attendancePolicy, { missingTimeIn: !next.time_in });
      const [created] = await conn.execute(
        `INSERT INTO attendance_log
           (employee_id, date, time_in, time_out, am_time_in, am_time_out, pm_time_in, pm_time_out, status, biometric_user_hash,
            biometric_user_id_encrypted, device_id, verification_status, source, first_scan_at, last_scan_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BIOMETRIC_API', ?, ?)`,
        [
          employeeId,
          scan.date,
          next.time_in,
          next.time_out,
          next.am_time_in,
          next.am_time_out,
          next.pm_time_in,
          next.pm_time_out,
          status,
          mapping.biometric_user_hash,
          mapping.biometric_user_id_encrypted,
          device.device_id,
          verificationStatus,
          scan.dateTime,
          scan.dateTime,
        ]
      );
      attendanceId = created.insertId;
    } else {
      const next = dtrUpdateValues(record, punch.slot, scan.time);
      await conn.execute(
        `UPDATE attendance_log
            SET time_in = ?, time_out = ?,
                am_time_in = ?, am_time_out = ?, pm_time_in = ?, pm_time_out = ?,
                status = ?, biometric_user_hash = ?,
                biometric_user_id_encrypted = ?, device_id = ?, source = 'BIOMETRIC_API',
                verification_status = ?,
                first_scan_at = COALESCE(first_scan_at, ?), last_scan_at = ?
          WHERE attendance_id = ?`,
        [
          next.time_in,
          next.time_out,
          next.am_time_in,
          next.am_time_out,
          next.pm_time_in,
          next.pm_time_out,
          next.time_in ? getAttendanceStatusForTimeIn(next.time_in, attendancePolicy) : 'Incomplete',
          mapping.biometric_user_hash,
          mapping.biometric_user_id_encrypted,
          device.device_id,
          getInitialVerificationStatus(scanType, attendancePolicy),
          scan.dateTime,
          scan.dateTime,
          attendanceId,
        ]
      );
    }

    const payload = {
      employee_id: employeeId,
      device_id: deviceReference,
      scan_type: scanType,
      scan_time: scan.dateTime,
      verification_score: score,
    };
    const payloadHash = sha256(canonicalJson(payload));
    const idempotencyKey = sha256(`${device.device_id}:${employeeId}:${scan.dateTime}:${scanType}:${payloadHash}`);
    await conn.execute(
      `INSERT INTO biometric_scan_event
         (external_event_id, idempotency_key, device_id, employee_id, biometric_user_hash,
          biometric_user_id_encrypted, scan_timestamp, attendance_type, verification_score,
          verification_status, attendance_id, payload_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'VALIDATED', ?, ?)`,
      [
        cleanText(req.body.external_event_id, 190) || null,
        idempotencyKey,
        device.device_id,
        employeeId,
        mapping.biometric_user_hash,
        mapping.biometric_user_id_encrypted,
        scan.dateTime,
        scanType,
        score,
        attendanceId,
        payloadHash,
      ]
    );

    await appendIntegrityEntry(conn, attendanceId, `BIOMETRIC_${scanType}`);
    await refreshSummary(conn, attendanceId);
    await conn.execute(
      `UPDATE biometric_device
          SET last_sync_at = NOW(), last_success_at = NOW(), last_error_message = NULL
        WHERE device_id = ?`,
      [device.device_id]
    );
    await conn.commit();
    biometricStep(5, 'Attendance saved', { employeeId, attendanceId, scanType, scanTime: scan.dateTime });

    await writeBiometricAudit(req, employeeId, 'BIOMETRIC ATTENDANCE SCAN', null, {
      scanType,
      scanTime: scan.dateTime,
      deviceReference,
      verificationScore: score,
      attendanceId,
    });

    const [attendanceRows] = await pool.execute(
      `SELECT al.verification_status, ats.payroll_eligible,
              e.employee_code, e.department_id, e.first_name, e.middle_name, e.last_name
         FROM attendance_log al
         JOIN employees e ON e.id = al.employee_id
         LEFT JOIN attendance_summary ats ON ats.attendance_id = al.attendance_id
        WHERE al.attendance_id = ?
        LIMIT 1`,
      [attendanceId]
    );
    const attendanceMeta = withBiometricEmployeeName(attendanceRows[0]) || {};
    const realtimePayload = {
      employee_id: employeeId,
      employee_name: attendanceMeta.employee_name || biometricEmployeeName(employee),
      employee_code: attendanceMeta.employee_code || employee.employee_code,
      department_id: attendanceMeta.department_id,
      scan_type: scanType,
      scan_time: scan.dateTime,
      attendance_status: attendanceMeta.verification_status || 'PENDING_VALIDATION',
      payroll_ready: Number(attendanceMeta.payroll_eligible || 0) === 1,
      device_id: deviceReference,
    };
    emitAttendanceCreated(realtimePayload);
    biometricStep(6, 'Socket event emitted', realtimePayload);

    res.json({
      message: `${scanType.replace('_', ' ')} recorded from biometric scan.`,
      action: scanType,
      attendance_id: attendanceId,
      employee: {
        id: employee.id,
        employee_code: employee.employee_code,
        name: `${employee.first_name || ''} ${employee.last_name || ''}`.trim(),
      },
      device_id: deviceReference,
      scan_time: scan.dateTime,
      verification_score: score,
      result: realtimePayload.attendance_status,
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Duplicate biometric scan event.' });
    }
    console.error('[biometric/attendance]', err.message, err.code || '');
    biometricStep(5, 'Backend attendance failure', { code: err.code || null });
    res.status(400).json({ error: 'Biometric attendance failed.' });
  } finally {
    conn.release();
  }
}

router.post('/attendance', requireAuth, requireRole(ROLES.any), async (req, res) => {
  return recordBiometricAttendance(req, res);
});

router.post('/bridge-commands', requireAuth, requireRole(BIOMETRIC_ADMIN_ROLES), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await ensureBiometricAttendanceSchema();
    const commandType = cleanText(req.body.command_type, 20).toUpperCase();
    if (!BRIDGE_COMMAND_TYPES.has(commandType)) {
      return res.status(400).json({ error: 'command_type must be VERIFY, ENROLL, or DELETE.' });
    }

    const employeeId = Number(req.body.employee_id);
    const requestedDeviceId = req.body.device_id ? Number(req.body.device_id) : null;
    if (!Number.isInteger(employeeId) || employeeId <= 0) {
      return res.status(400).json({ error: 'employee_id is required.' });
    }
    if (requestedDeviceId != null && (!Number.isInteger(requestedDeviceId) || requestedDeviceId <= 0)) {
      return res.status(400).json({ error: 'device_id is invalid.' });
    }

    const [employees] = await pool.execute(
      'SELECT id, employee_code, status FROM employees WHERE id = ? LIMIT 1',
      [employeeId]
    );
    if (!employees.length || String(employees[0].status || '').toLowerCase() !== 'active') {
      return res.status(400).json({ error: 'An active employee is required.' });
    }

    await conn.beginTransaction();
    const [devices] = await conn.execute(
      `SELECT device_id, device_reference, device_name
         FROM biometric_device
        WHERE is_active = 1
          ${requestedDeviceId ? 'AND device_id = ?' : ''}
        ORDER BY device_reference = ? DESC, device_name
        LIMIT 1
        FOR UPDATE`,
      requestedDeviceId ? [requestedDeviceId, BRIDGE_DEVICE_REFERENCE] : [BRIDGE_DEVICE_REFERENCE]
    );
    if (!devices.length) {
      await conn.rollback();
      return res.status(400).json({ error: 'No active biometric station is registered.' });
    }

    await conn.execute(
      `UPDATE biometric_bridge_command
          SET command_status = 'EXPIRED', error_message = 'Command expired before station pickup.'
        WHERE command_status IN ('PENDING','IN_PROGRESS') AND expires_at < NOW()`
    );

    const [activeCommands] = await conn.execute(
      `SELECT command_id, employee_id, command_type, command_status
         FROM biometric_bridge_command
        WHERE device_id = ?
          AND command_status IN ('PENDING','IN_PROGRESS')
          AND expires_at >= NOW()
        ORDER BY created_at
        FOR UPDATE`,
      [devices[0].device_id]
    );
    const reusable = activeCommands.find(command =>
      Number(command.employee_id) === employeeId
      && String(command.command_type).toUpperCase() === commandType
    );
    if (reusable) {
      await conn.commit();
      return res.status(200).json({
        command_id: reusable.command_id,
        command_status: reusable.command_status,
        command_type: commandType,
        device: devices[0],
        reused: true,
      });
    }
    if (activeCommands.length) {
      await conn.rollback();
      return res.status(409).json({ error: 'The biometric station is busy with another enrollment, verification, or removal. Please wait for it to finish.' });
    }

    await conn.execute(
      `UPDATE biometric_bridge_command
          SET command_status = 'EXPIRED',
              error_message = 'Duplicate queued command canceled; only one scanner command may run at a time.'
        WHERE device_id = ?
          AND employee_id = ?
          AND command_type = ?
          AND command_status = 'PENDING'`,
      [devices[0].device_id, employeeId, commandType]
    );

    const [result] = await conn.execute(
      `INSERT INTO biometric_bridge_command
         (device_id, employee_id, command_type, command_status, requested_by, expires_at)
       VALUES (?, ?, ?, 'PENDING', ?, DATE_ADD(NOW(), INTERVAL 90 SECOND))`,
      [devices[0].device_id, employeeId, commandType, req.user.id || null]
    );
    await writeBiometricAudit(req, employeeId, `BIOMETRIC ${commandType} COMMAND CREATED [ID:${result.insertId}]`, null, {
      device_id: devices[0].device_id,
      device_reference: devices[0].device_reference,
    });
    await conn.commit();
    res.status(201).json({
      command_id: result.insertId,
      command_status: 'PENDING',
      command_type: commandType,
      device: devices[0],
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[biometric/bridge-command-create]', err.message);
    res.status(500).json({ error: 'Failed to create biometric bridge command.' });
  } finally {
    conn.release();
  }
});

router.get('/bridge-commands/:commandId', requireAuth, requireRole(BIOMETRIC_ADMIN_ROLES), async (req, res) => {
  try {
    await ensureBiometricAttendanceSchema();
    const commandId = Number(req.params.commandId);
    if (!Number.isInteger(commandId) || commandId <= 0) return res.status(400).json({ error: 'Invalid command id.' });
    await pool.execute(
      `UPDATE biometric_bridge_command
          SET command_status = 'EXPIRED', error_message = 'Command expired before station pickup.'
        WHERE command_status IN ('PENDING','IN_PROGRESS') AND expires_at < NOW()`
    );
    const [rows] = await pool.execute(
      'SELECT * FROM biometric_bridge_command WHERE command_id = ? LIMIT 1',
      [commandId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Biometric command not found.' });
    res.json(parseCommandResult(rows[0]));
  } catch (err) {
    console.error('[biometric/bridge-command-status]', err.message);
    res.status(500).json({ error: 'Failed to load biometric bridge command.' });
  }
});

router.post('/station-command/next', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await ensureBiometricAttendanceSchema();
    const deviceReference = cleanText(req.body.device_id || BRIDGE_DEVICE_REFERENCE, 120);
    const [devices] = await pool.execute(
      'SELECT * FROM biometric_device WHERE device_reference = ? AND is_active = 1 LIMIT 1',
      [deviceReference]
    );
    if (!devices.length) return res.status(404).json({ error: 'Registered active biometric device not found.' });
    const device = devices[0];
    if (!(await validateDeviceAuth(req, device))) {
      return res.status(401).json({ error: 'Biometric device authentication failed.' });
    }

    await conn.beginTransaction();
    await conn.execute(
      `UPDATE biometric_bridge_command
          SET command_status = 'EXPIRED', error_message = 'Command expired before station pickup.'
        WHERE command_status IN ('PENDING','IN_PROGRESS') AND expires_at < NOW()`
    );
    const [commands] = await conn.execute(
      `SELECT bbc.command_id, bbc.command_type, bbc.employee_id,
              e.employee_code, e.first_name, e.middle_name, e.last_name
         FROM biometric_bridge_command bbc
         JOIN employees e ON e.id = bbc.employee_id
        WHERE bbc.device_id = ?
          AND bbc.command_status = 'PENDING'
          AND bbc.expires_at >= NOW()
        ORDER BY bbc.created_at
        LIMIT 1
        FOR UPDATE`,
      [device.device_id]
    );
    if (!commands.length) {
      await conn.commit();
      return res.json({ command: null });
    }
    const command = commands[0];
    await conn.execute(
      `UPDATE biometric_bridge_command
          SET command_status = 'IN_PROGRESS', claimed_at = NOW()
        WHERE command_id = ?`,
      [command.command_id]
    );
    await conn.commit();
    res.json({
      command: {
        command_id: command.command_id,
        command_type: command.command_type,
        employee_id: command.employee_id,
        employee_code: command.employee_code,
        employee_name: biometricEmployeeName(command),
      },
    });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[biometric/station-command-next]', err.message);
    res.status(500).json({ error: 'Failed to claim biometric command.' });
  } finally {
    conn.release();
  }
});

router.post('/station-command/:commandId/complete', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await ensureBiometricAttendanceSchema();
    const commandId = Number(req.params.commandId);
    if (!Number.isInteger(commandId) || commandId <= 0) return res.status(400).json({ error: 'Invalid command id.' });

    await conn.beginTransaction();
    const [commands] = await conn.execute(
      `SELECT bbc.*, bd.device_reference, bd.auth_type, bd.auth_header_name, bd.auth_secret_encrypted
         FROM biometric_bridge_command bbc
         JOIN biometric_device bd ON bd.device_id = bbc.device_id
        WHERE bbc.command_id = ?
        LIMIT 1
        FOR UPDATE`,
      [commandId]
    );
    if (!commands.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Biometric command not found.' });
    }
    const command = commands[0];
    if (!(await validateDeviceAuth(req, command))) {
      await conn.rollback();
      return res.status(401).json({ error: 'Biometric device authentication failed.' });
    }
    if (!['PENDING', 'IN_PROGRESS'].includes(command.command_status)) {
      await conn.rollback();
      return res.status(409).json({ error: 'Biometric command is no longer active.' });
    }

    const ok = req.body.ok === true || req.body.ok === 1 || req.body.ok === 'true';
    const payload = req.body.result && typeof req.body.result === 'object' ? req.body.result : {};
    const errorMessage = ok ? null : cleanText(req.body.error || payload.error || 'Biometric command failed.', 500);

    if (ok && command.command_type === 'ENROLL') {
      const referenceId = cleanText(payload.reference_id, 190);
      if (!referenceId) throw new Error('Enrollment result is missing reference_id.');
      const userHash = sha256(referenceId);
      const encryptedId = encryptAES256(referenceId);
      await conn.execute(
        `INSERT INTO biometric_employee_mapping
           (device_id, employee_id, biometric_user_hash, biometric_user_id_encrypted, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           employee_id = VALUES(employee_id),
           biometric_user_id_encrypted = VALUES(biometric_user_id_encrypted),
           is_active = 1,
           updated_by = VALUES(updated_by)`,
        [command.device_id, command.employee_id, userHash, encryptedId, command.requested_by, command.requested_by]
      );
    }
    if (ok && command.command_type === 'DELETE') {
      await conn.execute(
        `UPDATE biometric_employee_mapping
            SET is_active = 0, updated_by = ?
          WHERE device_id = ? AND employee_id = ?`,
        [command.requested_by || null, command.device_id, command.employee_id]
      );
    }

    const resultJson = JSON.stringify({
      ...payload,
      reference_id: payload.reference_id ? cleanText(payload.reference_id, 190) : undefined,
    });
    await conn.execute(
      `UPDATE biometric_bridge_command
          SET command_status = ?, completed_at = NOW(), result_json = ?, error_message = ?
        WHERE command_id = ?`,
      [ok ? 'COMPLETED' : 'FAILED', resultJson, errorMessage, commandId]
    );
    await conn.execute(
      `INSERT INTO system_audit_log
         (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent)
       VALUES (?, NULL, ?, ?, 'ATTENDANCE', NULL, ?, ?, ?)`,
      [
        command.requested_by || null,
        command.employee_id,
        `BIOMETRIC ${command.command_type} COMMAND ${ok ? 'COMPLETED' : 'FAILED'} [ID:${commandId}]`,
        JSON.stringify({ ok, score: payload.score || null, matched: payload.matched ?? null, error: errorMessage }),
        clientIp(req),
        cleanText(req.headers['user-agent'], 500),
      ]
    );
    await conn.commit();
    res.json({ message: 'Biometric command result saved.' });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    console.error('[biometric/station-command-complete]', err.message);
    res.status(400).json({ error: 'Failed to complete biometric command.' });
  } finally {
    conn.release();
  }
});

router.post('/station-attendance', async (req, res) => {
  return recordBiometricAttendance(req, res, { publicStation: true, autoScanType: true });
});

module.exports = router;
