/* ============================================================
   server/reports.js — ERP Report Library and Export Service
   ============================================================ */

const express = require('express');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const pool = require('../config/db');
const { requireAuth, requireRole, ROLES } = require('./middleware');
const { decryptColumnValue } = require('./data-protection');
const { isStrictDateOnly } = require('./utils/dateValidation');
const { calculatePieceShareTotal } = require('../services/pieceRateMath');

const router = express.Router();

const REPORT_HR_ROLES = [...ROLES.hr_manager, ...ROLES.admin_any, 'hr', 'hradmin', 'manager'];
const REPORT_ROLE_GROUPS = {
  attendance: [...REPORT_HR_ROLES, ...ROLES.payroll_any],
  payroll: ROLES.payroll_any,
  payslip: [...REPORT_HR_ROLES, ...ROLES.payroll_any],
};
const REPORT_ACCESS_ROLES = [...new Set([
  ...REPORT_ROLE_GROUPS.attendance,
  ...REPORT_ROLE_GROUPS.payroll,
  ...REPORT_ROLE_GROUPS.payslip,
])];

const BASE_FORMATS = ['csv', 'excel', 'pdf'];
const EXCEL_ONLY = ['excel'];
const ALLOWED_REPORT_IDS = new Set(['daily-attendance', 'payroll-register', 'employee-payslip']);

const REPORTS = [
  ['employee-master-list', 'Employee Master List', 'HR Reports', 'Complete employee list with department, position, employment type, and status.', BASE_FORMATS],
  ['employee-directory', 'Employee Directory', 'HR Reports', 'Employee contact directory grouped by department and position.', BASE_FORMATS],
  ['department-summary', 'Department Summary', 'HR Reports', 'Employee count and active headcount by department.', BASE_FORMATS],
  ['position-summary', 'Position Summary', 'HR Reports', 'Configured positions and employee counts by department.', BASE_FORMATS],
  ['active-inactive-employees', 'Active / Inactive Employees', 'HR Reports', 'Employee status report for active and inactive workers.', BASE_FORMATS],
  ['inactive-separated-employees', 'Inactive / Separated Employees', 'HR Reports', 'Separated, inactive, suspended, and offboarded employee records.', BASE_FORMATS],
  ['employee-status-summary', 'Employee Status Summary', 'HR Reports', 'Employee headcount grouped by employment status.', BASE_FORMATS],
  ['employee-lifecycle', 'Employee Lifecycle', 'HR Reports', 'Hiring type, deployment status, contract dates, and lifecycle status.', BASE_FORMATS],
  ['employee-profile-summary', 'Employee Profile Summary', 'HR Reports', 'Printable employee profile summary for selected employees.', BASE_FORMATS],

  ['daily-attendance', 'Daily Attendance Report', 'Attendance Reports', 'Daily attendance logs, time in, time out, hours, and validation status.', BASE_FORMATS],
  ['weekly-attendance', 'Weekly Attendance Report', 'Attendance Reports', 'Weekly attendance detail with payroll-ready validation.', BASE_FORMATS],
  ['monthly-attendance', 'Monthly Attendance Report', 'Attendance Reports', 'Monthly attendance summary by employee and department.', BASE_FORMATS],
  ['attendance-summary', 'Attendance Summary Report', 'Attendance Reports', 'Summary of attendance status, regular hours, overtime, late, and undertime.', BASE_FORMATS],
  ['late-report', 'Late Report', 'Attendance Reports', 'Employees with late minutes within the selected date range.', BASE_FORMATS],
  ['undertime-report', 'Undertime Report', 'Attendance Reports', 'Employees with undertime minutes within the selected date range.', BASE_FORMATS],
  ['overtime-report', 'Overtime Report', 'Attendance Reports', 'Approved and recorded overtime hours.', BASE_FORMATS],
  ['attendance-exceptions', 'Attendance Exceptions Report', 'Attendance Reports', 'Missing time out, duplicate scans, rejected, and needs-review records.', BASE_FORMATS],
  ['attendance-validation', 'Attendance Validation Report', 'Attendance Reports', 'Pending, validated, rejected, corrected, and payroll-ready attendance records.', BASE_FORMATS],
  ['biometric-attendance', 'Biometric Attendance Report', 'Attendance Reports', 'Biometric scan events and attendance source metadata.', BASE_FORMATS],

  ['leave-application', 'Leave Application Report', 'Leave Reports', 'Filed leave requests with dates, duration, reason, and source.', BASE_FORMATS],
  ['leave-approval', 'Leave Approval Report', 'Leave Reports', 'Approved and rejected leave review history.', BASE_FORMATS],
  ['leave-balance', 'Leave Balance Report', 'Leave Reports', 'Leave credits, used days, and remaining balances by year.', BASE_FORMATS],
  ['leave-utilization', 'Leave Utilization Report', 'Leave Reports', 'Leave days used by type, category, department, and employee.', BASE_FORMATS],
  ['pending-leave', 'Pending Leave Report', 'Leave Reports', 'Pending leave requests for HR review.', BASE_FORMATS],
  ['rejected-leave', 'Rejected Leave Report', 'Leave Reports', 'Rejected leave requests and rejection remarks.', BASE_FORMATS],

  ['payroll-register', 'Payroll Register', 'Payroll Reports', 'Payroll calculations with gross pay, deductions, allowances, and net pay.', BASE_FORMATS],
  ['payroll-summary', 'Payroll Summary Report', 'Payroll Reports', 'Payroll totals by period, status, and department.', BASE_FORMATS],
  ['payroll-validation', 'Payroll Validation Report', 'Payroll Reports', 'Attendance-to-payroll and payroll readiness validation details.', BASE_FORMATS],
  ['payroll-deductions', 'Payroll Deductions Report', 'Payroll Reports', 'SSS, PhilHealth, Pag-IBIG, loan, cash advance, and other deductions.', BASE_FORMATS],
  ['payroll-adjustments', 'Payroll Adjustments Report', 'Payroll Reports', 'Payroll adjustments, notes, and audit references.', BASE_FORMATS],
  ['net-pay-report', 'Net Pay Report', 'Payroll Reports', 'Net pay amounts by employee and payroll period.', BASE_FORMATS],
  ['gross-pay-report', 'Gross Pay Report', 'Payroll Reports', 'Gross pay amounts by employee and payroll period.', BASE_FORMATS],
  ['payslip-generation', 'Payslip Generation Report', 'Payroll Reports', 'Payslip-ready payroll calculation list.', BASE_FORMATS],
  ['payroll-approval', 'Payroll Approval Report', 'Payroll Reports', 'Submitted, approved, released, and paid payroll status report.', BASE_FORMATS],
  ['employee-payslip', 'Employee Payslip', 'Payroll Reports', 'Professional employee payslip with earnings, deductions, and net pay.', ['pdf']],

  ['daily-rate-payroll-register', 'Daily Rate Payroll Register', 'Wage Type Reports', 'Daily rate employees, days worked, gross pay, and validation status.', BASE_FORMATS],
  ['daily-rate-payroll-summary', 'Daily Rate Payroll Summary', 'Wage Type Reports', 'Summary of daily rate payroll by employee and period.', BASE_FORMATS],
  ['per-hour-payroll-register', 'Per-Hour Payroll Register', 'Wage Type Reports', 'Hourly employees, time worked, hourly rates, and gross pay.', BASE_FORMATS],
  ['per-hour-hours-summary', 'Per-Hour Hours Summary', 'Wage Type Reports', 'Hours worked, overtime, and payroll-ready validation.', BASE_FORMATS],
  ['per-piece-production-register', 'Per-Piece Production Register', 'Wage Type Reports', 'Piece-rate production entries, quantities, rates, and production amounts.', BASE_FORMATS],
  ['sewer-payroll-register', 'Sewer Payroll Register', 'Wage Type Reports', 'Sewer share amounts from piece-rate production.', BASE_FORMATS],
  ['fixer-payroll-register', 'Fixer Payroll Register', 'Wage Type Reports', 'Fixer share amounts from piece-rate production.', BASE_FORMATS],
  ['swr-fxr-sum', 'SWR-FXR-SUM', 'Wage Type Reports', 'Combined sewer and fixer payroll register with totals.', BASE_FORMATS],
  ['per-trip-trip-register', 'Per-Trip Trip Register', 'Wage Type Reports', 'Logistics trip entries by driver, helper, truck, and region.', BASE_FORMATS],
  ['driver-payroll-register', 'Driver Payroll Register', 'Wage Type Reports', 'Driver logistics payroll with base rate and missing-helper share.', BASE_FORMATS],
  ['helper-payroll-register', 'Helper Payroll Register', 'Wage Type Reports', 'Helper logistics payroll with base rate and missing-helper share.', BASE_FORMATS],
  ['logistics-payroll-summary', 'Logistics Payroll Summary', 'Wage Type Reports', 'Per-trip logistics payroll summary.', BASE_FORMATS],

  ['production-output', 'Production Output Report', 'Production Reports', 'Production output by sew type, size range, employee, and period.', BASE_FORMATS],
  ['production-summary', 'Production Summary Report', 'Production Reports', 'Production totals by sew type and size range.', BASE_FORMATS],
  ['piece-rate-configuration', 'Piece Rate Configuration Report', 'Production Reports', 'Configured piece rates by sew type, size range, effective date, and status.', BASE_FORMATS],
  ['sewer-productivity', 'Sewer Productivity Report', 'Production Reports', 'Sewer production volume and payroll share.', BASE_FORMATS],
  ['fixer-productivity', 'Fixer Productivity Report', 'Production Reports', 'Fixer production volume and payroll share.', BASE_FORMATS],
  ['production-payroll', 'Production Payroll Report', 'Production Reports', 'Production-based payroll output for piece-rate workers.', BASE_FORMATS],
  ['production-register-document', 'Production Register Document', 'Production Reports', 'Official production register document.', BASE_FORMATS],

  ['trip-summary', 'Trip Summary Report', 'Logistics Reports', 'Logistics trip totals by region, truck type, and crew status.', BASE_FORMATS],
  ['driver-trip', 'Driver Trip Report', 'Logistics Reports', 'Driver trip assignments and gross pay.', BASE_FORMATS],
  ['helper-trip', 'Helper Trip Report', 'Logistics Reports', 'Helper trip assignments and gross pay.', BASE_FORMATS],
  ['truck-utilization', 'Truck Utilization Report', 'Logistics Reports', 'Trip counts by truck type and region.', BASE_FORMATS],
  ['logistics-payroll', 'Logistics Payroll Report', 'Logistics Reports', 'Per-trip logistics payroll computation.', BASE_FORMATS],
  ['trip-register-document', 'Trip Register Document', 'Logistics Reports', 'Official trip register document.', BASE_FORMATS],

  ['sss-report', 'SSS Report', 'Government Reports', 'SSS statutory deduction amounts by employee and period.', BASE_FORMATS],
  ['philhealth-report', 'PhilHealth Report', 'Government Reports', 'PhilHealth statutory deduction amounts by employee and period.', BASE_FORMATS],
  ['pagibig-report', 'Pag-IBIG Report', 'Government Reports', 'Pag-IBIG statutory deduction amounts by employee and period.', BASE_FORMATS],
  ['withholding-tax-report', 'Withholding Tax Report', 'Government Reports', 'Withholding tax report placeholder for accounting-managed tax scope.', BASE_FORMATS],
  ['government-deduction-summary', 'Government Deduction Summary', 'Government Reports', 'Government deduction summary by payroll period.', BASE_FORMATS],

  ['user-activity-audit', 'User Activity Audit Report', 'Audit Reports', 'System user activity and module audit trail.', BASE_FORMATS],
  ['attendance-audit', 'Attendance Audit Report', 'Audit Reports', 'Attendance validations, corrections, and biometric events.', BASE_FORMATS],
  ['payroll-audit', 'Payroll Audit Report', 'Audit Reports', 'Payroll computation, approval, release, and configuration changes.', BASE_FORMATS],
  ['employee-change-audit', 'Employee Change Audit Report', 'Audit Reports', 'Employee profile and lifecycle change audit trail.', BASE_FORMATS],
  ['system-config-audit', 'System Configuration Changes Report', 'Audit Reports', 'Configuration changes across HRIS modules.', BASE_FORMATS],
  ['login-activity', 'Login Activity Report', 'Audit Reports', 'Login attempts, lockouts, and session-related audit entries.', BASE_FORMATS],

  ['attendance-blockchain-verification', 'Attendance Verification Report', 'Blockchain Verification Reports', 'Attendance integrity chain verification status and references.', BASE_FORMATS],
  ['payroll-blockchain-verification', 'Payroll Verification Report', 'Blockchain Verification Reports', 'Finalized payroll blockchain transaction verification metadata.', BASE_FORMATS],
  ['blockchain-audit-trail', 'Blockchain Audit Trail', 'Blockchain Verification Reports', 'Blockchain anchoring and integrity event trail.', BASE_FORMATS],
  ['integrity-verification', 'Integrity Verification Report', 'Blockchain Verification Reports', 'Record ID, transaction/reference ID, verification status, and timestamp.', BASE_FORMATS],

  ['leave-approval-form', 'Leave Approval / Rejection Form', 'Documents', 'Printable leave approval or rejection form.', ['pdf']],
  ['attendance-summary-sheet', 'Attendance Summary Sheet', 'Documents', 'Printable attendance summary sheet.', BASE_FORMATS],
  ['employment-certificate', 'Employment Certificate', 'Documents', 'Employment certificate template generated from employee data.', ['pdf']],
  ['attendance-certification', 'Attendance Certification', 'Documents', 'Attendance certification document.', ['pdf']]
].map(([id, name, category, description, formats]) => ({ id, name, category, description, formats }))
  .filter(report => ALLOWED_REPORT_IDS.has(report.id))
  .map(report => {
    if (report.id === 'daily-attendance') {
      return {
        ...report,
        name: 'Attendance DTR',
        description: 'Daily time record with AM in/out, PM in/out, hours, late, undertime, and payroll-ready status.'
      };
    }
    if (report.id === 'payroll-register') {
      return {
        ...report,
        name: 'Payroll Registry',
        description: 'Payroll calculation register with gross pay, statutory deductions, allowances, and net pay.'
      };
    }
    return report;
  });

