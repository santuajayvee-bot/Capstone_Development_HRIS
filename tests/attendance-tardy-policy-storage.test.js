const assert = require('assert');
const pool = require('../config/db');

const expectedKeys = [
  'late_apply_grace_period',
  'late_require_hr_approval',
  'undertime_require_hr_approval',
  'late_deduction_method',
  'undertime_deduction_method',
  'working_days_per_month',
];

async function run() {
  const placeholders = expectedKeys.map(() => '?').join(', ');
  const [rows] = await pool.execute(
    `SELECT policy_key, policy_value, is_active
       FROM attendance_policy_settings
      WHERE policy_key IN (${placeholders})
        AND is_active = 1
      ORDER BY policy_key`,
    expectedKeys
  );
  const uniqueKeys = [...new Set(rows.map((row) => row.policy_key))].sort();
  assert.deepStrictEqual(uniqueKeys, [...expectedKeys].sort(), 'All mandated tardy/undertime policy settings must be stored and active.');
  console.table(rows);
  console.log('attendance_policy_settings storage validation: PASS');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
