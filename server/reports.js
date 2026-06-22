/* ============================================================
   server/reports.js — ERP Report Library and Export Service
   ============================================================ */

const express = require('express');
const PDFDocument = require('pdfkit');
const XLSX = require('xlsx');
const pool = require('../config/db');
const { requireAuth, requireRole } = require('./middleware');

const router = express.Router();

const REPORT_ROLES = [
  'system_admin',
  'admin',
  'hr_admin',
  'hr_manager',
  'payroll_officer',
  'payroll_manager',
  'manager'
];

const BASE_FORMATS = ['csv', 'excel', 'pdf'];
const EXCEL_ONLY = ['excel'];

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
].map(([id, name, category, description, formats]) => ({ id, name, category, description, formats }));

const REPORT_BY_ID = new Map(REPORTS.map(report => [report.id, report]));

function cleanFilter(value) {
  const text = String(value || '').trim();
  return !text || text === 'all' || text === 'latest' ? null : text;
}

function sqlDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? value : null;
}

function addCondition(where, params, sql, value) {
  if (value !== null && value !== undefined && value !== '') {
    where.push(sql);
    params.push(value);
  }
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
      ${employeeNameSql()} AS "Employee",
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
  `, params);
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
  if (mode === 'pending-leave') addCondition(where, params, 'lr.status = ?', 'Pending');
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
      ${employeeNameSql()} AS "Employee",
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
  `, params);
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

router.get('/library', requireAuth, requireRole(REPORT_ROLES), (_req, res) => {
  res.json({ reports: REPORTS });
});

router.get('/:reportId.:format', requireAuth, requireRole(REPORT_ROLES), async (req, res) => {
  try {
    const report = REPORT_BY_ID.get(req.params.reportId);
    const format = String(req.params.format || '').toLowerCase();
    if (!report) return res.status(404).json({ error: 'Report not found.' });
    if (!report.formats.includes(format)) return res.status(400).json({ error: 'Export format is not available for this report.' });

    const filters = filtersFromRequest(req.query);
    const rows = await reportRows(report, filters);
    await logReportExport(req, report, format, rows.length);

    if (format === 'csv') return sendCsv(res, report, rows);
    if (format === 'excel') return sendExcel(res, report, rows);
    return sendPdf(res, report, rows, req);
  } catch (err) {
    console.error('Report generation failed:', err);
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

module.exports = router;