const REPORT_BY_ID = new Map(REPORTS.map(report => [report.id, report]));

function rolesForReport(reportId) {
  if (reportId === 'daily-attendance') return REPORT_ROLE_GROUPS.attendance;
  if (reportId === 'employee-payslip') return REPORT_ROLE_GROUPS.payslip;
  return REPORT_ROLE_GROUPS.payroll;
}

function userCanAccessReport(req, reportId) {
  return rolesForReport(reportId).includes(String(req.user?.role || '').trim());
}

function cleanFilter(value) {
  const text = String(value || '').trim();
  return !text || text === 'all' || text === 'latest' ? null : text;
}

function sqlDate(value) {
  const text = String(value || '').trim();
  return isStrictDateOnly(text) ? text : null;
}

function addCondition(where, params, sql, value) {
  if (value !== null && value !== undefined && value !== '') {
    where.push(sql);
    params.push(value);
  }
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function peso(value) {
  return `PHP ${numeric(value).toLocaleString('en-PH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

function decryptReportValue(value) {
  try {
    return decryptColumnValue(value) || '';
  } catch (_) {
    return '';
  }
}

function reportEmployeeName(row, prefix = '') {
  const first = decryptReportValue(row?.[`${prefix}first_name`]);
  const middle = decryptReportValue(row?.[`${prefix}middle_name`]);
  const last = decryptReportValue(row?.[`${prefix}last_name`]);
  return [first, middle, last].filter(Boolean).join(' ') || row?.['Employee ID'] || row?.employee_code || '-';
}

function applyEmployeeDisplay(row, prefix = '') {
  row.Employee = reportEmployeeName(row, prefix);
  delete row[`${prefix}first_name`];
  delete row[`${prefix}middle_name`];
  delete row[`${prefix}last_name`];
  return row;
}

async function tableExists(tableName) {
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS count FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [tableName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function safeQuery(tableName, query, params = []) {
  if (!(await tableExists(tableName))) return [];
  const [rows] = await pool.execute(query, params);
  return rows;
}

function filtersFromRequest(query) {
  return {
    dateFrom: sqlDate(query.date_from),
    dateTo: sqlDate(query.date_to),
    payrollPeriod: cleanFilter(query.payroll_period),
    registryType: cleanFilter(query.registry_type) || 'main',
    employeeId: cleanFilter(query.employee_id),
    department: cleanFilter(query.department),
    wageType: cleanFilter(query.wage_type),
    status: cleanFilter(query.status)
  };
}

function employeeNameSql(alias = 'e') {
  return `TRIM(CONCAT_WS(' ', ${alias}.first_name, ${alias}.middle_name, ${alias}.last_name, ${alias}.suffix))`;
}

function employeeFilters(where, params, filters, alias = 'e', departmentAlias = 'd') {
  addCondition(where, params, `${alias}.id = ?`, filters.employeeId);
  addCondition(where, params, `${departmentAlias}.name = ?`, filters.department);
  if (filters.status) {
    addCondition(where, params, `${alias}.status = ?`, filters.status);
  }
}

async function employeeReport(filters, mode) {
  const where = [];
  const params = [];
  employeeFilters(where, params, filters);
  if (mode === 'inactive-separated-employees') {
    where.push("COALESCE(e.status, 'Active') <> 'Active'");
  }

  const query = `
    SELECT
      e.employee_code AS "Employee ID",
      ${employeeNameSql()} AS "Employee",
      e.email AS "Email",
      e.contact_number AS "Contact Number",
      COALESCE(d.name, '-') AS "Department",
      COALESCE(e.position, '-') AS "Position",
      COALESCE(e.employment_type, '-') AS "Employment Type",
      COALESCE(wt.name, '-') AS "Wage Type",
      COALESCE(e.hiring_type, '-') AS "Hiring Classification",
      COALESCE(e.agency_name, '-') AS "Agency",
      COALESCE(e.deployment_status, '-') AS "Deployment Status",
      COALESCE(e.lifecycle_status, '-') AS "Lifecycle Status",
      COALESCE(e.status, '-') AS "Status",
      DATE_FORMAT(e.separation_date, '%Y-%m-%d') AS "Separation Date",
      COALESCE(e.separation_reason, '-') AS "Separation Reason",
      COALESCE(e.offboarding_remarks, '-') AS "Offboarding Remarks",
      DATE_FORMAT(e.date_hired, '%Y-%m-%d') AS "Date Hired"
    FROM employees e
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY d.name, e.last_name, e.first_name
  `;
  return safeQuery('employees', query, params);
}

async function employeeStatusSummary() {
  return safeQuery('employees', `
    SELECT
      COALESCE(status, 'Active') AS "Employment Status",
      COUNT(*) AS "Employees",
      SUM(CASE WHEN status = 'Active' THEN 1 ELSE 0 END) AS "Active Count",
      SUM(CASE WHEN status <> 'Active' OR status IS NULL THEN 1 ELSE 0 END) AS "Non-Active Count"
    FROM employees
    GROUP BY COALESCE(status, 'Active')
    ORDER BY FIELD(COALESCE(status, 'Active'), 'Active', 'Suspended', 'Inactive', 'Resigned', 'Terminated', 'End of Contract')
  `);
}

async function departmentSummary() {
  return safeQuery('departments', `
    SELECT
      d.name AS "Department",
      COUNT(e.id) AS "Employees",
      SUM(CASE WHEN e.status = 'Active' THEN 1 ELSE 0 END) AS "Active",
      SUM(CASE WHEN e.status <> 'Active' OR e.status IS NULL THEN 1 ELSE 0 END) AS "Inactive",
      CASE WHEN d.is_active = 1 THEN 'Active' ELSE 'Inactive' END AS "Status"
    FROM departments d
    LEFT JOIN employees e ON e.department_id = d.id
    GROUP BY d.id, d.name, d.is_active
    ORDER BY d.name
  `);
}

async function positionSummary(filters) {
  const where = [];
  const params = [];
  addCondition(where, params, 'd.name = ?', filters.department);
  return safeQuery('positions', `
    SELECT
      COALESCE(d.name, '-') AS "Department",
      p.name AS "Position",
      COUNT(e.id) AS "Employees",
      CASE WHEN p.is_active = 1 THEN 'Active' ELSE 'Inactive' END AS "Status"
    FROM positions p
    LEFT JOIN departments d ON d.id = p.department_id
    LEFT JOIN employees e ON e.department_id = p.department_id AND e.position = p.name
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    GROUP BY p.id, d.name, p.name, p.is_active
    ORDER BY d.name, p.name
  `, params);
}

async function attendanceReport(filters, mode) {
  const where = [];
  const params = [];
  addCondition(where, params, 'ats.attendance_date >= ?', filters.dateFrom);
  addCondition(where, params, 'ats.attendance_date <= ?', filters.dateTo);
  employeeFilters(where, params, filters);

  if (mode === 'late-report') where.push('ats.late_minutes > 0');
  if (mode === 'undertime-report') where.push('ats.undertime_minutes > 0');
  if (mode === 'overtime-report') where.push('ats.overtime_minutes > 0');
  if (mode === 'attendance-exceptions') {
    where.push(`(ats.verification_status IN ('NEEDS_REVIEW','REJECTED','MISSING_TIMEOUT','INCOMPLETE') OR al.time_out IS NULL)`);
  }
  if (mode === 'attendance-validation' && filters.status) {
    where.push('(ats.verification_status = ? OR ats.attendance_status = ?)');
    params.push(filters.status, filters.status);
  }

  return safeQuery('attendance_summary', `
    SELECT
      e.employee_code AS "Employee ID",
      e.first_name,
      e.middle_name,
      e.last_name,
      COALESCE(d.name, '-') AS "Department",
      DATE_FORMAT(ats.attendance_date, '%Y-%m-%d') AS "Date",
      TIME_FORMAT(al.time_in, '%H:%i:%s') AS "Time In",
      TIME_FORMAT(al.time_out, '%H:%i:%s') AS "Time Out",
      ROUND(ats.regular_minutes / 60, 2) AS "Regular Hours",
      ROUND(ats.overtime_minutes / 60, 2) AS "Overtime Hours",
      ats.late_minutes AS "Late Minutes",
      ats.undertime_minutes AS "Undertime Minutes",
      ats.attendance_status AS "Attendance Status",
      ats.verification_status AS "Validation Status",
      CASE WHEN ats.payroll_eligible = 1 THEN 'Ready' ELSE 'Not Ready' END AS "Payroll Ready"
    FROM attendance_summary ats
    LEFT JOIN attendance_log al ON al.attendance_id = ats.attendance_id
    LEFT JOIN employees e ON e.id = ats.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ats.attendance_date DESC, e.last_name
  `, params).then(rows => rows.map(row => applyEmployeeDisplay(row)));
}

function dtrDateRange(filters) {
  const today = new Date();
  const fallbackStart = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
  const fallbackEnd = new Date(Date.UTC(today.getFullYear(), today.getMonth() + 1, 0)).toISOString().slice(0, 10);
  return {
    start: filters.dateFrom || fallbackStart,
    end: filters.dateTo || fallbackEnd
  };
}

function dtrTime(value) {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return '';
  const hour = Number(match[1]);
  const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${displayHour}:${match[2]}`;
}

function dtrHour(value) {
  const match = String(value || '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  return Number.isFinite(hour) ? hour : null;
}

function dtrDateLabel(start, end) {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return `${start} - ${end}`;
  if (start === end) {
    return startDate.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC'
    });
  }
  const sameMonth = startDate.getUTCFullYear() === endDate.getUTCFullYear()
    && startDate.getUTCMonth() === endDate.getUTCMonth();
  if (sameMonth) {
    const month = startDate.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
    return `${month} ${startDate.getUTCDate()}-${endDate.getUTCDate()}, ${startDate.getUTCFullYear()}`;
  }
  return `${startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })} - ${endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`;
}

