/* ============================================================
   server/admin-rbac.js — Account Registration & RBAC Management
   ============================================================
   Zero Trust Security Model — Level 4 (System Admin) Only
   
   Features:
   1. Strict Level 4 Authorization Middleware
   2. Account Registration / Role Assignment (Use Case 17)
   3. Immutable Audit Logging (ISO/IEC 27001 Non-Repudiation)
   4. Role CRUD for System Administrator
   ============================================================ */

const express  = require('express');
const router   = express.Router();
const pool     = require('../config/db');
const { requireAuth, requirePermission } = require('./middleware');
const accountController = require('../controllers/accountController');
const { decryptColumnValue } = require('./data-protection');
const {
  hashTemporaryPassword,
  validateTemporaryPassword,
} = require('../services/passwordService');

async function hasColumn(tableName, columnName) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

function decryptEmployeeUserFields(row) {
  if (!row) return row;
  ['first_name', 'last_name'].forEach(field => {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      row[field] = decryptColumnValue(row[field]);
    }
  });
  return row;
}

// ── Argon2 Configuration (OWASP recommended) ────────────────
/* ================================================================
   MIDDLEWARE: requireLevel4 — Strict System Administrator Guard
   ================================================================
   Extracts role from the active JWT (set by requireAuth).
   If the role is NOT system_admin (Level 4), the request is
   immediately rejected with 403 Forbidden.
   ================================================================ */
function requireLevel4(req, res, next) {
  const userRole = req.user?.role;

  // Accept both 'system_admin' and legacy 'admin' mapped to Level 4
  const LEVEL_4_ROLES = ['system_admin', 'admin'];

  if (!userRole || !LEVEL_4_ROLES.includes(userRole)) {
    // Log the unauthorized attempt
    logAuditEntry(req, {
      action: `UNAUTHORIZED_ACCESS_ATTEMPT: Role '${userRole}' tried to access Level 4 endpoint ${req.method} ${req.originalUrl}`,
      module: 'RBAC_SECURITY',
    }).catch(() => {});

    return res.status(403).json({
      error: 'Access denied.',
      message: 'Only System Administrator (Level 4) can access this resource.',
      required_level: 'Level 4',
      your_role: userRole || 'unknown',
    });
  }

  next();
}

/* ================================================================
   HELPER: logAuditEntry — Immutable Audit Trail (Non-Repudiation)
   ================================================================
   Inserts into system_audit_log with parameterized queries.
   This function is called within every mutation to guarantee
   an unalterable record exists for ISO/IEC 27001 compliance.
   ================================================================ */
