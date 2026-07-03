/* ============================================================
   server/dashboard.js - Role-aware dashboard endpoint
   ============================================================ */

const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { requireAuth } = require('./middleware');
const { decryptColumnValue } = require('./data-protection');

router.use(requireAuth);

const DASHBOARD_CACHE_TTL_MS = 15000;
const dashboardCache = new Map();

const FALLBACK_PERMISSIONS = {
  system_admin: ['employee.view', 'employee.manage', 'attendance.view', 'leave.request.view_all', 'leave.request.approve', 'payroll.view', 'payroll.calculate', 'payroll.approve', 'report.view', 'settings.manage'],
  admin: ['employee.view', 'employee.manage', 'attendance.view', 'leave.request.view_all', 'leave.request.approve', 'payroll.view', 'payroll.calculate', 'payroll.approve', 'report.view', 'settings.manage'],
  hr_admin: ['employee.view', 'employee.manage', 'attendance.view', 'attendance.manage', 'leave.request.view_all', 'leave.request.approve', 'leave.manual.create', 'report.view'],
  hr_manager: ['employee.view', 'employee.manage', 'attendance.view', 'attendance.manage', 'leave.request.view_all', 'leave.request.approve', 'leave.manual.create', 'report.view'],
  payroll_officer: ['payroll.view', 'payroll.calculate', 'payroll.settings.manage', 'payroll.report.view', 'employee.view', 'attendance.view', 'leave.request.create', 'leave.request.view_all', 'leave.request.approve', 'leave.manual.create', 'leave.balance.manage', 'leave.report.view', 'leave.audit.view'],
  payroll_manager: ['payroll.view', 'payroll.calculate', 'payroll.settings.manage', 'payroll.approve', 'payroll.report.view', 'report.view', 'attendance.view', 'leave.request.create', 'leave.request.view_all', 'leave.request.approve', 'leave.manual.create', 'leave.balance.manage', 'leave.report.view', 'leave.audit.view'],
  manager: ['attendance.view', 'leave.request.approve', 'report.view'],
  employee: ['attendance.view', 'leave.request.create', 'leave.request.view_own', 'document.view'],
};

function hasPermission(permissions, key) {
  return permissions.includes(key);
}

function normalizeRole(role) {
  if (role === 'admin') return 'system_admin';
  if (role === 'hr_manager') return 'hr_manager';
  return role || 'employee';
}

function canFileLeave(profile, permissions) {
  if (!hasPermission(permissions, 'leave.request.create')) return false;
  const wageType = String(profile?.wage_type || '').toLowerCase();
  return !wageType.includes('trip') && !wageType.includes('piece');
}

