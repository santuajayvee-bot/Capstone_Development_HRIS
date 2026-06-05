/* ============================================================
   server/dashboard.js - Role-aware dashboard endpoint
   ============================================================ */

const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const { requireAuth } = require('./middleware');

router.use(requireAuth);

const DASHBOARD_CACHE_TTL_MS = 15000;
const dashboardCache = new Map();

const FALLBACK_PERMISSIONS = {
  system_admin: ['employee.view', 'employee.manage', 'attendance.view', 'leave.request.view_all', 'leave.request.approve', 'payroll.view', 'payroll.calculate', 'payroll.approve', 'report.view', 'settings.manage'],
  admin: ['employee.view', 'employee.manage', 'attendance.view', 'leave.request.view_all', 'leave.request.approve', 'payroll.view', 'payroll.calculate', 'payroll.approve', 'report.view', 'settings.manage'],
  hr_admin: ['employee.view', 'employee.manage', 'attendance.view', 'attendance.manage', 'leave.request.view_all', 'leave.request.approve', 'leave.manual.create', 'report.view'],
  payroll_officer: ['payroll.view', 'payroll.calculate', 'payroll.report.view', 'employee.view'],
  payroll_manager: ['payroll.view', 'payroll.calculate', 'payroll.approve', 'payroll.report.view', 'report.view'],
  manager: ['attendance.view', 'leave.request.approve', 'report.view'],
  employee: ['attendance.view', 'leave.request.create', 'leave.request.view_own', 'payroll.view'],
};

function hasPermission(permissions, key) {
  return permissions.includes(key);
}

