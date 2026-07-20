'use strict';

// Canonical application roles. Product policy treats HR Admin and HR Manager
// as the same HR-management role. Normalize both database spellings before
// permissions, sessions, and navigation are evaluated so they cannot disagree
// on first login or after an identity refresh.
const ROLE_ALIASES = Object.freeze({
  admin: 'system_admin',
  administrator: 'system_admin',
  system_admin: 'system_admin',
  system_administrator: 'system_admin',
  sys_admin: 'system_admin',
  hr: 'hr_manager',
  hradmin: 'hr_manager',
  hr_admin: 'hr_manager',
  human_resources: 'hr_manager',
  hr_manager: 'hr_manager',
  manager: 'hr_manager',
  payroll: 'payroll_officer',
  payrollofficer: 'payroll_officer',
  payroll_officer: 'payroll_officer',
  payrollmanager: 'payroll_manager',
  payroll_manager: 'payroll_manager',
  it_staff: 'it_staff',
  itstaff: 'it_staff',
  employee: 'employee',
  regular_employee: 'employee',
  regular: 'employee',
  worker: 'employee',
});

function roleCandidates(role) {
  const key = String(role || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const withoutParenthetical = key.replace(/_*\([^)]*\)/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const withoutLevelSuffix = key.replace(/_*\(?level_?\d+\)?/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return [...new Set([
    key,
    key.replace(/_/g, ''),
    withoutParenthetical,
    withoutParenthetical.replace(/_/g, ''),
    withoutLevelSuffix,
    withoutLevelSuffix.replace(/_/g, ''),
  ].filter(Boolean))];
}

function normalizeRole(role, fallback = 'employee') {
  const candidates = roleCandidates(role);
  for (const candidate of candidates) {
    if (ROLE_ALIASES[candidate]) return ROLE_ALIASES[candidate];
  }
  return candidates[0] || fallback;
}

module.exports = { ROLE_ALIASES, normalizeRole, roleCandidates };
