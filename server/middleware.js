/* ============================================================
   server/middleware.js — JWT auth + role-based route guards
   ============================================================ */

const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { auditSecurityEvent } = require('./security-controls');
const {
  getLinkedEmployeeProfile,
  getUserPermissions,
} = require('./users');

const PASSWORD_CHANGE_ALLOWED_PATHS = new Set([
  '/api/account/password',
  '/api/auth/me',
]);

function getJwtSecret() {
  return process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
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

const PERMISSION_ALIASES = {
  'admin_panel:access': 'settings.manage',
  'employee:read': 'employee.view',
  'employee:update': 'employee.manage',
  'files:read': 'employee.view',
  'payroll:read': 'payroll.view',
  'payroll:update': 'payroll.settings.manage',
  'system_settings:update': 'settings.manage',
  'user_roles:update': 'settings.manage',
};

const CLIENT_AUTHORITY_FIELDS = new Set([
  'access_level',
  'account_status',
  'admin',
  'admin_flag',
  'is_admin',
  'is_super_admin',
  'permissions',
  'role',
  'roles',
  'user_type',
]);

function normalizeRole(role) {
  return ROLE_ALIASES[role] || role || 'employee';
}

function normalizeAllowedRoles(allowedRoles) {
  return [...new Set((Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]).map(normalizeRole))];
}

/**
 * requireAuth — verifies JWT and attaches req.user.
 * Use on every protected API route.
 */
function isAllowedDuringForcedPasswordChange(req) {
  return PASSWORD_CHANGE_ALLOWED_PATHS.has(req.originalUrl.split('?')[0]);
}

function isTokenOlderThanPasswordChange(tokenPayload, passwordChangedAt) {
  if (!tokenPayload?.iat || !passwordChangedAt) return false;
  const changedAt = new Date(passwordChangedAt).getTime();
  if (Number.isNaN(changedAt)) return false;
  return tokenPayload.iat * 1000 < changedAt;
}

async function getAccountSessionState(tokenPayload) {
  const verifiedUserId = Number.parseInt(tokenPayload?.id || tokenPayload?.userId, 10);
  if (!Number.isFinite(verifiedUserId) || verifiedUserId <= 0) return null;

  const [rows] = await pool.execute(
    `SELECT
       u.id AS user_id,
       u.username,
       u.employee_id AS employee_table_id,
       u.is_active,
       u.role_id,
       r.name AS role_name,
       r.label AS role_label,
       r.access_level,
       e.Employee_ID,
       e.status AS employee_status,
       u.force_password_change,
       COALESCE(u.password_changed_at, e.Password_Changed_At) AS password_changed_at,
       s.Session_ID,
       s.Revoked_At,
       s.Expires_At
     FROM users u
     LEFT JOIN roles r ON r.id = u.role_id
     LEFT JOIN employees e ON e.id = u.employee_id
     LEFT JOIN USER_SESSION s ON s.JWT_ID = ?
     WHERE u.id = ?
     LIMIT 1`,
    [
      tokenPayload.jti || '',
      verifiedUserId,
    ]
  );

  return rows[0] || null;
}

function isInactiveAccount(accountState) {
  if (!accountState) return true;
  if (accountState.is_active === 0 || accountState.is_active === false) return true;
  return ['inactive', 'resigned', 'terminated', 'end of contract'].includes(
    String(accountState.employee_status || '').trim().toLowerCase()
  );
}

function authError(res, message = 'Invalid token.') {
  return res.status(401).json({ error: message });
}

function findClientAuthorityFields(body, path = '') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return [];
  const found = [];
  for (const [key, value] of Object.entries(body)) {
    const normalized = String(key || '')
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/[\s-]+/g, '_')
      .toLowerCase();
    const fieldPath = path ? `${path}.${key}` : key;
    if (CLIENT_AUTHORITY_FIELDS.has(normalized)) found.push(fieldPath);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      found.push(...findClientAuthorityFields(value, fieldPath));
    }
  }
  return found;
}

