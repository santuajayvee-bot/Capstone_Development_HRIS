const ROLE_LEVELS = {
  employee: 1,
  hr_admin: 2,
  hr_manager: 2,
  payroll_officer: 2,
  payroll_manager: 3,
  system_admin: 4,
  admin: 4,
};

function roleLevel(role) {
  return ROLE_LEVELS[role] || 0;
}

function authorizeLevel(requiredLevel, options = {}) {
  const { exact = false, allowedRoles = null } = options;

  return (req, res, next) => {
    const role = req.user?.role;
    const level = roleLevel(role);
    const roleAllowed = !allowedRoles || allowedRoles.includes(role);
    const levelAllowed = exact ? level === requiredLevel : level >= requiredLevel;

    if (!roleAllowed || !levelAllowed) {
      return res.status(403).json({
        error: 'Access denied.',
        required_level: `Level ${requiredLevel}`,
        your_level: level ? `Level ${level}` : 'unknown',
      });
    }

    next();
  };
}

module.exports = { authorizeLevel, roleLevel, ROLE_LEVELS };