function enumerateDtrDates(start, end) {
  const dates = [];
  const current = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(current.getTime()) || Number.isNaN(last.getTime())) return dates;
  while (current <= last && dates.length < 31) {
    dates.push(current.toISOString().slice(0, 10));
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return dates;
}

function dtrFormDates(record) {
  return record.dates.length ? record.dates : enumerateDtrDates(record.start, record.end);
}

async function dtrRecord(filters) {
  const { start, end } = dtrDateRange(filters);
  const [employeeRows] = await pool.execute(`
    SELECT e.id, e.employee_code, e.first_name, e.middle_name, e.last_name,
           COALESCE(d.name, '-') AS department
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
     WHERE e.id = ?
     LIMIT 1
  `, [filters.employeeId]);
  if (!employeeRows.length) {
    const err = new Error('Selected employee was not found.');
    err.status = 404;
    throw err;
  }

  const [attendanceRows] = await pool.execute(`
    SELECT DATE_FORMAT(ats.attendance_date, '%Y-%m-%d') AS attendance_date,
           TIME_FORMAT(al.time_in, '%H:%i') AS time_in,
           TIME_FORMAT(al.time_out, '%H:%i') AS time_out
      FROM attendance_summary ats
      LEFT JOIN attendance_log al ON al.attendance_id = ats.attendance_id
     WHERE ats.employee_id = ?
       AND ats.attendance_date BETWEEN ? AND ?
     ORDER BY ats.attendance_date
  `, [filters.employeeId, start, end]);
  const attendanceByDate = new Map(attendanceRows.map(row => [row.attendance_date, row]));
  return {
    employee: employeeRows[0],
    employeeName: reportEmployeeName(employeeRows[0]),
    department: employeeRows[0].department || '-',
    start,
    end,
    dates: enumerateDtrDates(start, end),
    attendanceByDate
  };
}

async function biometricReport(filters) {
  const where = [];
  const params = [];
  addCondition(where, params, 'DATE(bse.scan_timestamp) >= ?', filters.dateFrom);
  addCondition(where, params, 'DATE(bse.scan_timestamp) <= ?', filters.dateTo);
  addCondition(where, params, 'e.id = ?', filters.employeeId);
  addCondition(where, params, 'd.name = ?', filters.department);
  return safeQuery('biometric_scan_event', `
    SELECT
      e.employee_code AS "Employee ID",
      ${employeeNameSql()} AS "Employee",
      COALESCE(d.name, '-') AS "Department",
      bse.device_id AS "Device",
      bse.attendance_type AS "Scan Type",
      DATE_FORMAT(bse.scan_timestamp, '%Y-%m-%d %H:%i:%s') AS "Scan Time",
      bse.verification_score AS "Score",
      bse.verification_status AS "Result",
      bse.error_message AS "Message"
    FROM biometric_scan_event bse
    LEFT JOIN employees e ON e.id = bse.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY bse.scan_timestamp DESC
  `, params);
}

async function leaveReport(filters, mode) {
  const where = [];
  const params = [];
  addCondition(where, params, 'lr.date_from >= ?', filters.dateFrom);
  addCondition(where, params, 'lr.date_to <= ?', filters.dateTo);
  employeeFilters(where, params, filters);
  if (mode === 'pending-leave') where.push("lr.status IN ('Pending','Payroll Approved')");
  if (mode === 'rejected-leave') addCondition(where, params, 'lr.status = ?', 'Rejected');
  if (mode === 'leave-approval' && filters.status) addCondition(where, params, 'lr.status = ?', filters.status);

  return safeQuery('leave_requests', `
    SELECT
      e.employee_code AS "Employee ID",
      ${employeeNameSql()} AS "Employee",
      COALESCE(d.name, '-') AS "Department",
      COALESCE(lt.name, lr.type) AS "Leave Type",
      COALESCE(lr.leave_category, lt.category, '-') AS "Category",
      DATE_FORMAT(lr.date_from, '%Y-%m-%d') AS "Start Date",
      DATE_FORMAT(lr.date_to, '%Y-%m-%d') AS "End Date",
      lr.days AS "Days",
      lr.status AS "Status",
      lr.filing_source AS "Filing Source",
      lr.reason AS "Reason",
      COALESCE(lr.approval_remarks, lr.rejection_remarks, lr.remarks, '-') AS "Remarks"
    FROM leave_requests lr
    LEFT JOIN employees e ON e.id = lr.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY lr.date_from DESC
  `, params);
}

async function leaveBalanceReport(filters) {
  const where = [];
  const params = [];
  employeeFilters(where, params, filters);
  return safeQuery('leave_balances', `
    SELECT
      e.employee_code AS "Employee ID",
      ${employeeNameSql()} AS "Employee",
      COALESCE(d.name, '-') AS "Department",
      COALESCE(lt.name, lb.leave_type) AS "Leave Type",
      lb.year AS "Year",
      COALESCE(lb.total_days, lb.balance, 0) AS "Total Days",
      COALESCE(lb.used_days, lb.used, 0) AS "Used Days",
      COALESCE(lb.remaining_days, lb.balance, 0) AS "Remaining Days",
      DATE_FORMAT(lb.updated_at, '%Y-%m-%d %H:%i:%s') AS "Updated At"
    FROM leave_balances lb
    LEFT JOIN employees e ON e.id = lb.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN leave_types lt ON lt.id = lb.leave_type_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY lb.year DESC, e.last_name, lt.name
  `, params);
}

async function payrollReport(filters, mode) {
  const where = [];
  const params = [];
  addCondition(where, params, 'sc.calculation_date >= ?', filters.dateFrom);
  addCondition(where, params, 'sc.calculation_date <= ?', filters.dateTo);
  addCondition(where, params, 'sc.payroll_period = ?', filters.payrollPeriod);
  employeeFilters(where, params, filters);
  addCondition(where, params, 'wt.name = ?', filters.wageType);
  if (filters.status) addCondition(where, params, 'sc.status = ?', filters.status);
  if (mode === 'daily-rate-payroll-register' || mode === 'daily-rate-payroll-summary') where.push(`LOWER(wt.name) IN ('daily','per day','daily rate')`);
  if (mode === 'per-hour-payroll-register' || mode === 'per-hour-hours-summary') where.push(`LOWER(wt.name) IN ('hourly','per hour')`);
  if (mode === 'net-pay-report') where.push('sc.net_pay IS NOT NULL');
  if (mode === 'gross-pay-report') where.push('sc.gross_pay IS NOT NULL');

  return safeQuery('salary_calculations', `
    SELECT
      sc.id AS "Payroll ID",
      e.employee_code AS "Employee ID",
      e.first_name,
      e.middle_name,
      e.last_name,
      COALESCE(d.name, '-') AS "Department",
      COALESCE(wt.name, '-') AS "Wage Type",
      COALESCE(sc.payroll_period, DATE_FORMAT(sc.calculation_date, '%Y-%m')) AS "Payroll Period",
      DATE_FORMAT(sc.calculation_date, '%Y-%m-%d') AS "Calculation Date",
      sc.daily_rate AS "Daily Rate",
      sc.hourly_rate AS "Hourly Rate",
      sc.days_worked AS "Days Worked",
      sc.hours_worked AS "Hours Worked",
      sc.quantity AS "Output",
      sc.gross_pay AS "Gross Pay",
      sc.total_allowances AS "Allowances",
      sc.sss_deduction AS "SSS",
      sc.philhealth_deduction AS "PhilHealth",
      sc.pagibig_deduction AS "Pag-IBIG",
      sc.total_deductions AS "Total Deductions",
      sc.net_pay AS "Net Pay",
      sc.status AS "Status"
    FROM salary_calculations sc
    LEFT JOIN employees e ON e.id = sc.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN wage_types wt ON wt.id = sc.wage_type_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY sc.calculation_date DESC, e.last_name
  `, params).then(rows => rows.map(row => applyEmployeeDisplay(row)));
}

