/* ============================================================
   database/migrate-attendance.js — Create Attendance Module tables
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function migrate() {
  console.log('🔄 Starting Attendance Module migration...\n');

  try {
    // 1. ATTENDANCE_LOG — Core attendance tracking
    //    employee_id is INT to match employees.id (INT)
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS attendance_log (
        attendance_id   BIGINT AUTO_INCREMENT PRIMARY KEY,
        employee_id     INT NOT NULL,
        date            DATE NOT NULL,
        time_in         TIME NULL,
        time_out        TIME NULL,
        overtime_hours  DECIMAL(10,2) DEFAULT 0.00,
        absences        TINYINT(1) DEFAULT 0,
        status          ENUM('Present','Late','Absent','On Leave','Half Day') DEFAULT 'Present',
        device_fingerprint VARCHAR(255) NULL,
        clock_in_lat_encrypted  TEXT NULL,
        clock_in_lng_encrypted  TEXT NULL,
        clock_out_lat_encrypted TEXT NULL,
        clock_out_lng_encrypted TEXT NULL,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        UNIQUE KEY unique_emp_date (employee_id, date)
      )
    `);
    console.log('✅ Table: attendance_log');

    // 2. SYSTEM_AUDIT_LOG — Non-repudiation trail for manual overrides
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS system_audit_log (
        log_id          BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id         INT NOT NULL,
        employee_id     INT NULL,
        timestamp       DATETIME DEFAULT CURRENT_TIMESTAMP,
        action_performed TEXT NOT NULL,
        old_value       TEXT NULL,
        new_value       TEXT NULL,
        ip_address      VARCHAR(45) NULL,
        user_agent      VARCHAR(500) NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log('✅ Table: system_audit_log');

    // 3. GEOFENCE_CONFIG — Define allowed attendance geo-boundaries
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS geofence_config (
        id              INT AUTO_INCREMENT PRIMARY KEY,
        site_name       VARCHAR(100) NOT NULL DEFAULT 'Main Factory',
        latitude        DECIMAL(10,8) NOT NULL,
        longitude       DECIMAL(11,8) NOT NULL,
        radius_meters   INT NOT NULL DEFAULT 200,
        site_secret     VARCHAR(255) NOT NULL,
        is_active       TINYINT(1) DEFAULT 1,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    console.log('✅ Table: geofence_config');

    // 4. DEVICE_BINDINGS — Track device binding per employee per day
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS device_bindings (
        id              BIGINT AUTO_INCREMENT PRIMARY KEY,
        employee_id     INT NOT NULL,
        date            DATE NOT NULL,
        device_fingerprint VARCHAR(255) NOT NULL,
        created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        UNIQUE KEY unique_emp_device_date (employee_id, date)
      )
    `);
    console.log('✅ Table: device_bindings');

    // 5. Insert default geofence (can be updated later by admin)
    const [existing] = await pool.execute('SELECT id FROM geofence_config LIMIT 1');
    if (existing.length === 0) {
      const crypto = require('crypto');
      const siteSecret = crypto.randomBytes(32).toString('hex');
      await pool.execute(
        `INSERT INTO geofence_config (site_name, latitude, longitude, radius_meters, site_secret)
         VALUES (?, ?, ?, ?, ?)`,
        ['LGSV Main Factory', 14.5995, 120.9842, 200, siteSecret]
      );
      console.log('✅ Default geofence inserted (Manila coordinates — update via admin panel)');
      console.log('   Site Secret:', siteSecret);
    }

    console.log('\n🎉 Attendance Module migration complete!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    console.error(err);
  } finally {
    process.exit(0);
  }
}

migrate();
