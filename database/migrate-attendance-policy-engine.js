/* ============================================================
   database/migrate-attendance-policy-engine.js
   Creates the effective-dated attendance policy settings table.
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

const defaults = [
  ['Work Schedule Policy', 'schedule', 'work_start_time', '08:00'],
  ['Work Schedule Policy', 'schedule', 'work_end_time', '17:00'],
  ['Work Schedule Policy', 'schedule', 'break_start_time', '12:00'],
  ['Work Schedule Policy', 'schedule', 'break_end_time', '13:00'],
  ['Work Schedule Policy', 'schedule', 'standard_work_hours', '8'],
  ['Grace Period Policy', 'validation', 'grace_period_minutes', '10'],
  ['Late Policy', 'validation', 'enable_late_tracking', 'true'],
  ['Late Policy', 'validation', 'late_threshold_minutes', '0'],
  ['Late Policy', 'validation', 'count_late_for_payroll', 'true'],
  ['Undertime Policy', 'validation', 'enable_undertime_tracking', 'true'],
  ['Undertime Policy', 'validation', 'count_undertime_for_payroll', 'true'],
  ['Half-Day Policy', 'validation', 'enable_half_day_rule', 'true'],
  ['Half-Day Policy', 'validation', 'half_day_threshold_hours', '4'],
  ['Overtime Policy', 'overtime', 'enable_overtime', 'true'],
  ['Overtime Policy', 'overtime', 'overtime_threshold_minutes', '480'],
  ['Overtime Policy', 'overtime', 'overtime_approval_required', 'true'],
  ['Overtime Policy', 'overtime', 'minimum_overtime_minutes', '30'],
  ['Attendance Validation Policy', 'validation', 'require_hr_validation', 'true'],
  ['Attendance Validation Policy', 'validation', 'auto_payroll_ready', 'false'],
  ['Attendance Validation Policy', 'validation', 'validation_expiration_days', '3'],
  ['Missing Time Out Policy', 'exceptions', 'missing_timeout_handling', 'Needs Review'],
  ['Duplicate Scan Policy', 'biometric', 'duplicate_scan_window_seconds', '60'],
  ['Payroll Attendance Policy', 'payroll', 'payroll_attendance_source', 'payroll_ready'],
  ['Holiday Policy', 'holiday', 'enable_holiday_rules', 'false'],
  ['Holiday Policy', 'holiday', 'regular_holiday_multiplier', '2.00'],
  ['Holiday Policy', 'holiday', 'special_holiday_multiplier', '1.30'],
  ['Holiday Policy', 'holiday', 'rest_day_multiplier', '1.30'],
  ['Holiday Policy', 'holiday', 'holiday_overtime_multiplier', '1.30'],
  ['Attendance Exception Policy', 'exceptions', 'allow_manual_attendance', 'true'],
  ['Attendance Exception Policy', 'exceptions', 'allow_hr_correction', 'true'],
  ['Attendance Exception Policy', 'exceptions', 'allow_manager_certification', 'false'],
  ['Attendance Exception Policy', 'exceptions', 'device_failure_handling', 'HR Correction Required'],
];

async function hasColumn(conn, table, column) {
  const [rows] = await conn.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [table, column]
  );
  return rows.length > 0;
}

async function addColumnIfMissing(conn, table, column, definition) {
  if (!(await hasColumn(conn, table, column))) {
    await conn.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Added ${table}.${column}`);
  }
}

async function normalizeLegacyPolicyTable(conn) {
  const hasSettingKey = await hasColumn(conn, 'attendance_policy_settings', 'setting_key');
  const hasId = await hasColumn(conn, 'attendance_policy_settings', 'id');
  if (hasSettingKey && !hasId) {
    try {
      await conn.execute('ALTER TABLE attendance_policy_settings DROP PRIMARY KEY');
      console.log('Dropped legacy attendance_policy_settings primary key.');
    } catch (_) {}
    try {
      await conn.execute('ALTER TABLE attendance_policy_settings MODIFY setting_key VARCHAR(100) NULL');
      console.log('Made legacy setting_key nullable.');
    } catch (_) {}
    await conn.execute('ALTER TABLE attendance_policy_settings ADD COLUMN id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY FIRST');
    console.log('Added attendance_policy_settings.id primary key.');
  }
}

async function up(conn) {
  await conn.execute(`
    CREATE TABLE IF NOT EXISTS attendance_policy_settings (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      policy_name VARCHAR(120) NULL,
      policy_category VARCHAR(80) NULL,
      policy_key VARCHAR(120) NULL,
      policy_value TEXT NULL,
      effective_date DATE NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by BIGINT NULL,
      updated_by BIGINT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_att_policy_lookup (policy_key, is_active, effective_date),
      INDEX idx_att_policy_category (policy_category, is_active)
    )
  `);

  await normalizeLegacyPolicyTable(conn);
  await addColumnIfMissing(conn, 'attendance_policy_settings', 'policy_name', 'VARCHAR(120) NULL');
  await addColumnIfMissing(conn, 'attendance_policy_settings', 'policy_category', 'VARCHAR(80) NULL');
  await addColumnIfMissing(conn, 'attendance_policy_settings', 'policy_key', 'VARCHAR(120) NULL');
  await addColumnIfMissing(conn, 'attendance_policy_settings', 'policy_value', 'TEXT NULL');
  await addColumnIfMissing(conn, 'attendance_policy_settings', 'effective_date', 'DATE NULL');
  await addColumnIfMissing(conn, 'attendance_policy_settings', 'is_active', 'TINYINT(1) NOT NULL DEFAULT 1');
  await addColumnIfMissing(conn, 'attendance_policy_settings', 'created_by', 'BIGINT NULL');
  await addColumnIfMissing(conn, 'attendance_policy_settings', 'updated_by', 'BIGINT NULL');
  await addColumnIfMissing(conn, 'attendance_policy_settings', 'created_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
  await addColumnIfMissing(conn, 'attendance_policy_settings', 'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
  try { await conn.execute('CREATE INDEX idx_att_policy_lookup ON attendance_policy_settings (policy_key, is_active, effective_date)'); } catch (_) {}
  try { await conn.execute('CREATE INDEX idx_att_policy_category ON attendance_policy_settings (policy_category, is_active)'); } catch (_) {}

  for (const row of defaults) {
    await conn.execute(
      `INSERT INTO attendance_policy_settings
         (policy_name, policy_category, policy_key, policy_value, effective_date, is_active)
       SELECT ?, ?, ?, ?, CURDATE(), 1
        WHERE NOT EXISTS (
          SELECT 1 FROM attendance_policy_settings
           WHERE policy_key = ? AND is_active = 1
        )`,
      [...row, row[2]]
    );
  }

  if (await hasColumn(conn, 'attendance_summary', 'attendance_id')) {
    await addColumnIfMissing(conn, 'attendance_summary', 'undertime_minutes', 'INT NOT NULL DEFAULT 0 AFTER late_minutes');
    await addColumnIfMissing(conn, 'attendance_summary', 'policy_snapshot_json', 'JSON NULL AFTER integrity_hash');
  }
}

async function down(conn) {
  await conn.execute('DROP TABLE IF EXISTS attendance_policy_settings');
}

async function run() {
  const direction = String(process.argv[2] || 'up').toLowerCase();
  const conn = await pool.getConnection();
  try {
    if (direction === 'down') {
      await down(conn);
      console.log('Attendance policy engine migration rolled back.');
    } else {
      await up(conn);
      console.log('Attendance policy engine migration complete.');
    }
  } catch (error) {
    console.error('Attendance policy engine migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

if (require.main === module) run();

module.exports = { up, down };