function money(value) {
  const num = Number(value || 0);
  return `₱${num.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateLabel(value) {
  if (!value) return '-';
  return new Date(value).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formalModuleLabel(moduleName) {
  const key = String(moduleName || '').trim().toUpperCase();
  const labels = {
    RBAC: 'Role and Access Control',
    RBAC_SECURITY: 'Role and Access Control Security',
    ONBOARDING: 'Onboarding',
    PAYROLL: 'Payroll',
    ATTENDANCE: 'Attendance',
    LEAVE: 'Leave Management',
    EMPLOYEE: 'Employee Records',
    AUTH: 'Authentication',
    DASHBOARD: 'Dashboard',
    BLOCKCHAIN: 'Blockchain Audit',
  };
  return labels[key] || (key ? key.replaceAll('_', ' ') : 'System Activity');
}

function extractQuotedValue(text) {
  return String(text || '').match(/'([^']+)'/)?.[1] || null;
}

function extractEmployeeCode(text) {
  return String(text || '').match(/\bEmployee\s+([A-Za-z0-9-]+)/i)?.[1] || null;
}

function extractRoleLabel(text) {
  return String(text || '').match(/\bwith role\s+(.+)$/i)?.[1]?.trim() || null;
}

function formatAuditMessage(actionPerformed, moduleName) {
  const action = String(actionPerformed || '').trim();
  if (!action) return 'A system activity was recorded.';

  if (isInternalApiAuditAction(action)) {
    return `${formalModuleLabel(moduleName)} activity was recorded.`;
  }

  if (/^ACCOUNT_CREATED:/i.test(action)) {
    const username = extractQuotedValue(action);
    const employeeCode = extractEmployeeCode(action);
    const role = extractRoleLabel(action);
    const accountPart = username ? `User account ${username}` : 'A user account';
    const employeePart = employeeCode ? ` for employee ${employeeCode}` : '';
    const rolePart = role ? ` with the ${role} role` : '';
    return `${accountPart} was created${employeePart}${rolePart}.`;
  }

  if (/^ROLE_REASSIGNED:/i.test(action)) {
    const username = extractQuotedValue(action);
    const role = action.match(/\bto\s+(.+)$/i)?.[1]?.trim();
    const accountPart = username ? `User account ${username}` : 'A user account';
    return role
      ? `${accountPart} was assigned the ${role} role.`
      : `${accountPart} role assignment was updated.`;
  }

  if (/^ACCOUNT_ACTIVATED:/i.test(action)) {
    return 'A user account was reactivated by the system administrator.';
  }

  if (/^ACCOUNT_DEACTIVATED:/i.test(action)) {
    return 'A user account was deactivated by the system administrator.';
  }

  if (/^CREDENTIALS_UPDATED:/i.test(action)) {
    return 'User account credentials were updated by the system administrator.';
  }

  if (/^DOCUMENT_UPLOADED/i.test(action)) {
    const applicantId = action.match(/\[APPLICANT:(\d+)\]/i)?.[1];
    return applicantId
      ? `An onboarding document was uploaded for applicant record ${applicantId}.`
      : 'An onboarding document was uploaded.';
  }

  if (/^DASHBOARD_VIEWED$/i.test(action)) {
    return 'The dashboard was accessed.';
  }

  const label = action
    .replace(/^[A-Z_]+:\s*/i, '')
    .replace(/\[[^\]]+\]/g, '')
    .replaceAll('_', ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (!label) return `${formalModuleLabel(moduleName)} activity was recorded.`;
  if (/\/api\//i.test(label) || /\bapi\b/i.test(label)) return `${formalModuleLabel(moduleName)} activity was recorded.`;
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}.`;
}

function isInternalApiAuditAction(actionPerformed) {
  const action = String(actionPerformed || '');
  return /(?:^|:\s*)[A-Z_]*API:\s*(GET|POST|PUT|PATCH|DELETE)\s+\/api\//i.test(action)
    || /\b(GET|POST|PUT|PATCH|DELETE)\s+\/api\//i.test(action)
    || /\/api\//i.test(action);
}

function isUserFacingNotification(row) {
  if (!row?.action_performed) return false;
  if (isInternalApiAuditAction(row.action_performed)) return false;
  return true;
}

function auditNotification(row) {
  return {
    title: formalModuleLabel(row?.module),
    message: formatAuditMessage(row?.action_performed, row?.module),
    date: dateLabel(row?.timestamp),
  };
}

function safeDashboardText(value) {
  try {
    return decryptColumnValue(value) || '';
  } catch (_error) {
    return '';
  }
}

function employeeName(row) {
  const first = safeDashboardText(row?.first_name);
  const last = safeDashboardText(row?.last_name);
  return [first, last].filter(Boolean).join(' ') || row?.employee_code || '-';
}

function decryptProfile(profile) {
  if (!profile) return profile;
  profile.first_name = safeDashboardText(profile.first_name);
  profile.last_name = safeDashboardText(profile.last_name);
  return profile;
}

async function scalar(sql, params = [], fallback = 0) {
  try {
    const [rows] = await pool.execute(sql, params);
    return Object.values(rows[0] || {})[0] ?? fallback;
  } catch (error) {
    return fallback;
  }
}

async function rows(sql, params = []) {
  try {
    const [result] = await pool.execute(sql, params);
    return result;
  } catch (error) {
    return [];
  }
}

function getDashboardCacheKey(user) {
  return `${user.id}:${user.role}:${user.employeeId || 'none'}`;
}

function getCachedDashboard(user) {
  const cached = dashboardCache.get(getDashboardCacheKey(user));
  if (!cached) return null;
  if (Date.now() - cached.createdAt > DASHBOARD_CACHE_TTL_MS) {
    dashboardCache.delete(getDashboardCacheKey(user));
    return null;
  }
  return cached.payload;
}

function setCachedDashboard(user, payload) {
  dashboardCache.set(getDashboardCacheKey(user), {
    createdAt: Date.now(),
    payload,
  });
}

function auditDashboardAccess(req) {
  pool.execute(
    `INSERT INTO system_audit_log (user_id, employee_id, action_performed, module, ip_address, user_agent, timestamp)
     VALUES (?, ?, 'DASHBOARD_VIEWED', 'DASHBOARD', ?, ?, NOW())`,
    [
      req.user.id,
      req.user.employeeId || null,
      req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown',
      req.headers['user-agent'] || 'unknown',
    ]
  ).catch(() => {});
}