async function payslipRecords(filters) {
  const where = [];
  const params = [];
  addCondition(where, params, 'sc.calculation_date >= ?', filters.dateFrom);
  addCondition(where, params, 'sc.calculation_date <= ?', filters.dateTo);
  addCondition(where, params, 'sc.payroll_period = ?', filters.payrollPeriod);
  employeeFilters(where, params, filters);
  // Payslips are released only after payroll is finalized. Draft calculations
  // remain available in Payroll Records, but must not be issued as payslips.
  where.push("sc.status IN ('Finalized', 'Paid', 'Released', 'Locked')");
  where.push("(sc.agency_name IS NULL OR TRIM(sc.agency_name) = '')");
  where.push("(e.agency_name IS NULL OR TRIM(e.agency_name) = '')");
  where.push("(e.hiring_type IS NULL OR LOWER(e.hiring_type) NOT LIKE '%agency%')");

  const rows = await safeQuery('salary_calculations', `
    SELECT
      sc.id,
      sc.employee_id,
      sc.payroll_run_id,
      e.employee_code,
      e.first_name,
      e.middle_name,
      e.last_name,
      e.position,
      DATE_FORMAT(e.date_hired, '%Y-%m-%d') AS date_hired,
      COALESCE(d.name, '-') AS department,
      COALESCE(wt.name, '-') AS wage_type,
      COALESCE(sc.payroll_period, DATE_FORMAT(sc.calculation_date, '%Y-%m')) AS payroll_period,
      DATE_FORMAT(sc.calculation_date, '%Y-%m-%d') AS calculation_date,
      sc.days_worked,
      sc.hours_worked,
      sc.quantity,
      sc.base_rate,
      sc.daily_rate,
      sc.hourly_rate,
      sc.gross_pay,
      sc.total_allowances,
      sc.overtime_amount,
      sc.sss_deduction,
      sc.philhealth_deduction,
      sc.pagibig_deduction,
      sc.employee_deduction_total,
      sc.total_deductions,
      sc.net_pay,
      sc.status,
      u.username AS prepared_by
    FROM salary_calculations sc
    LEFT JOIN employees e ON e.id = sc.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN wage_types wt ON wt.id = sc.wage_type_id
    LEFT JOIN users u ON u.id = sc.calculated_by
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY sc.calculation_date DESC, e.employee_code
    LIMIT 2
  `, params);

  return rows.map(row => {
    const record = {
      ...row,
      employee_name: reportEmployeeName(row)
    };
    delete record.first_name;
    delete record.middle_name;
    delete record.last_name;
    return record;
  });
}

async function productionReport(filters, mode) {
  if (['piece-rate-configuration'].includes(mode)) {
    return safeQuery('payroll_piece_rates', `
      SELECT product_type AS "Product Type", product_category AS "Product Category", sew_type_code AS "Sew Type",
        size_range AS "Size Range", piece_rate AS "Piece Rate", DATE_FORMAT(effective_date, '%Y-%m-%d') AS "Effective Date",
        CASE WHEN is_active = 1 THEN 'Active' ELSE 'Inactive' END AS "Status"
      FROM payroll_piece_rates
      ORDER BY is_active DESC, effective_date DESC, sew_type_code, size_range
    `);
  }

  const where = [];
  const params = [];
  addCondition(where, params, 'pp.production_date >= ?', filters.dateFrom);
  addCondition(where, params, 'pp.production_date <= ?', filters.dateTo);
  addCondition(where, params, 'pp.payroll_period = ?', filters.payrollPeriod);

  const rows = await safeQuery('payroll_production_pairs', `
    SELECT
      DATE_FORMAT(pp.production_date, '%Y-%m-%d') AS "Production Date",
      pp.payroll_period AS "Payroll Period",
      w1.employee_code AS "Worker 1 ID",
      ${employeeNameSql('w1')} AS "Worker 1",
      w2.employee_code AS "Worker 2 ID",
      ${employeeNameSql('w2')} AS "Worker 2",
      pp.pairing_type AS "Pairing Type",
      pp.sew_type_code AS "Sew Type",
      pp.size_range AS "Size Range",
      pp.quantity_produced AS "Quantity",
      pp.piece_rate AS "Piece Rate",
      pp.production_value AS "Production Amount",
      pp.worker1_share AS "Worker 1 Share %",
      pp.worker1_earnings AS "Worker 1 Earnings",
      pp.worker2_share AS "Worker 2 Share %",
      pp.worker2_earnings AS "Worker 2 Earnings"
    FROM payroll_production_pairs pp
    LEFT JOIN employees w1 ON w1.id = pp.worker1_employee_id
    LEFT JOIN employees w2 ON w2.id = pp.worker2_employee_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY pp.production_date DESC
  `, params);

  if (mode === 'sewer-payroll-register' || mode === 'sewer-productivity') {
    return rows.map(row => ({ Employee: row['Worker 1'], Role: 'Sewer', 'Production Amount': row['Production Amount'], 'Share %': row['Worker 1 Share %'], 'Payroll Amount': row['Worker 1 Earnings'] }));
  }
  if (mode === 'fixer-payroll-register' || mode === 'fixer-productivity') {
    return rows.map(row => ({ Employee: row['Worker 2'], Role: row['Pairing Type']?.includes('Substitute') ? 'Substitute Sewer' : 'Fixer', 'Production Amount': row['Production Amount'], 'Share %': row['Worker 2 Share %'], 'Payroll Amount': row['Worker 2 Earnings'] }));
  }
  if (mode === 'swr-fxr-sum' || mode === 'production-payroll') {
    return rows.flatMap(row => ([
      { Employee: row['Worker 1'], Role: 'Sewer', 'Payroll Amount': row['Worker 1 Earnings'] },
      { Employee: row['Worker 2'], Role: row['Pairing Type']?.includes('Substitute') ? 'Substitute Sewer' : 'Fixer', 'Payroll Amount': row['Worker 2 Earnings'] }
    ]));
  }
  return rows;
}

async function logisticsReport(filters, mode) {
  const where = [];
  const params = [];
  addCondition(where, params, 'lt.transaction_date >= ?', filters.dateFrom);
  addCondition(where, params, 'lt.transaction_date <= ?', filters.dateTo);
  addCondition(where, params, 'lt.month_year = ?', filters.payrollPeriod);
  if (mode === 'driver-payroll-register' || mode === 'driver-trip') where.push(`lt.crew_role = 'Driver'`);
  if (mode === 'helper-payroll-register' || mode === 'helper-trip') where.push(`lt.crew_role LIKE 'Helper%'`);

  return safeQuery('logistics_transactions', `
    SELECT
      DATE_FORMAT(lt.transaction_date, '%Y-%m-%d') AS "Trip Date",
      COALESCE(lr.name, '-') AS "Region",
      lt.truck_type AS "Truck Type",
      e.employee_code AS "Employee ID",
      ${employeeNameSql()} AS "Employee",
      lt.crew_role AS "Role",
      lt.crew_status AS "Crew Status",
      lt.base_rate AS "Base Rate",
      lt.missing_helper_share AS "Missing Helper Share",
      lt.gross_pay AS "Gross Pay",
      lt.net_pay AS "Net Pay",
      lt.trip_reference AS "Trip Reference",
      lt.month_year AS "Payroll Period"
    FROM logistics_transactions lt
    LEFT JOIN employees e ON e.id = lt.employee_id
    LEFT JOIN logistics_regions lr ON lr.id = lt.logistics_region_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY lt.transaction_date DESC, lt.truck_type, lt.crew_role
  `, params);
}

async function auditReport(filters, mode) {
  if (mode === 'payroll-audit') {
    return safeQuery('payroll_audit_trail', `
      SELECT pat.id AS "Record ID", u.username AS "User", pat.action AS "Action", pat.remarks AS "Remarks",
        pat.metadata AS "Metadata", DATE_FORMAT(pat.created_at, '%Y-%m-%d %H:%i:%s') AS "Timestamp"
      FROM payroll_audit_trail pat
      LEFT JOIN users u ON u.id = pat.user_id
      ORDER BY pat.created_at DESC
    `);
  }
  return safeQuery('system_audit_log', `
    SELECT sal.id AS "Record ID", u.username AS "User", sal.module AS "Module", sal.action_performed AS "Action",
      sal.old_value AS "Old Value", sal.new_value AS "New Value", sal.ip_address AS "IP Address",
      DATE_FORMAT(sal.timestamp, '%Y-%m-%d %H:%i:%s') AS "Timestamp"
    FROM system_audit_log sal
    LEFT JOIN users u ON u.id = sal.user_id
    ORDER BY sal.timestamp DESC
  `);
}

async function blockchainReport() {
  const rows = await safeQuery('attendance_integrity_chain', `
    SELECT
      chain_id AS "Record ID",
      attendance_id AS "Source Record ID",
      anchor_reference AS "Blockchain Transaction ID",
      anchor_status AS "Verification Status",
      event_type AS "Event Type",
      payload_hash AS "Payload Hash",
      chain_hash AS "Integrity Hash",
      DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS "Timestamp"
    FROM attendance_integrity_chain
    ORDER BY created_at DESC
  `);
  return rows;
}

async function governmentReport(filters, reportId) {
  const rows = await payrollReport(filters, 'payroll-register');
  if (reportId === 'sss-report') return rows.map(row => ({ Employee: row.Employee, 'Payroll Period': row['Payroll Period'], SSS: row.SSS }));
  if (reportId === 'philhealth-report') return rows.map(row => ({ Employee: row.Employee, 'Payroll Period': row['Payroll Period'], PhilHealth: row.PhilHealth }));
  if (reportId === 'pagibig-report') return rows.map(row => ({ Employee: row.Employee, 'Payroll Period': row['Payroll Period'], 'Pag-IBIG': row['Pag-IBIG'] }));
  if (reportId === 'withholding-tax-report') return rows.map(row => ({ Employee: row.Employee, 'Payroll Period': row['Payroll Period'], 'Withholding Tax': 0, Note: 'Income tax is handled separately by accounting.' }));
  return rows.map(row => ({ Employee: row.Employee, 'Payroll Period': row['Payroll Period'], SSS: row.SSS, PhilHealth: row.PhilHealth, 'Pag-IBIG': row['Pag-IBIG'], 'Total Deductions': row['Total Deductions'] }));
}

