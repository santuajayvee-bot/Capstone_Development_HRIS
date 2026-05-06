/* ============================================================
   server/users.js — User database queries
   ============================================================ */

const pool = require('../config/db');

/**
 * Find a user by username, joining their role name.
 * @param {string} username
 * @returns {object|null}
 */
async function findByUsername(username) {
  const [rows] = await pool.execute(
    `SELECT
       u.id,
       u.username,
       u.password_hash,
       u.employee_id,
       u.is_active,
       r.name  AS role,
       r.label AS role_label
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.username = ?
     LIMIT 1`,
    [username]
  );
  return rows[0] || null;
}

/**
 * Update last_login timestamp.
 * @param {number} userId
 */
async function updateLastLogin(userId) {
  await pool.execute(
    'UPDATE users SET last_login = NOW() WHERE id = ?',
    [userId]
  );
}

/**
 * Get full user profile (joined with employee record).
 * @param {number} userId
 */
async function getUserProfile(userId) {
  const [rows] = await pool.execute(
    `SELECT
       u.id,
       u.username,
       r.name        AS role,
       r.label       AS role_label,
       e.employee_code,
       e.first_name,
       e.last_name,
       e.email,
       e.position,
       d.name        AS department
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN employees e  ON e.id = u.employee_id
     LEFT JOIN departments d ON d.id = e.department_id
     WHERE u.id = ?
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

module.exports = { findByUsername, updateLastLogin, getUserProfile };
