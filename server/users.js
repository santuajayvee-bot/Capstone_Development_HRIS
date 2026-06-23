/* ============================================================
   server/users.js — User database queries
   ============================================================ */

const pool = require('../config/db');
const { decryptNullable } = require('./data-protection');

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

const FALLBACK_ROLE_PERMISSIONS = {
  system_admin: ['employee.view', 'employee.manage', 'employee:offboard:create', 'employee:offboard:approve', 'employee:reboard:create', 'employee:reboard:approve', 'user_account:reactivate', 'attendance.view', 'leave.request.view_all', 'leave.request.approve', 'payroll.view', 'payroll.calculate', 'payroll.approve', 'report.view', 'settings.manage'],
  admin: ['employee.view', 'employee.manage', 'employee:offboard:create', 'employee:offboard:approve', 'employee:reboard:create', 'employee:reboard:approve', 'user_account:reactivate', 'attendance.view', 'leave.request.view_all', 'leave.request.approve', 'payroll.view', 'payroll.calculate', 'payroll.approve', 'report.view', 'settings.manage'],
  hr_admin: ['employee.view', 'employee.manage', 'employee:offboard:create', 'employee:offboard:approve', 'employee:reboard:create', 'employee:reboard:approve', 'user_account:reactivate', 'attendance.view', 'attendance.manage', 'leave.request.view_all', 'leave.request.approve', 'leave.manual.create', 'report.view'],
  hr_manager: ['employee.view', 'employee.manage', 'employee:offboard:create', 'employee:offboard:approve', 'employee:reboard:create', 'employee:reboard:approve', 'user_account:reactivate', 'attendance.view', 'attendance.manage', 'leave.request.view_all', 'leave.request.approve', 'leave.manual.create', 'report.view'],
  payroll_officer: ['payroll.view', 'payroll.calculate', 'payroll.settings.manage', 'payroll.report.view', 'employee.view', 'attendance.view', 'leave.request.view_all', 'leave.report.view', 'leave.audit.view'],
  payroll_manager: ['payroll.view', 'payroll.calculate', 'payroll.settings.manage', 'payroll.approve', 'payroll.report.view', 'report.view', 'attendance.view', 'leave.request.view_all', 'leave.report.view', 'leave.audit.view'],
  manager: ['attendance.view', 'leave.request.approve', 'report.view'],
  employee: ['attendance.view', 'leave.request.create', 'leave.request.view_own', 'payroll.view'],
};

async function getUserPermissions(userId, roleName = 'employee') {
  try {
    const [rows] = await pool.execute(
      `SELECT p.permission_key
         FROM users u
         JOIN role_permissions rp ON rp.role_id = u.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE u.id = ?
        ORDER BY p.permission_key`,
      [userId]
    );
    if (rows.length) return rows.map(row => row.permission_key);
  } catch (error) {
    // Permissions tables are optional for older installs.
  }
  return FALLBACK_ROLE_PERMISSIONS[roleName] || FALLBACK_ROLE_PERMISSIONS.employee;
}

async function getLinkedEmployeeProfile(employeeId) {
  if (!employeeId) return null;
  const [rows] = await pool.execute(
    `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.status, e.position,
            d.name AS department, wt.name AS wage_type
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
      WHERE e.id = ?
      LIMIT 1`,
    [employeeId]
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
       COALESCE(u.email, e.email) AS email,
       u.email_encrypted,
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
  const row = rows[0] || null;
  if (row?.email_encrypted && !row.email) row.email = decryptNullable(row.email_encrypted);
  if (row) delete row.email_encrypted;
  return row;
}

module.exports = { findByUsername, updateLastLogin, getUserProfile, getUserPermissions, getLinkedEmployeeProfile };