async function getProfile(user) {
  if (!user.employeeId) return null;
  const result = await rows(
    `SELECT e.id, e.employee_code, e.first_name, e.last_name, e.position, e.status,
            e.department_id, d.name AS department, wt.name AS wage_type
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
      WHERE e.id = ?
      LIMIT 1`,
    [user.employeeId]
  );
  return decryptProfile(result[0] || null);
}

async function getPermissions(user) {
  const fallback = FALLBACK_PERMISSIONS[user.role] || FALLBACK_PERMISSIONS.employee;
  try {
    const result = await rows(
      `SELECT p.permission_key
         FROM users u
         JOIN role_permissions rp ON rp.role_id = u.role_id
         JOIN permissions p ON p.id = rp.permission_id
        WHERE u.id = ?
        ORDER BY p.permission_key`,
      [user.id]
    );
    return result.length ? result.map(row => row.permission_key) : fallback;
  } catch (error) {
    return fallback;
  }
}

function card(label, value, sub = '') {
  return { label, value: String(value ?? '0'), sub };
}

function table(title, columns, rowsData) {
  return { title, columns, rows: rowsData };
}

function action(label, page, sub = '') {
  return { label, page, sub };
}

async function sharedWidgets(role, profile, permissions) {
  const notificationRows = await rows(
    `SELECT action_performed, module, timestamp
       FROM system_audit_log
      WHERE module IN ('LEAVE', 'PAYROLL', 'ATTENDANCE', 'ONBOARDING', 'RBAC', 'EMPLOYEE')
      ORDER BY timestamp DESC
      LIMIT 25`
  );

  const notifications = notificationRows
    .filter(isUserFacingNotification)
    .slice(0, 5)
    .map(auditNotification);

  return {
    notifications,
    recentActivities: notifications,
    pendingTasks: [],
  };
}

async function hrDashboard(profile, permissions) {
  const [
    totalEmployees,
    activeEmployees,
    newHires,
    employeesOnLeave,
    pendingLeaveRequests,
    pendingOnboarding,
    pendingAttendanceValidation,
    leaveRows,
    attendanceRows,
  ] = await Promise.all([
    scalar('SELECT COUNT(*) FROM employees'),
    scalar("SELECT COUNT(*) FROM employees WHERE status = 'Active'"),
    scalar('SELECT COUNT(*) FROM employees WHERE date_hired >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)'),
    scalar("SELECT COUNT(DISTINCT employee_id) FROM leave_requests WHERE status = 'Approved' AND CURDATE() BETWEEN date_from AND date_to"),
    scalar("SELECT COUNT(*) FROM leave_requests WHERE status = 'Pending'"),
    scalar("SELECT COUNT(*) FROM employees WHERE onboarding_status = 'active'"),
    scalar("SELECT COUNT(*) FROM attendance_log WHERE verification_status IN ('PENDING_VALIDATION','INCOMPLETE','NEEDS_REVIEW')"),
    rows(
      `SELECT e.first_name, e.last_name, e.employee_code, lr.type, lr.date_from, lr.date_to, lr.status
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
        ORDER BY lr.created_at DESC
        LIMIT 5`
    ),
    rows(
      `SELECT e.first_name, e.last_name,
              e.employee_code, al.date, al.time_in, al.time_out, al.status, al.verification_status
         FROM attendance_log al
         JOIN employees e ON e.id = al.employee_id
        WHERE al.verification_status IN ('PENDING_VALIDATION','INCOMPLETE','NEEDS_REVIEW','REJECTED','CORRECTED_BY_HR','PAYROLL_READY','VALIDATED')
        ORDER BY al.updated_at DESC, al.attendance_id DESC
        LIMIT 8`
    ),
  ]);

  const stats = [
    card('Total Employees', totalEmployees),
    card('Active Employees', activeEmployees),
    card('New Hires', newHires),
    card('Employees On Leave', employeesOnLeave),
    card('Pending Leave Requests', pendingLeaveRequests),
    card('Pending Onboarding', pendingOnboarding),
    card('Attendance Validation Queue', pendingAttendanceValidation),
  ];

  return {
    stats,
    tables: [
      table('Attendance Validation Queue', ['Employee', 'Date', 'Time In', 'Time Out', 'Attendance', 'Validation'], attendanceRows.map(r => [employeeName(r), dateLabel(r.date), r.time_in || '-', r.time_out || '-', r.status || '-', r.verification_status || '-'])),
      table('Recent Leave Requests', ['Employee', 'Type', 'Dates', 'Status'], leaveRows.map(r => [employeeName(r), r.type, `${dateLabel(r.date_from)} - ${dateLabel(r.date_to)}`, r.status])),
    ],
    actions: [
      action('Add Employee', 'register', 'Register a new employee record'),
      action('Create User Account', 'employees', 'Provision HRIS access'),
      action('Review Leave Requests', 'leave', 'Open leave inbox'),
      action('View Reports', 'reports', 'Open reports'),
    ],
  };
}

