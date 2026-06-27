const assert = require('assert');

const pool = require('../config/db');

async function run() {
  const [[userResult]] = await pool.execute(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN password_hash LIKE '$argon2id$%' THEN 1 ELSE 0 END) AS argon2id_count
      FROM users
  `);
  const [[linkedEmployeeResult]] = await pool.execute(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN e.Password_Hash LIKE '$argon2id$%' THEN 1 ELSE 0 END) AS argon2id_count
      FROM users u
      JOIN employees e ON e.id = u.employee_id
  `);

  assert.ok(Number(userResult.total) > 0, 'At least one user account is required.');
  assert.strictEqual(Number(userResult.argon2id_count), Number(userResult.total), 'Every user password must use Argon2id.');
  assert.strictEqual(
    Number(linkedEmployeeResult.argon2id_count),
    Number(linkedEmployeeResult.total),
    'Every linked employee password mirror must use Argon2id.'
  );
  console.log('Password storage security tests: PASS');
}

run()
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