function normalizeRole(role) {
  if (role === 'admin') return 'system_admin';
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
  return result[0] || null;
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
      LIMIT 5`
  );

  const notifications = notificationRows.map(item => ({
    title: item.module || 'HRIS',
    message: item.action_performed || 'System activity',
    date: dateLabel(item.timestamp),
  }));

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
    leaveRows,
    newHireRows,
    onboardingRows,
  ] = await Promise.all([
    scalar('SELECT COUNT(*) FROM employees'),
    scalar("SELECT COUNT(*) FROM employees WHERE status = 'Active'"),
    scalar('SELECT COUNT(*) FROM employees WHERE date_hired >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)'),
    scalar("SELECT COUNT(DISTINCT employee_id) FROM leave_requests WHERE status = 'Approved' AND CURDATE() BETWEEN date_from AND date_to"),
    scalar("SELECT COUNT(*) FROM leave_requests WHERE status = 'Pending'"),
    scalar("SELECT COUNT(*) FROM employees WHERE onboarding_status = 'active'"),
    rows(
      `SELECT CONCAT(e.first_name, ' ', e.last_name) AS employee, lr.type, lr.date_from, lr.date_to, lr.status
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
        ORDER BY lr.created_at DESC
        LIMIT 5`
    ),
    rows(
      `SELECT employee_code, CONCAT(first_name, ' ', last_name) AS employee, position, date_hired
         FROM employees
        ORDER BY created_at DESC
        LIMIT 5`
    ),
    rows(
      `SELECT employee_code, CONCAT(first_name, ' ', last_name) AS employee, onboarding_status, date_hired
         FROM employees
        WHERE onboarding_status = 'active'
        ORDER BY date_hired DESC
        LIMIT 5`
    ),
  ]);

  const stats = [
    card('Total Employees', totalEmployees),
    card('Active Employees', activeEmployees),
    card('New Hires', newHires, 'Last 30 days'),
    card('Employees On Leave', employeesOnLeave),
    card('Pending Leave Requests', pendingLeaveRequests),
    card('Pending Onboarding', pendingOnboarding),
  ];

  return {
    stats,
    tables: [
      table('Recent Leave Requests', ['Employee', 'Type', 'Dates', 'Status'], leaveRows.map(r => [r.employee, r.type, `${dateLabel(r.date_from)} - ${dateLabel(r.date_to)}`, r.status])),
      table('New Employee Registrations', ['Employee ID', 'Employee', 'Position', 'Date Hired'], newHireRows.map(r => [r.employee_code, r.employee, r.position || '-', dateLabel(r.date_hired)])),
      table('Pending Onboarding Tracking', ['Employee ID', 'Employee', 'Status', 'Date Hired'], onboardingRows.map(r => [r.employee_code, r.employee, r.onboarding_status || '-', dateLabel(r.date_hired)])),
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
    payrollRuns,
    salaryRows,
  ] = await Promise.all([
    scalar("SELECT COUNT(*) FROM payroll_runs WHERE status IN ('Draft','Pending','Submitted') AND run_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL 7 DAY)"),
    scalar("SELECT COUNT(*) FROM salary_calculations WHERE status = 'Draft'"),
    scalar("SELECT COUNT(*) FROM salary_calculations WHERE status = 'Submitted'"),
    scalar('SELECT COUNT(*) FROM payslips'),
    scalar("SELECT COUNT(*) FROM payroll_deduction_settings WHERE category = 'Government' AND is_active = 1"),
    rows(
      `SELECT id, month_year, run_date, status, created_at
         FROM payroll_runs
        ORDER BY created_at DESC
        LIMIT 5`
    ),
    rows(
      `SELECT sc.id, CONCAT(e.first_name, ' ', e.last_name) AS employee, sc.payroll_period, sc.status, sc.net_pay
         FROM salary_calculations sc
         JOIN employees e ON e.id = sc.employee_id
        ORDER BY sc.calculation_date DESC, sc.id DESC
        LIMIT 5`
    ),
  ]);

  const stats = [
    card('Payroll Due This Week', payrollDue),
    card('Draft Salary Calculations', draftCalculations),
    card('Pending Payroll Approval', pendingApproval),
    card('Payslips Generated', payslipsGenerated),
    card('Government Contributions Due', contributionsDue),
  ];

  return {
    stats,
    tables: [
      table('Recent Payroll Runs', ['Run ID', 'Period', 'Run Date', 'Status'], payrollRuns.map(r => [r.id, r.month_year || '-', dateLabel(r.run_date), r.status || '-'])),
      table('Pending Salary Calculations', ['Employee', 'Period', 'Net Pay', 'Status'], salaryRows.map(r => [r.employee, r.payroll_period || '-', money(r.net_pay), r.status || '-'])),
      table('Payroll Processing Queue', ['Employee', 'Period', 'Net Pay', 'Status'], salaryRows.map(r => [r.employee, r.payroll_period || '-', money(r.net_pay), r.status || '-'])),
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
      `SELECT CONCAT(e.first_name, ' ', e.last_name) AS employee, al.date, al.time_in, al.time_out, al.status
         FROM attendance_log al
         JOIN employees e ON e.id = al.employee_id
        WHERE e.department_id = ?
        ORDER BY al.date DESC
        LIMIT 5`,
      [departmentId]
    ),
    rows(
      `SELECT CONCAT(e.first_name, ' ', e.last_name) AS employee, lr.type, lr.date_from, lr.date_to, lr.status
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
      table('Team Attendance', ['Employee', 'Date', 'Time In', 'Time Out', 'Status'], attendanceRows.map(r => [r.employee, dateLabel(r.date), r.time_in || '-', r.time_out || '-', r.status || '-'])),
      table('Team Leave Requests', ['Employee', 'Type', 'Dates', 'Status'], leaveRows.map(r => [r.employee, r.type, `${dateLabel(r.date_from)} - ${dateLabel(r.date_to)}`, r.status])),
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
      table('Recent Activities', ['Module', 'Activity', 'Date'], auditRows.map(r => [r.module || '-', r.action_performed || '-', dateLabel(r.timestamp)])),
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
    const cached = getCachedDashboard(req.user);
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
    } else if (role === 'hr_admin') {
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