async function payrollDashboard(profile, permissions) {
  const [
    payrollDue,
    draftCalculations,
    pendingApproval,
    payslipsGenerated,
    contributionsDue,
    payrollReadyAttendance,
    payrollRuns,
    salaryRows,
    attendanceRows,
  ] = await Promise.all([
    scalar("SELECT COUNT(*) FROM payroll_runs WHERE status IN ('Draft','Pending','Submitted') AND run_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)"),
    scalar("SELECT COUNT(*) FROM salary_calculations WHERE status = 'Draft'"),
    scalar("SELECT COUNT(*) FROM salary_calculations WHERE status = 'Submitted'"),
    scalar('SELECT COUNT(*) FROM payslips'),
    scalar("SELECT COUNT(*) FROM payroll_deduction_settings WHERE category = 'Government' AND is_active = 1"),
    scalar("SELECT COUNT(*) FROM attendance_summary WHERE payroll_eligible = 1 AND attendance_date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)"),
    rows(
      `SELECT id, month_year, run_date, status, created_at
         FROM payroll_runs
        ORDER BY created_at DESC
        LIMIT 5`
    ),
    rows(
      `SELECT sc.id, e.first_name, e.last_name, e.employee_code, sc.payroll_period, sc.status, sc.net_pay
         FROM salary_calculations sc
         JOIN employees e ON e.id = sc.employee_id
        ORDER BY sc.calculation_date DESC, sc.id DESC
        LIMIT 5`
    ),
    rows(
      `SELECT e.first_name, e.last_name, e.employee_code,
              ats.attendance_date, ats.regular_minutes, ats.overtime_minutes,
              ats.attendance_status, ats.verification_status
         FROM attendance_summary ats
         JOIN employees e ON e.id = ats.employee_id
        WHERE ats.payroll_eligible = 1
        ORDER BY ats.attendance_date DESC, ats.updated_at DESC
        LIMIT 8`
    ),
  ]);

  const stats = [
    card('Payroll Due This Week', payrollDue),
    card('Draft Salary Calculations', draftCalculations),
    card('Pending Payroll Approval', pendingApproval),
    card('Payslips Generated', payslipsGenerated),
    card('Government Contributions Due', contributionsDue),
    card('Payroll Ready Attendance', payrollReadyAttendance, 'Last 7 days'),
  ];

  return {
    stats,
    tables: [
      table('Recent Payroll Runs', ['Run ID', 'Period', 'Run Date', 'Status'], payrollRuns.map(r => [r.id, r.month_year || '-', dateLabel(r.run_date), r.status || '-'])),
      table('Payroll Ready Attendance', ['Employee', 'Date', 'Regular Hours', 'OT Hours', 'Status'], attendanceRows.map(r => [employeeName(r), dateLabel(r.attendance_date), (Number(r.regular_minutes || 0) / 60).toFixed(1), (Number(r.overtime_minutes || 0) / 60).toFixed(1), r.verification_status || r.attendance_status || '-'])),
      table('Pending Salary Calculations', ['Employee', 'Period', 'Net Pay', 'Status'], salaryRows.map(r => [employeeName(r), r.payroll_period || '-', money(r.net_pay), r.status || '-'])),
      table('Payroll Processing Queue', ['Employee', 'Period', 'Net Pay', 'Status'], salaryRows.map(r => [employeeName(r), r.payroll_period || '-', money(r.net_pay), r.status || '-'])),
    ],
    actions: [
      action('Salary Calculation', 'payroll', 'Open salary calculation'),
      action('Process Payroll', 'payroll', 'Generate weekly payroll'),
      action('Generate Payslips', 'payroll', 'Review payslip queue'),
      action('Payroll Reports', 'reports', 'Open payroll reports'),
    ],
  };
}