async function reportRows(report, filters) {
  if (report.category === 'HR Reports' || report.id === 'employee-profile-summary' || report.id === 'employment-certificate') {
    if (report.id === 'department-summary') return departmentSummary();
    if (report.id === 'position-summary') return positionSummary(filters);
    if (report.id === 'employee-status-summary') return employeeStatusSummary();
    return employeeReport(filters, report.id);
  }
  if (report.category === 'Attendance Reports' || report.id === 'attendance-summary-sheet' || report.id === 'attendance-certification') {
    if (report.id === 'biometric-attendance') return biometricReport(filters);
    return attendanceReport(filters, report.id);
  }
  if (report.category === 'Leave Reports' || report.id === 'leave-approval-form') {
    if (report.id === 'leave-balance') return leaveBalanceReport(filters);
    return leaveReport(filters, report.id);
  }
  if (report.category === 'Payroll Reports' || report.id.includes('daily-rate') || report.id.includes('per-hour')) return payrollReport(filters, report.id);
  if (report.category === 'Wage Type Reports') {
    if (report.id.includes('trip') || report.id.includes('driver') || report.id.includes('helper') || report.id.includes('logistics')) return logisticsReport(filters, report.id);
    if (report.id.includes('piece') || report.id.includes('sewer') || report.id.includes('fixer') || report.id === 'swr-fxr-sum') return productionReport(filters, report.id);
    return payrollReport(filters, report.id);
  }
  if (report.category === 'Production Reports') return productionReport(filters, report.id);
  if (report.category === 'Logistics Reports') return logisticsReport(filters, report.id);
  if (report.category === 'Government Reports') return governmentReport(filters, report.id);
  if (report.category === 'Audit Reports') return auditReport(filters, report.id);
  if (report.category === 'Blockchain Verification Reports') return blockchainReport(filters);
  return [];
}

function registryPeriod(filters) {
  const match = String(filters.payrollPeriod || '').match(/^(\d{4}-\d{2})/);
  if (match) return match[1];

  const fromMonth = String(filters.dateFrom || '').match(/^(\d{4}-\d{2})-\d{2}$/)?.[1];
  const toMonth = String(filters.dateTo || '').match(/^(\d{4}-\d{2})-\d{2}$/)?.[1];
  if (fromMonth && toMonth && fromMonth === toMonth) return fromMonth;
  if (fromMonth && !toMonth) return fromMonth;
  if (!fromMonth && toMonth) return toMonth;

  const err = new Error('Select a monthly payroll period before generating a payroll registry.');
  err.status = 400;
  throw err;
}

function registryEmployeeName(row) {
  return [
    decryptReportValue(row.first_name),
    decryptReportValue(row.middle_name),
    decryptReportValue(row.last_name)
  ].filter(Boolean).join(' ') || row.employee_code || '-';
}

