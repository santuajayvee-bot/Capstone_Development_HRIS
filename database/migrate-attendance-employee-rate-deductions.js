const pool = require('../config/db');

const SETTINGS = [
  ['Late Deduction Policy', 'payroll', 'late_deduction_method', 'auto_compute'],
  ['Late Deduction Policy', 'payroll', 'late_fixed_deduction_amount', '0'],
  ['Undertime Deduction Policy', 'payroll', 'undertime_deduction_method', 'auto_compute'],
  ['Undertime Deduction Policy', 'payroll', 'undertime_fixed_deduction_amount', '0'],
];

async function up(connection = pool) {
  for (const [name, category, key, value] of SETTINGS) {
    await connection.execute(
      `INSERT INTO attendance_policy_settings
         (policy_name, policy_category, policy_key, policy_value, effective_date, is_active)
       SELECT ?, ?, ?, ?, CURDATE(), 1
       WHERE NOT EXISTS (
         SELECT 1 FROM attendance_policy_settings
         WHERE policy_key = ? AND is_active = 1
       )`,
      [name, category, key, value, key]
    );
  }
  await connection.execute(
    `UPDATE attendance_policy_settings
        SET is_active = 0
      WHERE policy_key IN ('late_deduction_type', 'late_deduction_rate', 'undertime_deduction_type', 'undertime_deduction_rate')`
  );
}

async function down(connection = pool) {
  const keys = SETTINGS.map((item) => item[2]);
  await connection.execute(
    `DELETE FROM attendance_policy_settings WHERE policy_key IN (${keys.map(() => '?').join(', ')})`,
    keys
  );
  await connection.execute(
    `UPDATE attendance_policy_settings
        SET is_active = 1
      WHERE policy_key IN ('late_deduction_type', 'late_deduction_rate', 'undertime_deduction_type', 'undertime_deduction_rate')`
  );
}

async function run() {
  try {
    if (String(process.argv[2] || 'up').toLowerCase() === 'down') await down();
    else await up();
    console.log(`Attendance employee-rate deduction migration ${process.argv[2] || 'up'} completed.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error('Attendance employee-rate deduction migration failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { up, down };
