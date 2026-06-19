/* ============================================================
   database/migrate-login-lockout.js
   Adds login lockout tracking columns to users.
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

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

async function migrate() {
  const conn = await pool.getConnection();
  try {
    if (!(await hasColumn(conn, 'users', 'login_attempts'))) {
      await conn.execute('ALTER TABLE users ADD COLUMN login_attempts INT NOT NULL DEFAULT 0 AFTER is_active');
      console.log('Added users.login_attempts');
    } else {
      console.log('users.login_attempts already exists');
    }

    if (!(await hasColumn(conn, 'users', 'locked_until'))) {
      await conn.execute('ALTER TABLE users ADD COLUMN locked_until DATETIME NULL AFTER login_attempts');
      console.log('Added users.locked_until');
    } else {
      console.log('users.locked_until already exists');
    }

    await conn.execute('UPDATE users SET login_attempts = COALESCE(login_attempts, 0) WHERE login_attempts IS NULL');
    console.log('Login lockout migration complete.');
  } catch (error) {
    console.error('Login lockout migration failed:', error.message);
    process.exitCode = 1;
  } finally {
    conn.release();
    await pool.end();
  }
}

migrate();