async function logAuditEntry(req, { action, module = 'RBAC', targetEmployeeId = null, oldValue = null, newValue = null }) {
  const userId    = req.user?.id || 0;
  const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';

  await pool.execute(
    `INSERT INTO system_audit_log 
       (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [userId, req.user?.employeeId || null, targetEmployeeId, action, module, oldValue, newValue, ipAddress, userAgent]
  );
}

/* ================================================================
   HELPER: extractClientIP — Get real client IP behind proxies
   ================================================================ */
function extractClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

/* ================================================================
   HELPER: sanitizeInput — Basic input sanitation
   ================================================================ */
function sanitizeInput(str) {
  if (typeof str !== 'string') return str;
  return str.trim().replace(/[<>]/g, '');
}

function passwordPolicyErrors(password) {
  const result = validateTemporaryPassword(password);
  return result.valid ? [] : result.errors;
}

async function revokeEmployeeSessions(conn, employeeId, reason) {
  await conn.execute(
    `UPDATE USER_SESSION
        SET Revoked_At = NOW(),
            Revocation_Reason = ?
      WHERE Employee_ID = (SELECT Employee_ID FROM employees WHERE id = ? LIMIT 1)
        AND Revoked_At IS NULL`,
    [reason, employeeId]
  );
}

// ── Apply auth + Level 4 guard to ALL routes in this router ──
router.use(requireAuth);
router.use(requireLevel4);
router.use(requirePermission('admin_panel:access'));

router.put('/users/:userId/reset-password', accountController.resetUserPassword);

/* ================================================================
   POST /api/admin/register-role
   ================================================================
   Account Registration & Role Assignment (Use Case 17)
   
   Creates or updates a user account and assigns a role.
   - Hashes password with Argon2id
   - Logs immutable audit entry
   
   Body: {
     employee_id:      (required) target employee's numeric ID
     username:         (required) login username
     password:         (required) default password
     role_id:          (required) role to assign
   }
   ================================================================ */
router.post('/register-role', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { employee_id, username, password, role_id } = req.body;

    // ── Input Validation ─────────────────────────────────────
    if (!employee_id || !username || !password || !role_id) {
      return res.status(400).json({
        error: 'Missing required fields.',
        required: ['employee_id', 'username', 'password', 'role_id'],
      });
    }

    const passwordErrors = passwordPolicyErrors(password);
    if (passwordErrors.length) {
      return res.status(400).json({
        error: 'Temporary password is invalid.',
        requirements: passwordErrors,
      });
    }

    const cleanUsername = sanitizeInput(username).toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(cleanUsername)) {
      return res.status(400).json({
        error: 'Username may only contain lowercase letters, numbers, dots, hyphens, and underscores.',
      });
    }

    // ── Verify employee exists ───────────────────────────────
    const [empRows] = await conn.execute(
      'SELECT id, first_name, last_name, employee_code FROM employees WHERE id = ?',
      [employee_id]
    );
    if (empRows.length === 0) {
      return res.status(404).json({ error: 'Employee not found.' });
    }
    const employee = empRows[0];

    // ── Verify role exists ───────────────────────────────────
    const [roleRows] = await conn.execute(
      'SELECT id, name, label, access_level FROM roles WHERE id = ?',
      [role_id]
    );
    if (roleRows.length === 0) {
      return res.status(404).json({ error: 'Role not found.' });
    }
    const assignedRole = roleRows[0];

    // ── Hash password with Argon2id ──────────────────────────
    // Administrator-created passwords are temporary. They are stored only as
    // Argon2id hashes and force the employee to choose a new password.
    const passwordHash = await hashTemporaryPassword(password);

    // ── Begin Transaction ────────────────────────────────────
    await conn.beginTransaction();

    // Check if user account already exists for this employee
    const [existingUser] = await conn.execute(
      'SELECT id, role_id FROM users WHERE employee_id = ?',
      [employee_id]
    );

    let userId;
    let actionPerformed;
    let oldValue = null;

    if (existingUser.length > 0) {
      // ── UPDATE existing account ────────────────────────────
      const oldRoleId = existingUser[0].role_id;
      userId = existingUser[0].id;

      // Fetch old role name for audit
      const [oldRoleRows] = await conn.execute('SELECT name, label FROM roles WHERE id = ?', [oldRoleId]);
      oldValue = JSON.stringify({
        role_id: oldRoleId,
        role_name: oldRoleRows[0]?.name || 'unknown',
        role_label: oldRoleRows[0]?.label || 'unknown',
      });

      await conn.execute(
        `UPDATE users
            SET username = ?,
                password_hash = ?,
                role_id = ?,
                password_changed_at = NOW(),
                force_password_change = 1,
                failed_login_attempts = 0,
                account_locked_until = NULL
          WHERE id = ?`,
        [cleanUsername, passwordHash, role_id, userId]
      );
      await revokeEmployeeSessions(conn, employee_id, 'admin_password_reset');

      actionPerformed = `ROLE_UPDATED: Employee ${employee.employee_code} (${employee.first_name} ${employee.last_name}) role changed from ${oldRoleRows[0]?.label || oldRoleId} to ${assignedRole.label}`;

    } else {
      // ── INSERT new account ─────────────────────────────────
      const [insertResult] = await conn.execute(
        `INSERT INTO users
           (username, password_hash, role_id, employee_id, is_active,
            password_changed_at, force_password_change, failed_login_attempts, account_locked_until)
         VALUES (?, ?, ?, ?, 1, NOW(), 1, 0, NULL)`,
        [cleanUsername, passwordHash, role_id, employee_id]
      );
      userId = insertResult.insertId;

      actionPerformed = `ACCOUNT_CREATED: New account '${cleanUsername}' for Employee ${employee.employee_code} (${employee.first_name} ${employee.last_name}) with role ${assignedRole.label} (${assignedRole.access_level})`;
    }

    await conn.execute(
      `UPDATE employees
          SET Password_Hash = ?,
              Password_Changed_At = NULL,
              Failed_Login_Attempts = 0,
              Locked_Until = NULL,
              force_password_change = 1
        WHERE id = ?`,
      [passwordHash, employee_id]
    );

    // ── Immutable Audit Log Entry (Non-Repudiation) ──────────
    const newValue = JSON.stringify({
      user_id: userId,
      username: cleanUsername,
      role_id: role_id,
      role_name: assignedRole.name,
      role_label: assignedRole.label,
      access_level: assignedRole.access_level,
      force_password_change: true,
    });

    const adminIP = extractClientIP(req);
    const adminUA = req.headers['user-agent'] || 'unknown';

    await conn.execute(
      `INSERT INTO system_audit_log 
         (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp)
       VALUES (?, ?, ?, ?, 'RBAC', ?, ?, ?, ?, NOW())`,
      [req.user.id, req.user.employeeId || null, employee_id, actionPerformed, oldValue, newValue, adminIP, adminUA]
    );

    // ── Commit Transaction ───────────────────────────────────
    await conn.commit();

    console.log(`✅ [RBAC] ${actionPerformed} — by Admin ID: ${req.user.id} from IP: ${adminIP}`);

    return res.status(existingUser.length > 0 ? 200 : 201).json({
      message: existingUser.length > 0 ? 'Account updated and role reassigned.' : 'Account registered with role assigned.',
      data: {
        user_id: userId,
        username: cleanUsername,
        employee_id: employee_id,
        employee_name: `${employee.first_name} ${employee.last_name}`,
        role: {
          id: assignedRole.id,
          name: assignedRole.name,
          label: assignedRole.label,
          access_level: assignedRole.access_level,
        },
      },
    });

  } catch (err) {
    await conn.rollback();

    // Handle duplicate username
    if (err.code === 'ER_DUP_ENTRY' && err.message.includes('username')) {
      return res.status(409).json({ error: 'Username already exists. Choose a different username.' });
    }

    console.error('❌ [RBAC] register-role error:', err.message);
    return res.status(500).json({ error: 'Failed to register account.' });
  } finally {
    conn.release();
  }
});

/* ================================================================
   PUT /api/admin/update-role/:userId
   ================================================================
   Update an existing user's role assignment only.
   Body: { role_id }
   ================================================================ */
router.put('/update-role/:userId', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const targetUserId = parseInt(req.params.userId, 10);
    const { role_id } = req.body;

    if (!role_id) {
      return res.status(400).json({ error: 'role_id is required.' });
    }

    // Prevent self-demotion
    if (targetUserId === req.user.id) {
      await logAuditEntry(req, {
        action: `DENIED_ROLE_CHANGE_ATTEMPT: User '${req.user.username || req.user.id}' attempted to change their own role`,
        module: 'RBAC_SECURITY',
        targetEmployeeId: req.user.employeeId || null,
        newValue: JSON.stringify({ target_user_id: targetUserId, requested_role_id: role_id, result: 'denied' }),
      }).catch(() => {});
      return res.status(403).json({ error: 'You cannot change your own role.' });
    }

    // Verify user exists
    const [userRows] = await conn.execute(
      `SELECT u.id, u.username, u.role_id, u.employee_id, r.name AS old_role_name, r.label AS old_role_label
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      [targetUserId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const targetUser = userRows[0];

    // Verify new role exists
    const [roleRows] = await conn.execute(
      'SELECT id, name, label, access_level FROM roles WHERE id = ?',
      [role_id]
    );
    if (roleRows.length === 0) {
      await logAuditEntry(req, {
        action: `DENIED_ROLE_CHANGE_ATTEMPT: Invalid role '${role_id}' requested for user ID ${targetUserId}`,
        module: 'RBAC_SECURITY',
        targetEmployeeId: targetUser.employee_id || null,
        newValue: JSON.stringify({ target_user_id: targetUserId, requested_role_id: role_id, result: 'denied' }),
      }).catch(() => {});
      return res.status(404).json({ error: 'Role not found.' });
    }
    const newRole = roleRows[0];

    await conn.beginTransaction();

    await conn.execute('UPDATE users SET role_id = ? WHERE id = ?', [role_id, targetUserId]);

    // Audit log
    const oldValue = JSON.stringify({ role_id: targetUser.role_id, role_name: targetUser.old_role_name });
    const newValue = JSON.stringify({ role_id: newRole.id, role_name: newRole.name, access_level: newRole.access_level });
    const action = `ROLE_REASSIGNED: User '${targetUser.username}' (ID: ${targetUserId}) changed from ${targetUser.old_role_label} to ${newRole.label}`;

    await conn.execute(
      `INSERT INTO system_audit_log 
         (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp)
       VALUES (?, ?, ?, ?, 'RBAC', ?, ?, ?, ?, NOW())`,
      [req.user.id, req.user.employeeId || null, targetUser.employee_id, action, oldValue, newValue, extractClientIP(req), req.headers['user-agent'] || 'unknown']
    );

    await conn.commit();

    console.log(`✅ [RBAC] ${action} — by Admin ID: ${req.user.id}`);

    return res.json({
      message: 'Role updated successfully.',
      data: { user_id: targetUserId, username: targetUser.username, new_role: newRole },
    });

  } catch (err) {
    await conn.rollback();
    console.error('❌ [RBAC] update-role error:', err.message);
    return res.status(500).json({ error: 'Failed to update role.' });
  } finally {
    conn.release();
  }
});