function registryEmployeeHeader(row) {
  const first = decryptReportValue(row.first_name);
  const middle = decryptReportValue(row.middle_name);
  const last = decryptReportValue(row.last_name);
  const name = [last, [first, middle].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return name || row.employee_code || '-';
}

function registryDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

async function sewingRegistryData(payrollPeriod, kind) {
  const shareFilter = kind === '55'
    ? 'AND s.share_percentage = 55.00'
    : kind === '45'
      ? 'AND s.share_percentage = 45.00'
      : `AND s.id = (
          SELECT s2.id
            FROM piece_rate_output_shares s2
           WHERE s2.piece_rate_output_id = o.id
           ORDER BY CASE
             WHEN s2.partner_role IN ('Solo', 'Sewer', 'Sewer 1') THEN 0
             WHEN s2.partner_role = 'Fixer' THEN 1
             ELSE 2
           END, s2.id
           LIMIT 1
        )`;
  const [sourceRows] = await pool.execute(`
    SELECT o.output_date, o.operation_type, o.size_range, o.quantity_produced,
           o.rate_per_piece, o.full_amount, s.share_amount, s.partner_role,
           e.employee_code, e.first_name, e.middle_name, e.last_name,
           COALESCE(NULLIF(e.agency_name, ''), 'Direct') AS agency
      FROM piece_rate_outputs o
      JOIN piece_rate_output_shares s ON s.piece_rate_output_id = o.id
      JOIN employees e ON e.id = s.employee_id
     WHERE o.payroll_period_id = ? AND o.status <> 'Voided' ${shareFilter}
     ORDER BY e.last_name, e.first_name, o.operation_type, o.size_range, o.output_date, o.id
  `, [payrollPeriod]);

  const dates = [...new Set(sourceRows
    .map(row => registryDate(row.output_date))
    .filter(Boolean))].sort();
  const grouped = new Map();
  const calculationRowsByEmployee = new Map();
  for (const source of sourceRows) {
    const date = registryDate(source.output_date);
    const role = source.partner_role || 'Solo';
    const operationType = String(source.operation_type || '').trim().toUpperCase() === 'MS'
      ? 'HT'
      : source.operation_type;
    const key = [source.employee_code, role, operationType, source.size_range || '', source.rate_per_piece].join('|');
    const row = grouped.get(key) || {
      employee: registryEmployeeHeader(source),
      employee_code: source.employee_code,
      employee_key: source.employee_code || registryEmployeeHeader(source),
      agency: source.agency,
      operation_type: operationType || '-',
      size_range: source.size_range || '-',
      rate_per_piece: numeric(source.rate_per_piece),
      partner_role: role,
      daily: {},
      total_output: 0,
      amount: 0,
      calculationRows: []
    };
    const quantity = numeric(source.quantity_produced);
    const productionValue = quantity * numeric(source.rate_per_piece);
    const amount = kind === 'main' ? productionValue : numeric(source.share_amount);
    const dayValue = kind === 'main' ? quantity : productionValue;
    row.daily[date] = numeric(row.daily[date]) + dayValue;
    row.total_output += kind === 'main' ? quantity : productionValue;
    row.amount += amount;
    row.calculationRows.push(source);
    grouped.set(key, row);
    const calculationRows = calculationRowsByEmployee.get(source.employee_code) || [];
    calculationRows.push(source);
    calculationRowsByEmployee.set(source.employee_code, calculationRows);
  }

  const rows = [...grouped.values()].map(row => {
    const { calculationRows, ...publicRow } = row;
    return {
      ...publicRow,
      amount: calculatePieceShareTotal(calculationRows.map(calculationRow => ({
        ...calculationRow,
        share_percentage: kind === 'main' ? 100 : calculationRow.share_percentage
      }))),
      total_output: Number(row.total_output.toFixed(2)),
      daily: Object.fromEntries(Object.entries(row.daily).map(([date, quantity]) => [date, Number(quantity.toFixed(2))]))
    };
  });
  const employees = new Map();
  for (const row of rows) {
    const key = row.employee_key;
    const employee = employees.get(key) || {
      employee: row.employee,
      employee_code: row.employee_code,
      agency: row.agency,
      rows: [],
      dailyTotals: {},
      totalOutput: 0,
      totalAmount: 0
    };
    employee.rows.push(row);
    if (kind === 'main') dates.forEach(date => {
      employee.dailyTotals[date] = Number((numeric(employee.dailyTotals[date]) + numeric(row.daily[date])).toFixed(2));
    });
    employee.totalOutput = Number((numeric(employee.totalOutput) + numeric(row.total_output)).toFixed(2));
    employee.totalAmount = Number((numeric(employee.totalAmount) + numeric(row.amount)).toFixed(2));
    employees.set(key, employee);
  }
  const employeeRows = [...employees.values()].map(employee => {
    const calculationRows = calculationRowsByEmployee.get(employee.employee_code) || [];
    const exactAmount = calculatePieceShareTotal(calculationRows.map(calculationRow => ({
      ...calculationRow,
      share_percentage: kind === 'main' ? 100 : calculationRow.share_percentage
    })));
    return {
      ...employee,
      dailyTotals: kind === 'main'
        ? employee.dailyTotals
        : Object.fromEntries(dates.map(date => [
          date,
          calculatePieceShareTotal(calculationRows.filter(row => registryDate(row.output_date) === date))
        ])),
      totalOutput: kind === 'main' ? employee.totalOutput : exactAmount,
      totalAmount: exactAmount
    };
  }).sort((a, b) => a.employee.localeCompare(b.employee));
  const dailyTotals = Object.fromEntries(dates.map(date => [date, kind === 'main'
    ? Number(employeeRows.reduce((sum, employee) => sum + numeric(employee.dailyTotals[date]), 0).toFixed(2))
    : calculatePieceShareTotal(sourceRows.filter(row => registryDate(row.output_date) === date))
  ]));
  const exactTotalAmount = calculatePieceShareTotal(sourceRows.map(row => ({
    ...row,
    share_percentage: kind === 'main' ? 100 : row.share_percentage
  })));
  return {
    payrollPeriod,
    kind,
    dates,
    dailyValueLabel: kind === 'main' ? 'Daily Output' : 'Daily Production Value',
    totalValueLabel: kind === 'main' ? 'Total Output' : 'Total Value',
    earningsLabel: kind === 'main' ? 'Employee Daily Total' : `${kind}% Daily Earnings`,
    rows,
    employees: employeeRows,
    dailyTotals,
    totalOutput: kind === 'main'
      ? Number(employeeRows.reduce((sum, employee) => sum + numeric(employee.totalOutput), 0).toFixed(2))
      : exactTotalAmount,
    totalAmount: exactTotalAmount
  };
}

async function swrFxrRegistryData(payrollPeriod) {
  const [sourceRows] = await pool.execute(`
    SELECT o.output_date,
           sewer.share_amount AS sewer_amount,
           fixer.share_amount AS fixer_amount,
           es.employee_code AS sewer_code, es.first_name AS sewer_first_name,
           es.middle_name AS sewer_middle_name, es.last_name AS sewer_last_name,
           ef.employee_code AS fixer_code, ef.first_name AS fixer_first_name,
           ef.middle_name AS fixer_middle_name, ef.last_name AS fixer_last_name,
           COALESCE(NULLIF(es.agency_name, ''), 'Direct') AS agency
      FROM piece_rate_outputs o
      JOIN piece_rate_output_shares sewer
        ON sewer.piece_rate_output_id = o.id AND sewer.partner_role = 'Sewer'
      JOIN piece_rate_output_shares fixer
        ON fixer.piece_rate_output_id = o.id AND fixer.partner_role = 'Fixer'
      JOIN employees es ON es.id = sewer.employee_id
      JOIN employees ef ON ef.id = fixer.employee_id
     WHERE o.payroll_period_id = ? AND o.output_mode = 'partner'
       AND o.split_rule = 'Standard Sewer-Fixer' AND o.status <> 'Voided'
     ORDER BY agency, es.last_name, es.first_name, ef.last_name, ef.first_name, o.output_date
  `, [payrollPeriod]);

  const grouped = new Map();
  for (const source of sourceRows) {
    const key = [source.sewer_code, source.fixer_code, source.agency].join('|');
    const row = grouped.get(key) || {
      agency: source.agency,
      sewer: registryEmployeeName({
        employee_code: source.sewer_code,
        first_name: source.sewer_first_name,
        middle_name: source.sewer_middle_name,
        last_name: source.sewer_last_name
      }),
      fixer: registryEmployeeName({
        employee_code: source.fixer_code,
        first_name: source.fixer_first_name,
        middle_name: source.fixer_middle_name,
        last_name: source.fixer_last_name
      }),
      workDates: new Set(),
      sewerAmount: 0,
      fixerAmount: 0
    };
    row.workDates.add(registryDate(source.output_date));
    row.sewerAmount += numeric(source.sewer_amount);
    row.fixerAmount += numeric(source.fixer_amount);
    grouped.set(key, row);
  }
  const rows = [...grouped.values()].map(row => ({
    agency: row.agency,
    sewer: row.sewer,
    fixer: row.fixer,
    days: row.workDates.size,
    sewerAmount: Number(row.sewerAmount.toFixed(2)),
    fixerAmount: Number(row.fixerAmount.toFixed(2)),
    total: Number((row.sewerAmount + row.fixerAmount).toFixed(2))
  }));
  return {
    payrollPeriod,
    rows,
    sewerTotal: Number(rows.reduce((sum, row) => sum + row.sewerAmount, 0).toFixed(2)),
    fixerTotal: Number(rows.reduce((sum, row) => sum + row.fixerAmount, 0).toFixed(2)),
    total: Number(rows.reduce((sum, row) => sum + row.total, 0).toFixed(2))
  };
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function normalizeRows(rows) {
  if (!rows.length) return { headers: ['Message'], rows: [{ Message: 'No data available for the selected filters.' }] };
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return { headers, rows };
}

function sendCsv(res, report, rows) {
  const normalized = normalizeRows(rows);
  const content = [
    normalized.headers.map(csvEscape).join(','),
    ...normalized.rows.map(row => normalized.headers.map(header => csvEscape(row[header])).join(','))
  ].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${report.id}.csv"`);
  res.send(content);
}

function sendExcel(res, report, rows) {
  const normalized = normalizeRows(rows);
  const sheet = XLSX.utils.json_to_sheet(normalized.rows, { header: normalized.headers });
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Report');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${report.id}.xlsx"`);
  res.send(buffer);
}

function payslipLineItems(record) {
  const grossPay = numeric(record.gross_pay);
  const allowances = numeric(record.total_allowances);
  const overtime = numeric(record.overtime_amount);
  const basePay = Math.max(0, grossPay - allowances - overtime);
  const otherDeductions = Math.max(0, numeric(record.total_deductions)
    - numeric(record.sss_deduction)
    - numeric(record.philhealth_deduction)
    - numeric(record.pagibig_deduction)
    - numeric(record.employee_deduction_total));

  const wageType = String(record.wage_type || '').toLowerCase();
  const primaryLabel = wageType.includes('piece')
    ? 'Output Pay'
    : wageType.includes('trip')
      ? 'Trip Pay'
      : 'Basic Pay';
  const earnings = [
    [primaryLabel, basePay],
    ['Overtime / Premium', overtime],
    ['Allowances', allowances],
    ['Total Earnings', grossPay]
  ].filter(([label, amount]) => amount > 0 || label === 'Total Earnings');

  const deductions = [
    ['SSS', numeric(record.sss_deduction)],
    ['PhilHealth', numeric(record.philhealth_deduction)],
    ['Pag-IBIG', numeric(record.pagibig_deduction)],
    ['Cash Advance / Loans', numeric(record.employee_deduction_total)],
    ['Other Deductions', otherDeductions],
    ['Total Deductions', numeric(record.total_deductions)]
  ].filter(([label, amount]) => amount > 0 || label === 'Total Deductions');

  return { earnings, deductions };
}

function payslipWorkLabel(record) {
  const wageType = String(record.wage_type || '').toLowerCase();
  if (wageType.includes('piece')) return 'Output Quantity';
  if (wageType.includes('trip')) return 'Trip Count';
  if (numeric(record.hours_worked) > 0) return 'Worked Hours';
  return 'Worked Days';
}

function payslipWorkValue(record) {
  const wageType = String(record.wage_type || '').toLowerCase();
  if (wageType.includes('piece') || wageType.includes('trip')) return numeric(record.quantity);
  if (numeric(record.hours_worked) > 0) return numeric(record.hours_worked);
  return numeric(record.days_worked);
}

function payslipAmountToWords(value) {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const chunk = number => {
    const parts = [];
    const hundreds = Math.floor(number / 100);
    const rest = number % 100;
    if (hundreds) parts.push(`${ones[hundreds]} Hundred`);
    if (rest >= 20) {
      parts.push([tens[Math.floor(rest / 10)], ones[rest % 10]].filter(Boolean).join(' '));
    } else if (rest >= 10) {
      parts.push(teens[rest - 10]);
    } else if (rest > 0) {
      parts.push(ones[rest]);
    }
    return parts.join(' ');
  };
  const integerWords = number => {
    if (number === 0) return 'Zero';
    const scales = ['', 'Thousand', 'Million', 'Billion'];
    const parts = [];
    let remaining = number;
    let scale = 0;
    while (remaining > 0) {
      const current = remaining % 1000;
      if (current) parts.unshift([chunk(current), scales[scale]].filter(Boolean).join(' '));
      remaining = Math.floor(remaining / 1000);
      scale += 1;
    }
    return parts.join(' ');
  };
  const amount = Math.abs(numeric(value));
  const pesos = Math.floor(amount);
  const centavos = Math.round((amount - pesos) * 100);
  return `${integerWords(pesos)} Pesos${centavos ? ` and ${String(centavos).padStart(2, '0')}/100` : ''}`;
}

function drawStandardPayslip(doc, record, req) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const ink = '#000000';
  const border = '#111111';
  const headerFill = '#d9d9d9';
  const generated = new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
  const { earnings, deductions } = payslipLineItems(record);
  const deductionRows = [...deductions, ['Net Pay', numeric(record.net_pay)]];

  const detail = (label, value, x, y, labelWidth, valueWidth) => {
    doc.font('Helvetica').fontSize(11).fillColor(ink).text(label, x, y, { width: labelWidth });
    doc.text(':', x + labelWidth + 4, y, { width: 8 });
    doc.text(String(value ?? '-'), x + labelWidth + 18, y, { width: valueWidth, ellipsis: true });
  };
  const table = (title, rows, y) => {
    const amountWidth = 118;
    const labelWidth = width - amountWidth;
    const headerHeight = 24;
    const rowHeight = 21;
    doc.rect(left, y, labelWidth, headerHeight).fillAndStroke(headerFill, border);
    doc.rect(left + labelWidth, y, amountWidth, headerHeight).fillAndStroke(headerFill, border);
    doc.font('Helvetica-Bold').fontSize(13).fillColor(ink)
      .text(title, left, y + 6, { width: labelWidth, align: 'center' })
      .text('Amount', left + labelWidth, y + 6, { width: amountWidth, align: 'center' });
    y += headerHeight;
    for (const [label, amount] of rows) {
      const isTotal = ['Total Earnings', 'Total Deductions', 'Net Pay'].includes(label);
      doc.rect(left, y, labelWidth, rowHeight).strokeColor(border).lineWidth(0.8).stroke();
      doc.rect(left + labelWidth, y, amountWidth, rowHeight).strokeColor(border).lineWidth(0.8).stroke();
      doc.font(isTotal ? 'Helvetica-Bold' : 'Helvetica').fontSize(10.5).fillColor(ink)
        .text(label, left + 6, y + 5, { width: labelWidth - 12, align: isTotal ? 'right' : 'left', ellipsis: true })
        .text(peso(amount), left + labelWidth + 6, y + 5, { width: amountWidth - 12, align: 'right' });
      y += rowHeight;
    }
    return y;
  };

  let y = 32;
  doc.font('Helvetica-Bold').fontSize(17).fillColor(ink).text('Payslip', left, y, { width, align: 'center' });
  y += 26;
  doc.font('Helvetica').fontSize(13).text('Marulas Industrial Corporation', left, y, { width, align: 'center' });
  y += 20;
  doc.font('Helvetica').fontSize(11).text('LGSV HR Payroll System', left, y, { width, align: 'center' });
  y += 58;

  const half = width / 2;
  const labelWidth = 118;
  detail('Date Hired', record.date_hired || '-', left, y, labelWidth, half - labelWidth - 28);
  detail('Employee Name', record.employee_name, left + half + 14, y, labelWidth, half - labelWidth - 14);
  y += 24;
  detail('Pay Period', record.payroll_period, left, y, labelWidth, half - labelWidth - 28);
  detail('Designation', record.position || '-', left + half + 14, y, labelWidth, half - labelWidth - 14);
  y += 24;
  detail(payslipWorkLabel(record), payslipWorkValue(record), left, y, labelWidth, half - labelWidth - 28);
  detail('Department', record.department || '-', left + half + 14, y, labelWidth, half - labelWidth - 14);
  y += 22;
  detail('Wage Type', record.wage_type || '-', left, y, labelWidth, half - labelWidth - 28);
  detail('Reference No.', `CALC-${String(record.id).padStart(5, '0')}`, left + half + 14, y, labelWidth, half - labelWidth - 14);
  y += 48;

  y = table('Earnings', earnings, y);
  y += 28;
  y = table('Deductions', deductionRows, y);
  if (y > doc.page.height - 245) {
    doc.addPage();
    y = doc.page.margins.top;
  }
  y += 44;

  doc.font('Helvetica').fontSize(12).fillColor(ink).text(peso(record.net_pay), left, y, { width, align: 'center' });
  y += 20;
  doc.font('Helvetica').fontSize(11).text(payslipAmountToWords(record.net_pay), left, y, { width, align: 'center' });

  const signY = Math.max(y + 74, doc.page.height - 155);
  const signatureWidth = 170;
  doc.font('Helvetica').fontSize(11).text('Employer Signature', left + 62, signY - 34, { width: signatureWidth, align: 'center' });
  doc.text('Employee Signature', right - signatureWidth - 62, signY - 34, { width: signatureWidth, align: 'center' });
  doc.moveTo(left + 62, signY + 42).lineTo(left + 62 + signatureWidth, signY + 42).strokeColor(border).lineWidth(0.8).stroke();
  doc.moveTo(right - signatureWidth - 62, signY + 42).lineTo(right - 62, signY + 42).strokeColor(border).lineWidth(0.8).stroke();

  doc.font('Helvetica').fontSize(8).text(`Generated: ${generated} | Prepared by: ${req.user?.username || 'System'}`, left, doc.page.height - 58, { width, align: 'center' });
  doc.font('Helvetica').fontSize(10).text('This is a system generated payslip', left, doc.page.height - 36, { width, align: 'center' });
}

function sendPayslipPdf(res, record, req) {
  const doc = new PDFDocument({ size: 'A4', margin: 54 });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('end', () => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="payslip-${record.id}.pdf"`);
    res.send(Buffer.concat(chunks));
  });

  drawStandardPayslip(doc, record, req);
  doc.end();
}

function registryDateLabel(date) {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString('en-PH', { day: '2-digit', month: 'short', timeZone: 'UTC' });
}

function registryNumber(value) {
  const number = numeric(value);
  const hasDecimals = Math.abs(number - Math.round(number)) > 0.001;
  return number.toLocaleString('en-PH', {
    minimumFractionDigits: hasDecimals ? 2 : 0,
    maximumFractionDigits: 2
  });
}

function sendSewingRegistryPdf(res, registry, req) {
  const title = registry.kind === '55'
    ? '55% Sewing Payroll Registry'
    : registry.kind === '45'
      ? '45% Sewing Payroll Registry'
      : 'Main Sewing Payroll Registry';
  const doc = new PDFDocument({ size: 'A3', layout: 'landscape', margin: 28 });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('end', () => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sewing-payroll-registry-${registry.kind}-${registry.payrollPeriod}.pdf"`);
    res.send(Buffer.concat(chunks));
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const fixedColumns = [92, 58, 76, 92, 100, 86];
  const dateWidth = Math.max(12, Math.floor((width - fixedColumns.reduce((sum, column) => sum + column, 0)) / Math.max(registry.dates.length, 1)));
  const headers = ['Sew Type', 'Size', 'Rate/Piece', ...registry.dates.map(registryDateLabel), registry.totalValueLabel, 'Amount', 'Partner Role'];
  const widths = [92, 58, 76, ...registry.dates.map(() => dateWidth), 92, 100, 86];
  const shareRegistry = registry.kind === '55' || registry.kind === '45';
  const totalFill = shareRegistry ? '#fff36a' : '#f2f2f2';
  let y = 0;

  const heading = () => {
    doc.font('Helvetica-Bold').fontSize(16).fillColor('#000000').text(title, left, 28, { width, align: 'left' });
    doc.font('Helvetica').fontSize(11).fillColor('#000000').text(`PAYROLL PERIOD: ${registry.payrollPeriod}`, left, 56, { width, align: 'left' });
    y = 88;
  };
  const drawCell = (text, x, rowY, columnWidth, height, options = {}) => {
    doc.rect(x, rowY, columnWidth, height)
      .fillAndStroke(options.fill || '#ffffff', options.border || '#222222');
    doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(options.fontSize || 6.8)
      .fillColor('#000000')
      .text(String(text ?? ''), x + 3, rowY + (options.subtext ? 4 : 6), {
        width: columnWidth - 6,
        height: height - 5,
        align: options.align || 'left',
        ellipsis: true
      });
    if (options.subtext) {
      doc.font('Helvetica').fontSize(5.6).fillColor('#000000')
        .text(options.subtext, x + 3, rowY + 12, {
          width: columnWidth - 6,
          height: height - 13,
          align: options.align || 'left',
          ellipsis: true
        });
    }
  };
  const ensureSpace = height => {
    if (y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      heading();
      drawHeader();
    }
  };
  const drawHeader = () => {
    const height = 24;
    ensureSpace(height);
    let x = left;
    headers.forEach((header, index) => {
      const isDate = index >= 3 && index < 3 + registry.dates.length;
      drawCell(header, x, y, widths[index], height, {
        bold: true,
        fill: '#ffffff',
        fontSize: 5.8,
        align: index >= 2 ? 'right' : 'left',
        subtext: isDate ? registry.dailyValueLabel : ''
      });
      x += widths[index];
    });
    y += height;
  };
  const drawRow = (cells, options = {}) => {
    const height = options.height || 18;
    ensureSpace(height);
    let x = left;
    cells.forEach((cell, index) => {
      drawCell(cell, x, y, widths[index], height, {
        fill: options.fill || '#ffffff',
        border: options.border || '#222222',
        bold: options.bold || false,
        fontSize: options.fontSize || 6.8,
        align: index >= 2 ? 'right' : 'left'
      });
      x += widths[index];
    });
    y += height;
  };
  const drawGroupRow = (label, options = {}) => {
    const height = options.height || 18;
    ensureSpace(height);
    drawCell(label, left, y, widths.reduce((sum, columnWidth) => sum + columnWidth, 0), height, {
      fill: options.fill || '#f2f2f2',
      bold: true,
      fontSize: options.fontSize || 6.8
    });
    y += height;
  };

  heading();
  drawHeader();
  const employees = Array.isArray(registry.employees) ? registry.employees : [];
  if (!employees.length) {
    drawGroupRow('No sewing output was encoded for this payroll period.');
  } else {
    employees.forEach(employee => {
      drawGroupRow(`${employee.employee} - ${employee.agency || 'Direct'}`);
      employee.rows.forEach(item => drawRow([
        item.operation_type,
        item.size_range,
        peso(item.rate_per_piece),
        ...registry.dates.map(date => registryNumber(item.daily?.[date] || 0)),
        registryNumber(item.total_output),
        peso(item.amount),
        item.partner_role
      ]));
      drawRow([
        registry.earningsLabel,
        '',
        '',
        ...registry.dates.map(date => registryNumber(employee.dailyTotals?.[date] || 0)),
        registryNumber(employee.totalOutput),
        peso(employee.totalAmount),
        ''
      ], { fill: totalFill, bold: true });
    });
  }
  drawRow([
    shareRegistry ? `Grand ${registry.kind}% Earnings` : 'Grand Daily Total',
    '',
    '',
    ...registry.dates.map(date => registryNumber(registry.dailyTotals?.[date] || 0)),
    registryNumber(registry.totalOutput),
    peso(registry.totalAmount),
    ''
  ], { fill: totalFill, bold: true });
  doc.end();
}

function sendSwrFxrRegistryPdf(res, registry, req) {
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 32 });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('end', () => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="swr-fxr-sum-${registry.payrollPeriod}.pdf"`);
    res.send(Buffer.concat(chunks));
  });
  const left = doc.page.margins.left;
  const width = doc.page.width - left - doc.page.margins.right;
  const headers = ['#', 'Agency', 'No. of Days', 'Sewer (55%)', 'Sewer Amount', 'Fixer (45%)', 'Fixer Amount', 'Total', 'Partner Information'];
  const widths = [24, 68, 50, 105, 72, 105, 72, 72, 92];
  let y = 0;
  const heading = () => {
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#111827').text('MARULAS INDUSTRIAL CORPORATION', left, 34, { width, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(11).text('SWR-FXR-SUM PAYROLL REGISTRY', left, 51, { width, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#475467').text(`PAYROLL PERIOD: ${registry.payrollPeriod}`, left, 66, { width, align: 'center' });
    doc.text(`Generated by: ${req.user?.username || 'System'}  |  ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`, left, 78, { width, align: 'center' });
    y = 101;
  };
  const row = (cells, header = false) => {
    const height = header ? 24 : 23;
    if (y + height > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      heading();
    }
    let x = left;
    cells.forEach((cell, index) => {
      doc.rect(x, y, widths[index], height).fillAndStroke(header ? '#eef2f6' : '#ffffff', '#98a2b3');
      doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(header ? 6.5 : 6.6).fillColor('#101828')
        .text(String(cell ?? '-'), x + 3, y + 7, { width: widths[index] - 6, height: height - 9, align: [0, 2, 4, 6, 7].includes(index) ? 'right' : 'left', ellipsis: true });
      x += widths[index];
    });
    y += height;
  };
  heading();
  row(headers, true);
  if (!registry.rows.length) {
    row(['No Sewer/Fixer production pairs were encoded for this payroll period.', ...Array(headers.length - 1).fill('')]);
  } else {
    registry.rows.forEach((item, index) => row([
      index + 1, item.agency, item.days, item.sewer, peso(item.sewerAmount), item.fixer,
      peso(item.fixerAmount), peso(item.total), 'Sewer + Fixer (55% / 45%)'
    ]));
  }
  row(['TOTAL', '', '', '', peso(registry.sewerTotal), '', peso(registry.fixerTotal), peso(registry.total), ''], true);
  doc.end();
}

function sendDtrPdf(res, record, req) {
  const doc = new PDFDocument({ size: [612, 936], margin: 36 });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('end', () => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Disposition', `attachment; filename="attendance-dtr-${record.employee.employee_code || record.employee.id}-${record.start}.pdf"`);
    res.send(Buffer.concat(chunks));
  });

  const formWidth = 360;
  const left = (doc.page.width - formWidth) / 2;
  const width = formWidth;
  const right = left + width;
  let y = 34;
  const center = (text, size = 8, bold = false) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(size)
      .fillColor('#000000')
      .text(text, left, y, { width, align: 'center' });
    y += size + 4;
  };
  const textLine = (label, value, rowY) => {
    doc.font('Helvetica').fontSize(8).fillColor('#000000').text(`${label}:`, left, rowY, { width: 72 });
    doc.text(String(value || ''), left + 74, rowY, { width: width - 74 });
    doc.moveTo(left + 74, rowY + 9).lineTo(right, rowY + 9).strokeColor('#000000').lineWidth(0.4).stroke();
  };

  center('REPUBLIC OF THE PHILIPPINES', 7, true);
  center('Marulas Industrial Corporation', 8, true);
  y += 12;
  textLine('Name', record.employeeName, y);
  y += 14;
  textLine('Department', record.department, y);
  y += 14;
  textLine(record.start === record.end ? 'For the Date of' : 'For the Period of', dtrDateLabel(record.start, record.end), y);
  y += 20;

  const col = [60, 150, 150];
  const tableLeft = left;
  const rowH = 15;
  const drawCell = (text, x, rowY, w, h, options = {}) => {
    doc.rect(x, rowY, w, h).strokeColor('#000000').lineWidth(0.5).stroke();
    doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(options.size || 7).fillColor('#000000')
      .text(String(text || ''), x + 2, rowY + (options.offsetY || 3.5), {
        width: w - 4,
        height: h - 2,
        align: options.align || 'center'
      });
  };

  let x = tableLeft;
  ['DAY', 'TIME IN', 'TIME OUT'].forEach((label, index) => {
    drawCell(label, x, y, col[index], rowH, { bold: true });
    x += col[index];
  });
  y += rowH;

  const dates = dtrFormDates(record);
  const sameMonth = dates.every(date => String(date || '').slice(0, 7) === String(dates[0] || '').slice(0, 7));
  dates.forEach(date => {
    const row = record.attendanceByDate.get(date) || {};
    const parsed = new Date(`${date}T00:00:00Z`);
    const day = sameMonth
      ? parsed.getUTCDate()
      : parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    const timeIn = dtrTime(row.time_in);
    const timeOut = dtrTime(row.time_out);
    let cx = tableLeft;
    [day, timeIn, timeOut].forEach((value, index) => {
      drawCell(value, cx, y, col[index], rowH, { size: index === 0 && !sameMonth ? 6 : 7 });
      cx += col[index];
    });
    y += rowH;
  });
  y += 18;
  doc.font('Helvetica').fontSize(8).fillColor('#000000')
    .text('I certify on my honor that the above is true', left, y, { width, align: 'center' });
  y += 11;
  doc.text('and correct report of the hours of work performed.', left, y, { width, align: 'center' });
  y += 46;
  doc.moveTo(left + 72, y).lineTo(right - 72, y).strokeColor('#000000').lineWidth(0.5).stroke();
  y += 5;
  doc.font('Helvetica').fontSize(8).text('Employee Signature', left, y, { width, align: 'center' });
  y += 32;
  doc.moveTo(left + 72, y).lineTo(right - 72, y).stroke();
  y += 5;
  doc.font('Helvetica-Bold').fontSize(8).text(req.user?.username || 'Prepared By', left, y, { width, align: 'center' });
  y += 11;
  doc.font('Helvetica').fontSize(7).text('Prepared / Verified By', left, y, { width, align: 'center' });
  doc.end();
}

function sendPdf(res, report, rows, req) {
  const normalized = normalizeRows(rows);
  const doc = new PDFDocument({ size: 'A4', margin: 36, layout: 'landscape' });
  const chunks = [];
  doc.on('data', chunk => chunks.push(chunk));
  doc.on('end', () => {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${report.id}.pdf"`);
    res.send(Buffer.concat(chunks));
  });

  doc.fontSize(16).text(report.name, { continued: false });
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor('#555').text(`Generated: ${new Date().toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}`);
  doc.text(`Generated by: ${req.user?.username || 'System'}`);
  doc.moveDown(1).fillColor('#111');

  const headers = normalized.headers.slice(0, 8);
  const columnWidth = Math.floor((doc.page.width - doc.page.margins.left - doc.page.margins.right) / headers.length);

  function drawRow(row, isHeader = false) {
    const y = doc.y;
    headers.forEach((header, index) => {
      const x = doc.page.margins.left + index * columnWidth;
      const value = isHeader ? header : row[header];
      doc.fontSize(isHeader ? 7 : 6)
        .fillColor(isHeader ? '#ef3333' : '#111')
        .text(String(value ?? '-'), x, y, { width: columnWidth - 4, height: 32 });
    });
    doc.y = y + (isHeader ? 24 : 30);
    doc.moveTo(doc.page.margins.left, doc.y - 4).lineTo(doc.page.width - doc.page.margins.right, doc.y - 4).strokeColor('#ddd').stroke();
    if (doc.y > doc.page.height - doc.page.margins.bottom - 36) doc.addPage();
  }

  drawRow({}, true);
  normalized.rows.slice(0, 250).forEach(row => drawRow(row));
  if (normalized.rows.length > 250) {
    doc.moveDown().fontSize(8).fillColor('#555').text(`Showing first 250 of ${normalized.rows.length} rows. Use Excel or CSV for full data.`);
  }
  doc.end();
}

