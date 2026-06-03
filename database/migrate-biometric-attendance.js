/* ============================================================
   Biometric attendance integration migration

   Keeps the existing daily attendance_log table for payroll and
   adds privacy-preserving biometric ingestion and integrity data.

   Run:
     node database/migrate-biometric-attendance.js
   ============================================================ */

require('dotenv').config();
const crypto = require('crypto');
const pool = require('../config/db');

const GENESIS_HASH = '0'.repeat(64);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.execute(
    `SELECT 1
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
}

async function indexExists(conn, table, index) {
  const [rows] = await conn.execute(
    `SELECT 1
       FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND INDEX_NAME = ?`,
    [table, index]
  );
  return rows.length > 0;
}

async function ensureColumn(conn, table, column, definition) {
  if (!(await columnExists(conn, table, column))) {
    await conn.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`  Added ${table}.${column}`);
  }
}

async function ensureIndex(conn, table, index, columns, unique = false) {
  if (!(await indexExists(conn, table, index))) {
    await conn.execute(
      `CREATE ${unique ? 'UNIQUE ' : ''}INDEX \`${index}\` ON \`${table}\` (${columns})`
    );
    console.log(`  Added index ${index}`);
  }
}

async function migrate() {
  const conn = await pool.getConnection();
  try {
    console.log('Running biometric attendance migration...');

    await conn.execute(`
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

    await conn.execute(`
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

    await conn.execute(`
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

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS attendance_adjustment (
        adjustment_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        attendance_id BIGINT NOT NULL,
        employee_id INT NOT NULL,
        adjustment_type ENUM('MANUAL_CORRECTION','MANUAL_ATTENDANCE','VERIFICATION','OVERTIME') NOT NULL,
        reason VARCHAR(500) NOT NULL,
        old_value JSON NULL,
        new_value JSON NULL,
        verification_status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'APPROVED',
        requested_by INT NOT NULL,
        approved_by INT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        approved_at DATETIME NULL,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        FOREIGN KEY (requested_by) REFERENCES users(id) ON DELETE RESTRICT,
        INDEX idx_adjustment_attendance (attendance_id, created_at),
        INDEX idx_adjustment_employee (employee_id, created_at)
      )
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS attendance_summary (
        summary_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        attendance_date DATE NOT NULL,
        attendance_id BIGINT NULL,
        regular_minutes INT NOT NULL DEFAULT 0,
        overtime_minutes INT NOT NULL DEFAULT 0,
        late_minutes INT NOT NULL DEFAULT 0,
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

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS biometric_sync_log (
        sync_log_id BIGINT AUTO_INCREMENT PRIMARY KEY,
        device_id INT NOT NULL,
        sync_mode ENUM('PULL','WEBHOOK') NOT NULL,
        status ENUM('STARTED','SUCCESS','PARTIAL','FAILED') NOT NULL,
        received_count INT NOT NULL DEFAULT 0,
        accepted_count INT NOT NULL DEFAULT 0,
        duplicate_count INT NOT NULL DEFAULT 0,
        rejected_count INT NOT NULL DEFAULT 0,
        error_message VARCHAR(500) NULL,
        initiated_by INT NULL,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME NULL,
        FOREIGN KEY (device_id) REFERENCES biometric_device(device_id) ON DELETE CASCADE,
        INDEX idx_sync_device_started (device_id, started_at),
        INDEX idx_sync_status_started (status, started_at)
      )
    `);

    await conn.execute(`
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

    await ensureColumn(conn, 'attendance_log', 'biometric_user_hash', 'CHAR(64) NULL');
    await ensureColumn(conn, 'attendance_log', 'biometric_user_id_encrypted', 'TEXT NULL');
    await ensureColumn(conn, 'attendance_log', 'device_id', 'INT NULL');
    await ensureColumn(
      conn,
      'attendance_log',
      'verification_status',
      "ENUM('VALIDATED','INCOMPLETE','NEEDS_REVIEW','REJECTED') NOT NULL DEFAULT 'VALIDATED'"
    );
    await ensureColumn(
      conn,
      'attendance_log',
      'source',
      "ENUM('BIOMETRIC_API','QR_GEOFENCE','HR_MANUAL_ADJUSTMENT') NOT NULL DEFAULT 'QR_GEOFENCE'"
    );
    await ensureColumn(conn, 'attendance_log', 'first_scan_at', 'DATETIME NULL');
    await ensureColumn(conn, 'attendance_log', 'last_scan_at', 'DATETIME NULL');
    await ensureColumn(conn, 'attendance_log', 'integrity_hash', 'CHAR(64) NULL');

    await conn.execute(`
      ALTER TABLE biometric_scan_event
      MODIFY COLUMN scan_timestamp DATETIME NULL
    `);

    await conn.execute(`
      ALTER TABLE attendance_log
      MODIFY COLUMN status
      ENUM('Present','Late','Absent','On Leave','Half Day','Incomplete','Needs Review')
      NOT NULL DEFAULT 'Present'
    `);

    await ensureIndex(conn, 'attendance_log', 'idx_attendance_verification', '`verification_status`, `date`');
    await ensureIndex(conn, 'attendance_log', 'idx_attendance_device', '`device_id`, `date`');

    await conn.execute(`
      UPDATE attendance_log
         SET verification_status = CASE
               WHEN time_in IS NOT NULL AND time_out IS NOT NULL THEN 'VALIDATED'
               ELSE 'INCOMPLETE'
             END
       WHERE source = 'QR_GEOFENCE'
    `);

    const [lastChain] = await conn.execute(
      'SELECT chain_hash FROM attendance_integrity_chain ORDER BY chain_id DESC LIMIT 1'
    );
    let previousHash = lastChain[0]?.chain_hash || GENESIS_HASH;
    const [unhashedRows] = await conn.execute(`
      SELECT attendance_id, employee_id, date, time_in, time_out, overtime_hours,
             absences, status, biometric_user_hash, device_id, verification_status,
             source, first_scan_at, last_scan_at
        FROM attendance_log
       WHERE integrity_hash IS NULL
       ORDER BY attendance_id
    `);

    for (const row of unhashedRows) {
      const payloadHash = sha256(canonicalJson(row));
      const chainHash = sha256(`${payloadHash}:${previousHash}:MIGRATION_BASELINE`);
      await conn.execute(
        `INSERT INTO attendance_integrity_chain
           (attendance_id, event_type, payload_hash, previous_hash, chain_hash)
         VALUES (?, 'MIGRATION_BASELINE', ?, ?, ?)`,
        [row.attendance_id, payloadHash, previousHash, chainHash]
      );
      await conn.execute(
        'UPDATE attendance_log SET integrity_hash = ? WHERE attendance_id = ?',
        [chainHash, row.attendance_id]
      );
      previousHash = chainHash;
    }

    await conn.execute(`
      INSERT INTO attendance_summary
        (employee_id, attendance_date, attendance_id, regular_minutes, overtime_minutes,
         late_minutes, attendance_status, verification_status, payroll_eligible, integrity_hash)
      SELECT employee_id, date, attendance_id,
             CASE WHEN time_in IS NOT NULL AND time_out IS NOT NULL
                  THEN GREATEST(0, FLOOR(TIME_TO_SEC(TIMEDIFF(time_out, time_in)) / 60))
                  ELSE 0 END,
             ROUND(COALESCE(overtime_hours, 0) * 60),
             CASE WHEN time_in IS NOT NULL
                  THEN GREATEST(0, FLOOR(TIME_TO_SEC(TIMEDIFF(time_in, '09:00:00')) / 60))
                  ELSE 0 END,
             status, verification_status,
             CASE WHEN verification_status = 'VALIDATED' AND time_in IS NOT NULL AND time_out IS NOT NULL
                  THEN 1 ELSE 0 END,
             integrity_hash
        FROM attendance_log
      ON DUPLICATE KEY UPDATE
        attendance_id = VALUES(attendance_id),
        regular_minutes = VALUES(regular_minutes),
        overtime_minutes = VALUES(overtime_minutes),
        late_minutes = VALUES(late_minutes),
        attendance_status = VALUES(attendance_status),
        verification_status = VALUES(verification_status),
        payroll_eligible = VALUES(payroll_eligible),
        integrity_hash = VALUES(integrity_hash)
    `);

    console.log('Biometric attendance migration completed.');
  } catch (err) {
    console.error('Biometric attendance migration failed:', err);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate();
