const pool = require('../config/db');

const SETTINGS = [
  ['Late Deduction Policy', 'payroll', 'late_deduction_type', 'None'],
  ['Late Deduction Policy', 'payroll', 'late_deduction_rate', '0'],
  ['Late Deduction Policy', 'payroll', 'late_apply_grace_period', 'true'],
  ['Late Deduction Policy', 'payroll', 'late_require_hr_approval', 'true'],
  ['Undertime Deduction Policy', 'payroll', 'undertime_deduction_type', 'None'],
  ['Undertime Deduction Policy', 'payroll', 'undertime_deduction_rate', '0'],
  ['Undertime Deduction Policy', 'payroll', 'undertime_require_hr_approval', 'true'],
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
}

async function down(connection = pool) {
  const keys = SETTINGS.map((item) => item[2]);
  const placeholders = keys.map(() => '?').join(', ');
  await connection.execute(
    `DELETE FROM attendance_policy_settings WHERE policy_key IN (${placeholders})`,
    keys
  );
}

async function run() {
  const direction = String(process.argv[2] || 'up').toLowerCase();
  try {
    if (direction === 'down') await down();
    else await up();
    console.log(`Attendance tardy deduction migration ${direction} completed.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error('Attendance tardy deduction migration failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { up, down, SETTINGS };
