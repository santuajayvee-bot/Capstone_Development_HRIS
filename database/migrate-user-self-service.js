const pool = require('../config/db');

async function up(connection = pool) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS user_profile_change_requests (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      employee_id BIGINT NOT NULL,
      field_name VARCHAR(120) NOT NULL,
      old_value TEXT NULL,
      requested_value TEXT NOT NULL,
      reason TEXT NULL,
      status ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
      reviewed_by BIGINT NULL,
      reviewed_at DATETIME NULL,
      rejection_reason TEXT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_profile_request_employee (employee_id),
      INDEX idx_profile_request_status (status)
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS user_profile_audit_logs (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      employee_id BIGINT NOT NULL,
      action VARCHAR(120) NOT NULL,
      field_changed VARCHAR(120) NULL,
      old_value TEXT NULL,
      new_value TEXT NULL,
      ip_address VARCHAR(80) NULL,
      user_agent VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_profile_audit_employee (employee_id),
      INDEX idx_profile_audit_user (user_id)
    )
  `);
}

async function down(connection = pool) {
  await connection.query('DROP TABLE IF EXISTS user_profile_audit_logs');
  await connection.query('DROP TABLE IF EXISTS user_profile_change_requests');
}

async function run() {
  try {
    await up();
    console.log('User self-service migration complete.');
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  run().catch(error => {
    console.error('User self-service migration failed:', error);
    process.exit(1);
  });
}

module.exports = { up, down };
