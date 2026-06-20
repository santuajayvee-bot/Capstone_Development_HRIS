const pool = require('../config/db');

const POLICY_KEY = 'working_days_per_month';

async function up(connection = pool) {
  await connection.execute(
    `INSERT INTO attendance_policy_settings
       (policy_name, policy_category, policy_key, policy_value, effective_date, is_active)
     SELECT 'Payroll Attendance Policy', 'payroll', ?, '26', CURDATE(), 1
     WHERE NOT EXISTS (
       SELECT 1 FROM attendance_policy_settings
       WHERE policy_key = ? AND is_active = 1
     )`,
    [POLICY_KEY, POLICY_KEY]
  );
}

async function down(connection = pool) {
  await connection.execute(
    'DELETE FROM attendance_policy_settings WHERE policy_key = ?',
    [POLICY_KEY]
  );
}

async function run() {
  try {
    if (String(process.argv[2] || 'up').toLowerCase() === 'down') await down();
    else await up();
    console.log(`Attendance working-days migration ${process.argv[2] || 'up'} completed.`);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error('Attendance working-days migration failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { up, down };
