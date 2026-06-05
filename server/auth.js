/* ============================================================
   server/auth.js — Authentication route handlers
   ============================================================ */

const bcrypt = require('bcrypt');
const argon2 = require('argon2');
const jwt    = require('jsonwebtoken');
const { findByUsername, updateLastLogin } = require('./users');

const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '8h';

/**
 * POST /api/auth/login
 * Body: { username, password }
 * Returns: { token, user: { id, username, role, roleLabel, employeeId } }
 */
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;

async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    const pool = require('../config/db');

    // 1. Find user
    const user = await findByUsername(username.trim().toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // 2. Check active
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated. Contact your administrator.' });
    }

    // 3. Check account lockout (Spoofing mitigation — STRIDE)
    try {
      const [lockRows] = await pool.execute(
        'SELECT login_attempts, locked_until FROM users WHERE id = ?',
        [user.id]
      );
      if (lockRows.length > 0) {
        const { login_attempts, locked_until } = lockRows[0];
        if (locked_until && new Date(locked_until) > new Date()) {
          const minutesLeft = Math.ceil((new Date(locked_until) - new Date()) / 60000);
          console.log(`\n🔒 [SECURITY] ACCOUNT_LOCKED: User '${user.username}' — ${minutesLeft} min remaining`);
          return res.status(423).json({
            error: `Account locked due to ${MAX_LOGIN_ATTEMPTS} failed attempts. Try again in ${minutesLeft} minute(s).`,
          });
        }
      }
    } catch (lockErr) {
      // Columns may not exist yet — proceed without lockout
    }

    // 4. Verify password (supports both Argon2 and bcrypt)
    let valid = false;
    if (user.password_hash.startsWith('$argon2')) {
      valid = await argon2.verify(user.password_hash, password);
    } else {
      valid = await bcrypt.compare(password, user.password_hash);
    }
    
    if (!valid) {
      // Increment failed attempts
      try {
        const [lockRows] = await pool.execute(
          'SELECT login_attempts FROM users WHERE id = ?', [user.id]
        );
        const attempts = (lockRows[0]?.login_attempts || 0) + 1;

        if (attempts >= MAX_LOGIN_ATTEMPTS) {
          // Lock account
          await pool.execute(
            'UPDATE users SET login_attempts = ?, locked_until = DATE_ADD(NOW(), INTERVAL ? MINUTE) WHERE id = ?',
            [attempts, LOCKOUT_DURATION_MINUTES, user.id]
          );
          console.log(`\n🔒 [SECURITY] ACCOUNT_LOCKED: User '${user.username}' locked after ${MAX_LOGIN_ATTEMPTS} failed attempts`);
          return res.status(423).json({
            error: `Account locked after ${MAX_LOGIN_ATTEMPTS} failed attempts. Try again in ${LOCKOUT_DURATION_MINUTES} minutes.`,
          });
        } else {
          await pool.execute(
            'UPDATE users SET login_attempts = ? WHERE id = ?', [attempts, user.id]
          );
          console.log(`\n⚠️  [AUTH] Failed login attempt ${attempts}/${MAX_LOGIN_ATTEMPTS} for user '${user.username}'`);
        }
      } catch (lockErr) {
        // Columns may not exist — continue
      }
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // 5. Successful login — reset lockout counter
    try {
      await pool.execute(
        'UPDATE users SET login_attempts = 0, locked_until = NULL WHERE id = ?',
        [user.id]
      );
    } catch (lockErr) {
      // Columns may not exist — continue
    }

    // 6. Sign JWT
    const effectiveRole = user.username === 'hr.admin' && user.role === 'hr_admin'
      ? 'hr_manager'
      : user.role;
    const effectiveRoleLabel = effectiveRole === 'hr_manager'
      ? 'HR Manager (Level 3)'
      : user.role_label;

    const payload = {
      id:         user.id,
      username:   user.username,
      role:       effectiveRole,
      roleLabel:  effectiveRoleLabel,
      employeeId: user.employee_id,
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

    // 7. Update last login
    await updateLastLogin(user.id);

    console.log(`\n✅ [AUTH] Successful login: ${user.username} (${user.role})`);

    return res.json({
      token,
      user: payload,
    });

  } catch (err) {
    console.error('[auth/login]', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
}

/**
 * GET /api/auth/me
 * Requires: Authorization: Bearer <token>
 * Returns the decoded token payload (verified) mixed with fresh DB data.
 */
async function me(req, res) {
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute('SELECT employee_id FROM users WHERE id = ?', [req.user.id]);
    if (rows.length > 0) {
      req.user.employeeId = rows[0].employee_id;
    }
  } catch (err) {
    console.error('[auth/me]', err);
  }
  return res.json({ user: req.user });
}

module.exports = { login, me };
