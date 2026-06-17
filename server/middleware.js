/* ============================================================
   server/middleware.js — JWT auth + role-based route guards
   ============================================================ */

const jwt = require('jsonwebtoken');

function getJwtSecret() {
  return process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
}

// ── Role hierarchy ───────────────────────────────────────────
// Support both old role names (for backward compatibility with existing tokens) and new names
const ROLE_ALIASES = {
  'admin': 'system_admin',
  'system_admin': 'system_admin',
  'hr_admin': 'hr_manager',
  'hr_manager': 'hr_manager',
  'payroll_officer': 'payroll_officer',
  'payroll_manager': 'payroll_manager',
  'manager': 'hr_manager',
  'employee': 'employee'
};

const ROLES = {
  system_admin:    ['system_admin', 'admin'],
  hr_admin:        ['hr_manager', 'hr_admin'],
  hr_manager:      ['hr_manager', 'hr_admin'],
  payroll_officer: ['payroll_officer'],
  payroll_manager: ['payroll_manager'],
  payroll_any:     ['payroll_officer', 'payroll_manager'],
  hr_ops:          ['hr_manager', 'hr_admin'],
  hr_final_approval: ['hr_manager', 'hr_admin'],
  staff_management: ['hr_manager', 'hr_admin'],
  admin_any:       ['system_admin', 'admin'],
  staff_any:       ['hr_manager', 'hr_admin', 'payroll_officer', 'payroll_manager'],
  any:             ['hr_admin', 'hr_manager', 'system_admin', 'admin', 'payroll_officer', 'payroll_manager', 'employee'],
};

/**
 * requireAuth — verifies JWT and attaches req.user.
 * Use on every protected API route.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  console.log('[requireAuth] Authorization header present:', !!authHeader);

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('[requireAuth] No Bearer token found');
    return res.status(401).json({ error: 'No token provided.' });
  }

  const token = authHeader.slice(7);
  const jwtSecret = getJwtSecret();
  console.log('[requireAuth] Token received, length:', token.length);
  console.log('[requireAuth] JWT secret configured:', !!jwtSecret);

  try {
    req.user = jwt.verify(token, jwtSecret);
    req.user.role = ROLE_ALIASES[req.user.role] || req.user.role;
    console.log('[requireAuth] Token verified successfully for user:', req.user.username);
    next();
  } catch (err) {
    console.error('[requireAuth] JWT verification failed:', err.name, err.message);
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ error: 'Invalid token.' });
  }
}

/**
 * requireRole(allowedRoles) — role guard, must come AFTER requireAuth.
 * @param {string[]} allowedRoles  e.g. ['admin', 'payroll_manager']
 *
 * Usage:
 *   router.get('/payroll', requireAuth, requireRole(['admin','payroll_manager']), handler)
 *   router.get('/payroll', requireAuth, requireRole(ROLES.payroll_any), handler)
 */
function requireRole(allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Access denied. Required role: ${allowedRoles.join(' or ')}.`,
      });
    }
    next();
  };
}

/**
 * requireSelf — for employee routes, ensures they can only access their own data.
 * Admins and payroll roles bypass this check.
 * Expects req.params.employeeId or req.params.id.
 */
function requireSelf(req, res, next) {
  const { role, employeeId } = req.user;

  // Non-employee roles can see anyone
  if (role !== 'employee') return next();

  // Employees can only access their own record
  const requestedId = parseInt(req.params.employeeId || req.params.id, 10);
  if (requestedId !== employeeId) {
    return res.status(403).json({ error: 'You can only access your own records.' });
  }
  next();
}

module.exports = { requireAuth, requireRole, requireSelf, ROLES };