async function rejectClientAuthorityTampering(req, res) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return false;
  const fields = findClientAuthorityFields(req.body);
  if (!fields.length) return false;
  await auditSecurityEvent(req, {
    action: 'blocked_client_authority_field_tampering',
    module: 'PARAMETER_TAMPERING',
    targetTable: req.originalUrl || null,
    newValue: { fields, method: req.method, path: req.originalUrl },
    result: 'blocked',
  }).catch(() => {});
  res.status(403).json({ error: 'Request contains unauthorized fields.' });
  return true;
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return authError(res, 'No token provided.');
  }

  const token = authHeader.slice(7);
  const jwtSecret = getJwtSecret();
  if (!isNonEmptyString(jwtSecret)) {
    console.error('[requireAuth] JWT secret is not configured.');
    return res.status(500).json({ error: 'Authentication is not configured.' });
  }

  try {
    const verifiedToken = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] });
    const accountState = await getAccountSessionState(verifiedToken);

    if (!accountState) {
      return authError(res, 'Invalid session.');
    }

    if (isInactiveAccount(accountState)) {
      await auditSecurityEvent(req, {
        action: 'blocked_inactive_account_token_use',
        module: 'AUTH_SECURITY',
        targetTable: 'users',
        targetRecord: accountState.user_id,
        newValue: { username: accountState.username, path: req.originalUrl },
        result: 'blocked',
      }).catch(() => {});
      return res.status(403).json({ error: 'Account is deactivated. Contact your administrator.' });
    }

    if (verifiedToken.jti) {
      if (!accountState.Session_ID || accountState.Revoked_At || new Date(accountState.Expires_At) <= new Date()) {
        return authError(res, 'Session expired. Please log in again.');
      }
    }

    if (isTokenOlderThanPasswordChange(verifiedToken, accountState.password_changed_at)) {
      return authError(res, 'Session expired. Please log in again.');
    }

    const forcePasswordChange = Boolean(Number(accountState.force_password_change));
    const role = normalizeRole(accountState.role_name);
    const permissions = await getUserPermissions(accountState.user_id, role);
    const employeeProfile = await getLinkedEmployeeProfile(accountState.employee_table_id);

    req.user = {
      id: accountState.user_id,
      username: accountState.username,
      role,
      roleLabel: accountState.role_label,
      roleId: accountState.role_id,
      accessLevel: accountState.access_level,
      employeeId: accountState.employee_table_id,
      Employee_ID: accountState.Employee_ID || accountState.employee_table_id,
      permissions,
      employeeProfile,
      jti: verifiedToken.jti || null,
      iat: verifiedToken.iat || null,
      exp: verifiedToken.exp || null,
    };
    req.user.forcePasswordChange = forcePasswordChange;
    req.user.mustChangePassword = forcePasswordChange;
    req.user.passwordChangedAt = accountState.password_changed_at || null;

    if (await rejectClientAuthorityTampering(req, res)) return;

    if (forcePasswordChange && !isAllowedDuringForcedPasswordChange(req)) {
      return res.status(403).json({
        error: 'Password change required.',
        code: 'PASSWORD_CHANGE_REQUIRED',
        mustChangePassword: true,
      });
    }

    next();
  } catch (err) {
    await auditSecurityEvent(req, {
      action: err.name === 'TokenExpiredError' ? 'expired_jwt_attempt' : 'invalid_or_tampered_jwt_attempt',
      module: 'AUTH_SECURITY',
      targetTable: req.originalUrl || null,
      newValue: { error_name: err.name, method: req.method, path: req.originalUrl },
      result: 'blocked',
    }).catch(() => {});
    if (err.name === 'TokenExpiredError') {
      return authError(res, 'Session expired. Please log in again.');
    }
    return authError(res, 'Invalid token.');
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
  const normalizedAllowedRoles = normalizeAllowedRoles(allowedRoles);
  return (req, res, next) => {
    if (!req.user || !normalizedAllowedRoles.includes(normalizeRole(req.user.role))) {
      auditSecurityEvent(req, {
        action: 'failed_unauthorized_access_attempt',
        module: 'RBAC_SECURITY',
        targetTable: req.originalUrl || null,
        newValue: {
          method: req.method,
          path: req.originalUrl,
          required_roles: normalizedAllowedRoles,
          actual_role: req.user?.role || 'anonymous',
        },
        result: 'blocked',
      }).catch(() => {});
      return res.status(403).json({
        error: 'Access denied.',
      });
    }
    next();
  };
}

function permissionCandidates(permission) {
  const key = String(permission || '').trim();
  return [...new Set([key, PERMISSION_ALIASES[key]].filter(Boolean))];
}

function hasPermission(req, permission) {
  const permissions = Array.isArray(req.user?.permissions) ? req.user.permissions : [];
  const candidates = permissionCandidates(permission);
  return candidates.some(candidate => permissions.includes(candidate));
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No token provided.' });
    if (hasPermission(req, permission)) return next();

    auditSecurityEvent(req, {
      action: 'failed_permission_check',
      module: 'RBAC_SECURITY',
      targetTable: req.originalUrl || null,
      newValue: {
        method: req.method,
        path: req.originalUrl,
        required_permission: permission,
        mapped_permissions: permissionCandidates(permission),
        actual_role: req.user.role,
      },
      result: 'blocked',
    }).catch(() => {});
    return res.status(403).json({ error: 'Access denied.' });
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

module.exports = { hasPermission, requireAuth, requirePermission, requireRole, requireSelf, ROLES };
