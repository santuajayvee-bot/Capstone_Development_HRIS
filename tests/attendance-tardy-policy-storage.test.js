const assert = require('assert');
const pool = require('../config/db');

const expectedKeys = [
  'late_apply_grace_period',
  'late_require_hr_approval',
  'undertime_require_hr_approval',
  'late_deduction_method',
  'late_fixed_deduction_amount',
  'undertime_deduction_method',
  'undertime_fixed_deduction_amount',
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
  assert.strictEqual(rows.length, expectedKeys.length, 'All tardy deduction settings must be stored and active.');
  assert.deepStrictEqual(rows.map((row) => row.policy_key).sort(), [...expectedKeys].sort());
  console.table(rows);
  console.log('attendance_policy_settings storage validation: PASS');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
