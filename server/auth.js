/* ============================================================
   server/auth.js — Authentication route handlers
   ============================================================ */

const bcrypt = require('bcrypt');
const jwt    = require('jsonwebtoken');
const { findByUsername, updateLastLogin } = require('./users');

const JWT_SECRET  = process.env.JWT_SECRET;
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '8h';

/**
 * POST /api/auth/login
 * Body: { username, password }
 * Returns: { token, user: { id, username, role, roleLabel, employeeId } }
 */
async function login(req, res) {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  try {
    // 1. Find user
    const user = await findByUsername(username.trim().toLowerCase());
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // 2. Check active
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account is deactivated. Contact your administrator.' });
    }

    // 3. Verify password
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    // 4. Sign JWT
    const payload = {
      id:         user.id,
      username:   user.username,
      role:       user.role,          // 'admin' | 'payroll_officer' | 'payroll_manager' | 'employee'
      roleLabel:  user.role_label,
      employeeId: user.employee_id,
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });

    // 5. Update last login
    await updateLastLogin(user.id);

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
