/* ============================================================
   server/middleware.js — JWT auth + role-based route guards
   ============================================================ */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

// ── Role hierarchy ───────────────────────────────────────────
const ROLES = {
  admin:           ['admin'],
  payroll_officer: ['admin', 'payroll_officer'],
  payroll_manager: ['admin', 'payroll_manager'],
  payroll_any:     ['admin', 'payroll_officer', 'payroll_manager'],
  any:             ['admin', 'payroll_officer', 'payroll_manager', 'employee'],
};

/**
 * requireAuth — verifies JWT and attaches req.user.
 * Use on every protected API route.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided.' });
  }

  const token = authHeader.slice(7);
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
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
