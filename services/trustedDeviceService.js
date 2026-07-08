const crypto = require('crypto');
const pool = require('../config/db');
const { verifyPassword } = require('./passwordService');
const { getSocketDeviceMetadata, metadataFromUserAgent } = require('./socketDeviceDetectionService');

const MAX_FINGERPRINT_FIELDS = 24;
const DEVICE_TYPES = new Set(['Desktop', 'Mobile', 'Tablet']);
const DEVICE_STATUS_VALUES = new Set(['Trusted', 'Revoked', 'Removed']);
const RISK_LEVELS = new Set(['Low', 'Medium', 'High']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function cleanText(value, max = 120) {
  if (!isNonEmptyString(value)) return null;
  return value.trim().replace(/[\x00-\x1F\x7F]/g, '').slice(0, max) || null;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function requestIp(req) {
  return req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req?.ip
    || req?.socket?.remoteAddress
    || null;
}

function userAgent(req) {
  return req?.headers?.['user-agent'] || '';
}

function normalizeDeviceType(requestedType = '') {
  const normalized = cleanText(requestedType, 20);
  if (DEVICE_TYPES.has(normalized)) return normalized;
  return 'Desktop';
}

function normalizeDeviceStatus(row = {}) {
  const raw = String(row?.status || '').trim();
  if (DEVICE_STATUS_VALUES.has(raw)) return raw;
  if (row?.removed_at) return 'Removed';
  if (row?.revoked_at) return 'Revoked';
  return 'Trusted';
}

function canonicalizeFingerprint(fingerprint = {}, req = null) {
  const safe = {};
  const entries = Object.entries(fingerprint && typeof fingerprint === 'object' ? fingerprint : {})
    .filter(([key, value]) => /^[A-Za-z0-9_.-]{1,40}$/.test(key) && value !== undefined && value !== null)
    .slice(0, MAX_FINGERPRINT_FIELDS);
  for (const [key, value] of entries) {
    const text = cleanText(Array.isArray(value) ? value.join(',') : value, 300);
    if (text) safe[key] = text;
  }
  safe.userAgent = cleanText(userAgent(req), 500) || safe.userAgent || 'unknown';
  return Object.keys(safe).sort().reduce((ordered, key) => {
    ordered[key] = safe[key];
    return ordered;
  }, {});
}

function fingerprintHash(userId, fingerprint = {}, req = null) {
  const canonical = canonicalizeFingerprint(fingerprint, req);
  const pepper = process.env.TRUSTED_DEVICE_PEPPER || process.env.JWT_SECRET || 'lgsv-trusted-device-local';
  return sha256(JSON.stringify({ userId: Number(userId), fingerprint: canonical, pepper }));
}

function deviceMetadata(fingerprint = {}, req = null) {
  const ua = userAgent(req) || fingerprint.userAgent || '';
  const socketMetadata = getSocketDeviceMetadata(fingerprint.clientDeviceId);
  const parsedMetadata = socketMetadata || metadataFromUserAgent(ua);
  const browser = cleanText(parsedMetadata.browser, 100) || 'Unknown Browser';
  const operatingSystem = cleanText(parsedMetadata.operatingSystem, 120) || 'Unknown OS';
  const deviceType = normalizeDeviceType(parsedMetadata.deviceType);
  const deviceModel = cleanText(parsedMetadata.deviceModel, 160);
  const fallbackName = `${operatingSystem} ${browser}`.trim();
  return {
    browser,
    operatingSystem,
    deviceType,
    deviceModel,
    deviceName: cleanText(fingerprint.deviceName, 120) || fallbackName || 'Trusted Device',
    ipAddress: cleanText(requestIp(req), 45),
    screenSize: cleanText(fingerprint.screenSize, 80),
    timezone: cleanText(fingerprint.timezone, 120),
    clientDeviceId: cleanText(fingerprint.clientDeviceId, 120),
  };
}

function approximateLocationFromRequest(req = null) {
  const header = req?.headers?.['x-lgsv-location'] || req?.headers?.['cf-ipcity'];
  const city = cleanText(Array.isArray(header) ? header[0] : header, 80);
  const country = cleanText(req?.headers?.['cf-ipcountry'], 80);
  if (city && country) return `${city}, ${country}`;
  return city || country || null;
}

function normalizeRiskLevel(value) {
  const text = cleanText(value, 20) || 'Low';
  return RISK_LEVELS.has(text) ? text : 'Low';
}

async function scoreDeviceRisk(userId, fingerprint = {}, req = null, deviceStatus = null) {
  const metadata = deviceMetadata(fingerprint, req);
  const reasons = [];
  let score = 0;
  if (!deviceStatus?.trusted) {
    score += 35;
    reasons.push('Untrusted device');
  }
  const [knownBrowser] = await pool.execute(
    `SELECT id FROM trusted_devices
      WHERE user_id = ? AND browser = ? AND operating_system = ? AND status = 'Trusted'
      LIMIT 1`,
    [userId, metadata.browser, metadata.operatingSystem]
  );
  if (!knownBrowser.length) {
    score += 20;
    reasons.push('New browser or operating system');
  }
  const [knownIp] = await pool.execute(
    `SELECT id FROM trusted_devices
      WHERE user_id = ? AND ip_address = ? AND status = 'Trusted'
      LIMIT 1`,
    [userId, metadata.ipAddress]
  );
  if (metadata.ipAddress && !knownIp.length) {
    score += 15;
    reasons.push('New IP address');
  }
  const [recentFailures] = await pool.execute(
    `SELECT COUNT(*) AS total
       FROM device_audit_logs
      WHERE user_id = ?
        AND action IN ('Failed Login','Unknown Device Attempt')
        AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)`,
    [userId]
  ).catch(() => [[{ total: 0 }]]);
  if (Number(recentFailures[0]?.total || 0) >= 3) {
    score += 30;
    reasons.push('Multiple recent failed or unknown-device attempts');
  }
  const riskLevel = score >= 60 ? 'High' : score >= 25 ? 'Medium' : 'Low';
  return { riskLevel, score, reasons, metadata, location: approximateLocationFromRequest(req) };
}

async function ensureColumn(tableName, columnName, definition) {
  const [rows] = await pool.query(`SHOW COLUMNS FROM ${tableName} LIKE ?`, [columnName]);
  if (rows.length) return;
  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

async function ensureTrustedDevicesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trusted_devices (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      device_name VARCHAR(120) NOT NULL,
      device_hash CHAR(64) NOT NULL,
      browser VARCHAR(100) NULL,
      operating_system VARCHAR(120) NULL,
      device_type ENUM('Desktop','Mobile','Tablet') NOT NULL DEFAULT 'Desktop',
      device_model VARCHAR(160) NULL,
      ip_address VARCHAR(45) NULL,
      last_used DATETIME NULL,
      registered_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      is_trusted BOOLEAN NOT NULL DEFAULT TRUE,
      revoked_at DATETIME NULL,
      removed_at DATETIME NULL,
      removed_by BIGINT NULL,
      restored_at DATETIME NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'Trusted',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_trusted_devices_user_hash (user_id, device_hash),
      INDEX idx_trusted_devices_user_status (user_id, status, revoked_at),
      INDEX idx_trusted_devices_last_used (last_used)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await ensureColumn('trusted_devices', 'removed_at', 'DATETIME NULL');
  await ensureColumn('trusted_devices', 'removed_by', 'BIGINT NULL');
  await ensureColumn('trusted_devices', 'restored_at', 'DATETIME NULL');
  await ensureColumn('trusted_devices', 'status', "VARCHAR(20) NOT NULL DEFAULT 'Trusted'");
  await ensureColumn('trusted_devices', 'device_model', 'VARCHAR(160) NULL');
}

async function ensureDeviceSessionTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_sessions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      device_id BIGINT NULL,
      login_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      logout_at DATETIME NULL,
      session_status VARCHAR(20) NOT NULL DEFAULT 'Active',
      login_method VARCHAR(40) NULL,
      ip_address VARCHAR(45) NULL,
      location VARCHAR(160) NULL,
      browser VARCHAR(100) NULL,
      operating_system VARCHAR(120) NULL,
      device_type VARCHAR(20) NULL,
      device_model VARCHAR(160) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_device_sessions_user_status (user_id, session_status, login_at),
      INDEX idx_device_sessions_device (device_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureDeviceAuditLogTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_audit_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      device_id BIGINT NULL,
      action VARCHAR(80) NOT NULL,
      timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ip_address VARCHAR(45) NULL,
      device_name VARCHAR(120) NULL,
      browser VARCHAR(100) NULL,
      operating_system VARCHAR(120) NULL,
      device_model VARCHAR(160) NULL,
      location VARCHAR(160) NULL,
      login_status VARCHAR(40) NULL,
      risk_level VARCHAR(20) NOT NULL DEFAULT 'Low',
      details TEXT NULL,
      INDEX idx_device_audit_logs_user (user_id, timestamp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureSecurityCenterSchema() {
  await ensureTrustedDevicesTable();
  await ensureDeviceSessionTable();
  await ensureDeviceAuditLogTable();
  await ensureColumn('trusted_devices', 'nickname', 'VARCHAR(120) NULL');
  await ensureColumn('trusted_devices', 'device_model', 'VARCHAR(160) NULL');
  await ensureColumn('trusted_devices', 'first_registered_ip', 'VARCHAR(45) NULL');
  await ensureColumn('trusted_devices', 'last_location', 'VARCHAR(160) NULL');
  await ensureColumn('device_sessions', 'user_session_id', 'BIGINT NULL');
  await ensureColumn('device_sessions', 'jwt_id', 'VARCHAR(255) NULL');
  await ensureColumn('device_sessions', 'last_activity', 'DATETIME NULL');
  await ensureColumn('device_sessions', 'risk_level', 'VARCHAR(20) NULL');
  await ensureColumn('device_sessions', 'device_model', 'VARCHAR(160) NULL');
  await ensureColumn('device_audit_logs', 'device_name', 'VARCHAR(120) NULL');
  await ensureColumn('device_audit_logs', 'browser', 'VARCHAR(100) NULL');
  await ensureColumn('device_audit_logs', 'operating_system', 'VARCHAR(120) NULL');
  await ensureColumn('device_audit_logs', 'device_model', 'VARCHAR(160) NULL');
  await ensureColumn('device_audit_logs', 'location', 'VARCHAR(160) NULL');
  await ensureColumn('device_audit_logs', 'login_status', 'VARCHAR(40) NULL');
  await ensureColumn('device_audit_logs', 'risk_level', "VARCHAR(20) NOT NULL DEFAULT 'Low'");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_notifications (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      notification_type VARCHAR(80) NOT NULL,
      title VARCHAR(180) NOT NULL,
      message TEXT NOT NULL,
      risk_level ENUM('Low','Medium','High') NOT NULL DEFAULT 'Low',
      device_id BIGINT NULL,
      device_hash CHAR(64) NULL,
      approval_request_id BIGINT NULL,
      ip_address VARCHAR(45) NULL,
      location VARCHAR(160) NULL,
      browser VARCHAR(100) NULL,
      operating_system VARCHAR(120) NULL,
      device_model VARCHAR(160) NULL,
      login_status VARCHAR(40) NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      read_at DATETIME NULL,
      delivery_status VARCHAR(40) NOT NULL DEFAULT 'In-App',
      email_status VARCHAR(40) NULL,
      metadata JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_security_notifications_user_read (user_id, is_read, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await ensureColumn('security_notifications', 'device_model', 'VARCHAR(160) NULL');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_approval_requests (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      device_hash CHAR(64) NOT NULL,
      device_name VARCHAR(120) NOT NULL,
      browser VARCHAR(100) NULL,
      operating_system VARCHAR(120) NULL,
      device_type VARCHAR(20) NULL,
      device_model VARCHAR(160) NULL,
      ip_address VARCHAR(45) NULL,
      location VARCHAR(160) NULL,
      risk_level ENUM('Low','Medium','High') NOT NULL DEFAULT 'Medium',
      login_status VARCHAR(40) NOT NULL DEFAULT 'Pending Approval',
      status ENUM('Pending','Approved','Ignored','Secured','Expired') NOT NULL DEFAULT 'Pending',
      requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      approved_at DATETIME NULL,
      approved_by INT NULL,
      expires_at DATETIME NULL,
      metadata JSON NULL,
      INDEX idx_device_approval_user_status (user_id, status, requested_at),
      INDEX idx_device_approval_hash (device_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await ensureColumn('device_approval_requests', 'device_model', 'VARCHAR(160) NULL');
}

async function auditTrustedDevice(req, action, result, details = {}) {
  try {
    await pool.execute(
      `INSERT INTO system_audit_log
         (user_id, employee_id, target_employee_id, action_performed, module,
          new_value, ip_address, user_agent, timestamp, Action_Type, Description, Created_At)
       VALUES (?, ?, ?, ?, 'TRUSTED_DEVICES', ?, ?, ?, NOW(), ?, ?, NOW())`,
      [
        req?.user?.id || details.user_id || null,
        req?.user?.employeeId || details.employee_id || null,
        req?.user?.employeeId || details.employee_id || null,
        `${action} [${String(result || 'recorded').toUpperCase()}]`,
        JSON.stringify(details),
        requestIp(req),
        userAgent(req),
        action.slice(0, 100),
        `Trusted device ${action} ${String(result || '').toUpperCase()}.`,
      ]
    );
  } catch (error) {
    console.error('[trustedDeviceService] audit failed:', error.message);
  }
}

async function auditDeviceAction({ userId, deviceId = null, action, req = null, details = {} }) {
  try {
    await ensureSecurityCenterSchema();
    const metadata = details.metadata || deviceMetadata(details.fingerprint || {}, req);
    const riskLevel = normalizeRiskLevel(details.risk_level || details.riskLevel);
    await pool.execute(
      `INSERT INTO device_audit_logs
         (user_id, device_id, action, timestamp, ip_address, device_name, browser,
          operating_system, device_model, location, login_status, risk_level, details)
       VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        userId,
        deviceId,
        action,
        details.ip_address || metadata.ipAddress || requestIp(req),
        details.device_name || details.deviceName || metadata.deviceName || null,
        details.browser || metadata.browser || null,
        details.operating_system || details.operatingSystem || null,
        details.device_model || details.deviceModel || metadata.deviceModel || null,
        details.location || null,
        details.login_status || details.loginStatus || null,
        riskLevel,
        JSON.stringify(details),
      ]
    );
  } catch (error) {
    console.error('[trustedDeviceService] device audit failed:', error.message);
  }
}

async function createSecurityNotification({ userId, type, title, message, riskLevel = 'Low', deviceId = null, deviceHash = null, approvalRequestId = null, req = null, metadata = {}, loginStatus = null }) {
  await ensureSecurityCenterSchema();
  const device = metadata.metadata || deviceMetadata(metadata.fingerprint || {}, req);
  const location = metadata.location || approximateLocationFromRequest(req);
  const [result] = await pool.execute(
    `INSERT INTO security_notifications
       (user_id, notification_type, title, message, risk_level, device_id, device_hash,
        approval_request_id, ip_address, location, browser, operating_system, device_model, login_status, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      cleanText(type, 80) || 'Security Event',
      cleanText(title, 180) || 'Security event',
      String(message || '').slice(0, 2000),
      normalizeRiskLevel(riskLevel),
      deviceId,
      deviceHash,
      approvalRequestId,
      device.ipAddress || requestIp(req),
      location,
      device.browser,
      device.operatingSystem,
      device.deviceModel,
      loginStatus,
      JSON.stringify(metadata),
    ]
  );
  return result.insertId;
}

async function createDeviceApprovalRequest({ userId, deviceHash, fingerprint = {}, req = null, riskLevel = 'Medium', loginStatus = 'Pending Approval', metadata = {} }) {
  await ensureSecurityCenterSchema();
  const device = deviceMetadata(fingerprint, req);
  const location = metadata.location || approximateLocationFromRequest(req);
  const [existing] = await pool.execute(
    `SELECT id FROM device_approval_requests
      WHERE user_id = ? AND device_hash = ?
        AND requested_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE)
        AND status IN ('Pending','Approved','Ignored','Secured')
      ORDER BY id DESC LIMIT 1`,
    [userId, deviceHash]
  );
  if (existing[0]) return existing[0].id;
  const [result] = await pool.execute(
    `INSERT INTO device_approval_requests
       (user_id, device_hash, device_name, browser, operating_system, device_type,
        device_model, ip_address, location, risk_level, login_status, expires_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE), ?)`,
    [
      userId,
      deviceHash,
      device.deviceName,
      device.browser,
      device.operatingSystem,
      device.deviceType,
      device.deviceModel,
      device.ipAddress,
      location,
      normalizeRiskLevel(riskLevel),
      loginStatus,
      JSON.stringify(metadata),
    ]
  );
  return result.insertId;
}

async function countTrustedDevices(userId) {
  await ensureTrustedDevicesTable();
  const [rows] = await pool.execute(
    "SELECT COUNT(*) AS total FROM trusted_devices WHERE user_id = ? AND status = 'Trusted'",
    [userId]
  );
  return Number(rows[0]?.total || 0);
}

async function getDeviceApprovalRequestStatus({ userId, requestId, deviceHash = null }) {
  await ensureSecurityCenterSchema();
  const params = [Number(requestId), Number(userId)];
  let hashClause = '';
  if (deviceHash) {
    hashClause = ' AND device_hash = ?';
    params.push(deviceHash);
  }
  const [rows] = await pool.execute(
    `SELECT id, user_id, device_hash, status, expires_at, requested_at, approved_at
       FROM device_approval_requests
      WHERE id = ? AND user_id = ?${hashClause}
      LIMIT 1`,
    params
  );
  const request = rows[0] || null;
  if (!request) return null;
  const expired = request.expires_at ? new Date(request.expires_at).getTime() < Date.now() : false;
  return {
    id: request.id,
    userId: request.user_id,
    deviceHash: request.device_hash,
    status: expired && request.status === 'Pending' ? 'Expired' : request.status,
    expiresAt: request.expires_at,
    requestedAt: request.requested_at,
    approvedAt: request.approved_at,
  };
}

async function recordLoginDeviceEvent({ userId, action, fingerprint = {}, req = null, deviceStatus = null, loginStatus = 'Successful', risk = null, details = {} }) {
  await ensureSecurityCenterSchema();
  const scored = risk || await scoreDeviceRisk(userId, fingerprint, req, deviceStatus);
  const device = deviceStatus?.device || null;
  await auditDeviceAction({
    userId,
    deviceId: device?.id || null,
    action,
    req,
    details: {
      ...details,
      fingerprint,
      metadata: scored.metadata,
      location: scored.location,
      login_status: loginStatus,
      risk_level: scored.riskLevel,
      risk_score: scored.score,
      risk_reasons: scored.reasons,
      device_name: scored.metadata.deviceName,
      device_model: scored.metadata.deviceModel,
    },
  });
  return scored;
}

async function recordUnknownDeviceAttempt({ userId, fingerprint = {}, req = null, deviceStatus = null, loginStatus = 'Successful', allowApprovalRequest = true }) {
  const scored = await recordLoginDeviceEvent({
    userId,
    action: 'Unknown Device Attempt',
    fingerprint,
    req,
    deviceStatus,
    loginStatus,
  });
  const approvalRequestId = allowApprovalRequest
    ? await createDeviceApprovalRequest({
      userId,
      deviceHash: deviceStatus?.deviceHash || fingerprintHash(userId, fingerprint, req),
      fingerprint,
      req,
      riskLevel: scored.riskLevel,
      loginStatus,
      metadata: { risk_reasons: scored.reasons, location: scored.location },
    })
    : null;
  await createSecurityNotification({
    userId,
    type: 'UNKNOWN_DEVICE_ATTEMPT',
    title: 'New sign-in attempt detected.',
    message: `Device: ${scored.metadata.deviceModel || scored.metadata.deviceType || 'Unknown device'} using ${scored.metadata.browser} on ${scored.metadata.operatingSystem}. Location: ${scored.location || 'Unavailable'}. IP: ${scored.metadata.ipAddress || 'Unavailable'}. Was this you?`,
    riskLevel: scored.riskLevel,
    deviceHash: deviceStatus?.deviceHash || fingerprintHash(userId, fingerprint, req),
    approvalRequestId,
    req,
    metadata: { risk_reasons: scored.reasons, login_status: loginStatus, fingerprint },
    loginStatus,
  });
  await auditTrustedDevice(req, 'UNKNOWN_DEVICE_ATTEMPT', 'recorded', {
    user_id: userId,
    login_status: loginStatus,
    risk_level: scored.riskLevel,
    approval_request_id: approvalRequestId,
  });
  return { ...scored, approvalRequestId };
}

async function findTrustedDevice(userId, fingerprint = {}, req = null) {
  await ensureTrustedDevicesTable();
  const hash = fingerprintHash(userId, fingerprint, req);
  const [rows] = await pool.execute(
    `SELECT id, user_id, device_name, device_hash, browser, operating_system,
            device_type, device_model, ip_address, last_used, registered_at, is_trusted, revoked_at,
            removed_at, removed_by, restored_at, status
       FROM trusted_devices
      WHERE user_id = ? AND device_hash = ?
      LIMIT 1`,
    [userId, hash]
  );
  if (rows[0]) return { device: rows[0], deviceHash: hash };

  const metadata = deviceMetadata(fingerprint, req);
  const [fallbackRows] = await pool.execute(
    `SELECT id, user_id, device_name, device_hash, browser, operating_system,
            device_type, device_model, ip_address, last_used, registered_at, is_trusted, revoked_at,
            removed_at, removed_by, restored_at, status
       FROM trusted_devices
      WHERE user_id = ?
        AND browser = ?
        AND operating_system = ?
        AND device_type = ?
        AND status = 'Trusted'
      ORDER BY COALESCE(last_used, registered_at) DESC, id DESC
      LIMIT 1`,
    [userId, metadata.browser, metadata.operatingSystem, metadata.deviceType]
  );

  const fallback = fallbackRows[0] || null;
  if (fallback) {
    try {
      await pool.execute(
        `UPDATE trusted_devices
            SET device_hash = ?, last_used = NOW(), ip_address = COALESCE(?, ip_address)
          WHERE id = ? AND user_id = ?`,
        [hash, metadata.ipAddress, fallback.id, userId]
      );
      fallback.device_hash = hash;
      fallback.last_used = new Date();
    } catch (error) {
      if (error?.code !== 'ER_DUP_ENTRY') throw error;
    }
  }

  return { device: fallback, deviceHash: hash };
}

async function deduplicateTrustedDevices(userId, fingerprint = {}, req = null) {
  await ensureTrustedDevicesTable();
  const metadata = deviceMetadata(fingerprint, req);
  const [rows] = await pool.execute(
    `SELECT id
       FROM trusted_devices
      WHERE user_id = ?
        AND browser = ?
        AND operating_system = ?
        AND device_type = ?
        AND status = 'Trusted'
      ORDER BY COALESCE(last_used, registered_at) DESC, id DESC`,
    [userId, metadata.browser, metadata.operatingSystem, metadata.deviceType]
  );
  if (rows.length <= 1) return 0;
  const keepId = rows[0].id;
  const duplicateIds = rows.slice(1).map(row => row.id);
  const placeholders = duplicateIds.map(() => '?').join(', ');
  const [result] = await pool.execute(
    `UPDATE trusted_devices
        SET status = 'Removed',
            is_trusted = FALSE,
            removed_at = COALESCE(removed_at, NOW()),
            removed_by = COALESCE(removed_by, ?)
      WHERE user_id = ? AND id IN (${placeholders})`,
    [userId, userId, ...duplicateIds]
  );
  await auditTrustedDevice(req, 'TRUSTED_DEVICE_DUPLICATES_MERGED', 'success', {
    user_id: userId,
    kept_device_id: keepId,
    removed_device_ids: duplicateIds,
  });
  return result.affectedRows || 0;
}

async function listDevices(userId, fingerprint = {}, req = null) {
  await ensureTrustedDevicesTable();
  await deduplicateTrustedDevices(userId, fingerprint, req);
  const currentHash = fingerprintHash(userId, fingerprint, req);
  const [rows] = await pool.execute(
    `SELECT id, device_name, device_hash, browser, operating_system, device_type,
            device_model, ip_address, last_used, registered_at, is_trusted, revoked_at,
            removed_at, removed_by, restored_at, status
       FROM trusted_devices
      WHERE user_id = ? AND status IN ('Trusted','Revoked')
      ORDER BY COALESCE(last_used, registered_at) DESC, id DESC`,
    [userId]
  );
  return rows.map(row => ({
    id: row.id,
    deviceName: row.device_name,
    browser: row.browser,
    operatingSystem: row.operating_system,
    deviceType: row.device_type,
    deviceModel: row.device_model,
    ipAddress: row.ip_address,
    lastUsed: row.last_used,
    registeredAt: row.registered_at,
    isTrusted: normalizeDeviceStatus(row) === 'Trusted',
    status: normalizeDeviceStatus(row),
    revokedAt: row.revoked_at,
    removedAt: row.removed_at,
    removedBy: row.removed_by,
    restoredAt: row.restored_at,
    currentDevice: row.device_hash === currentHash,
  }));
}

async function listDeviceHistory(userId) {
  await ensureTrustedDevicesTable();
  const [rows] = await pool.execute(
    `SELECT id, device_name, device_hash, browser, operating_system, device_type,
            device_model, ip_address, last_used, registered_at, is_trusted, revoked_at,
            removed_at, removed_by, restored_at, status
       FROM trusted_devices
      WHERE user_id = ?
      ORDER BY registered_at DESC, id DESC`,
    [userId]
  );
  return rows.map(row => ({
    id: row.id,
    deviceName: row.device_name,
    browser: row.browser,
    operatingSystem: row.operating_system,
    deviceType: row.device_type,
    deviceModel: row.device_model,
    ipAddress: row.ip_address,
    lastUsed: row.last_used,
    registeredAt: row.registered_at,
    isTrusted: normalizeDeviceStatus(row) === 'Trusted',
    status: normalizeDeviceStatus(row),
    revokedAt: row.revoked_at,
    removedAt: row.removed_at,
    removedBy: row.removed_by,
    restoredAt: row.restored_at,
  }));
}

async function getTrustedDeviceStatus(userId, fingerprint = {}, req = null) {
  await deduplicateTrustedDevices(userId, fingerprint, req);
  const { device, deviceHash } = await findTrustedDevice(userId, fingerprint, req);
  return {
    deviceHash,
    trusted: Boolean(device && normalizeDeviceStatus(device) === 'Trusted'),
    device,
  };
}

async function updateLastUsed(userId, deviceHash, req = null) {
  if (!deviceHash) return 0;
  await ensureTrustedDevicesTable();
  const metadata = deviceMetadata({}, req);
  const [result] = await pool.execute(
    `UPDATE trusted_devices
        SET last_used = NOW(), ip_address = COALESCE(?, ip_address), status = 'Trusted', is_trusted = TRUE, revoked_at = NULL, removed_at = NULL, removed_by = NULL
      WHERE user_id = ? AND device_hash = ? AND status = 'Trusted'`,
    [metadata.ipAddress, userId, deviceHash]
  );
  return result.affectedRows || 0;
}

async function registerDevice({ userId, fingerprint, req, password = null, passwordHash = null, deviceName = null }) {
  await ensureTrustedDevicesTable();
  await deduplicateTrustedDevices(userId, fingerprint, req);
  if (!passwordHash) {
    const error = new Error('Account password is not configured.');
    error.status = 403;
    throw error;
  }
  const verified = await verifyPassword(passwordHash, password || '');
  if (!verified) {
    await auditTrustedDevice(req, 'TRUSTED_DEVICE_PASSWORD_CONFIRMATION_FAILED', 'blocked', { user_id: userId });
    const error = new Error('Password confirmation failed.');
    error.status = 401;
    throw error;
  }
  const hash = fingerprintHash(userId, fingerprint, req);
  const metadata = deviceMetadata({ ...(fingerprint || {}), deviceName }, req);
  const existing = await findTrustedDevice(userId, fingerprint, req);
  if (existing.device) {
    const status = normalizeDeviceStatus(existing.device);
    if (status === 'Trusted') {
      await updateLastUsed(userId, existing.device.device_hash || existing.deviceHash, req);
      const error = new Error('This device has already been registered as a trusted device.');
      error.status = 409;
      error.code = 'DEVICE_ALREADY_REGISTERED';
      throw error;
    }
    const error = new Error('This device was previously registered. Would you like to restore it instead?');
    error.status = 409;
    error.code = 'DEVICE_RESTORE_REQUIRED';
    error.deviceId = existing.device.id;
    throw error;
  }

  await pool.execute(
    `INSERT INTO trusted_devices
       (user_id, device_name, device_hash, browser, operating_system, device_type, device_model,
        ip_address, first_registered_ip, last_location, last_used, registered_at, is_trusted, revoked_at, removed_at, removed_by, restored_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), TRUE, NULL, NULL, NULL, NULL, 'Trusted')`,
    [
      userId,
      metadata.deviceName,
      hash,
      metadata.browser,
      metadata.operatingSystem,
      metadata.deviceType,
      metadata.deviceModel,
      metadata.ipAddress,
      metadata.ipAddress,
      approximateLocationFromRequest(req),
    ]
  );
  await auditTrustedDevice(req, 'TRUSTED_DEVICE_REGISTERED', 'success', {
    user_id: userId,
    device_type: metadata.deviceType,
    browser: metadata.browser,
    operating_system: metadata.operatingSystem,
    device_model: metadata.deviceModel,
  });
  await auditDeviceAction({ userId, action: 'Device Registered', req, details: { device_type: metadata.deviceType, device_model: metadata.deviceModel, browser: metadata.browser, operating_system: metadata.operatingSystem } });
  return { deviceHash: hash, metadata };
}

async function restoreDevice({ userId, deviceId, req }) {
  await ensureTrustedDevicesTable();
  const [result] = await pool.execute(
    `UPDATE trusted_devices
        SET status = 'Trusted', is_trusted = TRUE, revoked_at = NULL, removed_at = NULL, removed_by = NULL, restored_at = NOW()
      WHERE id = ? AND user_id = ?`,
    [deviceId, userId]
  );
  if (!result.affectedRows) {
    const error = new Error('Device was not found.');
    error.status = 404;
    throw error;
  }
  await auditTrustedDevice(req, 'TRUSTED_DEVICE_RESTORED', 'success', { user_id: userId, device_id: deviceId });
  await auditDeviceAction({ userId, deviceId, action: 'Device Restored', req, details: { device_id: deviceId } });
}

async function renameDevice({ userId, deviceId, deviceName, req }) {
  await ensureTrustedDevicesTable();
  const name = cleanText(deviceName, 120);
  if (!name || name.length < 2) {
    const error = new Error('Device name must be at least 2 characters.');
    error.status = 400;
    throw error;
  }
  const [result] = await pool.execute(
    `UPDATE trusted_devices SET device_name = ? WHERE id = ? AND user_id = ?`,
    [name, deviceId, userId]
  );
  if (!result.affectedRows) {
    const error = new Error('Device was not found.');
    error.status = 404;
    throw error;
  }
  await auditTrustedDevice(req, 'TRUSTED_DEVICE_RENAMED', 'success', { user_id: userId, device_id: deviceId });
  await auditDeviceAction({ userId, deviceId, action: 'Device Renamed', req, details: { device_name: name } });
}

async function revokeDevice({ userId, deviceId, password, passwordHash, req }) {
  await ensureTrustedDevicesTable();
  if (!passwordHash) {
    const error = new Error('Account password is not configured.');
    error.status = 403;
    throw error;
  }
  const verified = await verifyPassword(passwordHash, password || '');
  if (!verified) {
    await auditTrustedDevice(req, 'TRUSTED_DEVICE_REVOKE_PASSWORD_FAILED', 'blocked', { user_id: userId, device_id: deviceId });
    const error = new Error('Password confirmation failed.');
    error.status = 401;
    throw error;
  }
  const [result] = await pool.execute(
    `UPDATE trusted_devices
        SET is_trusted = FALSE, revoked_at = COALESCE(revoked_at, NOW()), removed_at = COALESCE(removed_at, NOW()), removed_by = COALESCE(removed_by, ?), status = 'Removed'
      WHERE id = ? AND user_id = ?`,
    [userId, deviceId, userId]
  );
  if (!result.affectedRows) {
    const error = new Error('Device was not found.');
    error.status = 404;
    throw error;
  }
  await auditTrustedDevice(req, 'TRUSTED_DEVICE_REVOKED', 'success', { user_id: userId, device_id: deviceId });
  await auditDeviceAction({ userId, deviceId, action: 'Device Removed', req, details: { device_id: deviceId } });
}

async function createDeviceSession({ userId, deviceId = null, req = null, fingerprint = {}, loginMethod = 'Password', sessionStatus = 'Active', location = null, deviceName = null, userSessionId = null, jwtId = null, riskLevel = null }) {
  await ensureSecurityCenterSchema();
  const metadata = deviceMetadata({ ...(fingerprint || {}), deviceName }, req);
  const supersedeParams = [
    userId,
    deviceId || null,
    metadata.ipAddress || null,
    metadata.browser || null,
    metadata.operatingSystem || null,
    metadata.deviceType || null,
    metadata.deviceModel || null,
  ];
  const duplicateWhere = `
    ds.user_id = ?
    AND ds.session_status = 'Active'
    AND (
      (? IS NOT NULL AND ds.device_id = ?)
      OR (
        COALESCE(ds.ip_address, '') = COALESCE(?, '')
        AND COALESCE(ds.browser, '') = COALESCE(?, '')
        AND COALESCE(ds.operating_system, '') = COALESCE(?, '')
        AND COALESCE(ds.device_type, '') = COALESCE(?, '')
        AND COALESCE(ds.device_model, '') = COALESCE(?, '')
      )
    )`;
  const duplicateValues = [
    supersedeParams[0],
    supersedeParams[1],
    supersedeParams[1],
    supersedeParams[2],
    supersedeParams[3],
    supersedeParams[4],
    supersedeParams[5],
    supersedeParams[6],
  ];
  if (jwtId || userSessionId) {
    await pool.execute(
      `UPDATE USER_SESSION us
         JOIN device_sessions ds
           ON ds.jwt_id = us.JWT_ID
           OR (ds.user_session_id IS NOT NULL AND ds.user_session_id = us.Session_ID)
          SET us.Revoked_At = COALESCE(us.Revoked_At, NOW()),
              us.Revocation_Reason = COALESCE(us.Revocation_Reason, 'device_session_superseded')
        WHERE ${duplicateWhere}
          AND us.Revoked_At IS NULL`,
      duplicateValues
    );
    await pool.execute(
      `UPDATE device_sessions
          SET session_status = 'Superseded',
              logout_at = COALESCE(logout_at, NOW())
        WHERE ${duplicateWhere.replaceAll('ds.', '')}`,
      duplicateValues
    );
  }
  const [result] = await pool.execute(
    `INSERT INTO device_sessions
       (user_id, device_id, user_session_id, jwt_id, login_at, last_activity, logout_at,
        session_status, login_method, risk_level, ip_address, location, browser, operating_system, device_type, device_model)
     VALUES (?, ?, ?, ?, NOW(), NOW(), NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      deviceId,
      userSessionId,
      jwtId,
      sessionStatus,
      loginMethod,
      riskLevel,
      metadata.ipAddress,
      location || null,
      metadata.browser,
      metadata.operatingSystem,
      metadata.deviceType,
      metadata.deviceModel,
    ]
  );
  await auditDeviceAction({ userId, deviceId, action: 'Session Started', req, details: { session_id: result.insertId, login_method: loginMethod, device_model: metadata.deviceModel } });
  return { id: result.insertId, loginMethod, sessionStatus, browser: metadata.browser, operatingSystem: metadata.operatingSystem, deviceType: metadata.deviceType, deviceModel: metadata.deviceModel };
}

async function listSessionHistory(userId) {
  await ensureSecurityCenterSchema();
  const [rows] = await pool.execute(
    `SELECT ds.id, ds.user_id, ds.device_id, ds.user_session_id, ds.jwt_id,
            ds.login_at, COALESCE(ds.last_activity, ds.updated_at, ds.login_at) AS last_activity,
            ds.logout_at, ds.session_status, ds.login_method, ds.risk_level,
            ds.ip_address, ds.location, ds.browser, ds.operating_system, ds.device_type, ds.device_model,
            td.device_name
       FROM device_sessions ds
       LEFT JOIN trusted_devices td ON td.id = ds.device_id
      WHERE ds.user_id = ?
      ORDER BY ds.login_at DESC, ds.id DESC`,
    [userId]
  );
  return rows.map((row, index) => ({
    id: row.id,
    deviceId: row.device_id,
    userSessionId: row.user_session_id,
    jwtId: row.jwt_id,
    deviceName: row.device_name || 'Current Device',
    loginAt: row.login_at,
    lastActivity: row.last_activity,
    logoutAt: row.logout_at,
    sessionStatus: row.session_status || 'Active',
    loginMethod: row.login_method || 'Password',
    riskLevel: row.risk_level || 'Low',
    ipAddress: row.ip_address,
    location: row.location,
    browser: row.browser,
    operatingSystem: row.operating_system,
    deviceType: row.device_type,
    deviceModel: row.device_model,
    isCurrent: row.session_status === 'Active' && index === 0,
  }));
}

async function updateSessionStatus({ userId, sessionId = null, jwtId = null, sessionStatus = 'Logged Out', req = null }) {
  await ensureSecurityCenterSchema();
  let query = `UPDATE device_sessions SET session_status = ?, logout_at = COALESCE(logout_at, NOW())`;
  const params = [sessionStatus];
  if (sessionId) {
    query += ` WHERE id = ? AND user_id = ?`;
    params.push(sessionId, userId);
  } else if (jwtId) {
    query += ` WHERE jwt_id = ? AND user_id = ?`;
    params.push(jwtId, userId);
  } else {
    query += ` WHERE user_id = ? AND session_status = 'Active' ORDER BY login_at DESC, id DESC LIMIT 1`;
    params.push(userId);
  }
  const [result] = await pool.execute(query, params);
  if (result.affectedRows) {
    await auditDeviceAction({ userId, action: sessionStatus === 'Terminated' ? 'Session Terminated' : 'Session Ended', req, details: { session_id: sessionId || null, jwt_id: jwtId || null, session_status: sessionStatus } });
  }
  return result.affectedRows || 0;
}

async function listDeviceActivity({ userId, search = '', riskLevel = '', status = '', limit = 100, offset = 0 } = {}) {
  await ensureSecurityCenterSchema();
  const clauses = ['dal.user_id = ?'];
  const params = [userId];
  if (riskLevel && RISK_LEVELS.has(riskLevel)) {
    clauses.push('dal.risk_level = ?');
    params.push(riskLevel);
  }
  if (status) {
    clauses.push('dal.login_status = ?');
    params.push(cleanText(status, 40));
  }
  if (search) {
    clauses.push('(dal.action LIKE ? OR dal.device_name LIKE ? OR dal.browser LIKE ? OR dal.operating_system LIKE ? OR dal.ip_address LIKE ? OR dal.location LIKE ?)');
    const like = `%${cleanText(search, 80)}%`;
    params.push(like, like, like, like, like, like);
  }
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const [rows] = await pool.query(
    `SELECT dal.*, u.username
       FROM device_audit_logs dal
       LEFT JOIN users u ON u.id = dal.user_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY dal.timestamp DESC, dal.id DESC
      LIMIT ? OFFSET ?`,
    [...params, safeLimit, safeOffset]
  );
  return rows.map(row => ({
    id: row.id,
    userId: row.user_id,
    user: row.username || '',
    deviceId: row.device_id,
    deviceName: row.device_name || 'Unknown Device',
    browser: row.browser || '',
    operatingSystem: row.operating_system || '',
    deviceModel: row.device_model || '',
    ipAddress: row.ip_address || '',
    location: row.location || '',
    status: row.login_status || row.action,
    riskLevel: row.risk_level || 'Low',
    action: row.action,
    details: row.details,
    createdAt: row.timestamp,
  }));
}

async function listSecurityNotifications(userId, unreadOnly = false) {
  await ensureSecurityCenterSchema();
  const [rows] = await pool.execute(
    `SELECT *
       FROM security_notifications
      WHERE user_id = ?
        ${unreadOnly ? 'AND is_read = FALSE' : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
    [userId]
  );
  return rows.map(row => ({
    id: row.id,
    type: row.notification_type,
    title: row.title,
    message: row.message,
    riskLevel: row.risk_level,
    deviceId: row.device_id,
    approvalRequestId: row.approval_request_id,
    ipAddress: row.ip_address,
    location: row.location,
    browser: row.browser,
    operatingSystem: row.operating_system,
    deviceModel: row.device_model,
    loginStatus: row.login_status,
    isRead: Boolean(row.is_read),
    createdAt: row.created_at,
  }));
}

async function markNotificationRead(userId, notificationId) {
  await ensureSecurityCenterSchema();
  const [result] = await pool.execute(
    `UPDATE security_notifications
        SET is_read = TRUE, read_at = NOW()
      WHERE id = ? AND user_id = ?`,
    [notificationId, userId]
  );
  return result.affectedRows || 0;
}

async function listApprovalRequests(userId) {
  await ensureSecurityCenterSchema();
  const [rows] = await pool.execute(
    `SELECT *
       FROM device_approval_requests
      WHERE user_id = ?
      ORDER BY requested_at DESC, id DESC
      LIMIT 100`,
    [userId]
  );
  return rows.map(row => ({
    id: row.id,
    deviceHash: row.device_hash,
    deviceName: row.device_name,
    browser: row.browser,
    operatingSystem: row.operating_system,
    deviceType: row.device_type,
    deviceModel: row.device_model,
    ipAddress: row.ip_address,
    location: row.location,
    riskLevel: row.risk_level,
    loginStatus: row.login_status,
    status: row.status,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    expiresAt: row.expires_at,
  }));
}

async function approveDeviceRequest({ userId, requestId, req = null }) {
  await ensureSecurityCenterSchema();
  const [rows] = await pool.execute(
    `SELECT * FROM device_approval_requests WHERE id = ? AND user_id = ? LIMIT 1`,
    [requestId, userId]
  );
  const request = rows[0];
  if (!request) {
    const error = new Error('Device approval request was not found.');
    error.status = 404;
    throw error;
  }
  if (request.status !== 'Pending') {
    const error = new Error('Device approval request is no longer pending.');
    error.status = 409;
    throw error;
  }
  const [existing] = await pool.execute(
    `SELECT id FROM trusted_devices WHERE user_id = ? AND device_hash = ? LIMIT 1`,
    [userId, request.device_hash]
  );
  let deviceId = existing[0]?.id || null;
  if (deviceId) {
    await pool.execute(
      `UPDATE trusted_devices
          SET status = 'Trusted', is_trusted = TRUE, revoked_at = NULL, removed_at = NULL,
              device_name = ?, browser = ?, operating_system = ?, device_type = ?, device_model = ?,
              ip_address = ?, last_location = ?, last_used = NOW()
        WHERE id = ? AND user_id = ?`,
      [request.device_name, request.browser, request.operating_system, request.device_type, request.device_model, request.ip_address, request.location, deviceId, userId]
    );
  } else {
    const [created] = await pool.execute(
      `INSERT INTO trusted_devices
         (user_id, device_name, device_hash, browser, operating_system, device_type, device_model,
          ip_address, first_registered_ip, last_location, last_used, registered_at, is_trusted, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), TRUE, 'Trusted')`,
      [userId, request.device_name, request.device_hash, request.browser, request.operating_system, request.device_type || 'Desktop', request.device_model, request.ip_address, request.ip_address, request.location]
    );
    deviceId = created.insertId;
  }
  await pool.execute(
    `UPDATE device_approval_requests
        SET status = 'Approved', approved_at = NOW(), approved_by = ?
      WHERE id = ? AND user_id = ?`,
    [userId, requestId, userId]
  );
  await auditTrustedDevice(req, 'DEVICE_TRUST_APPROVED', 'success', { user_id: userId, device_id: deviceId, approval_request_id: requestId });
  await auditDeviceAction({ userId, deviceId, action: 'Device Trust Approved', req, details: { risk_level: request.risk_level, login_status: 'Approved', device_name: request.device_name, browser: request.browser, operating_system: request.operating_system, device_model: request.device_model, location: request.location } });
  await createSecurityNotification({ userId, type: 'DEVICE_TRUST_APPROVED', title: 'Trusted device added', message: `${request.device_name} is now trusted.`, riskLevel: 'Low', deviceId, deviceHash: request.device_hash, approvalRequestId: requestId, req, metadata: { approved: true }, loginStatus: 'Approved' });
  return { deviceId };
}

async function updateApprovalRequestStatus({ userId, requestId, status, req = null }) {
  await ensureSecurityCenterSchema();
  if (!['Ignored', 'Secured'].includes(status)) {
    const error = new Error('Invalid approval request action.');
    error.status = 400;
    throw error;
  }
  const [rows] = await pool.execute('SELECT * FROM device_approval_requests WHERE id = ? AND user_id = ? LIMIT 1', [requestId, userId]);
  const request = rows[0];
  if (!request) {
    const error = new Error('Device approval request was not found.');
    error.status = 404;
    throw error;
  }
  await pool.execute(
    `UPDATE device_approval_requests SET status = ?, approved_at = NOW(), approved_by = ? WHERE id = ? AND user_id = ?`,
    [status, userId, requestId, userId]
  );
  await auditTrustedDevice(req, status === 'Secured' ? 'UNKNOWN_DEVICE_SECURE_ACCOUNT' : 'UNKNOWN_DEVICE_IGNORED', 'success', { user_id: userId, approval_request_id: requestId });
  await auditDeviceAction({ userId, action: status === 'Secured' ? 'Secure Account Selected' : 'Unknown Device Ignored', req, details: { risk_level: request.risk_level, login_status: status, device_name: request.device_name, browser: request.browser, operating_system: request.operating_system, device_model: request.device_model, location: request.location } });
}

async function securitySummary(userId) {
  await ensureSecurityCenterSchema();
  const scalar = async (sql, params) => {
    const [rows] = await pool.execute(sql, params);
    return Number(Object.values(rows[0] || {})[0] || 0);
  };
  return {
    trustedDevices: await scalar("SELECT COUNT(*) FROM trusted_devices WHERE user_id = ? AND status = 'Trusted'", [userId]),
    activeSessions: await scalar("SELECT COUNT(*) FROM device_sessions WHERE user_id = ? AND session_status = 'Active'", [userId]),
    unknownDeviceAttempts: await scalar("SELECT COUNT(*) FROM device_audit_logs WHERE user_id = ? AND action = 'Unknown Device Attempt' AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)", [userId]),
    failedLoginAttempts: await scalar("SELECT COUNT(*) FROM device_audit_logs WHERE user_id = ? AND action = 'Failed Login' AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)", [userId]),
    highRiskEvents: await scalar("SELECT COUNT(*) FROM device_audit_logs WHERE user_id = ? AND risk_level = 'High' AND timestamp >= DATE_SUB(NOW(), INTERVAL 30 DAY)", [userId]),
    unreadNotifications: await scalar('SELECT COUNT(*) FROM security_notifications WHERE user_id = ? AND is_read = FALSE', [userId]),
    pendingApprovals: await scalar("SELECT COUNT(*) FROM device_approval_requests WHERE user_id = ? AND status = 'Pending'", [userId]),
  };
}

module.exports = {
  approveDeviceRequest,
  auditTrustedDevice,
  auditDeviceAction,
  countTrustedDevices,
  createDeviceSession,
  createSecurityNotification,
  deviceMetadata,
  ensureSecurityCenterSchema,
  ensureTrustedDevicesTable,
  findTrustedDevice,
  fingerprintHash,
  getDeviceApprovalRequestStatus,
  getTrustedDeviceStatus,
  listApprovalRequests,
  listDeviceActivity,
  listDeviceHistory,
  listDevices,
  listSecurityNotifications,
  listSessionHistory,
  markNotificationRead,
  recordLoginDeviceEvent,
  recordUnknownDeviceAttempt,
  registerDevice,
  renameDevice,
  restoreDevice,
  revokeDevice,
  scoreDeviceRisk,
  securitySummary,
  updateApprovalRequestStatus,
  updateLastUsed,
  updateSessionStatus,
};
