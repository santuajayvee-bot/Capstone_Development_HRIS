/* ============================================================
   Static QR Attendance migration
   Creates:
   - attendance_locations
   - attendance
   - attendance_scan_logs
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function migrate() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS attendance_locations (
        id INT AUTO_INCREMENT PRIMARY KEY,
        location_name VARCHAR(160) NOT NULL,
        latitude DECIMAL(10,8) NOT NULL,
        longitude DECIMAL(11,8) NOT NULL,
        allowed_radius_meters INT NOT NULL DEFAULT 200,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS attendance (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        attendance_date DATE NOT NULL,
        time_in DATETIME NULL,
        time_out DATETIME NULL,
        time_in_latitude DECIMAL(10,8) NULL,
        time_in_longitude DECIMAL(11,8) NULL,
        time_out_latitude DECIMAL(10,8) NULL,
        time_out_longitude DECIMAL(11,8) NULL,
        time_in_distance_meters DECIMAL(10,2) NULL,
        time_out_distance_meters DECIMAL(10,2) NULL,
        location_id INT NULL,
        source VARCHAR(40) NOT NULL DEFAULT 'STATIC_QR',
        status ENUM('Timed In','Completed') NOT NULL DEFAULT 'Timed In',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY unique_employee_attendance_date (employee_id, attendance_date),
        INDEX idx_attendance_employee_date (employee_id, attendance_date),
        CONSTRAINT fk_static_attendance_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        CONSTRAINT fk_static_attendance_location FOREIGN KEY (location_id) REFERENCES attendance_locations(id) ON DELETE SET NULL
      )
    `);

    await pool.execute(`
      CREATE TABLE IF NOT EXISTS attendance_scan_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NULL,
        employee_id INT NULL,
        location_id INT NULL,
        scan_type ENUM('TIME_IN','TIME_OUT','AUTO','GPS_DENIED','DUPLICATE','OUTSIDE_RADIUS','UNAUTHENTICATED','ERROR') NOT NULL DEFAULT 'AUTO',
        result ENUM('SUCCESS','REJECTED') NOT NULL,
        reason VARCHAR(255) NULL,
        latitude DECIMAL(10,8) NULL,
        longitude DECIMAL(11,8) NULL,
        distance_meters DECIMAL(10,2) NULL,
        allowed_radius_meters INT NULL,
        ip_address VARCHAR(45) NULL,
        user_agent VARCHAR(500) NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_att_scan_employee_created (employee_id, created_at),
        INDEX idx_att_scan_result_created (result, created_at)
      )
    `);

    const [locations] = await pool.execute('SELECT id FROM attendance_locations LIMIT 1');
    if (!locations.length) {
      let geofences = [];
      try {
        [geofences] = await pool.execute('SELECT site_name, latitude, longitude, radius_meters FROM geofence_config WHERE is_active = 1 LIMIT 1');
      } catch (error) {
        if (error.code !== 'ER_NO_SUCH_TABLE') throw error;
      }
      const source = geofences[0] || {
        site_name: 'LGSV Main Factory',
        latitude: 14.5995,
        longitude: 120.9842,
        radius_meters: 200,
      };
      await pool.execute(
        `INSERT INTO attendance_locations (location_name, latitude, longitude, allowed_radius_meters)
         VALUES (?, ?, ?, ?)`,
        [source.site_name, source.latitude, source.longitude, source.radius_meters]
      );
    }

    console.log('Static QR attendance tables are ready.');
  } catch (error) {
    console.error('Static QR attendance migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

migrate();