/* ================================================================
   PUT /api/admin/users/:userId/credentials
   ================================================================
   Update a user's username and password.
   Body: { username, password }
   ================================================================ */
router.put('/users/:userId/credentials', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const targetUserId = parseInt(req.params.userId, 10);
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Both username and password are required.' });
    }

    const passwordErrors = passwordPolicyErrors(password);
    if (passwordErrors.length) {
      return res.status(400).json({
        error: 'Temporary password is invalid.',
        requirements: passwordErrors,
      });
    }

    const cleanUsername = sanitizeInput(username).toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(cleanUsername)) {
      return res.status(400).json({
        error: 'Username may only contain lowercase letters, numbers, dots, hyphens, and underscores.',
      });
    }

    // Verify user exists
    const [userRows] = await conn.execute(
      'SELECT id, username, employee_id FROM users WHERE id = ?',
      [targetUserId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const targetUser = userRows[0];

    const passwordHash = await hashTemporaryPassword(password);

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE users
          SET username = ?,
              password_hash = ?,
              password_changed_at = NOW(),
              force_password_change = 1,
              failed_login_attempts = 0,
              account_locked_until = NULL
        WHERE id = ?`,
      [cleanUsername, passwordHash, targetUserId]
    );
    await conn.execute(
      `UPDATE employees
          SET Password_Hash = ?,
              Password_Changed_At = NULL,
              Failed_Login_Attempts = 0,
              Locked_Until = NULL,
              force_password_change = 1
        WHERE id = ?`,
      [passwordHash, targetUser.employee_id]
    );
    await revokeEmployeeSessions(conn, targetUser.employee_id, 'admin_password_reset');

    // Audit log
    const oldValue = JSON.stringify({ username: targetUser.username });
    const newValue = JSON.stringify({ username: cleanUsername, password_changed: true, force_password_change: true });
    const action = `CREDENTIALS_UPDATED: Credentials updated for user ID ${targetUserId} (${targetUser.username} -> ${cleanUsername})`;

    await conn.execute(
      `INSERT INTO system_audit_log 
         (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp)
       VALUES (?, ?, ?, ?, 'RBAC', ?, ?, ?, ?, NOW())`,
      [req.user.id, req.user.employeeId || null, targetUser.employee_id, action, oldValue, newValue, extractClientIP(req), req.headers['user-agent'] || 'unknown']
    );

    await conn.commit();
    console.log(`✅ [RBAC] ${action} — by Admin ID: ${req.user.id}`);

    return res.json({ message: 'Credentials updated successfully.' });

  } catch (err) {
    await conn.rollback();
    
    if (err.code === 'ER_DUP_ENTRY' && err.message.includes('username')) {
      return res.status(409).json({ error: 'Username already exists. Choose a different username.' });
    }

    console.error('❌ [RBAC] update credentials error:', err.message);
    return res.status(500).json({ error: 'Failed to update credentials.' });
  } finally {
    conn.release();
  }
});

/* ================================================================
   GET /api/admin/roles — List all roles with access levels
   ================================================================ */
router.get('/roles', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, name, label, access_level, created_at FROM roles ORDER BY id'
    );
    return res.json(rows);
  } catch (err) {
    console.error('❌ [RBAC] list roles error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch roles.' });
  }
});

/* ================================================================
   GET /api/admin/users — List all user accounts with roles
   ================================================================ */
router.get('/users', async (req, res) => {
  try {
    const hasFailedAttempts = await hasColumn('users', 'failed_login_attempts');
    const hasAccountLockedUntil = await hasColumn('users', 'account_locked_until');
    const hasLoginAttempts = await hasColumn('users', 'login_attempts');
    const hasLockedUntil = await hasColumn('users', 'locked_until');
    const attemptsExpr = hasFailedAttempts
      ? 'u.failed_login_attempts'
      : hasLoginAttempts
        ? 'u.login_attempts'
        : '0';
    const lockedUntilExpr = hasAccountLockedUntil
      ? 'u.account_locked_until'
      : hasLockedUntil
        ? 'u.locked_until'
        : 'NULL';

    const [rows] = await pool.execute(
      `SELECT u.id, u.username, u.role_id, u.employee_id, u.is_active, u.last_login,
              u.password_changed_at, u.force_password_change, u.created_at,
              COALESCE(${attemptsExpr}, 0) AS failed_login_attempts,
              ${lockedUntilExpr} AS account_locked_until,
              CASE
                WHEN ${lockedUntilExpr} IS NOT NULL AND ${lockedUntilExpr} > NOW() THEN 1
                ELSE 0
              END AS is_locked,
              GREATEST(TIMESTAMPDIFF(SECOND, NOW(), ${lockedUntilExpr}), 0) AS lock_seconds_remaining,
              r.name AS role_name, r.label AS role_label, r.access_level,
              e.first_name, e.last_name, e.employee_code
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN employees e ON e.id = u.employee_id
       ORDER BY u.id`
    );
    return res.json(rows.map(decryptEmployeeUserFields));
  } catch (err) {
    console.error('❌ [RBAC] list users error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

/* ================================================================
   PATCH /api/admin/users/:userId/deactivate — Deactivate account
   ================================================================ */
router.patch('/users/:userId/deactivate', async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId, 10);

    if (targetUserId === req.user.id) {
      return res.status(403).json({ error: 'You cannot deactivate your own account.' });
    }

    const [result] = await pool.execute(
      'UPDATE users SET is_active = 0 WHERE id = ?',
      [targetUserId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    await logAuditEntry(req, {
      action: `ACCOUNT_DEACTIVATED: User ID ${targetUserId} deactivated by Admin`,
      targetEmployeeId: null,
    });

    return res.json({ message: 'Account deactivated.' });
  } catch (err) {
    console.error('❌ [RBAC] deactivate error:', err.message);
    return res.status(500).json({ error: 'Failed to deactivate account.' });
  }
});

/* ================================================================
   PATCH /api/admin/users/:userId/activate — Reactivate account
   ================================================================ */
router.patch('/users/:userId/activate', async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId, 10);

    const [result] = await pool.execute(
      'UPDATE users SET is_active = 1 WHERE id = ?',
      [targetUserId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    await logAuditEntry(req, {
      action: `ACCOUNT_ACTIVATED: User ID ${targetUserId} reactivated by Admin`,
      targetEmployeeId: null,
    });

    return res.json({ message: 'Account activated.' });
  } catch (err) {
    console.error('❌ [RBAC] activate error:', err.message);
    return res.status(500).json({ error: 'Failed to activate account.' });
  }
});

/* ================================================================
   GET /api/admin/audit-log — View RBAC audit trail
   ================================================================ */
router.get('/audit-log', async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const module = req.query.module || null;

    let query = `SELECT sal.*, u.username AS admin_username
                 FROM system_audit_log sal
                 LEFT JOIN users u ON u.id = sal.user_id`;
    const params = [];

    if (module) {
      query += ' WHERE sal.module = ?';
      params.push(module);
    }

    // Use string interpolation for LIMIT/OFFSET (safe — values are parseInt'd above)
    query += ` ORDER BY sal.timestamp DESC LIMIT ${limit} OFFSET ${offset}`;

    const [rows] = await pool.execute(query, params);
    return res.json(rows);
  } catch (err) {
    console.error('❌ [RBAC] audit-log error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch audit log.' });
  }
});

module.exports = router;