async function managerDashboard(profile, permissions) {
  const departmentId = profile?.department_id || null;
  const [
    teamMembers,
    presentToday,
    pendingApprovals,
    attendanceIssues,
    attendanceRows,
    leaveRows,
  ] = departmentId ? await Promise.all([
    scalar('SELECT COUNT(*) FROM employees WHERE department_id = ?', [departmentId]),
    scalar(`SELECT COUNT(DISTINCT al.employee_id) FROM attendance_log al JOIN employees e ON e.id = al.employee_id WHERE e.department_id = ? AND al.date = CURDATE() AND al.time_in IS NOT NULL`, [departmentId]),
    scalar(`SELECT COUNT(*) FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE e.department_id = ? AND lr.status = 'Pending'`, [departmentId]),
    scalar(`SELECT COUNT(*) FROM attendance_log al JOIN employees e ON e.id = al.employee_id WHERE e.department_id = ? AND al.date = CURDATE() AND al.status IN ('Late','Absent')`, [departmentId]),
    rows(
      `SELECT e.first_name, e.last_name, e.employee_code, al.date, al.time_in, al.time_out, al.status
         FROM attendance_log al
         JOIN employees e ON e.id = al.employee_id
        WHERE e.department_id = ?
        ORDER BY al.date DESC
        LIMIT 5`,
      [departmentId]
    ),
    rows(
      `SELECT e.first_name, e.last_name, e.employee_code, lr.type, lr.date_from, lr.date_to, lr.status
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
        WHERE e.department_id = ?
        ORDER BY lr.created_at DESC
        LIMIT 5`,
      [departmentId]
    ),
  ]) : [0, 0, 0, 0, [], []];

  const stats = [
    card('Team Members', teamMembers),
    card('Employees Present Today', presentToday),
    card('Pending Leave Approvals', pendingApprovals),
    card('Attendance Issues', attendanceIssues),
  ];

  return {
    stats,
    tables: [
      table('Team Attendance', ['Employee', 'Date', 'Time In', 'Time Out', 'Status'], attendanceRows.map(r => [employeeName(r), dateLabel(r.date), r.time_in || '-', r.time_out || '-', r.status || '-'])),
      table('Team Leave Requests', ['Employee', 'Type', 'Dates', 'Status'], leaveRows.map(r => [employeeName(r), r.type, `${dateLabel(r.date_from)} - ${dateLabel(r.date_to)}`, r.status])),
    ],
    actions: [
      action('Approve Leave', 'leave', 'Review team leave requests'),
      action('View Team Attendance', 'attendance', 'Open attendance monitoring'),
    ],
  };
}

async function employeeDashboard(profile, permissions) {
  const employeeId = profile?.id;
  const leaveAllowed = canFileLeave(profile, permissions);
  const [
    attendanceToday,
    pendingLeaves,
    leaveCredits,
    upcomingPayroll,
    attendanceRows,
    leaveRows,
    payslipRows,
  ] = await Promise.all([
    scalar('SELECT COALESCE(MAX(status), ?) FROM attendance_log WHERE employee_id = ? AND date = CURDATE()', ['No log', employeeId], 'No log'),
    scalar("SELECT COUNT(*) FROM leave_requests WHERE employee_id = ? AND status = 'Pending'", [employeeId]),
    scalar('SELECT COALESCE(SUM(balance - used), 0) FROM leave_balances WHERE employee_id = ? AND year = YEAR(CURDATE())', [employeeId]),
    scalar("SELECT COALESCE(MAX(month_year), 'No payroll yet') FROM payroll_runs WHERE status IN ('Approved','Released','Paid')", [], 'No payroll yet'),
    rows(
      `SELECT date, time_in, time_out, status
         FROM attendance_log
        WHERE employee_id = ?
        ORDER BY date DESC
        LIMIT 5`,
      [employeeId]
    ),
    rows(
      `SELECT type, date_from, date_to, days, status
         FROM leave_requests
        WHERE employee_id = ?
        ORDER BY created_at DESC
        LIMIT 5`,
      [employeeId]
    ),
    rows(
      `SELECT ps.net_pay, ps.status, pr.month_year
         FROM payslips ps
         JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
        WHERE ps.employee_id = ?
        ORDER BY ps.created_at DESC
        LIMIT 5`,
      [employeeId]
    ),
  ]);

  const stats = [
    card('Attendance Today', attendanceToday),
    card('Pending Leave Requests', pendingLeaves),
    card('Available Leave Credits', leaveCredits),
    card('Upcoming Payroll', upcomingPayroll),
  ];

  const actions = [
    action('Time In / Time Out', 'attendance', 'Open attendance'),
    action('View Payslip', 'payroll', 'Open payslips'),
    action('Update Profile', 'employee-profile', 'Review employee profile'),
  ];
  if (leaveAllowed) actions.splice(1, 0, action('File Leave Request', 'leave', 'Submit leave through portal'));

  return {
    stats,
    tables: [
      table('Recent Attendance Logs', ['Date', 'Time In', 'Time Out', 'Status'], attendanceRows.map(r => [dateLabel(r.date), r.time_in || '-', r.time_out || '-', r.status || '-'])),
      table('Leave Request History', ['Type', 'Dates', 'Duration', 'Status'], leaveRows.map(r => [r.type, `${dateLabel(r.date_from)} - ${dateLabel(r.date_to)}`, `${r.days || 0} day(s)`, r.status])),
      table('Recent Payslips', ['Period', 'Net Pay', 'Status'], payslipRows.map(r => [r.month_year || '-', money(r.net_pay), r.status || '-'])),
    ],
    actions,
    leaveAllowed,
  };
}