async function logReportExport(req, report, format, rowCount) {
  try {
    await pool.execute(`
      INSERT INTO system_audit_log
        (user_id, action_performed, module, new_value, ip_address, user_agent)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      req.user?.id || req.user?.userId || null,
      'REPORT_EXPORTED',
      'Reports',
      JSON.stringify({ report_id: report.id, report_name: report.name, format, row_count: rowCount }),
      req.ip,
      req.headers['user-agent'] || null
    ]);
  } catch (err) {
    console.warn('Report audit log skipped:', err.message);
  }
}

async function safeLookupQuery(tableName, query, params = []) {
  if (!(await tableExists(tableName))) return [];
  try {
    const [rows] = await pool.execute(query, params);
    return rows;
  } catch (err) {
    console.warn(`Report lookup skipped for ${tableName}:`, err.message);
    return [];
  }
}

function reportLookupEmployeeName(row) {
  const first = decryptReportValue(row.first_name) || row.first_name;
  const middle = decryptReportValue(row.middle_name) || row.middle_name;
  const last = decryptReportValue(row.last_name) || row.last_name;
  return [first, middle, last].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    || row.employee_code
    || `Employee #${row.id}`;
}

async function reportEmployeeLookupRows() {
  const rows = await safeLookupQuery('employees', `
    SELECT e.id, e.employee_code, e.first_name, e.middle_name, e.last_name,
           COALESCE(d.name, '') AS department
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
     WHERE COALESCE(e.status, 'Active') NOT IN ('Deleted', 'Archived')
     ORDER BY e.employee_code, e.last_name, e.first_name
     LIMIT 1000
  `);
  return rows.map(row => ({
    id: row.id,
    employee_code: row.employee_code,
    employee_name: reportLookupEmployeeName(row),
    department: row.department || ''
  }));
}

async function reportDepartmentLookupRows() {
  const rows = await safeLookupQuery('departments', `
    SELECT id, name
      FROM departments
     WHERE COALESCE(name, '') <> ''
     ORDER BY name
     LIMIT 500
  `);
  return rows.map(row => ({ id: row.id, name: row.name }));
}

async function reportPayrollPeriodLookupRows() {
  const periods = new Map();
  const addPeriod = row => {
    const value = row.month_year || row.payroll_period;
    if (!/^\d{4}-\d{2}(?:-W[1-5])?$/.test(String(value || ''))) return;
    if (!periods.has(value)) {
      periods.set(value, {
        id: row.id || value,
        month_year: value,
        payroll_period: value,
        period_label: row.period_label || row.payroll_period_label || value,
        start_date: row.start_date || null,
        end_date: row.end_date || null,
        source: row.source || null
      });
    }
  };

  (await safeLookupQuery('payroll_runs', `
    SELECT id, month_year, period_label,
           DATE_FORMAT(start_date, '%Y-%m-%d') AS start_date,
           DATE_FORMAT(end_date, '%Y-%m-%d') AS end_date,
           'payroll_runs' AS source
      FROM payroll_runs
     WHERE month_year REGEXP '^[0-9]{4}-[0-9]{2}(-W[1-5])?$'
     ORDER BY month_year DESC
     LIMIT 100
  `)).forEach(addPeriod);

  (await safeLookupQuery('salary_calculations', `
    SELECT NULL AS id, payroll_period AS month_year,
           NULL AS period_label,
           DATE_FORMAT(MIN(calculation_date), '%Y-%m-%d') AS start_date,
           DATE_FORMAT(MAX(calculation_date), '%Y-%m-%d') AS end_date,
           'salary_calculations' AS source
      FROM salary_calculations
     WHERE payroll_period REGEXP '^[0-9]{4}-[0-9]{2}(-W[1-5])?$'
     GROUP BY payroll_period
     ORDER BY payroll_period DESC
     LIMIT 100
  `)).forEach(addPeriod);

  (await safeLookupQuery('payroll_production_pairs', `
    SELECT NULL AS id, payroll_period AS month_year,
           NULL AS period_label,
           DATE_FORMAT(MIN(production_date), '%Y-%m-%d') AS start_date,
           DATE_FORMAT(MAX(production_date), '%Y-%m-%d') AS end_date,
           'payroll_production_pairs' AS source
      FROM payroll_production_pairs
     WHERE payroll_period REGEXP '^[0-9]{4}-[0-9]{2}(-W[1-5])?$'
     GROUP BY payroll_period
     ORDER BY payroll_period DESC
     LIMIT 100
  `)).forEach(addPeriod);

  return [...periods.values()].sort((a, b) => String(b.month_year).localeCompare(String(a.month_year)));
}

router.get('/library', requireAuth, requireRole(REPORT_ACCESS_ROLES), (req, res) => {
  res.json({ reports: REPORTS.filter(report => userCanAccessReport(req, report.id)) });
});

router.get('/filters', requireAuth, requireRole(REPORT_ACCESS_ROLES), async (_req, res) => {
  try {
    const [employees, departments, payrollPeriods] = await Promise.all([
      reportEmployeeLookupRows(),
      reportDepartmentLookupRows(),
      reportPayrollPeriodLookupRows()
    ]);
    res.json({
      employees,
      departments,
      payroll_periods: payrollPeriods
    });
  } catch (err) {
    console.error('Error loading report filters:', err);
    res.status(500).json({ error: 'Failed to load report filters.' });
  }
});

router.get('/:reportId.:format', requireAuth, requireRole(REPORT_ACCESS_ROLES), async (req, res) => {
  try {
    const report = REPORT_BY_ID.get(req.params.reportId);
    const format = String(req.params.format || '').toLowerCase();
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    if (!userCanAccessReport(req, report.id)) return res.status(403).json({ error: 'Access denied.' });
    if (!report.formats.includes(format)) return res.status(400).json({ error: 'Export format is not available for this report.' });

    const filters = filtersFromRequest(req.query);
    if (report.id === 'daily-attendance' && format === 'pdf') {
      if (!/^\d+$/.test(String(filters.employeeId || ''))) {
        return res.status(400).json({ error: 'Select one employee before generating an attendance DTR.' });
      }
      const record = await dtrRecord(filters);
      await logReportExport(req, report, format, record.dates.length);
      return sendDtrPdf(res, record, req);
    }
    if (report.id === 'payroll-register' && format === 'pdf') {
      const kind = ['main', '55', '45', 'swr-fxr-sum'].includes(filters.registryType)
        ? filters.registryType
        : 'main';
      const payrollPeriod = registryPeriod(filters);
      if (kind === 'swr-fxr-sum') {
        const registry = await swrFxrRegistryData(payrollPeriod);
        await logReportExport(req, report, format, registry.rows.length);
        return sendSwrFxrRegistryPdf(res, registry, req);
      }
      const registry = await sewingRegistryData(payrollPeriod, kind);
      await logReportExport(req, report, format, registry.rows.length);
      return sendSewingRegistryPdf(res, registry, req);
    }
    if (report.id === 'employee-payslip') {
      if (!/^\d+$/.test(String(filters.employeeId || ''))) {
        return res.status(400).json({ error: 'Select one employee before generating a payslip.' });
      }
      if (!filters.payrollPeriod) {
        return res.status(400).json({ error: 'Select a payroll period before generating a payslip.' });
      }

      const records = await payslipRecords(filters);
      if (!records.length) {
        return res.status(404).json({ error: 'No finalized payslip was found for the selected employee and payroll period.' });
      }
      if (records.length > 1) {
        return res.status(409).json({ error: 'More than one payroll record matched. Select the exact payroll period for one payslip.' });
      }
      await logReportExport(req, report, format, records.length);
      return sendPayslipPdf(res, records[0], req);
    }

    const rows = await reportRows(report, filters);
    await logReportExport(req, report, format, rows.length);

    if (format === 'csv') return sendCsv(res, report, rows);
    if (format === 'excel') return sendExcel(res, report, rows);
    return sendPdf(res, report, rows, req);
  } catch (err) {
    console.error('Report generation failed:', err);
    if (err.status === 400) return res.status(400).json({ error: err.message || 'Invalid report filters.' });
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

module.exports = router;
