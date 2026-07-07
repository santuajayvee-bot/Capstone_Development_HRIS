const crypto = require('crypto');
const pool = require('../config/db');
const { verifyPassword } = require('./passwordService');

const MAX_FINGERPRINT_FIELDS = 24;
const DEVICE_TYPES = new Set(['Desktop', 'Mobile', 'Tablet']);
const DEVICE_STATUS_VALUES = new Set(['Trusted', 'Revoked', 'Removed']);

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

function parseBrowser(ua = '') {
  const value = String(ua);
  if (/Edg\//i.test(value)) return 'Microsoft Edge';
  if (/OPR\//i.test(value)) return 'Opera';
  if (/Chrome\//i.test(value) && !/Chromium/i.test(value)) return 'Chrome';
  if (/Firefox\//i.test(value)) return 'Firefox';
  if (/Safari\//i.test(value) && !/Chrome\//i.test(value)) return 'Safari';
  if (/MSIE|Trident/i.test(value)) return 'Internet Explorer';
  return 'Unknown Browser';
}

function parseOperatingSystem(ua = '', platform = '') {
  const value = `${ua} ${platform}`;
  if (/Windows NT/i.test(value)) return 'Windows';
  if (/Android/i.test(value)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(value)) return 'iOS';
  if (/Mac OS X|Macintosh|MacIntel/i.test(value)) return 'macOS';
  if (/Linux/i.test(value)) return 'Linux';
  return cleanText(platform, 120) || 'Unknown OS';
}

function parseDeviceType(ua = '', requestedType = '') {
  const normalized = cleanText(requestedType, 20);
  if (DEVICE_TYPES.has(normalized)) return normalized;
  const value = String(ua);
  if (/iPad|Tablet|Silk/i.test(value)) return 'Tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(value)) return 'Mobile';
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
  const platform = fingerprint.platform || fingerprint.userAgentDataPlatform || '';
  const browser = cleanText(fingerprint.browser, 100) || parseBrowser(ua);
  const operatingSystem = cleanText(fingerprint.operatingSystem, 120) || parseOperatingSystem(ua, platform);
  const deviceType = parseDeviceType(ua, fingerprint.deviceType);
  const fallbackName = `${operatingSystem} ${browser}`.trim();
  return {
    browser,
    operatingSystem,
    deviceType,
    deviceName: cleanText(fingerprint.deviceName, 120) || fallbackName || 'Trusted Device',
    ipAddress: cleanText(requestIp(req), 45),
  };
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
      details TEXT NULL,
      INDEX idx_device_audit_logs_user (user_id, timestamp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
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
    await ensureDeviceAuditLogTable();
    await pool.execute(
      `INSERT INTO device_audit_logs (user_id, device_id, action, timestamp, ip_address, details)
       VALUES (?, ?, ?, NOW(), ?, ?)`,
      [userId, deviceId, action, requestIp(req), JSON.stringify(details)]
    );
  } catch (error) {
    console.error('[trustedDeviceService] device audit failed:', error.message);
  }
}

async function findTrustedDevice(userId, fingerprint = {}, req = null) {
  await ensureTrustedDevicesTable();
  const hash = fingerprintHash(userId, fingerprint, req);
  const [rows] = await pool.execute(
    `SELECT id, user_id, device_name, device_hash, browser, operating_system,
            device_type, ip_address, last_used, registered_at, is_trusted, revoked_at,
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
            device_type, ip_address, last_used, registered_at, is_trusted, revoked_at,
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
            ip_address, last_used, registered_at, is_trusted, revoked_at,
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
            ip_address, last_used, registered_at, is_trusted, revoked_at,
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
       (user_id, device_name, device_hash, browser, operating_system, device_type,
        ip_address, last_used, registered_at, is_trusted, revoked_at, removed_at, removed_by, restored_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), TRUE, NULL, NULL, NULL, NULL, 'Trusted')`,
    [
      userId,
      metadata.deviceName,
      hash,
      metadata.browser,
      metadata.operatingSystem,
      metadata.deviceType,
      metadata.ipAddress,
    ]
  );
  await auditTrustedDevice(req, 'TRUSTED_DEVICE_REGISTERED', 'success', {
    user_id: userId,
    device_type: metadata.deviceType,
    browser: metadata.browser,
    operating_system: metadata.operatingSystem,
  });
  await auditDeviceAction({ userId, action: 'Device Registered', req, details: { device_type: metadata.deviceType, browser: metadata.browser, operating_system: metadata.operatingSystem } });
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

async function createDeviceSession({ userId, deviceId = null, req = null, fingerprint = {}, loginMethod = 'Password', sessionStatus = 'Active', location = null, deviceName = null }) {
  await ensureDeviceSessionTable();
  const metadata = deviceMetadata({ ...(fingerprint || {}), deviceName }, req);
  const [result] = await pool.execute(
    `INSERT INTO device_sessions (user_id, device_id, login_at, logout_at, session_status, login_method, ip_address, location, browser, operating_system, device_type)
     VALUES (?, ?, NOW(), NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      deviceId,
      sessionStatus,
      loginMethod,
      metadata.ipAddress,
      location || null,
      metadata.browser,
      metadata.operatingSystem,
      metadata.deviceType,
    ]
  );
  await auditDeviceAction({ userId, deviceId, action: 'Session Started', req, details: { session_id: result.insertId, login_method: loginMethod } });
  return { id: result.insertId, loginMethod, sessionStatus, browser: metadata.browser, operatingSystem: metadata.operatingSystem, deviceType: metadata.deviceType };
}

async function listSessionHistory(userId) {
  await ensureDeviceSessionTable();
  const [rows] = await pool.execute(
    `SELECT ds.id, ds.user_id, ds.device_id, ds.login_at, ds.logout_at, ds.session_status, ds.login_method,
            ds.ip_address, ds.location, ds.browser, ds.operating_system, ds.device_type,
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
    deviceName: row.device_name || 'Current Device',
    loginAt: row.login_at,
    logoutAt: row.logout_at,
    sessionStatus: row.session_status || 'Active',
    loginMethod: row.login_method || 'Password',
    ipAddress: row.ip_address,
    location: row.location,
    browser: row.browser,
    operatingSystem: row.operating_system,
    deviceType: row.device_type,
    isCurrent: row.session_status === 'Active' && index === 0,
  }));
}

async function updateSessionStatus({ userId, sessionId = null, sessionStatus = 'Logged Out', req = null }) {
  await ensureDeviceSessionTable();
  let query = `UPDATE device_sessions SET session_status = ?, logout_at = COALESCE(logout_at, NOW())`;
  const params = [sessionStatus];
  if (sessionId) {
    query += ` WHERE id = ? AND user_id = ?`;
    params.push(sessionId, userId);
  } else {
    query += ` WHERE user_id = ? AND session_status = 'Active' ORDER BY login_at DESC, id DESC LIMIT 1`;
    params.push(userId);
  }
  const [result] = await pool.execute(query, params);
  if (result.affectedRows) {
    await auditDeviceAction({ userId, action: sessionStatus === 'Terminated' ? 'Session Terminated' : 'Session Ended', req, details: { session_id: sessionId || null, session_status: sessionStatus } });
  }
  return result.affectedRows || 0;
}

module.exports = {
  auditTrustedDevice,
  auditDeviceAction,
  createDeviceSession,
  deviceMetadata,
  ensureTrustedDevicesTable,
  findTrustedDevice,
  fingerprintHash,
  getTrustedDeviceStatus,
  listDeviceHistory,
  listDevices,
  listSessionHistory,
  registerDevice,
  renameDevice,
  restoreDevice,
  revokeDevice,
  updateLastUsed,
  updateSessionStatus,
};