async function systemAdminDashboard(profile, permissions) {
  const [totalEmployees, activeUsers, disabledUsers, recentAuditEvents, auditRows] = await Promise.all([
    scalar('SELECT COUNT(*) FROM employees'),
    scalar('SELECT COUNT(*) FROM users WHERE is_active = 1'),
    scalar('SELECT COUNT(*) FROM users WHERE is_active = 0'),
    scalar('SELECT COUNT(*) FROM system_audit_log WHERE timestamp >= DATE_SUB(NOW(), INTERVAL 7 DAY)', [], 0),
    rows(
      `SELECT action_performed, module, timestamp
         FROM system_audit_log
        ORDER BY timestamp DESC
        LIMIT 5`
    ),
  ]);

  const stats = [
    card('Total Employees', totalEmployees),
    card('Active Users', activeUsers),
    card('Disabled Users', disabledUsers),
    card('Recent Audit Events', recentAuditEvents, 'Last 7 days'),
  ];
  return {
    stats,
    tables: [
      table('Recent Activities', ['Module', 'Activity', 'Date'], auditRows.map(r => [
        formalModuleLabel(r.module),
        formatAuditMessage(r.action_performed, r.module),
        dateLabel(r.timestamp),
      ])),
    ],
    actions: [
      action('System Admin', 'system-admin', 'Manage users and roles'),
      action('Employees', 'employees', 'Open employee management'),
      action('Audit Log', 'blockchain', 'Review audit activity'),
    ],
  };
}

router.get('/', async (req, res) => {
  try {
    const bypassCache = req.query.refresh === '1' || req.headers['x-dashboard-refresh'] === '1';
    const cached = bypassCache ? null : getCachedDashboard(req.user);
    if (cached) {
      auditDashboardAccess(req);
      return res.json({ ...cached, cached: true });
    }

    const role = normalizeRole(req.user.role);
    const [permissions, profile] = await Promise.all([
      getPermissions(req.user),
      getProfile(req.user),
    ]);
    const sharedPromise = sharedWidgets(role, profile, permissions);

    let rolePayload;
    if (role === 'system_admin') {
      rolePayload = await systemAdminDashboard(profile, permissions);
    } else if (role === 'hr_admin' || role === 'hr_manager') {
      rolePayload = await hrDashboard(profile, permissions);
    } else if (role === 'payroll_officer' || role === 'payroll_manager') {
      rolePayload = await payrollDashboard(profile, permissions);
    } else if (role === 'manager') {
      rolePayload = await managerDashboard(profile, permissions);
    } else {
      rolePayload = await employeeDashboard(profile, permissions);
    }

    const shared = await sharedPromise;
    const payload = {
      role,
      roleLabel: req.user.roleLabel,
      permissions,
      profile,
      welcome: profile ? `Welcome back, ${profile.first_name}.` : `Welcome back, ${req.user.username}.`,
      subtitle: 'Here are the HRIS items that need your attention.',
      ...shared,
      ...rolePayload,
    };

    setCachedDashboard(req.user, payload);
    auditDashboardAccess(req);
    res.json(payload);
  } catch (error) {
    console.error('[dashboard]', error);
    res.status(500).json({ error: 'Failed to load dashboard.' });
  }
});

module.exports = router;
