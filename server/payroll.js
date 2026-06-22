/* ============================================================
   server/payroll.js — Payroll endpoints (wages, rates, transactions)
   ============================================================ */

const express = require('express');
const PDFDocument = require('pdfkit');
const router = express.Router();
const { requireAuth, requireRole, ROLES } = require('./middleware');
const { getActiveAttendancePolicy } = require('./attendance-policy-engine');
const { computeLateUndertimeDeductions } = require('./payroll-attendance-deductions');
const { selectCurrentStatutoryDeductions } = require('./services/statutoryDeductionSelection');
const { computePayrollHash } = require('./utils/payrollHash');
const {
  isTripBasedWageType,
  normalizeTripType,
  normalizeTripRole,
  computeTripPay,
  findActiveLogisticsRate,
} = require('./services/logisticsTripPayroll');
const {
  COMPUTED_PAYROLL_FIELDS,
  auditSecurityEvent,
  rejectForbiddenFields,
} = require('./security-controls');

const PAYROLL_PERMISSIONS = {
  view: ['payroll_officer', 'payroll_manager', 'hr_manager', 'hr_admin', 'admin', 'system_admin'],
  calculate: ROLES.payroll_any,
  approve: ['payroll_manager'],
  release: ['payroll_manager'],
  settings: ['payroll_officer', 'payroll_manager', 'hr_manager', 'hr_admin', 'admin'],
  reports: ['payroll_officer', 'payroll_manager', 'hr_manager', 'hr_admin', 'admin']
};

const LOGISTICS_TRIP_PERMISSIONS = {
  view: PAYROLL_PERMISSIONS.view,
  encode: ROLES.payroll_any,
  approve: [...ROLES.payroll_manager, ...ROLES.hr_final_approval],
  configure: [...ROLES.payroll_manager, ...ROLES.hr_final_approval, ...ROLES.admin_any],
};

const PAYROLL_COMPUTED_FIELD_GUARD = rejectForbiddenFields(COMPUTED_PAYROLL_FIELDS, {
  action: 'blocked_payroll_parameter_tampering_attempt',
  module: 'PAYROLL_SECURITY',
  targetTable: 'salary_calculations',
});

const PAYROLL_SETTINGS_TAMPER_FIELDS = new Set([
  'gross_pay',
  'net_pay',
  'base_pay',
  'total_deductions',
  'sss_deduction',
  'philhealth_deduction',
  'pagibig_deduction',
  'payroll_status',
  'role',
  'access_level',
  'employee_id_override',
]);

const PAYROLL_SETTINGS_GUARD = rejectForbiddenFields(PAYROLL_SETTINGS_TAMPER_FIELDS, {
  action: 'blocked_payroll_settings_parameter_tampering_attempt',
  module: 'PAYROLL_SECURITY',
});

function currentUserId(req) {
  return req.user?.id || req.user?.userId || req.user?.sub || null;
}

function currentRequestIp(req) {
  return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || null;
}

function safePayrollError(err, fallback) {
  const message = String(err?.message || '').trim();
  const code = String(err?.code || '');
  if (
    err?.sqlMessage ||
    err?.sqlState ||
    code.startsWith('ER_') ||
    /\b(sql|mysql|database|table|column|constraint|syntax|foreign key|select|insert|update|delete)\b/i.test(message)
  ) {
    return fallback;
  }
  return message || fallback;
}

async function logPayrollAudit(pool, req, action, options = {}) {
  try {
    await pool.execute(`
      INSERT INTO payroll_audit_trail
        (user_id, employee_id, payroll_run_id, salary_calculation_id, action, remarks, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      currentUserId(req),
      options.employee_id || null,
      options.payroll_run_id || null,
      options.salary_calculation_id || null,
      action,
      options.remarks || null,
      options.metadata ? JSON.stringify(options.metadata) : null
    ]);
  } catch (err) {
    console.warn('Payroll audit logging skipped:', err.message);
  }
}

async function getPayrollIntegritySource(executor, salaryCalculationId) {
  const [rows] = await executor.execute(
    `SELECT id, employee_id, gross_pay, sss_deduction, pagibig_deduction,
            philhealth_deduction, total_allowances, net_pay, status,
            approved_by, approved_at
       FROM salary_calculations
      WHERE id = ?
      LIMIT 1`,
    [salaryCalculationId]
  );
  return rows[0] || null;
}

function buildIntegritySnapshot(record, approvalStatus, finalizedAt = null, approvedBy = null) {
  return {
    Payroll_ID: record.id,
    Employee_ID: record.employee_id,
    Gross_Pay: record.gross_pay || 0,
    Total_Statutory_Deductions:
      Number(record.sss_deduction || 0)
      + Number(record.pagibig_deduction || 0)
      + Number(record.philhealth_deduction || 0),
    Net_Pay: record.net_pay || 0,
    Non_Taxable_Allowance: record.total_allowances || 0,
    Approval_Status: approvalStatus,
    Finalized_At: finalizedAt,
    Approved_By: approvedBy,
  };
}

async function writePayrollBlockchainAudit(executor, req, payrollId, eventType, status, payloadHash, details) {
  await executor.execute(
    `INSERT INTO BLOCKCHAIN_AUDIT_LOG
       (Payroll_ID, Event_Type, Actor_User_ID, Actor_Role, Payload_Hash,
        Status, IP_Address, Details, Created_At)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      payrollId,
      eventType,
      currentUserId(req),
      req.user?.role || null,
      payloadHash,
      status,
      currentRequestIp(req),
      JSON.stringify(details),
    ]
  );
}

async function queueSubmittedPayrollRecord(executor, req, salaryCalculationId) {
  const record = await getPayrollIntegritySource(executor, salaryCalculationId);
  if (!record || record.status !== 'Submitted') return null;

  const snapshot = buildIntegritySnapshot(record, 'Submitted');
  const payloadHash = computePayrollHash(snapshot);

  await executor.execute(
    `INSERT INTO PAYROLL_RECORD
       (Payroll_ID, Employee_ID, Gross_Pay, Total_Statutory_Deductions,
        Net_Pay, Non_Taxable_Allowance, Approval_Status, Blockchain_Status,
        Finalized_At, Approved_By)
     VALUES (?, ?, ?, ?, ?, ?, 'Submitted', 'PENDING_APPROVAL', NULL, NULL)
     ON DUPLICATE KEY UPDATE
       Employee_ID = CASE WHEN Blockchain_Status = 'RECORDED' THEN Employee_ID ELSE VALUES(Employee_ID) END,
       Gross_Pay = CASE WHEN Blockchain_Status = 'RECORDED' THEN Gross_Pay ELSE VALUES(Gross_Pay) END,
       Total_Statutory_Deductions = CASE WHEN Blockchain_Status = 'RECORDED' THEN Total_Statutory_Deductions ELSE VALUES(Total_Statutory_Deductions) END,
       Net_Pay = CASE WHEN Blockchain_Status = 'RECORDED' THEN Net_Pay ELSE VALUES(Net_Pay) END,
       Non_Taxable_Allowance = CASE WHEN Blockchain_Status = 'RECORDED' THEN Non_Taxable_Allowance ELSE VALUES(Non_Taxable_Allowance) END,
       Approval_Status = CASE WHEN Blockchain_Status = 'RECORDED' THEN Approval_Status ELSE 'Submitted' END,
       Blockchain_Status = CASE WHEN Blockchain_Status = 'RECORDED' THEN Blockchain_Status ELSE 'PENDING_APPROVAL' END,
       Finalized_At = CASE WHEN Blockchain_Status = 'RECORDED' THEN Finalized_At ELSE NULL END,
       Approved_By = CASE WHEN Blockchain_Status = 'RECORDED' THEN Approved_By ELSE NULL END,
       updated_at = NOW()`,
    [
      snapshot.Payroll_ID,
      snapshot.Employee_ID,
      snapshot.Gross_Pay,
      snapshot.Total_Statutory_Deductions,
      snapshot.Net_Pay,
      snapshot.Non_Taxable_Allowance,
    ]
  );

  await writePayrollBlockchainAudit(executor, req, snapshot.Payroll_ID, 'PAYROLL_SUBMITTED_QUEUE', 'PENDING_APPROVAL', payloadHash, {
    source: 'salary_calculations',
    approval_status: 'Submitted',
    message: 'Payroll calculation is queued locally and awaits Payroll Manager approval before Fabric anchoring.',
  });

  return {
    payroll_id: snapshot.Payroll_ID,
    employee_id: snapshot.Employee_ID,
    blockchain_status: 'PENDING_APPROVAL',
    payload_hash: payloadHash,
  };
}

async function syncFinalizedPayrollRecord(executor, req, salaryCalculationId) {
  const record = await getPayrollIntegritySource(executor, salaryCalculationId);
  if (!record || !['Approved', 'Released', 'Paid'].includes(record.status)) return null;

  const finalizedAt = record.approved_at || new Date();
  const finalApprover = record.approved_by || currentUserId(req) || null;
  const snapshot = buildIntegritySnapshot(record, 'Finalized', finalizedAt, finalApprover);
  const payloadHash = computePayrollHash(snapshot);

  // PAYROLL_RECORD is the off-chain integrity snapshot used by the Fabric
  // audit layer. Once a hash has been recorded, do not overwrite integrity
  // fields through ordinary payroll status updates.
  await executor.execute(
    `INSERT INTO PAYROLL_RECORD
       (Payroll_ID, Employee_ID, Gross_Pay, Total_Statutory_Deductions,
        Net_Pay, Non_Taxable_Allowance, Approval_Status, Blockchain_Status,
        Finalized_At, Approved_By)
     VALUES (?, ?, ?, ?, ?, ?, 'Finalized', 'PENDING', ?, ?)
     ON DUPLICATE KEY UPDATE
       Employee_ID = CASE WHEN Blockchain_Status = 'RECORDED' THEN Employee_ID ELSE VALUES(Employee_ID) END,
       Gross_Pay = CASE WHEN Blockchain_Status = 'RECORDED' THEN Gross_Pay ELSE VALUES(Gross_Pay) END,
       Total_Statutory_Deductions = CASE WHEN Blockchain_Status = 'RECORDED' THEN Total_Statutory_Deductions ELSE VALUES(Total_Statutory_Deductions) END,
       Net_Pay = CASE WHEN Blockchain_Status = 'RECORDED' THEN Net_Pay ELSE VALUES(Net_Pay) END,
       Non_Taxable_Allowance = CASE WHEN Blockchain_Status = 'RECORDED' THEN Non_Taxable_Allowance ELSE VALUES(Non_Taxable_Allowance) END,
       Approval_Status = CASE WHEN Blockchain_Status = 'RECORDED' THEN Approval_Status ELSE 'Finalized' END,
       Blockchain_Status = CASE WHEN Blockchain_Status = 'RECORDED' THEN Blockchain_Status ELSE 'PENDING' END,
       Finalized_At = CASE WHEN Blockchain_Status = 'RECORDED' THEN Finalized_At ELSE VALUES(Finalized_At) END,
       Approved_By = CASE WHEN Blockchain_Status = 'RECORDED' THEN Approved_By ELSE VALUES(Approved_By) END,
       updated_at = NOW()`,
    [
      snapshot.Payroll_ID,
      snapshot.Employee_ID,
      snapshot.Gross_Pay,
      snapshot.Total_Statutory_Deductions,
      snapshot.Net_Pay,
      snapshot.Non_Taxable_Allowance,
      finalizedAt,
      finalApprover,
    ]
  );

  await writePayrollBlockchainAudit(executor, req, snapshot.Payroll_ID, 'PAYROLL_APPROVED_READY_FOR_ANCHOR', 'PENDING', payloadHash, {
    source: 'salary_calculations',
    approval_status: 'Finalized',
    message: 'Payroll calculation was approved and is ready for Hyperledger Fabric anchoring.',
  });

  return {
    payroll_id: snapshot.Payroll_ID,
    employee_id: snapshot.Employee_ID,
    blockchain_status: 'PENDING',
    payload_hash: payloadHash,
  };
}

function payrollWeekFromDate(dateValue) {
  const date = dateValue ? new Date(dateValue) : new Date();
  return Math.min(5, Math.max(1, Math.ceil(date.getDate() / 7)));
}

function settingAppliesThisWeek(setting, weekNumber) {
  return setting.apply_schedule === 'Every Payroll' || setting.apply_schedule === `${weekNumber}${weekNumber === 1 ? 'st' : weekNumber === 2 ? 'nd' : weekNumber === 3 ? 'rd' : 'th'} Week`;
}

function logisticsDate(value, label = 'Date') {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must use YYYY-MM-DD.`);
  return text;
}

function logisticsPositiveId(value, label) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`${label} is required.`);
  return id;
}

function logisticsMoney(value, label, { allowZero = true } = {}) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0 || (!allowZero && amount === 0)) {
    throw new Error(`${label} must be a valid ${allowZero ? 'non-negative' : 'positive'} amount.`);
  }
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

function logisticsText(value, label, maxLength, { required = false } = {}) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (required && !text) throw new Error(`${label} is required.`);
  if (text.length > maxLength) throw new Error(`${label} must not exceed ${maxLength} characters.`);
  if (/[<>]/.test(text) || /(?:javascript:|on\w+\s*=)/i.test(text)) throw new Error(`${label} contains invalid characters.`);
  return text || null;
}

function logisticsStatus(value) {
  return String(value || '').trim().toLowerCase() === 'inactive' ? 'Inactive' : 'Active';
}

function canManageTrip(req, trip) {
  if (req.user?.role !== 'payroll_officer') return true;
  return Number(trip.created_by) === Number(currentUserId(req));
}

async function assertLogisticsTripSchema(pool) {
  for (const table of ['truck_types', 'logistics_locations', 'logistics_rates', 'delivery_trips']) {
    if (!(await payrollTableExists(pool, table))) {
      throw new Error('Logistics trip payroll is not configured. Apply the logistics trip payroll migration first.');
    }
  }
  const columns = await payrollTableColumns(pool, 'delivery_trips');
  if (!columns.has('output_quantity')) {
    await pool.execute('ALTER TABLE delivery_trips ADD COLUMN output_quantity DECIMAL(10,2) NOT NULL DEFAULT 1 AFTER plate_number');
  }
  if (!columns.has('paid_at')) {
    await pool.execute('ALTER TABLE delivery_trips ADD COLUMN paid_at DATETIME NULL AFTER approved_at');
  }
}

async function getApprovedDeliveryTripPayroll(pool, employeeId, period) {
  const [trips] = await pool.execute(`
    SELECT id, total_trip_pay, trip_date, trip_type, role, truck_type_id, location_id,
           COALESCE(output_quantity, 1) AS output_quantity,
           base_rate, additional_rate, multiplier
      FROM delivery_trips
     WHERE employee_id = ?
       AND trip_date BETWEEN ? AND ?
       AND status = 'Approved'
       AND payroll_run_id IS NULL
     ORDER BY trip_date, id
  `, [employeeId, period.start, period.end]);
  return {
    trips,
    total: trips.reduce((sum, trip) => sum + numeric(trip.total_trip_pay), 0),
    quantity: trips.reduce((sum, trip) => sum + numeric(trip.output_quantity || 1), 0)
  };
}

async function computeConfiguredDeductions(pool, grossPay, calculationDate) {
  const weekNumber = payrollWeekFromDate(calculationDate);
  const [settings] = await pool.execute(`
    SELECT id, name, category, computation_type, rate_or_amount, apply_schedule, effective_date
    FROM payroll_deduction_settings
    WHERE is_active = 1 AND effective_date <= ?
    ORDER BY effective_date DESC, id DESC
  `, [calculationDate || new Date().toISOString().split('T')[0]]);

  const applied = [];
  let total = 0;

  for (const setting of selectCurrentStatutoryDeductions(settings)) {
    if (!settingAppliesThisWeek(setting, weekNumber)) continue;
    let amount = 0;
    if (setting.computation_type === 'Percentage') {
      amount = parseFloat(grossPay || 0) * (parseFloat(setting.rate_or_amount || 0) / 100);
    } else if (setting.computation_type === 'Fixed Amount') {
      amount = parseFloat(setting.rate_or_amount || 0);
    }
    total += amount;
    applied.push({ ...setting, amount });
  }

  return { total, applied, weekNumber };
}

async function computeEmployeeDeductions(pool, employeeId, calculationDate) {
  if (!employeeId) return { total: 0, applied: [] };
  const effectiveDate = calculationDate || new Date().toISOString().split('T')[0];
  const [rows] = await pool.execute(`
    SELECT id, module_type, deduction_name, loan_type, remaining_balance, installment_amount, start_date, end_date
    FROM employee_deduction_accounts
    WHERE employee_id = ?
      AND status = 'Active'
      AND remaining_balance > 0
      AND start_date <= ?
      AND (end_date IS NULL OR end_date >= ?)
    ORDER BY start_date, id
  `, [employeeId, effectiveDate, effectiveDate]);

  const applied = rows.map(row => {
    const remaining = numeric(row.remaining_balance);
    const installment = numeric(row.installment_amount);
    const amount = Math.min(remaining, installment);
    return {
      id: row.id,
      name: row.deduction_name,
      category: row.module_type,
      loan_type: row.loan_type,
      computation_type: 'Employee Installment',
      rate_or_amount: installment,
      apply_schedule: 'Every Payroll',
      amount
    };
  }).filter(row => row.amount > 0);

  return {
    total: applied.reduce((sum, row) => sum + row.amount, 0),
    applied
  };
}

async function computePayrollDeductions(pool, employeeId, grossPay, calculationDate) {
  const configured = await computeConfiguredDeductions(pool, grossPay, calculationDate);
  const employee = await computeEmployeeDeductions(pool, employeeId, calculationDate);
  return {
    total: configured.total + employee.total,
    statutoryTotal: configured.total,
    employeeTotal: employee.total,
    applied: [...configured.applied, ...employee.applied],
    configured: configured.applied,
    employee: employee.applied,
    weekNumber: configured.weekNumber
  };
}

function deductionSnapshotKey(item, index = 0) {
  if (item?.id) return `config:${item.id}`;
  const name = String(item?.name || item?.deduction_name || item?.category || `deduction-${index}`).trim().toLowerCase();
  return name.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `deduction_${index}`;
}

function configuredDeductionBreakdown(appliedDeductions) {
  return (appliedDeductions || []).reduce((acc, item) => {
    const key = String(item.name || '').trim().toLowerCase();
    if (key === 'sss') acc.sss += numeric(item.amount);
    else if (key === 'pag-ibig' || key === 'pagibig') acc.pagibig += numeric(item.amount);
    else if (key === 'philhealth') acc.philhealth += numeric(item.amount);
    return acc;
  }, { sss: 0, pagibig: 0, philhealth: 0 });
}

function buildDeductionSnapshotRows(computedDeductions, extraRows = []) {
  const rows = [
    ...(computedDeductions?.configured || []),
    ...(computedDeductions?.employee || []),
    ...(extraRows || [])
  ];
  return rows
    .map((item, index) => ({
      deduction_config_id: item.id || null,
      deduction_key: deductionSnapshotKey(item, index),
      name: item.name || item.deduction_name || item.category || 'Deduction',
      category: item.category || null,
      computation_type: item.computation_type || null,
      rate_or_amount: item.rate_or_amount || null,
      amount: roundMoney(item.amount || 0)
    }))
    .filter(item => item.amount > 0);
}

async function clearSalaryCalculationDeductions(pool, salaryCalculationId) {
  if (!salaryCalculationId) return;
  await pool.execute('DELETE FROM salary_calculation_deductions WHERE salary_calculation_id = ?', [salaryCalculationId]);
}

async function upsertSalaryCalculationDeductions(pool, salaryCalculationId, deductionRows) {
  if (!salaryCalculationId) return;
  const seen = new Set();
  for (const row of deductionRows || []) {
    const key = row.deduction_config_id ? `config:${row.deduction_config_id}` : row.deduction_key;
    if (seen.has(key)) continue;
    seen.add(key);
    await pool.execute(`
      INSERT INTO salary_calculation_deductions
        (salary_calculation_id, deduction_config_id, deduction_key, name, category,
         computation_type, rate_or_amount, amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        category = VALUES(category),
        computation_type = VALUES(computation_type),
        rate_or_amount = VALUES(rate_or_amount),
        amount = VALUES(amount),
        updated_at = CURRENT_TIMESTAMP
    `, [
      salaryCalculationId,
      row.deduction_config_id || null,
      row.deduction_key,
      row.name,
      row.category,
      row.computation_type,
      row.rate_or_amount,
      row.amount
    ]);
  }
}

async function applySalaryCalculationDeductionSnapshot(pool, salaryCalculationId, deductionRows) {
  await clearSalaryCalculationDeductions(pool, salaryCalculationId);
  await upsertSalaryCalculationDeductions(pool, salaryCalculationId, deductionRows);
}

async function calculateSalaryDeductionSnapshot(pool, employeeId, grossPay, calculationDate, extraRows = []) {
  const computed = await computePayrollDeductions(pool, employeeId, grossPay, calculationDate);
  const rows = buildDeductionSnapshotRows(computed, extraRows);
  const configuredBreakdown = configuredDeductionBreakdown(computed.configured);
  return {
    ...computed,
    rows,
    configuredBreakdown,
    total: rows.reduce((sum, row) => sum + numeric(row.amount), 0),
    employeeTotal: computed.employeeTotal
  };
}

async function computeConfiguredAllowances(pool, grossPay, calculationDate) {
  // Allowance settings are a catalog/configuration list only. Do not apply
  // these rows globally because allowance amounts can differ per employee.
  return { total: 0, applied: [] };
}

async function applyEmployeeDeductionBalances(pool, req, employeeId, salaryCalculationId, payrollPeriod, employeeDeductions) {
  for (const item of employeeDeductions || []) {
    const [existingPayments] = await pool.execute(`
      SELECT id
      FROM employee_deduction_payments
      WHERE deduction_account_id = ? AND salary_calculation_id = ?
      LIMIT 1
    `, [item.id, salaryCalculationId]);
    if (existingPayments.length) continue;

    const [accounts] = await pool.execute(`
      SELECT id, remaining_balance
      FROM employee_deduction_accounts
      WHERE id = ? AND employee_id = ? AND status = 'Active'
      LIMIT 1
    `, [item.id, employeeId]);
    const account = accounts[0];
    if (!account) continue;

    const balanceBefore = numeric(account.remaining_balance);
    const appliedAmount = Math.min(balanceBefore, numeric(item.amount));
    const balanceAfter = Math.max(0, balanceBefore - appliedAmount);

    await pool.execute(`
      UPDATE employee_deduction_accounts
      SET remaining_balance = ?,
          status = CASE WHEN ? <= 0 THEN 'Paid' ELSE status END,
          updated_by = ?
      WHERE id = ? AND employee_id = ?
    `, [balanceAfter, balanceAfter, currentUserId(req), item.id, employeeId]);

    await pool.execute(`
      INSERT INTO employee_deduction_payments
        (deduction_account_id, employee_id, salary_calculation_id, payroll_period, applied_amount,
         balance_before, balance_after, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      item.id,
      employeeId,
      salaryCalculationId,
      payrollPeriod || null,
      appliedAmount,
      balanceBefore,
      balanceAfter,
      currentUserId(req)
    ]);

    await logPayrollAudit(pool, req, 'employee_deduction_applied', {
      employee_id: employeeId,
      salary_calculation_id: salaryCalculationId,
      remarks: `Applied ${item.name} installment`,
      metadata: { deduction_account_id: item.id, applied_amount: appliedAmount, balance_before: balanceBefore, balance_after: balanceAfter }
    });
  }
}

function normalizePayrollWageType(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('hour')) return 'Hourly';
  if (text.includes('day') || text.includes('daily')) return 'Daily';
  if (text.includes('piece')) return 'Per-Piece';
  if (text.includes('trip') || text.includes('logistics')) return 'Per-Trip';
  if (text.includes('salary') || text.includes('base') || text.includes('month')) return 'Monthly';
  return String(value || '');
}

function peso(value) {
  const amount = Number(value || 0);
  const formatted = `PHP ${Math.abs(amount).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return amount < 0 ? `(${formatted})` : formatted;
}

function numeric(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value) {
  return Math.round((numeric(value) + Number.EPSILON) * 100) / 100;
}

function payrollDate(value, label = 'Date') {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label} must use YYYY-MM-DD.`);
  return text;
}

function weeklyPayrollKey(startDate, endDate) {
  const start = payrollDate(startDate, 'Payroll start date');
  const end = payrollDate(endDate, 'Payroll end date');
  return `${start.slice(0, 7)}-W${payrollWeekFromDate(end)}`;
}

function payrollPeriodFromRequest(body = {}) {
  const requestedMonth = monthRange(body.month_year);
  const start = body.start_date ? payrollDate(body.start_date, 'Payroll start date') : requestedMonth.start;
  const end = body.end_date ? payrollDate(body.end_date, 'Payroll end date') : requestedMonth.end;
  if (start > end) throw new Error('Period start must be before or equal to period end.');
  const hasExplicitWeek = Boolean(body.start_date || body.end_date || body.weekly);
  const key = String(body.payroll_period || body.period_key || (hasExplicitWeek ? weeklyPayrollKey(start, end) : requestedMonth.month_year)).trim();
  if (!/^\d{4}-\d{2}(?:-W[1-5])?$/.test(key)) throw new Error('Payroll period must use YYYY-MM or YYYY-MM-W# format.');
  return {
    month_year: key,
    base_month: start.slice(0, 7),
    start,
    end,
    period_label: `${start} to ${end}`,
    is_weekly: hasExplicitWeek || /-W[1-5]$/.test(key)
  };
}

function periodFilterSql(columnSql, periodValue) {
  const value = String(periodValue || '').trim();
  if (/^\d{4}-\d{2}$/.test(value)) {
    return { sql: `${columnSql} LIKE ?`, params: [`${value}%`] };
  }
  return { sql: `${columnSql} = ?`, params: [value] };
}

function payrollTypePattern(payType) {
  const normalized = normalizePayrollWageType(payType);
  if (normalized === 'Monthly') return '%month%';
  if (normalized === 'Daily') return '%day%';
  if (normalized === 'Hourly') return '%hour%';
  if (normalized === 'Per-Piece') return '%piece%';
  if (normalized === 'Per-Trip') return '%trip%';
  return '';
}

function sourceIdList(rows, prefix = '') {
  return rows
    .map(row => row.id || row.summary_id || row.attendance_id)
    .filter(Boolean)
    .map(id => `${prefix}${id}`);
}

async function payrollTableColumns(pool, tableName) {
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName]
  );
  return new Set(rows.map(row => row.COLUMN_NAME));
}

async function payrollTableExists(pool, tableName) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function employeeActiveCondition(pool, alias = '') {
  const columns = await payrollTableColumns(pool, 'employees');
  const prefix = alias ? `${alias}.` : '';
  const statusColumn = columns.has('status') ? `${prefix}status` : null;
  const employmentStatusColumn = columns.has('employment_status') ? `${prefix}employment_status` : null;
  if (statusColumn && employmentStatusColumn) {
    return `COALESCE(${statusColumn}, ${employmentStatusColumn}, 'Active') = 'Active'`;
  }
  if (statusColumn) return `COALESCE(${statusColumn}, 'Active') = 'Active'`;
  if (employmentStatusColumn) return `COALESCE(${employmentStatusColumn}, 'Active') = 'Active'`;
  return '1 = 1';
}

async function payrollEnumValues(pool, tableName, columnName) {
  const [rows] = await pool.execute(
    `SELECT COLUMN_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?
      LIMIT 1`,
    [tableName, columnName]
  );
  const columnType = rows[0]?.COLUMN_TYPE || '';
  return Array.from(columnType.matchAll(/'([^']+)'/g)).map(match => match[1]);
}

function monthRange(monthYear) {
  const raw = String(monthYear || '').trim();
  const weekMatch = raw.match(/^(\d{4})-(\d{2})-W([1-5])$/);
  if (weekMatch) {
    const year = Number(weekMatch[1]);
    const month = Number(weekMatch[2]);
    const week = Number(weekMatch[3]);
    const monthEndDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const startDay = Math.min(monthEndDay, ((week - 1) * 7) + 1);
    const endDay = Math.min(monthEndDay, week * 7);
    return {
      month_year: `${year}-${String(month).padStart(2, '0')}-W${week}`,
      start: `${year}-${String(month).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`,
      end: `${year}-${String(month).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`,
    };
  }
  const match = raw.match(/^(\d{4})-(\d{2})$/);
  const now = new Date();
  const year = match ? Number(match[1]) : now.getFullYear();
  const month = match ? Number(match[2]) : now.getMonth() + 1;
  const safeMonth = Math.min(12, Math.max(1, month));
  const start = `${year}-${String(safeMonth).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(year, safeMonth, 0)).toISOString().slice(0, 10);
  return { month_year: `${year}-${String(safeMonth).padStart(2, '0')}`, start, end };
}

async function findOrCreatePayrollRun(pool, req, period) {
  const [existing] = await pool.execute(
    'SELECT * FROM payroll_runs WHERE month_year = ? LIMIT 1',
    [period.month_year]
  );
  if (existing.length) return existing[0];

  const columns = await payrollTableColumns(pool, 'payroll_runs');
  const fields = ['month_year', 'start_date', 'end_date'];
  const values = [period.month_year, period.start, period.end];
  if (columns.has('period_label')) {
    fields.push('period_label');
    values.push(period.period_label || `${period.start} to ${period.end}`);
  }
  if (columns.has('payroll_type')) {
    fields.push('payroll_type');
    values.push(period.payroll_type || 'All Pay Types');
  }
  if (columns.has('status')) {
    fields.push('status');
    values.push('Draft');
  }
  if (columns.has('created_by')) {
    fields.push('created_by');
    values.push(currentUserId(req));
  } else if (columns.has('processed_by')) {
    fields.push('processed_by');
    values.push(currentUserId(req));
  }
  if (columns.has('processed_by') && !fields.includes('processed_by')) {
    fields.push('processed_by');
    values.push(currentUserId(req));
  }
  if (columns.has('processed_at')) {
    fields.push('processed_at');
    values.push(new Date());
  }
  if (columns.has('source_summary')) {
    fields.push('source_summary');
    values.push(JSON.stringify({ period_start: period.start, period_end: period.end, filters: period.filters || {} }));
  }
  const placeholders = fields.map(() => '?').join(', ');
  const [result] = await pool.execute(
    `INSERT INTO payroll_runs (${fields.join(', ')}) VALUES (${placeholders})`,
    values
  );
  const [rows] = await pool.execute('SELECT * FROM payroll_runs WHERE id = ?', [result.insertId]);
  return rows[0] || { id: result.insertId, month_year: period.month_year, start_date: period.start, end_date: period.end, status: 'Draft' };
}

async function updatePayrollRunTotals(pool, payrollRunId) {
  const columns = await payrollTableColumns(pool, 'payroll_runs');
  const [summaryRows] = await pool.execute(
    `SELECT COUNT(*) AS total_employees,
            COALESCE(SUM(total_earning), 0) AS total_payroll,
            COALESCE(SUM(total_deduction), 0) AS total_deductions
       FROM payslips
      WHERE payroll_run_id = ?`,
    [payrollRunId]
  );
  const summary = summaryRows[0] || {};
  const fields = [];
  const values = [];
  if (columns.has('total_employees')) {
    fields.push('total_employees = ?');
    values.push(Number(summary.total_employees || 0));
  }
  if (columns.has('total_payroll')) {
    fields.push('total_payroll = ?');
    values.push(numeric(summary.total_payroll));
  }
  if (columns.has('total_amount')) {
    fields.push('total_amount = ?');
    values.push(numeric(summary.total_payroll));
  }
  if (columns.has('total_deductions')) {
    fields.push('total_deductions = ?');
    values.push(numeric(summary.total_deductions));
  }
  if (columns.has('status')) {
    const allowedStatuses = await payrollEnumValues(pool, 'payroll_runs', 'status');
    const generatedStatus = allowedStatuses.includes('Generated')
      ? 'Generated'
      : allowedStatuses.includes('Pending Review')
        ? 'Pending Review'
        : null;
    if (generatedStatus) {
      fields.push('status = CASE WHEN status IN (\'Draft\', \'Generated\', \'Pending Review\') THEN ? ELSE status END');
      values.push(generatedStatus);
    }
  }
  if (!fields.length) return summary;
  values.push(payrollRunId);
  await pool.execute(`UPDATE payroll_runs SET ${fields.join(', ')} WHERE id = ?`, values);
  return summary;
}

function periodLabel(record) {
  const raw = record.payroll_period || (record.calculation_date ? String(record.calculation_date).slice(0, 7) : '');
  const match = String(raw).match(/^(\d{4})-(\d{2})$/);
  if (!match) return raw || '-';
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric'
  });
}

function parseJsonSafe(value) {
  if (!value) return {};
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch (_) {
    return {};
  }
}

async function getSalaryCalculationForPayslip(pool, calculationId) {
  const [rows] = await pool.execute(`
    SELECT sc.*,
           CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
           e.employee_code,
           e.position,
           d.name AS department,
           wt.name AS wage_type,
           u.username AS prepared_by
      FROM salary_calculations sc
      JOIN employees e ON e.id = sc.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN wage_types wt ON wt.id = sc.wage_type_id
      LEFT JOIN users u ON u.id = sc.calculated_by
     WHERE sc.id = ?
     LIMIT 1
  `, [calculationId]);
  return rows[0] || null;
}

function canAccessPayslip(req, record) {
  const role = req.user?.role;
  const employeeId = Number(req.user?.employeeId || req.user?.employee_id || 0);
  if (['system_admin', 'admin', 'hr_manager', 'hr_admin', 'payroll_officer', 'payroll_manager'].includes(role)) return true;
  return role === 'employee' && employeeId && employeeId === Number(record.employee_id);
}

function buildPayslipPayload(record) {
  const snapshot = parseJsonSafe(record.validation_snapshot);
  const wageType = normalizePayrollWageType(record.wage_type);
  const grossPay = numeric(record.gross_pay);
  const allowances = numeric(record.total_allowances)
    || numeric(record.housing_allowance) + numeric(record.meal_allowance) + numeric(record.transport_allowance) + numeric(record.bonus_allowance);
  const basePay = Math.max(0, grossPay - allowances);
  const totalDeductions = numeric(record.total_deductions);
  const knownDeductions = [
    { key: 'sss', label: 'SSS', amount: numeric(record.sss_deduction) },
    { key: 'hdmf', label: 'HDMF / Pag-IBIG', amount: numeric(record.pagibig_deduction) },
    { key: 'phic', label: 'PHIC / PhilHealth', amount: numeric(record.philhealth_deduction) },
  ];
  const knownTotal = knownDeductions.reduce((sum, item) => sum + item.amount, 0);
  const employeeDeductionTotal = numeric(record.employee_deduction_total);
  const configuredBreakdown = Array.isArray(snapshot.deductions) ? snapshot.deductions : [];
  const configuredRows = [];
  const configuredNames = new Set(['sss', 'philhealth', 'pag-ibig', 'pagibig', 'late deduction', 'undertime deduction']);
  let configuredOtherTotal = 0;
  let employeeBreakdownTotal = 0;

  for (const item of configuredBreakdown) {
    const amount = numeric(item.amount);
    if (amount <= 0) continue;
    const rawName = String(item.name || item.deduction_name || item.category || '').trim();
    const normalized = rawName.toLowerCase();
    if (configuredNames.has(normalized)) continue;

    if (normalized.includes('cash advance') || normalized.includes('loan')) {
      employeeBreakdownTotal += amount;
      continue;
    }

    const label = normalized.includes('ir coop') || normalized.includes('coop')
      ? 'IR COOP'
      : normalized.includes('canteen')
        ? 'Canteen'
        : normalized.includes('adjust')
          ? 'Adjustment'
          : rawName || 'Other Deductions';
    configuredRows.push({ key: normalized || label.toLowerCase(), label, amount });
    configuredOtherTotal += amount;
  }

  const employeeDeductionAmount = employeeDeductionTotal || employeeBreakdownTotal;
  const lateDeduction = numeric(snapshot.late_deduction);
  const undertimeDeduction = numeric(snapshot.undertime_deduction);
  const tardyUtDeduction = lateDeduction + undertimeDeduction;
  const knownPlusDetailed = knownTotal + configuredOtherTotal + employeeDeductionAmount + tardyUtDeduction;
  const otherAmount = Math.max(0, totalDeductions - knownPlusDetailed);
  const deductionRows = [
    ...knownDeductions,
    { key: 'late_deduction', label: 'Late Deduction', amount: lateDeduction },
    { key: 'undertime_deduction', label: 'Undertime Deduction', amount: undertimeDeduction },
    { key: 'tardy_ut_total', label: 'Total Tardy/UT', amount: tardyUtDeduction },
    ...configuredRows,
    ...(employeeDeductionAmount > 0 ? [{ key: 'employee_deductions', label: 'Cash Advance / Loans', amount: employeeDeductionAmount }] : []),
    ...(otherAmount > 0 ? [{ key: 'other', label: 'Other Deductions', amount: otherAmount }] : []),
  ];
  const quantity = numeric(record.quantity);
  const productionAmount = wageType === 'Per-Piece' ? numeric(record.base_rate) * quantity : 0;
  const tripCount = wageType === 'Per-Trip' ? quantity : 0;

  return {
    reference_no: `CALC-${String(record.id).padStart(5, '0')}`,
    company_name: 'Marulas Industrial Corp',
    generated_at: new Date().toISOString(),
    prepared_by: record.prepared_by || 'Payroll',
    payroll_period: periodLabel(record),
    employee: {
      name: record.employee_name,
      code: record.employee_code,
      department: record.department || '-',
      position: record.position || '-',
    },
    wage_type: wageType,
    earnings: {
      days_worked: numeric(record.days_worked) || snapshot.days_worked || 0,
      hours_worked: numeric(record.hours_worked) || snapshot.hours_worked || 0,
      employee_minute_rate: numeric(snapshot.minute_rate),
      basic_pay: basePay,
      rot_sot: numeric(record.overtime_amount),
      nd: 0,
      add: numeric(record.bonus_allowance),
      late_minutes: numeric(snapshot.late_minutes),
      deductible_late_minutes: numeric(snapshot.deductible_late_minutes),
      undertime_minutes: numeric(snapshot.undertime_minutes),
      late_deduction: lateDeduction,
      undertime_deduction: undertimeDeduction,
      tardy_ut: tardyUtDeduction,
      allowances,
      gross_pay: grossPay,
      quantity,
      piece_rate: wageType === 'Per-Piece' ? numeric(record.base_rate) : 0,
      production_amount: productionAmount,
      share_label: snapshot.pairing_type || snapshot.role || '',
      share_percentage: snapshot.worker1_share || snapshot.share_percentage || null,
      trip_count: tripCount,
      trip_rate: wageType === 'Per-Trip' ? numeric(record.base_rate) : 0,
      monthly_salary: wageType === 'Monthly' ? numeric(snapshot.monthly_salary || record.base_rate) : 0,
      monthly_conversion_method: snapshot.monthly_conversion_method || null,
      weekly_from_monthly_amount: numeric(snapshot.weekly_from_monthly_amount),
      working_days_per_month: snapshot.working_days_per_month || null,
      source_records: Array.isArray(snapshot.records) ? snapshot.records : [],
      logistics_trips: Array.isArray(snapshot.trips) ? snapshot.trips : [],
    },
    deductions: deductionRows,
    summary: {
      gross_pay: grossPay,
      total_deductions: totalDeductions,
      net_due: numeric(record.net_pay),
    },
  };
}

function drawPayslipPdf(doc, payslip) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const width = right - left;
  const red = '#e73236';
  const ink = '#111827';
  const muted = '#64748b';
  const border = '#d7dde8';
  const soft = '#f6f8fb';
  const textValue = value => String(value ?? '-');
  const line = (x1, x2, y, color = border) => {
    doc.moveTo(x1, y).lineTo(x2, y).strokeColor(color).lineWidth(0.5).stroke();
  };
  const cell = (label, value, x, y, w) => {
    doc.font('Helvetica').fontSize(7).fillColor(muted).text(label, x, y, { width: w });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(ink).text(value || '-', x, y + 10, { width: w, ellipsis: true });
  };
  const tableRow = (x, y, label, value, w, options = {}) => {
    const rowHeight = options.rowHeight || 15;
    const labelWidth = w - 92;
    if (options.fill) doc.rect(x, y - 3, w, rowHeight + 2).fill(options.fill);
    doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(options.bold ? 8.5 : 8)
      .fillColor(options.color || ink)
      .text(label, x + 7, y, { width: labelWidth - 10, ellipsis: true });
    doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica')
      .fontSize(options.bold ? 8.5 : 8)
      .fillColor(options.color || ink)
      .text(textValue(value), x + labelWidth, y, { width: 84, align: 'right' });
    line(x, x + w, y + rowHeight - 2, '#e8edf3');
  };

  const slipTop = 24;
  const slipHeight = 340;
  doc.rect(left, slipTop, width, slipHeight).strokeColor(border).lineWidth(0.8).stroke();

  let y = slipTop;
  doc.rect(left, y, width, 48).fill('#ffffff');
  doc.rect(left, y, 5, 48).fill(red);
  doc.font('Helvetica-Bold').fontSize(15).fillColor(ink).text(payslip.company_name, left + 16, y + 10);
  doc.font('Helvetica').fontSize(8).fillColor(muted).text('Employee Payslip', left + 16, y + 29);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ink)
    .text(`Payroll Period: ${payslip.payroll_period}`, right - 210, y + 10, { width: 200, align: 'right' });
  doc.font('Helvetica').fontSize(8).fillColor(muted)
    .text(`Reference: ${payslip.reference_no}`, right - 210, y + 27, { width: 200, align: 'right' });
  y += 48;
  line(left, right, y);

  doc.rect(left, y, width, 46).fill(soft);
  const infoPadding = 12;
  const infoGap = 10;
  const infoWidth = (width - infoPadding * 2 - infoGap * 3) / 4;
  const infoY = y + 9;
  cell('Employee Name', payslip.employee.name, left + infoPadding, infoY, infoWidth);
  cell('Employee Code', payslip.employee.code, left + infoPadding + (infoWidth + infoGap), infoY, infoWidth);
  cell('Department', payslip.employee.department, left + infoPadding + (infoWidth + infoGap) * 2, infoY, infoWidth);
  cell('Position', payslip.employee.position, left + infoPadding + (infoWidth + infoGap) * 3, infoY, infoWidth);
  y += 46;
  line(left, right, y);

  const contentPadding = 14;
  const columnGap = 18;
  const columnWidth = (width - contentPadding * 2 - columnGap) / 2;
  const earningsX = left + contentPadding;
  const deductionsX = earningsX + columnWidth + columnGap;
  y += 12;

  doc.rect(earningsX, y, columnWidth, 22).fill('#f9fafb').strokeColor(border).stroke();
  doc.rect(deductionsX, y, columnWidth, 22).fill('#f9fafb').strokeColor(border).stroke();
  doc.font('Helvetica-Bold').fontSize(9).fillColor(ink).text('Earnings', earningsX + 7, y + 7);
  doc.text('Deductions', deductionsX + 7, y + 7);
  y += 24;

  const earnings = [
    ['Days Worked', payslip.earnings.days_worked],
    ['Employee Minute Rate', peso(payslip.earnings.employee_minute_rate)],
    ['Late Minutes', payslip.earnings.late_minutes],
    ['Undertime Minutes', payslip.earnings.undertime_minutes],
    ['Basic Pay', peso(payslip.earnings.basic_pay)],
    ['ROT/SOT', peso(payslip.earnings.rot_sot)],
    ['ND', peso(payslip.earnings.nd)],
    ['ADD', peso(payslip.earnings.add)],
    ['Tardy/UT', peso(payslip.earnings.tardy_ut)],
    ['Allowances', peso(payslip.earnings.allowances)],
    ['Gross Pay', peso(payslip.earnings.gross_pay)],
  ];
  if (payslip.wage_type === 'Per-Piece') {
    earnings.splice(1, 0, ['Quantity', payslip.earnings.quantity], ['Piece Rate', peso(payslip.earnings.piece_rate)], ['Production Amount', peso(payslip.earnings.production_amount)]);
    if (payslip.earnings.share_percentage) earnings.splice(4, 0, ['Share', `${payslip.earnings.share_percentage}%`]);
  }
  if (payslip.wage_type === 'Per-Trip') {
    earnings.splice(1, 0, ['Trip Count', payslip.earnings.trip_count], ['Driver/Helper Rate', peso(payslip.earnings.trip_rate)]);
  }
  if (payslip.wage_type === 'Monthly') {
    earnings.splice(1, 0,
      ['Monthly Salary', peso(payslip.earnings.monthly_salary)],
      ['Conversion', payslip.earnings.monthly_conversion_method === 'daily_equivalent' ? 'Daily Equivalent' : 'Monthly / 4']
    );
  }

  const maxRows = Math.max(earnings.length, payslip.deductions.length);
  for (let i = 0; i < maxRows; i += 1) {
    const e = earnings[i];
    const d = payslip.deductions[i];
    if (e) {
      tableRow(earningsX, y, e[0], e[1], columnWidth, {
        bold: e[0] === 'Gross Pay',
        fill: e[0] === 'Gross Pay' ? '#f9fafb' : null
      });
    }
    if (d) {
      tableRow(deductionsX, y, d.label, peso(d.amount), columnWidth);
    }
    y += 15;
  }

  y += 6;
  tableRow(deductionsX, y, 'Total Deductions', peso(payslip.summary.total_deductions), columnWidth, {
    bold: true,
    fill: '#f9fafb'
  });
  y += 22;

  const netBoxHeight = 30;
  doc.rect(left + contentPadding, y, width - contentPadding * 2, netBoxHeight).fill('#fff1f2');
  doc.rect(left + contentPadding, y, width - contentPadding * 2, netBoxHeight).strokeColor('#fecdd3').lineWidth(0.5).stroke();
  doc.font('Helvetica-Bold').fontSize(11).fillColor(red).text('Net Due / Net Pay', left + contentPadding + 10, y + 9);
  doc.text(peso(payslip.summary.net_due), right - contentPadding - 180, y + 9, { width: 170, align: 'right' });

  const footerY = slipTop + slipHeight - 44;
  line(left + contentPadding, right - contentPadding, footerY - 8);
  doc.font('Helvetica').fontSize(7.5).fillColor(muted)
    .text(`Generated: ${new Date(payslip.generated_at).toLocaleString('en-PH')}`, left + contentPadding, footerY)
    .text(`Prepared by: ${payslip.prepared_by}`, left + contentPadding, footerY + 13);
}

function renderPayslipPdfBuffer(payslip) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A5', layout: 'landscape', margin: 28 });
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      drawPayslipPdf(doc, payslip);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

function periodRange(payrollPeriod, fallbackDate) {
  const raw = String(payrollPeriod || '').trim();
  const match = raw.match(/^(\d{4})-(\d{2})$/);
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    const start = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(Date.UTC(year, month, 0));
    const end = endDate.toISOString().slice(0, 10);
    return { start, end, payroll_period: `${year}-${String(month).padStart(2, '0')}` };
  }
  const date = fallbackDate || new Date().toISOString().slice(0, 10);
  return { start: date, end: date, payroll_period: date.slice(0, 7) };
}

async function getPayrollPolicy(pool) {
  await ensurePieceRatePayrollSchema(pool);
  const [rows] = await pool.execute('SELECT setting_key, setting_value FROM payroll_policy_settings');
  const attendancePolicy = await getActiveAttendancePolicy(pool);
  const map = {};
  for (const row of rows) map[row.setting_key] = row.setting_value;
  const bool = key => String(map[key] || '').toLowerCase() === 'true';
  const num = (key, fallback = 0) => {
    const value = Number(map[key]);
    return Number.isFinite(value) ? value : fallback;
  };
  return {
    raw: map,
    daily: {
      require_hr_validation: attendancePolicy.require_hr_validation,
      use_payroll_ready_only: attendancePolicy.payroll_attendance_source === 'payroll_ready',
      count_late: attendancePolicy.count_late_for_payroll,
      count_late_for_payroll: attendancePolicy.count_late_for_payroll,
      count_undertime: attendancePolicy.count_undertime_for_payroll,
      count_undertime_for_payroll: attendancePolicy.count_undertime_for_payroll,
      allow_half_day: attendancePolicy.enable_half_day_rule,
      half_day_threshold_hours: attendancePolicy.half_day_threshold_hours || num('daily_half_day_threshold_hours', 4),
      standard_hours_per_day: attendancePolicy.standard_work_hours || num('hourly_standard_hours_per_day', 8),
      working_days_per_month: attendancePolicy.working_days_per_month || 26,
      work_start_time: attendancePolicy.work_start_time,
      grace_period_minutes: attendancePolicy.grace_period_minutes,
      late_deduction_method: attendancePolicy.late_deduction_method,
      late_fixed_deduction_amount: attendancePolicy.late_fixed_deduction_amount,
      late_apply_grace_period: attendancePolicy.late_apply_grace_period,
      late_require_hr_approval: attendancePolicy.late_require_hr_approval,
      undertime_deduction_method: attendancePolicy.undertime_deduction_method,
      undertime_fixed_deduction_amount: attendancePolicy.undertime_fixed_deduction_amount,
      undertime_require_hr_approval: attendancePolicy.undertime_require_hr_approval,
    },
    hourly: {
      standard_hours_per_day: attendancePolicy.standard_work_hours || num('hourly_standard_hours_per_day', 8),
      work_start_time: attendancePolicy.work_start_time,
      break_deduction_hours: 0,
      overtime_threshold: (attendancePolicy.overtime_threshold_minutes || 480) / 60,
      maximum_regular_hours: num('hourly_maximum_regular_hours', 8),
      round_off_rule: map.hourly_round_off_rule || 'none',
      require_hr_validation: attendancePolicy.require_hr_validation,
      require_payroll_ready_attendance: attendancePolicy.payroll_attendance_source === 'payroll_ready',
      count_late_for_payroll: attendancePolicy.count_late_for_payroll,
      count_undertime: attendancePolicy.count_undertime_for_payroll,
      count_undertime_for_payroll: attendancePolicy.count_undertime_for_payroll,
      grace_period_minutes: attendancePolicy.grace_period_minutes,
      late_deduction_method: attendancePolicy.late_deduction_method,
      late_fixed_deduction_amount: attendancePolicy.late_fixed_deduction_amount,
      late_apply_grace_period: attendancePolicy.late_apply_grace_period,
      late_require_hr_approval: attendancePolicy.late_require_hr_approval,
      undertime_deduction_method: attendancePolicy.undertime_deduction_method,
      undertime_fixed_deduction_amount: attendancePolicy.undertime_fixed_deduction_amount,
      undertime_require_hr_approval: attendancePolicy.undertime_require_hr_approval,
    },
    monthly: {
      conversion_method: ['weekly_from_monthly', 'daily_equivalent'].includes(String(map.monthly_conversion_method || '').toLowerCase())
        ? String(map.monthly_conversion_method || '').toLowerCase()
        : 'weekly_from_monthly',
      working_days_per_month: num('monthly_working_days_per_month', attendancePolicy.working_days_per_month || 26)
    }
  };
}

function applyHourRoundOff(hours, rule) {
  const value = Number(hours || 0);
  if (rule === 'nearest_quarter') return Math.round(value * 4) / 4;
  if (rule === 'nearest_half') return Math.round(value * 2) / 2;
  return value;
}

function payrollClockMinutes(value) {
  const match = String(value || '').match(/(?:T|\s|^)(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

async function validateDailyHourlyPayroll(pool, options) {
  await ensurePieceRatePayrollSchema(pool);
  const employeeId = Number(options.employee_id);
  const payrollPeriod = options.payroll_period || options.calculation_date?.slice(0, 7);
  const calcDate = options.calculation_date || new Date().toISOString().slice(0, 10);
  const range = options.start_date && options.end_date
    ? {
      start: payrollDate(options.start_date, 'Payroll start date'),
      end: payrollDate(options.end_date, 'Payroll end date'),
      payroll_period: payrollPeriod || weeklyPayrollKey(options.start_date, options.end_date)
    }
    : periodRange(payrollPeriod, calcDate);
  const policy = await getPayrollPolicy(pool);

  const [employeeRows] = await pool.execute(`
    SELECT e.id, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
           e.status, e.wage_type_id, wt.name AS wage_type
      FROM employees e
      LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
     WHERE e.id = ?
     LIMIT 1
  `, [employeeId]);
  const employee = employeeRows[0];
  if (!employee) {
    return { ok: false, errors: ['Employee does not exist.'], warnings: [], employee: null };
  }

  const wageType = normalizePayrollWageType(employee.wage_type || options.wage_type);
  const isDaily = wageType === 'Daily';
  const isMonthly = wageType === 'Monthly';
  const isHourly = wageType === 'Hourly';
  if (!isDaily && !isMonthly && !isHourly) {
    return { ok: true, skipped: true, wage_type: wageType, errors: [], warnings: [] };
  }

  const errors = [];
  const warnings = [];
  if (employee.status !== 'Active') errors.push('Employee must be active.');

  const [rateRows] = await pool.execute(`
    SELECT *
      FROM employee_wage_rates
     WHERE employee_id = ?
       AND wage_type_id = ?
       AND end_date IS NULL
       AND COALESCE(is_active, 1) = 1
       AND effective_date <= ?
     ORDER BY effective_date DESC, id DESC
  `, [employeeId, employee.wage_type_id, calcDate]);

  if (!rateRows.length) {
    errors.push(isHourly ? 'No Hourly Rate configured.' : isMonthly ? 'No Monthly Salary configured.' : 'No Daily Rate configured.');
  }
  if (rateRows.length > 1) {
    errors.push(isHourly ? 'Multiple active Hourly Rates exist.' : isMonthly ? 'Multiple active Monthly Salaries exist.' : 'Multiple active Daily Rates exist.');
  }

  const rateRow = rateRows[0] || {};
  const configuredRate = Number(rateRow.rate || rateRow.base_rate || 0);
  const monthlySalary = isMonthly ? Number(rateRow.monthly_salary || rateRow.rate || rateRow.base_rate || 0) : 0;
  const dailyRate = isMonthly
    ? monthlySalary / Math.max(1, Number(policy.monthly.working_days_per_month || policy.daily.working_days_per_month || 26))
    : isDaily ? Number(rateRow.daily_rate || rateRow.rate || rateRow.base_rate || 0) : 0;
  const rate = (isDaily || isMonthly)
    ? dailyRate
    : Number(rateRow.hourly_rate || rateRow.rate || rateRow.base_rate || 0);
  if (!(rate > 0)) {
    errors.push(isHourly ? 'Hourly Rate must be greater than zero.' : isMonthly ? 'Monthly salary and working days per month must produce a Daily Rate greater than zero.' : 'Daily Rate must be greater than zero.');
  }
  if (!rateRow.effective_date) errors.push('Effective Date is required.');

  const attendanceWhere = [
    'ats.employee_id = ?',
    'ats.attendance_date BETWEEN ? AND ?',
    "ats.verification_status = 'PAYROLL_READY'",
    'COALESCE(ats.payroll_eligible, 0) = 1',
    'ats.payroll_run_id IS NULL'
  ];
  const attendanceValues = [employeeId, range.start, range.end];
  if (isHourly) {
    attendanceWhere.push('al.time_in IS NOT NULL');
    attendanceWhere.push('al.time_out IS NOT NULL');
  }

  const [attendanceRows] = await pool.execute(`
    SELECT ats.*, al.time_in, al.time_out, al.status AS log_status
      FROM attendance_summary ats
      LEFT JOIN attendance_log al ON al.attendance_id = ats.attendance_id
     WHERE ${attendanceWhere.join(' AND ')}
     ORDER BY ats.attendance_date
  `, attendanceValues);

  const [blockedRows] = await pool.execute(`
    SELECT ats.attendance_date, ats.attendance_status, ats.verification_status, ats.payroll_eligible,
           al.time_in, al.time_out
      FROM attendance_summary ats
      LEFT JOIN attendance_log al ON al.attendance_id = ats.attendance_id
     WHERE ats.employee_id = ?
       AND ats.attendance_date BETWEEN ? AND ?
       AND (
         ats.verification_status IN ('PENDING_VALIDATION','REJECTED','NEEDS_REVIEW','INCOMPLETE')
         OR COALESCE(ats.payroll_eligible, 0) = 0
         OR ats.payroll_run_id IS NOT NULL
         OR (? = 'Hourly' AND (al.time_in IS NULL OR al.time_out IS NULL))
       )
     ORDER BY ats.attendance_date
     LIMIT 20
  `, [employeeId, range.start, range.end, wageType]);

  if (!attendanceRows.length) {
    errors.push((isDaily || isMonthly) ? 'No validated payroll-ready attendance exists.' : 'No validated payroll-ready attendance with complete Time In and Time Out exists.');
  }
  if (blockedRows.length) {
    warnings.push(`${blockedRows.length} attendance record(s) excluded because they are pending, rejected, incomplete, needs review, or not payroll ready.`);
  }

  const attendanceDays = attendanceRows.length;
  const lateDays = attendanceRows.filter(row => Number(row.late_minutes || 0) > 0 || String(row.attendance_status || row.log_status || '').toLowerCase().includes('late')).length;
  const undertimeDays = attendanceRows.filter(row => Number(row.undertime_minutes || 0) > 0).length;
  const undertimeHours = attendanceRows.reduce((sum, row) => sum + Number(row.undertime_minutes || 0) / 60, 0);
  const absentDays = attendanceRows.filter(row => String(row.attendance_status || '').toLowerCase().includes('absent')).length;
  const rawRegularHours = attendanceRows.reduce((sum, row) => sum + Number(row.regular_minutes || 0) / 60, 0);
  const overtimeHours = attendanceRows.reduce((sum, row) => sum + Number(row.overtime_minutes || 0) / 60, 0);
  const activePolicy = (isDaily || isMonthly) ? policy.daily : policy.hourly;
  const scheduledStartMinutes = payrollClockMinutes(activePolicy.work_start_time);
  const graceCreditHours = isHourly && activePolicy.late_apply_grace_period
    ? attendanceRows.reduce((sum, row) => {
      const actualStartMinutes = payrollClockMinutes(row.time_in);
      if (scheduledStartMinutes == null || actualStartMinutes == null) return sum;
      const late = Math.max(0, actualStartMinutes - scheduledStartMinutes);
      return sum + (late > 0 && late <= Number(activePolicy.grace_period_minutes || 0) ? late / 60 : 0);
    }, 0)
    : 0;
  const attendanceDeductions = computeLateUndertimeDeductions({
    attendanceRows,
    policy: (isDaily || isMonthly) ? policy.daily : policy.hourly,
    wageType,
    rate
  });

  let daysWorked = attendanceDays;
  if ((isDaily || isMonthly) && policy.daily.allow_half_day) {
    daysWorked = attendanceRows.reduce((sum, row) => {
      const hours = Number(row.regular_minutes || 0) / 60;
      return sum + (hours > 0 && hours < policy.daily.half_day_threshold_hours ? 0.5 : 1);
    }, 0);
  }
  const breakDeduction = isHourly ? attendanceDays * Number(policy.hourly.break_deduction_hours || 0) : 0;
  let hoursWorked = isHourly ? Math.max(0, rawRegularHours + graceCreditHours - breakDeduction) : 0;
  hoursWorked = applyHourRoundOff(hoursWorked, policy.hourly.round_off_rule);

  if ((isDaily || isMonthly) && !(daysWorked > 0)) errors.push('Days Worked must be greater than zero.');
  if (isHourly && !(hoursWorked > 0)) errors.push('Hours Worked must be greater than zero.');

  const monthlyConversionMethod = isMonthly ? policy.monthly.conversion_method : null;
  const grossPay = isMonthly && monthlyConversionMethod === 'weekly_from_monthly'
    ? monthlySalary / 4
    : (isDaily || isMonthly)
      ? rate * daysWorked
      : rate * hoursWorked;
  const result = {
    ok: errors.length === 0,
    errors,
    warnings,
    employee,
    wage_type: wageType,
    payroll_period: range.payroll_period,
    date_from: range.start,
    date_to: range.end,
    rate,
    monthly_salary: Number(monthlySalary.toFixed(2)),
    daily_rate: Number(((isDaily || isMonthly) ? dailyRate : 0).toFixed(2)),
    hourly_rate: Number((isHourly ? rate : attendanceDeductions.hourly_rate_used).toFixed(2)),
    minute_rate: Number((attendanceDeductions.hourly_rate_used / 60).toFixed(4)),
    monthly_conversion_method: monthlyConversionMethod,
    weekly_from_monthly_amount: isMonthly ? Number((monthlySalary / 4).toFixed(2)) : null,
    working_days_per_month: isMonthly ? Number(policy.monthly.working_days_per_month || policy.daily.working_days_per_month || 26) : null,
    active_rate_count: rateRows.length,
    effective_date: rateRow.effective_date || null,
    attendance_count: attendanceRows.length,
    excluded_attendance_count: blockedRows.length,
    days_worked: Number(daysWorked.toFixed(2)),
    absent_days: absentDays,
    late_days: lateDays,
    undertime_days: undertimeDays,
    undertime_hours: Number(undertimeHours.toFixed(2)),
    hours_worked: Number(hoursWorked.toFixed(2)),
    regular_hours: Number(hoursWorked.toFixed(2)),
    overtime_hours: Number(overtimeHours.toFixed(2)),
    late_minutes: attendanceDeductions.late_minutes,
    deductible_late_minutes: attendanceDeductions.deductible_late_minutes,
    undertime_minutes: attendanceDeductions.undertime_minutes,
    overtime_minutes: attendanceDeductions.overtime_minutes,
    late_deduction: attendanceDeductions.late_deduction,
    undertime_deduction: attendanceDeductions.undertime_deduction,
    tardy_ut_deduction: attendanceDeductions.tardy_ut_deduction,
    gross_pay: Number(grossPay.toFixed(2)),
    validation_status: errors.length ? 'Blocked' : 'Ready',
    policy: (isDaily || isMonthly) ? policy.daily : policy.hourly,
    attendance_rows: attendanceRows.map(row => ({
      id: row.id || row.summary_id,
      summary_id: row.summary_id,
      attendance_id: row.attendance_id,
      attendance_date: row.attendance_date,
      attendance_status: row.attendance_status,
      verification_status: row.verification_status,
      payroll_eligible: Number(row.payroll_eligible || 0) === 1,
      regular_hours: Number(row.regular_minutes || 0) / 60,
      overtime_hours: Number(row.overtime_minutes || 0) / 60,
      late_minutes: Number(row.late_minutes || 0),
      undertime_minutes: Number(row.undertime_minutes || 0),
      time_in: row.time_in,
      time_out: row.time_out
    }))
  };
  return result;
}

function logisticsPositionKind(position) {
  const value = String(position || '').toLowerCase();
  if (value.includes('driver')) return 'Driver';
  if (value.includes('helper')) return 'Helper';
  return '';
}

async function computeLogisticsCrewPayroll(pool, body) {
  const driverId = Number(body.driver_employee_id);
  const helper1Id = Number(body.helper1_employee_id);
  const helper2Id = body.helper2_employee_id ? Number(body.helper2_employee_id) : null;
  const tripDate = body.transaction_date || new Date().toISOString().split('T')[0];
  const truckTypeId = logisticsPositiveId(body.truck_type_id, 'Truck type');
  const locationId = logisticsPositiveId(body.location_id, 'Delivery location');
  const tripType = normalizeTripType(body.trip_type);
  const tripCount = Math.max(1, Number(body.trip_count || body.trips || 1));

  if (!driverId) throw new Error('A logistics transaction must have 1 Driver.');
  if (!helper1Id) throw new Error('A logistics transaction must have at least 1 Helper.');
  const uniqueIds = [driverId, helper1Id, helper2Id].filter(Boolean);
  if (new Set(uniqueIds).size !== uniqueIds.length) {
    throw new Error('Driver and helpers must be different employees.');
  }

  const [employees] = await pool.execute(`
    SELECT id, employee_code, first_name, last_name, position, status
      FROM employees
     WHERE id IN (${uniqueIds.map(() => '?').join(',')})
  `, uniqueIds);
  const byId = new Map(employees.map(emp => [Number(emp.id), emp]));
  const driver = byId.get(driverId);
  const helper1 = byId.get(helper1Id);
  const helper2 = helper2Id ? byId.get(helper2Id) : null;
  if (!driver || !helper1 || (helper2Id && !helper2)) throw new Error('Selected logistics crew employee was not found.');
  for (const emp of [driver, helper1, helper2].filter(Boolean)) {
    if (String(emp.status || '').toLowerCase() !== 'active') throw new Error(`${emp.employee_code} is not active.`);
  }
  if (logisticsPositionKind(driver.position) !== 'Driver') throw new Error('Driver Employee must have a Driver position.');
  if (logisticsPositionKind(helper1.position) !== 'Helper') throw new Error('Helper 1 Employee must have a Helper position.');
  if (helper2 && logisticsPositionKind(helper2.position) !== 'Helper') throw new Error('Helper 2 Employee must have a Helper position.');

  const [truckRows, locationRows] = await Promise.all([
    pool.execute('SELECT id, name FROM truck_types WHERE id = ? AND is_active = 1 LIMIT 1', [truckTypeId]),
    pool.execute('SELECT id, name, location_category FROM logistics_locations WHERE id = ? AND is_active = 1 LIMIT 1', [locationId])
  ]);
  const truck = truckRows[0][0];
  const location = locationRows[0][0];
  if (!truck || !location) throw new Error('Selected truck and delivery location must be active.');
  const regionName = String(location.location_category) === 'Manila' ? 'Manila' : 'Provincial';
  const [regionRows] = await pool.execute('SELECT id FROM logistics_regions WHERE LOWER(name) = LOWER(?) LIMIT 1', [regionName]);
  if (!regionRows.length) throw new Error('Legacy payroll region mapping is unavailable for the selected delivery location.');
  const logisticsRegionId = Number(regionRows[0].id);

  const [driverRateConfig, helperRateConfig] = await Promise.all([
    findActiveLogisticsRate(pool, { truckTypeId, locationId, tripType, role: 'Driver', tripDate }),
    findActiveLogisticsRate(pool, { truckTypeId, locationId, tripType, role: 'Helper', tripDate })
  ]);
  if (!driverRateConfig || !helperRateConfig) {
    throw new Error('Active Driver and Helper logistics rates are required for the selected truck, location, trip type, and date.');
  }
  const driverRate = computeTripPay({ baseRate: driverRateConfig.base_rate, multiplier: driverRateConfig.multiplier, additionalRate: driverRateConfig.additional_rate });
  const helperRate = computeTripPay({ baseRate: helperRateConfig.base_rate, multiplier: helperRateConfig.multiplier, additionalRate: helperRateConfig.additional_rate });

  const crewStatus = helper2 ? 'Complete' : 'Incomplete';
  const missingHelperShare = helper2 ? 0 : helperRate / 2;
  const rows = [
    {
      employee: driver,
      role: 'Driver',
      base_rate: Number(driverRateConfig.base_rate || 0),
      multiplier: Number(driverRateConfig.multiplier || 1),
      additional_rate: Number(driverRateConfig.additional_rate || 0),
      configured_trip_pay: driverRate,
      computed_trip_pay: driverRate + missingHelperShare,
      rule_applied: helper2 ? 'Driver full trip rate' : 'Driver full trip rate plus half of missing Helper 2 pay',
      gross_pay: (driverRate + missingHelperShare) * tripCount
    },
    {
      employee: helper1,
      role: 'Helper 1',
      base_rate: Number(helperRateConfig.base_rate || 0),
      multiplier: Number(helperRateConfig.multiplier || 1),
      additional_rate: Number(helperRateConfig.additional_rate || 0),
      configured_trip_pay: helperRate,
      computed_trip_pay: helperRate + missingHelperShare,
      rule_applied: helper2 ? 'Helper configured trip rate' : 'Helper 1 configured trip rate plus half of missing Helper 2 pay',
      gross_pay: (helperRate + missingHelperShare) * tripCount
    }
  ];
  if (helper2) rows.push({
    employee: helper2,
    role: 'Helper 2',
    base_rate: Number(helperRateConfig.base_rate || 0),
    multiplier: Number(helperRateConfig.multiplier || 1),
    additional_rate: Number(helperRateConfig.additional_rate || 0),
    configured_trip_pay: helperRate,
    computed_trip_pay: helperRate,
    rule_applied: 'Helper configured trip rate',
    gross_pay: helperRate * tripCount
  });

  return {
    logistics_region_id: logisticsRegionId,
    truck_type: truck.name,
    trip_count: tripCount,
    transaction_date: tripDate,
    driver_employee_id: driverId,
    helper1_employee_id: helper1Id,
    helper2_employee_id: helper2Id,
    driver_rate: driverRate,
    helper_rate: helperRate,
    crew_status: crewStatus,
    missing_helper_share: missingHelperShare,
    rows,
    snapshot: {
      rule: helper2 ? 'complete_crew' : 'missing_helper_split',
      driver_rate: driverRate,
      helper_rate: helperRate,
      truck_type_id: truckTypeId,
      location_id: locationId,
      location_name: location.name,
      location_category: location.location_category,
      trip_type: tripType,
      missing_helper_share: missingHelperShare,
      crew_status: crewStatus,
      trip_count: tripCount
    }
  };
}

async function ensurePieceRatePayrollSchema(pool) {
  const ensureColumn = async (table, column, definition) => {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS count
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = ?
          AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (!Number(rows[0]?.count || 0)) {
      await pool.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };

  await ensureColumn('salary_calculations', 'agency_name', 'VARCHAR(180) NULL AFTER payroll_period');
  await ensureColumn('salary_calculations', 'validation_snapshot', 'LONGTEXT NULL AFTER agency_name');
  await ensureColumn('salary_calculations', 'payroll_run_id', 'INT NULL AFTER wage_type_id');
  await ensureColumn('salary_calculations', 'period_start', 'DATE NULL AFTER payroll_period');
  await ensureColumn('salary_calculations', 'period_end', 'DATE NULL AFTER period_start');
  await ensureColumn('salary_calculations', 'source_type', 'VARCHAR(40) NULL AFTER validation_snapshot');
  await ensureColumn('salary_calculations', 'source_record_ids', 'TEXT NULL AFTER source_type');
  await ensureColumn('salary_calculations', 'employee_deduction_total', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS salary_calculation_deductions (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      salary_calculation_id BIGINT NOT NULL,
      deduction_config_id BIGINT NULL,
      deduction_key VARCHAR(120) NOT NULL,
      name VARCHAR(160) NOT NULL,
      category VARCHAR(80) NULL,
      computation_type VARCHAR(80) NULL,
      rate_or_amount DECIMAL(12,4) NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_salary_calc_deduction_config (salary_calculation_id, deduction_config_id),
      UNIQUE KEY uq_salary_calc_deduction_key (salary_calculation_id, deduction_key),
      INDEX idx_salary_calc_deductions_calc (salary_calculation_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  try { await pool.execute('ALTER TABLE salary_calculations MODIFY COLUMN payroll_period VARCHAR(20) NULL'); } catch (_) {}
  try {
    await pool.execute(`
      ALTER TABLE salary_calculations
      MODIFY COLUMN status ENUM('Draft','Calculated','Submitted','Approved','Finalized','Paid','Released','Superseded','Cancelled') DEFAULT 'Submitted'
    `);
  } catch (_) {}
  await ensureColumn('payslips', 'salary_calculation_id', 'INT NULL AFTER payroll_run_id');
  await ensureColumn('payslips', 'payroll_period', 'VARCHAR(20) NULL AFTER wage_type_id');
  await ensureColumn('payslips', 'source_summary', 'TEXT NULL AFTER notes');
  await ensureColumn('payroll_runs', 'period_label', 'VARCHAR(80) NULL AFTER month_year');
  await ensureColumn('payroll_runs', 'payroll_type', 'VARCHAR(40) NULL AFTER end_date');
  await ensureColumn('payroll_runs', 'processed_by', 'INT NULL AFTER created_by');
  await ensureColumn('payroll_runs', 'processed_at', 'DATETIME NULL AFTER processed_by');
  await ensureColumn('payroll_runs', 'source_summary', 'TEXT NULL AFTER processed_at');
  await ensureColumn('employee_wage_rates', 'monthly_salary', 'DECIMAL(12,2) NULL AFTER base_rate');
  await ensureColumn('employee_wage_rates', 'daily_rate', 'DECIMAL(12,2) NULL AFTER monthly_salary');
  await ensureColumn('employee_wage_rates', 'default_role', 'VARCHAR(60) NULL AFTER logistics_region_id');
  await ensureColumn('employees', 'default_payroll_role', 'VARCHAR(60) NULL AFTER wage_type_id');
  if (await payrollTableExists(pool, 'attendance_summary')) {
    await ensureColumn('attendance_summary', 'payroll_run_id', 'INT NULL AFTER payroll_eligible');
    await ensureColumn('attendance_summary', 'paid_at', 'DATETIME NULL AFTER payroll_run_id');
  }
  await ensureColumn('logistics_transactions', 'truck_type', 'VARCHAR(80) NULL AFTER logistics_region_id');
  await ensureColumn('logistics_transactions', 'crew_status', "ENUM('Complete','Incomplete') NULL AFTER truck_type");
  await ensureColumn('logistics_transactions', 'crew_role', "ENUM('Driver','Helper 1','Helper 2') NULL AFTER crew_status");
  await ensureColumn('logistics_transactions', 'driver_employee_id', 'INT NULL AFTER crew_role');
  await ensureColumn('logistics_transactions', 'helper1_employee_id', 'INT NULL AFTER driver_employee_id');
  await ensureColumn('logistics_transactions', 'helper2_employee_id', 'INT NULL AFTER helper1_employee_id');
  await ensureColumn('logistics_transactions', 'driver_rate', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER helper2_employee_id');
  await ensureColumn('logistics_transactions', 'helper_rate', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER driver_rate');
  await ensureColumn('logistics_transactions', 'missing_helper_share', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER helper_rate');
  await ensureColumn('logistics_transactions', 'base_rate', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER missing_helper_share');
  await ensureColumn('logistics_transactions', 'gross_pay', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER base_rate');
  await ensureColumn('logistics_transactions', 'net_pay', 'DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER gross_pay');
  await ensureColumn('logistics_transactions', 'split_rule_snapshot', 'TEXT NULL AFTER net_pay');

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_policy_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      setting_key VARCHAR(80) NOT NULL UNIQUE,
      setting_value VARCHAR(255) NOT NULL,
      setting_group VARCHAR(40) NOT NULL DEFAULT 'General',
      description VARCHAR(255) NULL,
      updated_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  const policyDefaults = [
    ['daily_require_hr_validation', 'true', 'Daily Rate Rules', 'Daily payroll requires HR validation.'],
    ['daily_use_payroll_ready_only', 'true', 'Daily Rate Rules', 'Daily payroll uses payroll-ready attendance only.'],
    ['daily_count_late', 'true', 'Daily Rate Rules', 'Count late days in validation output.'],
    ['daily_count_undertime', 'true', 'Daily Rate Rules', 'Count undertime days in validation output.'],
    ['daily_allow_half_day', 'true', 'Daily Rate Rules', 'Allow half-day computation when hours fall below the threshold.'],
    ['daily_half_day_threshold_hours', '4', 'Daily Rate Rules', 'Hours threshold for half-day.'],
    ['hourly_standard_hours_per_day', '8', 'Hourly Rules', 'Standard regular hours per day.'],
    ['hourly_break_deduction_hours', '0', 'Hourly Rules', 'Break hours deducted per attendance day.'],
    ['hourly_overtime_threshold', '8', 'Hourly Rules', 'Hours per day before overtime.'],
    ['hourly_maximum_regular_hours', '8', 'Hourly Rules', 'Maximum regular payable hours per day.'],
    ['hourly_round_off_rule', 'none', 'Hourly Rules', 'Round off rule: none, nearest_quarter, nearest_half.'],
    ['hourly_require_hr_validation', 'true', 'Hourly Rules', 'Hourly payroll requires HR validation.'],
    ['hourly_require_payroll_ready_attendance', 'true', 'Hourly Rules', 'Hourly payroll requires payroll-ready attendance.'],
    ['monthly_conversion_method', 'weekly_from_monthly', 'Monthly Rules', 'Monthly conversion: weekly_from_monthly or daily_equivalent.'],
    ['monthly_working_days_per_month', '26', 'Monthly Rules', 'Working days per month for daily-equivalent monthly payroll.']
  ];
  for (const row of policyDefaults) {
    await pool.execute(`
      INSERT INTO payroll_policy_settings (setting_key, setting_value, setting_group, description)
      SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM payroll_policy_settings WHERE setting_key = ?)
    `, [...row, row[0]]);
  }

  const wageTypeDefaults = [
    ['Monthly', 'Monthly salary converted for weekly payroll'],
    ['Daily', 'Daily rate based on approved days worked'],
    ['Hourly', 'Hourly rate based on approved hours worked'],
    ['Piece Rate', 'Production output-based payroll'],
    ['Logistics', 'Delivery trip/output-based payroll'],
    ['Trip-Based', 'Logistics: paid from approved delivery trips']
  ];
  for (const row of wageTypeDefaults) {
    await pool.execute(`
      INSERT INTO wage_types (name, description)
      SELECT ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM wage_types WHERE LOWER(name) = LOWER(?))
    `, [row[0], row[1], row[0]]);
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_logistics_rates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      logistics_region_id INT NOT NULL,
      truck_type VARCHAR(80) NOT NULL DEFAULT 'Standard Truck',
      position VARCHAR(40) NOT NULL,
      rate DECIMAL(12,2) NOT NULL DEFAULT 0,
      effective_date DATE NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_logistics_rate_lookup (logistics_region_id, truck_type, position, is_active, effective_date)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_sew_types (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(40) NOT NULL,
      description VARCHAR(255) NULL,
      effective_date DATE NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payroll_sew_type_code_date (code, effective_date),
      INDEX idx_sew_type_active (is_active, effective_date)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_size_ranges (
      id INT AUTO_INCREMENT PRIMARY KEY,
      size_range VARCHAR(40) NOT NULL,
      description VARCHAR(255) NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_payroll_size_range (size_range),
      INDEX idx_size_range_active (is_active)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_piece_rates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      product_type VARCHAR(120) NOT NULL,
      product_category VARCHAR(120) NULL,
      piece_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
      effective_date DATE NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_piece_rate_active (is_active, effective_date),
      INDEX idx_piece_rate_product (product_type, product_category)
    )
  `);

  await ensureColumn('payroll_piece_rates', 'sew_type_code', 'VARCHAR(40) NULL AFTER product_category');
  await ensureColumn('payroll_piece_rates', 'size_range', 'VARCHAR(40) NULL AFTER sew_type_code');

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_production_shares (
      id INT AUTO_INCREMENT PRIMARY KEY,
      worker_category VARCHAR(80) NOT NULL,
      percentage_share DECIMAL(6,2) NOT NULL DEFAULT 0,
      effective_date DATE NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_share_active (is_active, effective_date),
      INDEX idx_share_category (worker_category)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_production_split_configs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      split_name VARCHAR(120) NOT NULL,
      sewer_percentage DECIMAL(6,2) NOT NULL DEFAULT 0,
      fixer_percentage DECIMAL(6,2) NOT NULL DEFAULT 0,
      effective_date DATE NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_piece_split_active (is_active, effective_date)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_production_share_rules (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pairing_type ENUM('Standard Sewer-Fixer','Substitute Sewer-Sewer') NOT NULL,
      worker1_share DECIMAL(6,2) NOT NULL DEFAULT 0,
      worker2_share DECIMAL(6,2) NOT NULL DEFAULT 0,
      effective_date DATE NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_pair_rule_active (is_active, effective_date),
      INDEX idx_pair_rule_type (pairing_type)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_piece_incentives (
      id INT AUTO_INCREMENT PRIMARY KEY,
      incentive_name VARCHAR(120) NOT NULL,
      incentive_category ENUM('Quota Incentive','Sunday Work Incentive','Special Sewing Type Incentive') NOT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      threshold_quantity INT NULL,
      sewing_type VARCHAR(120) NULL,
      computation_type ENUM('Fixed Amount','Percentage Multiplier') NOT NULL DEFAULT 'Fixed Amount',
      effective_date DATE NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_incentive_active (is_active, effective_date),
      INDEX idx_incentive_category (incentive_category)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_production_outputs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NULL,
      payroll_period VARCHAR(7) NOT NULL,
      product_type VARCHAR(120) NOT NULL,
      product_category VARCHAR(120) NULL,
      sew_type_code VARCHAR(40) NULL,
      size_range VARCHAR(40) NULL,
      worker_category VARCHAR(80) NOT NULL,
      quantity_produced INT NOT NULL DEFAULT 0,
      piece_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
      production_value DECIMAL(12,2) NOT NULL DEFAULT 0,
      share_percentage DECIMAL(6,2) NOT NULL DEFAULT 0,
      quota_incentive DECIMAL(12,2) NOT NULL DEFAULT 0,
      sunday_incentive DECIMAL(12,2) NOT NULL DEFAULT 0,
      special_incentive DECIMAL(12,2) NOT NULL DEFAULT 0,
      final_gross_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
      output_date DATE NOT NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_production_period (payroll_period, output_date),
      INDEX idx_production_employee (employee_id)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_production_pairs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      production_date DATE NOT NULL,
      payroll_period VARCHAR(7) NOT NULL,
      worker1_employee_id INT NOT NULL,
      worker2_employee_id INT NOT NULL,
      pairing_type ENUM('Standard Sewer-Fixer','Substitute Sewer-Sewer') NOT NULL,
      product_type VARCHAR(120) NOT NULL,
      product_category VARCHAR(120) NULL,
      sew_type_code VARCHAR(40) NULL,
      size_range VARCHAR(40) NULL,
      quantity_produced INT NOT NULL DEFAULT 0,
      piece_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
      production_value DECIMAL(12,2) NOT NULL DEFAULT 0,
      worker1_share DECIMAL(6,2) NOT NULL DEFAULT 0,
      worker2_share DECIMAL(6,2) NOT NULL DEFAULT 0,
      worker1_earnings DECIMAL(12,2) NOT NULL DEFAULT 0,
      worker2_earnings DECIMAL(12,2) NOT NULL DEFAULT 0,
      rule_snapshot JSON NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_pair_period (payroll_period, production_date),
      INDEX idx_pair_workers (worker1_employee_id, worker2_employee_id)
    )
  `);

  // Daily sewing outputs are kept separate from their employee shares.  This
  // preserves the actual production amount while making partner splits auditable.
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS piece_rate_outputs (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      payroll_period_id VARCHAR(20) NOT NULL,
      output_date DATE NOT NULL,
      sew_type_id BIGINT NULL,
      operation_type VARCHAR(40) NOT NULL,
      size_range VARCHAR(40) NULL,
      quantity_produced DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      rate_per_piece DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      full_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      output_mode ENUM('solo','partner') NOT NULL DEFAULT 'solo',
      split_rule VARCHAR(40) NOT NULL DEFAULT 'SOLO',
      status VARCHAR(30) NOT NULL DEFAULT 'Draft',
      created_by BIGINT NULL,
      approved_by BIGINT NULL,
      approved_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_piece_rate_outputs_period_date (payroll_period_id, output_date),
      INDEX idx_piece_rate_outputs_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS piece_rate_output_shares (
      id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      piece_rate_output_id BIGINT NOT NULL,
      employee_id BIGINT NOT NULL,
      partner_role VARCHAR(40) NOT NULL,
      share_percentage DECIMAL(5,2) NOT NULL DEFAULT 0.00,
      share_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_piece_rate_output_shares_output
        FOREIGN KEY (piece_rate_output_id) REFERENCES piece_rate_outputs(id) ON DELETE CASCADE,
      INDEX idx_piece_rate_output_shares_employee (employee_id, piece_rate_output_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await ensureColumn('payroll_production_outputs', 'sew_type_code', 'VARCHAR(40) NULL AFTER product_category');
  await ensureColumn('payroll_production_outputs', 'size_range', 'VARCHAR(40) NULL AFTER sew_type_code');
  await ensureColumn('payroll_production_outputs', 'remarks', 'VARCHAR(255) NULL AFTER final_gross_pay');
  await ensureColumn('payroll_production_outputs', 'status', "VARCHAR(30) NOT NULL DEFAULT 'Approved' AFTER remarks");
  await ensureColumn('payroll_production_outputs', 'payroll_run_id', 'INT NULL AFTER status');
  await ensureColumn('payroll_production_outputs', 'approved_by', 'INT NULL AFTER payroll_run_id');
  await ensureColumn('payroll_production_outputs', 'approved_at', 'DATETIME NULL AFTER approved_by');
  await ensureColumn('payroll_production_outputs', 'paid_at', 'DATETIME NULL AFTER approved_at');
  await ensureColumn('payroll_production_outputs', 'updated_by', 'INT NULL AFTER paid_at');
  await ensureColumn('payroll_production_pairs', 'sew_type_code', 'VARCHAR(40) NULL AFTER product_category');
  await ensureColumn('payroll_production_pairs', 'size_range', 'VARCHAR(40) NULL AFTER sew_type_code');
  await ensureColumn('payroll_production_pairs', 'status', "VARCHAR(30) NOT NULL DEFAULT 'Approved' AFTER rule_snapshot");
  await ensureColumn('payroll_production_pairs', 'payroll_run_id', 'INT NULL AFTER status');
  await ensureColumn('payroll_production_pairs', 'approved_by', 'INT NULL AFTER payroll_run_id');
  await ensureColumn('payroll_production_pairs', 'approved_at', 'DATETIME NULL AFTER approved_by');
  await ensureColumn('payroll_production_pairs', 'paid_at', 'DATETIME NULL AFTER approved_at');
  await ensureColumn('payroll_production_pairs', 'updated_by', 'INT NULL AFTER paid_at');
  if (await payrollTableExists(pool, 'delivery_trips')) {
    await ensureColumn('delivery_trips', 'output_quantity', 'DECIMAL(10,2) NOT NULL DEFAULT 1 AFTER plate_number');
    await ensureColumn('delivery_trips', 'paid_at', 'DATETIME NULL AFTER approved_at');
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_piece_incentive_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      payroll_period VARCHAR(7) NOT NULL,
      incentive_type ENUM('Quota Incentive','Sunday Work Incentive','Special Sewing Incentive') NOT NULL,
      amount DECIMAL(12,2) NOT NULL DEFAULT 0,
      remarks VARCHAR(255) NULL,
      created_by INT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_piece_incentive_entry_employee (employee_id, payroll_period),
      INDEX idx_piece_incentive_entry_period (payroll_period)
    )
  `);

  const [shares] = await pool.execute('SELECT COUNT(*) AS count FROM payroll_production_shares WHERE is_active = 1');
  if (!Number(shares[0].count)) {
    const today = new Date().toISOString().split('T')[0];
    await pool.execute(
      `INSERT INTO payroll_production_shares (worker_category, percentage_share, effective_date, is_active)
       VALUES ('Sewer', 55, ?, 1), ('Fixer', 45, ?, 1)`,
      [today, today]
    );
  }

  const [splitConfigs] = await pool.execute('SELECT COUNT(*) AS count FROM payroll_production_split_configs');
  if (!Number(splitConfigs[0].count)) {
    const today = new Date().toISOString().split('T')[0];
    await pool.execute(
      `INSERT INTO payroll_production_split_configs
        (split_name, sewer_percentage, fixer_percentage, effective_date, is_active)
       VALUES ('SEWING', 55, 45, ?, 1)`,
      [today]
    );
  }

  const [pairRules] = await pool.execute('SELECT COUNT(*) AS count FROM payroll_production_share_rules WHERE is_active = 1');
  if (!Number(pairRules[0].count)) {
    const today = new Date().toISOString().split('T')[0];
    await pool.execute(
      `INSERT INTO payroll_production_share_rules
         (pairing_type, worker1_share, worker2_share, effective_date, is_active)
       VALUES
         ('Standard Sewer-Fixer', 55, 45, ?, 1),
         ('Substitute Sewer-Sewer', 50, 50, ?, 1)`,
      [today, today]
    );
  }

  const today = new Date().toISOString().split('T')[0];
  const [sewTypes] = await pool.execute('SELECT COUNT(*) AS count FROM payroll_sew_types');
  if (!Number(sewTypes[0].count)) {
    await pool.execute(
      `INSERT INTO payroll_sew_types (code, description, effective_date, is_active)
       VALUES
         ('UL', 'UL sewing operation', ?, 1),
         ('MS', 'MS sewing operation', ?, 1),
         ('HL', 'HL sewing operation', ?, 1),
         ('AL', 'AL sewing operation', ?, 1),
         ('DF', 'DF sewing operation', ?, 1)`,
      [today, today, today, today, today]
    );
  }

  const [sizeRanges] = await pool.execute('SELECT COUNT(*) AS count FROM payroll_size_ranges');
  if (!Number(sizeRanges[0].count)) {
    await pool.execute(
      `INSERT INTO payroll_size_ranges (size_range, description, is_active)
       VALUES
         ('14-19', 'Size range 14-19', 1),
         ('20-23', 'Size range 20-23', 1),
         ('24-26', 'Size range 24-26', 1),
         ('27-29', 'Size range 27-29', 1)`,
    );
  }
}

async function activePieceRate(pool, productType, productCategory, dateValue) {
  const date = dateValue || new Date().toISOString().split('T')[0];
  const sewTypeCode = String(productType || '').trim();
  const sizeRange = String(productCategory || '').trim();
  const [rows] = await pool.execute(`
    SELECT *
      FROM payroll_piece_rates
     WHERE is_active = 1
       AND (
          sew_type_code = ?
          OR product_type = ?
       )
       AND (
          size_range = ?
          OR product_category = ?
          OR ((size_range IS NULL OR size_range = '') AND (product_category IS NULL OR product_category = ''))
       )
       AND effective_date <= ?
     ORDER BY
       CASE WHEN sew_type_code = ? THEN 0 ELSE 1 END,
       CASE WHEN size_range = ? THEN 0 ELSE 1 END,
       effective_date DESC,
       id DESC
     LIMIT 1
  `, [sewTypeCode, sewTypeCode, sizeRange, sizeRange, date, sewTypeCode, sizeRange]);
  return rows[0] || null;
}

async function getEmployeeProductionRole(pool, employeeId) {
  const [rows] = await pool.execute(`
    SELECT e.id, e.employee_code, e.first_name, e.last_name,
           COALESCE(e.position, '') AS position,
           w.name AS wage_type
      FROM employees e
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
     WHERE e.id = ?
     LIMIT 1
  `, [employeeId]);
  const employee = rows[0];
  if (!employee) throw new Error('Selected worker was not found.');
  const position = String(employee.position || '').toLowerCase();
  const role = position.includes('fixer') ? 'Fixer' : position.includes('sewer') ? 'Sewer' : '';
  return { ...employee, production_role: role };
}

async function activeProductionShares(pool, dateValue) {
  const date = dateValue || new Date().toISOString().split('T')[0];
  const [rows] = await pool.execute(`
    SELECT worker_category, percentage_share, effective_date
      FROM payroll_production_shares
     WHERE is_active = 1 AND effective_date <= ?
     ORDER BY effective_date DESC, worker_category
  `, [date]);
  const latestByCategory = new Map();
  rows.forEach(row => {
    if (!latestByCategory.has(row.worker_category)) latestByCategory.set(row.worker_category, row);
  });
  return [...latestByCategory.values()];
}

async function activeProductionSplit(pool, dateValue) {
  await ensurePieceRatePayrollSchema(pool);
  const date = dateValue || new Date().toISOString().split('T')[0];
  const [activeCount] = await pool.execute(
    'SELECT COUNT(*) AS count FROM payroll_production_split_configs WHERE is_active = 1'
  );
  if (Number(activeCount[0]?.count || 0) > 1) {
    throw new Error('Multiple active production split configurations exist. Keep only one active split configuration.');
  }
  const [rows] = await pool.execute(`
    SELECT *
      FROM payroll_production_split_configs
     WHERE is_active = 1
       AND effective_date <= ?
     ORDER BY effective_date DESC, id DESC
     LIMIT 1
  `, [date]);
  const split = rows[0] || null;
  if (!split) throw new Error('Split Configuration is missing.');
  const sewer = Number(split.sewer_percentage || 0);
  const fixer = Number(split.fixer_percentage || 0);
  if (!(sewer > 0) || !(fixer > 0)) throw new Error('Sewer and Fixer percentages must be greater than zero.');
  if (Math.abs(sewer + fixer - 100) > 0.001) throw new Error('Split Configuration total must equal 100%.');
  return split;
}

async function activePieceIncentives(pool, dateValue) {
  const date = dateValue || new Date().toISOString().split('T')[0];
  const [rows] = await pool.execute(`
    SELECT *
      FROM payroll_piece_incentives
     WHERE is_active = 1 AND effective_date <= ?
     ORDER BY effective_date DESC, threshold_quantity DESC, amount DESC
  `, [date]);
  return rows;
}

async function activeProductionPairRule(pool, pairingType, dateValue) {
  const date = dateValue || new Date().toISOString().split('T')[0];
  const [rows] = await pool.execute(`
    SELECT *
      FROM payroll_production_share_rules
     WHERE is_active = 1 AND pairing_type = ? AND effective_date <= ?
     ORDER BY effective_date DESC, id DESC
     LIMIT 1
  `, [pairingType, date]);
  return rows[0] || null;
}

async function computeProductionPairPayroll(pool, input) {
  await ensurePieceRatePayrollSchema(pool);
  const productionDate = input.production_date || new Date().toISOString().split('T')[0];
  const sewTypeCode = String(input.sew_type_code || input.product_type || '').trim();
  const sizeRange = String(input.size_range || input.product_category || '').trim();
  const pairingType = String(input.pairing_type || '').trim();
  const quantity = Math.max(0, parseInt(input.quantity_produced || 0, 10) || 0);
  if (!sewTypeCode) throw new Error('Type of Sew is required.');
  if (!sizeRange) throw new Error('Size Range is required.');
  if (!['Standard Sewer-Fixer', 'Substitute Sewer-Sewer'].includes(pairingType)) throw new Error('Valid pairing type is required.');
  if (!quantity) throw new Error('Quantity produced is required.');
  if (!input.worker1_employee_id || !input.worker2_employee_id) throw new Error('Worker 1 and Worker 2 are required.');
  if (String(input.worker1_employee_id) === String(input.worker2_employee_id)) throw new Error('Worker 1 and Worker 2 must be different employees.');

  const worker1 = await getEmployeeProductionRole(pool, input.worker1_employee_id);
  const worker2 = await getEmployeeProductionRole(pool, input.worker2_employee_id);
  if (worker1.production_role !== 'Sewer') throw new Error('Worker 1 must be classified as Sewer.');
  if (pairingType === 'Standard Sewer-Fixer' && worker2.production_role !== 'Fixer') {
    throw new Error('Standard pairing requires Worker 2 to be classified as Fixer.');
  }
  if (pairingType === 'Substitute Sewer-Sewer' && worker2.production_role !== 'Sewer') {
    throw new Error('Substitute pairing requires Worker 2 to be another Sewer.');
  }

  const rate = await activePieceRate(pool, sewTypeCode, sizeRange, productionDate);
  if (!rate) throw new Error('No active piece rate found for the selected Type of Sew, Size Range, and date.');
  let rule = await activeProductionPairRule(pool, pairingType, productionDate);
  let splitConfig = null;
  if (pairingType === 'Standard Sewer-Fixer') {
    splitConfig = await activeProductionSplit(pool, productionDate);
    rule = {
      ...(rule || {}),
      pairing_type: pairingType,
      worker1_share: Number(splitConfig.sewer_percentage || 0),
      worker2_share: Number(splitConfig.fixer_percentage || 0),
      effective_date: splitConfig.effective_date,
      split_name: splitConfig.split_name
    };
  }
  if (!rule) throw new Error('No active production share rule found for this pairing type.');
  const totalShare = Number(rule.worker1_share || 0) + Number(rule.worker2_share || 0);
  if (Math.abs(totalShare - 100) > 0.001) throw new Error('Production share rule must total exactly 100%.');

  const productionValue = quantity * Number(rate.piece_rate || 0);
  return {
    production_date: productionDate,
    payroll_period: input.payroll_period || productionDate.slice(0, 7),
    worker1_employee_id: Number(input.worker1_employee_id),
    worker2_employee_id: Number(input.worker2_employee_id),
    pairing_type: pairingType,
    product_type: sewTypeCode,
    product_category: sizeRange,
    sew_type_code: sewTypeCode,
    size_range: sizeRange,
    quantity_produced: quantity,
    piece_rate: Number(rate.piece_rate || 0),
    production_value: productionValue,
    worker1_share: Number(rule.worker1_share || 0),
    worker2_share: Number(rule.worker2_share || 0),
    worker1_earnings: productionValue * (Number(rule.worker1_share || 0) / 100),
    worker2_earnings: productionValue * (Number(rule.worker2_share || 0) / 100),
    rule_snapshot: { rate, rule, split_config: splitConfig, worker1, worker2 }
  };
}

async function computePieceRatePayroll(pool, input) {
  await ensurePieceRatePayrollSchema(pool);
  const outputDate = input.output_date || input.calculation_date || new Date().toISOString().split('T')[0];
  const quantity = Math.max(0, parseInt(input.quantity_produced ?? input.quantity ?? 0, 10) || 0);
  const productType = String(input.sew_type_code || input.product_type || '').trim();
  const productCategory = String(input.size_range || input.product_category || '').trim();
  const workerCategory = String(input.worker_category || '').trim();
  if (!productType) throw new Error('Type of Sew is required for piece-rate payroll.');
  if (!productCategory) throw new Error('Size Range is required for piece-rate payroll.');
  if (!workerCategory) throw new Error('Worker category is required for piece-rate payroll.');
  if (!quantity) throw new Error('Quantity produced is required for piece-rate payroll.');

  const rate = await activePieceRate(pool, productType, productCategory, outputDate);
  if (!rate) throw new Error('No active piece rate found for the selected Type of Sew, Size Range, and date.');

  const shares = await activeProductionShares(pool, outputDate);
  const totalShare = shares.reduce((sum, row) => sum + Number(row.percentage_share || 0), 0);
  if (Math.abs(totalShare - 100) > 0.001) throw new Error('Active production share percentages must total exactly 100%.');
  const share = shares.find(row => row.worker_category.toLowerCase() === workerCategory.toLowerCase());
  if (!share) throw new Error('No active production share found for this worker category.');

  const productionValue = quantity * Number(rate.piece_rate || 0);
  const shareEarnings = productionValue * (Number(share.percentage_share || 0) / 100);
  const incentives = await activePieceIncentives(pool, outputDate);
  const quota = incentives
    .filter(item => item.incentive_category === 'Quota Incentive' && Number(item.threshold_quantity || 0) <= quantity)
    .sort((a, b) => Number(b.threshold_quantity || 0) - Number(a.threshold_quantity || 0))[0];
  const sunday = input.is_sunday
    ? incentives.find(item => item.incentive_category === 'Sunday Work Incentive')
    : null;
  const special = incentives.find(item =>
    item.incentive_category === 'Special Sewing Type Incentive'
    && (!item.sewing_type || item.sewing_type.toLowerCase() === productCategory.toLowerCase() || item.sewing_type.toLowerCase() === productType.toLowerCase())
  );

  const sundayAmount = sunday
    ? sunday.computation_type === 'Percentage Multiplier'
      ? shareEarnings * (Number(sunday.amount || 0) / 100)
      : Number(sunday.amount || 0)
    : 0;
  const quotaAmount = quota ? Number(quota.amount || 0) : 0;
  const specialAmount = special ? Number(special.amount || 0) : 0;

  return {
    product_type: productType,
    product_category: productCategory,
    sew_type_code: productType,
    size_range: productCategory,
    worker_category: share.worker_category,
    quantity_produced: quantity,
    piece_rate: Number(rate.piece_rate || 0),
    production_value: productionValue,
    share_percentage: Number(share.percentage_share || 0),
    gross_production_earnings: shareEarnings,
    quota_incentive: quotaAmount,
    sunday_incentive: sundayAmount,
    special_incentive: specialAmount,
    final_gross_pay: shareEarnings + quotaAmount + sundayAmount + specialAmount,
    output_date: outputDate,
    config_snapshot: { rate, share, quota: quota || null, sunday: sunday || null, special: special || null }
  };
}

async function getApprovedPieceRatePayroll(pool, employeeId, period) {
  await ensurePieceRatePayrollSchema(pool);
  const [outputs] = await pool.execute(`
    SELECT id, output_date, payroll_period, product_type, product_category, sew_type_code, size_range,
           worker_category, quantity_produced, piece_rate, production_value, share_percentage,
           quota_incentive, sunday_incentive, special_incentive, final_gross_pay
      FROM payroll_production_outputs
     WHERE employee_id = ?
       AND output_date BETWEEN ? AND ?
       AND status = 'Approved'
       AND payroll_run_id IS NULL
     ORDER BY output_date, id
  `, [employeeId, period.start, period.end]);

  const [pairs] = await pool.execute(`
    SELECT id, production_date, payroll_period, pairing_type, product_type, product_category,
           sew_type_code, size_range, quantity_produced, piece_rate, production_value,
           worker1_employee_id, worker2_employee_id, worker1_share, worker2_share,
           worker1_earnings, worker2_earnings
      FROM payroll_production_pairs
     WHERE (worker1_employee_id = ? OR worker2_employee_id = ?)
       AND production_date BETWEEN ? AND ?
       AND status = 'Approved'
       AND payroll_run_id IS NULL
     ORDER BY production_date, id
  `, [employeeId, employeeId, period.start, period.end]);

  const directRecords = outputs.map(row => ({
    id: row.id,
    source: 'output',
    date: row.output_date,
    role: row.worker_category,
    quantity: numeric(row.quantity_produced),
    piece_rate: numeric(row.piece_rate),
    gross_pay: numeric(row.final_gross_pay),
    details: row
  }));
  const pairRecords = pairs.map(row => {
    const isWorker1 = Number(row.worker1_employee_id) === Number(employeeId);
    return {
      id: row.id,
      source: 'pair',
      date: row.production_date,
      role: isWorker1 ? 'Sewer' : 'Fixer',
      quantity: numeric(row.quantity_produced),
      piece_rate: numeric(row.piece_rate),
      gross_pay: numeric(isWorker1 ? row.worker1_earnings : row.worker2_earnings),
      share_percentage: numeric(isWorker1 ? row.worker1_share : row.worker2_share),
      details: row
    };
  });
  const records = [...directRecords, ...pairRecords];
  const total = roundMoney(records.reduce((sum, row) => sum + numeric(row.gross_pay), 0));
  const quantity = records.reduce((sum, row) => sum + numeric(row.quantity), 0);
  const productionValue = records.reduce((sum, row) => sum + numeric(row.quantity) * numeric(row.piece_rate), 0);
  return {
    outputs,
    pairs,
    records,
    total,
    quantity,
    average_rate: quantity > 0 ? roundMoney(productionValue / quantity) : 0
  };
}

function deductionBreakdown(applied = []) {
  const result = { sss: 0, pagibig: 0, philhealth: 0 };
  for (const item of applied) {
    const name = String(item.name || item.deduction_name || item.category || '').toLowerCase();
    const amount = numeric(item.amount);
    if (name.includes('sss')) result.sss += amount;
    else if (name.includes('pag') || name.includes('hdmf')) result.pagibig += amount;
    else if (name.includes('phil') || name.includes('phic')) result.philhealth += amount;
  }
  return result;
}

function summarizePayrollSource(snapshot = {}) {
  const wageType = normalizePayrollWageType(snapshot.wage_type || snapshot.pay_type);
  if (wageType === 'Monthly') {
    return `${snapshot.monthly_conversion_method === 'daily_equivalent'
      ? `${numeric(snapshot.monthly_salary).toFixed(2)} / ${snapshot.working_days_per_month || 26} × ${snapshot.days_worked || 0} day(s)`
      : `${numeric(snapshot.monthly_salary).toFixed(2)} / 4 weekly conversion`}`;
  }
  if (wageType === 'Daily') return `${snapshot.days_worked || 0} approved day(s) × ${peso(snapshot.daily_rate || snapshot.base_rate)}`;
  if (wageType === 'Hourly') return `${snapshot.hours_worked || 0} approved hour(s) × ${peso(snapshot.hourly_rate || snapshot.base_rate)}`;
  if (wageType === 'Per-Piece') return `${snapshot.output_quantity || snapshot.quantity || 0} approved piece/output qty`;
  if (wageType === 'Per-Trip') return `${snapshot.trip_count || 0} approved trip output(s)`;
  return 'Payroll source details';
}

async function createSalaryCalculationRecord(pool, req, input) {
  const deductions = deductionBreakdown(input.deductions?.applied || []);
  const snapshot = {
    ...input.snapshot,
    wage_type: input.wage_type,
    pay_type: input.wage_type,
    period_start: input.period.start,
    period_end: input.period.end,
    total_allowances: input.allowances?.total || 0,
    deductions: input.deductions?.applied || []
  };
  const sourceRecordIds = JSON.stringify(input.source_record_ids || []);
  const validationSnapshot = JSON.stringify(snapshot);
  const [result] = await pool.execute(`
    INSERT INTO salary_calculations (
      employee_id, wage_type_id, payroll_run_id, base_rate, quantity,
      housing_allowance, meal_allowance, transport_allowance, bonus_allowance, total_allowances,
      overtime_hours, overtime_amount, gross_pay,
      sss_deduction, pagibig_deduction, philhealth_deduction, total_deductions,
      net_pay, calculation_date, notes, status, hours_worked, days_worked, daily_rate, hourly_rate,
      payroll_period, period_start, period_end, agency_name, validation_snapshot,
      source_type, source_record_ids, calculated_by, submitted_at, employee_deduction_total
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
  `, [
    input.employee_id,
    input.wage_type_id,
    input.payroll_run_id,
    roundMoney(input.base_rate),
    numeric(input.quantity),
    0,
    0,
    0,
    0,
    roundMoney(input.allowances?.total || 0),
    numeric(input.overtime_hours),
    roundMoney(input.overtime_amount),
    roundMoney(input.gross_pay),
    roundMoney(deductions.sss),
    roundMoney(deductions.pagibig),
    roundMoney(deductions.philhealth),
    roundMoney(input.total_deductions),
    roundMoney(input.net_pay),
    input.period.end,
    summarizePayrollSource(snapshot),
    numeric(input.hours_worked),
    numeric(input.days_worked),
    roundMoney(input.daily_rate),
    roundMoney(input.hourly_rate),
    input.period.month_year,
    input.period.start,
    input.period.end,
    input.agency_name || null,
    validationSnapshot,
    input.source_type,
    sourceRecordIds,
    currentUserId(req),
    roundMoney(input.deductions?.employeeTotal || 0)
  ]);
  const salaryCalculationId = result.insertId;
  const blockchainQueue = await queueSubmittedPayrollRecord(pool, req, salaryCalculationId);
  await logPayrollAudit(pool, req, 'salary_calculation_submitted', {
    employee_id: input.employee_id,
    payroll_run_id: input.payroll_run_id,
    salary_calculation_id: salaryCalculationId,
    remarks: 'Submitted payroll calculation for approval.',
    metadata: { blockchain_queue: blockchainQueue, source_type: input.source_type }
  });
  return salaryCalculationId;
}

async function markAttendanceRowsPaid(pool, attendanceRows, payrollRunId) {
  const ids = attendanceRows.map(row => row.summary_id || row.id).filter(Boolean);
  if (!ids.length) return;
  const columns = await payrollTableColumns(pool, 'attendance_summary');
  const keyColumn = columns.has('summary_id') ? 'summary_id' : columns.has('id') ? 'id' : null;
  if (!keyColumn) return;
  await pool.execute(`
    UPDATE attendance_summary
       SET payroll_run_id = ?, paid_at = NOW()
     WHERE ${keyColumn} IN (${ids.map(() => '?').join(', ')})
       AND payroll_run_id IS NULL
  `, [payrollRunId, ...ids]);
}

async function markPieceRecordsPaid(pool, piecePayroll, payrollRunId, userId) {
  const outputIds = piecePayroll.outputs.map(row => row.id);
  if (outputIds.length) {
    await pool.execute(`
      UPDATE payroll_production_outputs
         SET status = 'Paid', payroll_run_id = ?, paid_at = NOW(), updated_by = ?
       WHERE id IN (${outputIds.map(() => '?').join(', ')})
         AND status = 'Approved'
         AND payroll_run_id IS NULL
    `, [payrollRunId, userId, ...outputIds]);
  }
  const pairIds = piecePayroll.pairs.map(row => row.id);
  if (pairIds.length) {
    await pool.execute(`
      UPDATE payroll_production_pairs
         SET status = 'Paid', payroll_run_id = ?, paid_at = NOW(), updated_by = ?
       WHERE id IN (${pairIds.map(() => '?').join(', ')})
         AND status = 'Approved'
         AND payroll_run_id IS NULL
    `, [payrollRunId, userId, ...pairIds]);
  }
}

async function markDeliveryTripsPaid(pool, trips, payrollRunId, userId) {
  const ids = trips.map(row => row.id).filter(Boolean);
  if (!ids.length) return;
  await pool.execute(`
    UPDATE delivery_trips
       SET status = 'Paid', payroll_run_id = ?, paid_at = NOW(), updated_by = ?
     WHERE id IN (${ids.map(() => '?').join(', ')})
       AND status = 'Approved'
       AND payroll_run_id IS NULL
  `, [payrollRunId, userId, ...ids]);
}

// Get all wage types
router.get('/wage-types', requireAuth, async (req, res) => {
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute('SELECT * FROM wage_types ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error('Error fetching wage types:', err);
    res.status(500).json({ error: 'Failed to fetch wage types' });
  }
});

router.get('/agencies', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const values = new Set();

    const addAgencyRows = rows => {
      rows.forEach(row => {
        const name = String(row.agency_name || '').trim();
        if (name) values.add(name);
      });
    };

    const [employeeAgencies] = await pool.execute(`
      SELECT DISTINCT agency_name
      FROM employees
      WHERE agency_name IS NOT NULL AND TRIM(agency_name) <> ''
      ORDER BY agency_name
    `);
    addAgencyRows(employeeAgencies);

    const [hasOnboarding] = await pool.execute(`
      SELECT COUNT(*) AS count
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'onboarding_applicant'
    `);
    if (Number(hasOnboarding[0]?.count || 0)) {
      const [onboardingAgencies] = await pool.execute(`
        SELECT DISTINCT agency_name
        FROM onboarding_applicant
        WHERE agency_name IS NOT NULL AND TRIM(agency_name) <> ''
        ORDER BY agency_name
      `);
      addAgencyRows(onboardingAgencies);
    }

    const [hasSalaryAgencies] = await pool.execute(`
      SELECT COUNT(*) AS count
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'salary_calculations'
        AND COLUMN_NAME = 'agency_name'
    `);
    if (Number(hasSalaryAgencies[0]?.count || 0)) {
      const [salaryAgencies] = await pool.execute(`
        SELECT DISTINCT agency_name
        FROM salary_calculations
        WHERE agency_name IS NOT NULL AND TRIM(agency_name) <> ''
        ORDER BY agency_name
      `);
      addAgencyRows(salaryAgencies);
    }

    res.json([...values].sort((a, b) => a.localeCompare(b)).map(name => ({ name })));
  } catch (err) {
    console.error('Error fetching payroll agencies:', err);
    res.status(500).json({ error: 'Failed to fetch agencies.' });
  }
});

// Get sewing types (production)
router.get('/sewing-types', requireAuth, async (req, res) => {
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute(`
      SELECT id, name, description, default_rate 
      FROM sewing_types 
      ORDER BY name
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching sewing types:', err);
    res.status(500).json({ error: 'Failed to fetch sewing types' });
  }
});

// Get logistics regions
router.get('/logistics-regions', requireAuth, async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const [rows] = await pool.execute(`
      SELECT id, name, code, description, default_rate 
      FROM logistics_regions 
      ORDER BY name
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching logistics regions:', err);
    res.status(500).json({ error: 'Failed to fetch logistics regions' });
  }
});

router.get('/logistics-rates', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const [rows] = await pool.execute(`
      SELECT plr.*, lr.name AS region_name
        FROM payroll_logistics_rates plr
        JOIN logistics_regions lr ON lr.id = plr.logistics_region_id
       ORDER BY plr.is_active DESC, plr.effective_date DESC, lr.name, plr.truck_type, plr.position
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching logistics rates:', err);
    res.status(500).json({ error: 'Failed to fetch logistics rates' });
  }
});

router.get('/policy-settings', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const policy = await getPayrollPolicy(pool);
    const [rows] = await pool.execute('SELECT * FROM payroll_policy_settings ORDER BY setting_group, setting_key');
    res.json({ policy, settings: rows });
  } catch (err) {
    console.error('Error loading payroll policy settings:', err);
    res.status(500).json({ error: 'Failed to load payroll policy settings.' });
  }
});

router.post('/policy-settings', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const settings = req.body?.settings || req.body || {};
    const allowed = new Set([
      'daily_require_hr_validation',
      'daily_use_payroll_ready_only',
      'daily_count_late',
      'daily_count_undertime',
      'daily_allow_half_day',
      'daily_half_day_threshold_hours',
      'hourly_standard_hours_per_day',
      'hourly_break_deduction_hours',
      'hourly_overtime_threshold',
      'hourly_maximum_regular_hours',
      'hourly_round_off_rule',
      'hourly_require_hr_validation',
      'hourly_require_payroll_ready_attendance'
    ]);

    for (const [key, value] of Object.entries(settings)) {
      if (!allowed.has(key)) continue;
      await pool.execute(
        'UPDATE payroll_policy_settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?',
        [String(value), currentUserId(req), key]
      );
    }
    await logPayrollAudit(pool, req, 'payroll_policy_updated', {
      remarks: 'Daily/hourly payroll policy settings updated.',
      metadata: { settings }
    });
    res.json({ message: 'Payroll policy settings saved.' });
  } catch (err) {
    console.error('Error saving payroll policy settings:', err);
    res.status(500).json({ error: 'Failed to save payroll policy settings.' });
  }
});

router.get('/employees/:id/payroll-validation', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const validation = await validateDailyHourlyPayroll(pool, {
      employee_id: req.params.id,
      payroll_period: req.query.payroll_period,
      calculation_date: req.query.calculation_date
    });
    res.json(validation);
  } catch (err) {
    console.error('Error validating daily/hourly payroll:', err);
    res.status(500).json({ error: 'Failed to validate payroll.' });
  }
});

router.post('/logistics-rates', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const logisticsRegionId = Number(req.body.logistics_region_id);
    const truckType = String(req.body.truck_type || 'Standard Truck').trim() || 'Standard Truck';
    const position = req.body.position === 'Driver' ? 'Driver' : 'Helper';
    const rate = Number(req.body.rate);
    const effectiveDate = req.body.effective_date || new Date().toISOString().split('T')[0];
    const isActive = req.body.is_active === false || req.body.is_active === '0' ? 0 : 1;
    if (!logisticsRegionId || !(rate > 0)) return res.status(400).json({ error: 'Region and rate greater than 0 are required.' });
    const [result] = await pool.execute(`
      INSERT INTO payroll_logistics_rates
        (logistics_region_id, truck_type, position, rate, effective_date, is_active, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [logisticsRegionId, truckType, position, rate, effectiveDate, isActive, currentUserId(req)]);
    await logPayrollAudit(pool, req, 'logistics_rate_configured', {
      remarks: `${position} ${truckType} logistics rate configured`,
      metadata: { logistics_region_id: logisticsRegionId, truck_type: truckType, position, rate, effective_date: effectiveDate, is_active: isActive }
    });
    res.json({ id: result.insertId, message: 'Logistics rate saved.' });
  } catch (err) {
    console.error('Error saving logistics rate:', err);
    res.status(500).json({ error: 'Failed to save logistics rate.' });
  }
});

// ── Approved delivery-trip payroll ────────────────────────────────────────
// This workflow is independent from legacy logistics_transactions. It is the
// authoritative source for new trip-based payroll calculations.
router.get('/logistics/truck-types', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const includeInactive = req.query.include_inactive === '1';
    const [rows] = await pool.execute(`
      SELECT id, name, description, is_active, created_at, updated_at
        FROM truck_types
       ${includeInactive ? '' : 'WHERE is_active = 1'}
       ORDER BY is_active DESC, name
    `);
    res.json(rows);
  } catch (err) {
    console.error('[logistics/truck-types:get]', err.message);
    res.status(500).json({ error: 'Failed to load truck types.' });
  }
});

router.post('/logistics/truck-types', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.configure), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const name = logisticsText(req.body.name, 'Truck type', 100, { required: true });
    const description = logisticsText(req.body.description, 'Description', 255);
    const [result] = await pool.execute(
      'INSERT INTO truck_types (name, description, is_active, created_by, updated_by) VALUES (?, ?, 1, ?, ?)',
      [name, description, currentUserId(req), currentUserId(req)]
    );
    await logPayrollAudit(pool, req, 'logistics_truck_type_created', { remarks: `Created truck type ${name}`, metadata: { new_value: { name, description } } });
    res.status(201).json({ id: result.insertId, message: 'Truck type created.' });
  } catch (err) {
    console.error('[logistics/truck-types:post]', err.message);
    res.status(err.code === 'ER_DUP_ENTRY' ? 409 : 400).json({ error: err.code === 'ER_DUP_ENTRY' ? 'Truck type already exists.' : err.message || 'Failed to create truck type.' });
  }
});

router.put('/logistics/truck-types/:id', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.configure), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const id = logisticsPositiveId(req.params.id, 'Truck type');
    const [existing] = await pool.execute('SELECT * FROM truck_types WHERE id = ? LIMIT 1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Truck type not found.' });
    const name = logisticsText(req.body.name, 'Truck type', 100, { required: true });
    const description = logisticsText(req.body.description, 'Description', 255);
    const isActive = req.body.is_active === false || req.body.is_active === '0' ? 0 : 1;
    await pool.execute('UPDATE truck_types SET name = ?, description = ?, is_active = ?, updated_by = ? WHERE id = ?', [name, description, isActive, currentUserId(req), id]);
    await logPayrollAudit(pool, req, 'logistics_truck_type_updated', { remarks: `Updated truck type ${name}`, metadata: { old_value: existing[0], new_value: { name, description, is_active: isActive } } });
    res.json({ message: 'Truck type updated.' });
  } catch (err) {
    console.error('[logistics/truck-types:put]', err.message);
    res.status(err.code === 'ER_DUP_ENTRY' ? 409 : 400).json({ error: err.code === 'ER_DUP_ENTRY' ? 'Truck type already exists.' : err.message || 'Failed to update truck type.' });
  }
});

router.delete('/logistics/truck-types/:id', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.configure), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const id = logisticsPositiveId(req.params.id, 'Truck type');
    const [existing] = await pool.execute('SELECT * FROM truck_types WHERE id = ? LIMIT 1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Truck type not found.' });
    await pool.execute('UPDATE truck_types SET is_active = 0, updated_by = ? WHERE id = ?', [currentUserId(req), id]);
    await logPayrollAudit(pool, req, 'logistics_truck_type_deactivated', { remarks: `Deactivated truck type ${existing[0].name}`, metadata: { old_value: existing[0], new_value: { is_active: 0 } } });
    res.json({ message: 'Truck type deactivated. Existing trip history was retained.' });
  } catch (err) {
    console.error('[logistics/truck-types:delete]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to deactivate truck type.') });
  }
});

router.get('/logistics/locations', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const includeInactive = req.query.include_inactive === '1';
    const [rows] = await pool.execute(`
      SELECT id, location_category, name, description, is_active, created_at, updated_at
        FROM logistics_locations
       ${includeInactive ? '' : 'WHERE is_active = 1'}
       ORDER BY is_active DESC, location_category, name
    `);
    res.json(rows);
  } catch (err) {
    console.error('[logistics/locations:get]', err.message);
    res.status(500).json({ error: 'Failed to load logistics locations.' });
  }
});

router.post('/logistics/locations', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.configure), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const locationCategory = logisticsText(req.body.location_category, 'Location category', 40, { required: true });
    if (!['Manila', 'Province', 'Special Location'].includes(locationCategory)) throw new Error('Location category must be Manila, Province, or Special Location.');
    const name = logisticsText(req.body.name, 'Specific location', 120, { required: true });
    const description = logisticsText(req.body.description, 'Description', 255);
    const [result] = await pool.execute(
      'INSERT INTO logistics_locations (location_category, name, description, is_active, created_by, updated_by) VALUES (?, ?, ?, 1, ?, ?)',
      [locationCategory, name, description, currentUserId(req), currentUserId(req)]
    );
    await logPayrollAudit(pool, req, 'logistics_location_created', { remarks: `Created logistics location ${name}`, metadata: { new_value: { location_category: locationCategory, name, description } } });
    res.status(201).json({ id: result.insertId, message: 'Logistics location created.' });
  } catch (err) {
    console.error('[logistics/locations:post]', err.message);
    res.status(err.code === 'ER_DUP_ENTRY' ? 409 : 400).json({ error: err.code === 'ER_DUP_ENTRY' ? 'Location already exists in this category.' : err.message || 'Failed to create logistics location.' });
  }
});

router.put('/logistics/locations/:id', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.configure), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const id = logisticsPositiveId(req.params.id, 'Location');
    const [existing] = await pool.execute('SELECT * FROM logistics_locations WHERE id = ? LIMIT 1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Logistics location not found.' });
    const locationCategory = logisticsText(req.body.location_category, 'Location category', 40, { required: true });
    if (!['Manila', 'Province', 'Special Location'].includes(locationCategory)) throw new Error('Location category must be Manila, Province, or Special Location.');
    const name = logisticsText(req.body.name, 'Specific location', 120, { required: true });
    const description = logisticsText(req.body.description, 'Description', 255);
    const isActive = req.body.is_active === false || req.body.is_active === '0' ? 0 : 1;
    await pool.execute('UPDATE logistics_locations SET location_category = ?, name = ?, description = ?, is_active = ?, updated_by = ? WHERE id = ?', [locationCategory, name, description, isActive, currentUserId(req), id]);
    await logPayrollAudit(pool, req, 'logistics_location_updated', { remarks: `Updated logistics location ${name}`, metadata: { old_value: existing[0], new_value: { location_category: locationCategory, name, description, is_active: isActive } } });
    res.json({ message: 'Logistics location updated.' });
  } catch (err) {
    console.error('[logistics/locations:put]', err.message);
    res.status(err.code === 'ER_DUP_ENTRY' ? 409 : 400).json({ error: err.code === 'ER_DUP_ENTRY' ? 'Location already exists in this category.' : err.message || 'Failed to update logistics location.' });
  }
});

router.delete('/logistics/locations/:id', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.configure), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const id = logisticsPositiveId(req.params.id, 'Location');
    const [existing] = await pool.execute('SELECT * FROM logistics_locations WHERE id = ? LIMIT 1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Logistics location not found.' });
    await pool.execute('UPDATE logistics_locations SET is_active = 0, updated_by = ? WHERE id = ?', [currentUserId(req), id]);
    await logPayrollAudit(pool, req, 'logistics_location_deactivated', { remarks: `Deactivated logistics location ${existing[0].name}`, metadata: { old_value: existing[0], new_value: { is_active: 0 } } });
    res.json({ message: 'Logistics location deactivated. Existing trip history was retained.' });
  } catch (err) {
    console.error('[logistics/locations:delete]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to deactivate logistics location.') });
  }
});

async function logisticsRatePayload(pool, body) {
  const truckTypeId = logisticsPositiveId(body.truck_type_id, 'Truck type');
  const locationId = logisticsPositiveId(body.location_id, 'Location');
  const tripType = normalizeTripType(body.trip_type || 'Any', { allowAny: true });
  const role = normalizeTripRole(body.role);
  const baseRate = logisticsMoney(body.base_rate, 'Base rate');
  const additionalRate = logisticsMoney(body.additional_rate || 0, 'Additional rate');
  const multiplier = Number(body.multiplier === undefined || body.multiplier === '' ? 1 : body.multiplier);
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 100) throw new Error('Multiplier must be greater than zero and no more than 100.');
  const specialRuleDescription = logisticsText(body.special_rule_description, 'Special rule description', 500);
  const status = logisticsStatus(body.status);
  const effectiveDate = logisticsDate(body.effective_date || new Date().toISOString().slice(0, 10), 'Effective date');
  const [truckRows] = await pool.execute('SELECT id FROM truck_types WHERE id = ? LIMIT 1', [truckTypeId]);
  const [locationRows] = await pool.execute('SELECT id FROM logistics_locations WHERE id = ? LIMIT 1', [locationId]);
  if (!truckRows.length || !locationRows.length) throw new Error('Truck type and location must exist.');
  return { truckTypeId, locationId, tripType, role, baseRate, additionalRate, multiplier, specialRuleDescription, status, effectiveDate };
}

router.get('/logistics/rates', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const includeInactive = req.query.include_inactive === '1';
    const [rows] = await pool.execute(`
      SELECT r.*, tt.name AS truck_type, ll.name AS location_name, ll.location_category
        FROM logistics_rates r
        JOIN truck_types tt ON tt.id = r.truck_type_id
        JOIN logistics_locations ll ON ll.id = r.location_id
       ${includeInactive ? '' : "WHERE r.status = 'Active'"}
       ORDER BY CASE WHEN r.status = 'Active' THEN 0 ELSE 1 END, r.effective_date DESC, tt.name, ll.name, r.trip_type, r.role
    `);
    res.json(rows);
  } catch (err) {
    console.error('[logistics/rates:get]', err.message);
    res.status(500).json({ error: 'Failed to load logistics rates.' });
  }
});

router.post('/logistics/rates', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.configure), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const rate = await logisticsRatePayload(pool, req.body);
    const [result] = await pool.execute(`
      INSERT INTO logistics_rates
        (truck_type_id, location_id, trip_type, role, base_rate, additional_rate, multiplier, special_rule_description, status, effective_date, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [rate.truckTypeId, rate.locationId, rate.tripType, rate.role, rate.baseRate, rate.additionalRate, rate.multiplier, rate.specialRuleDescription, rate.status, rate.effectiveDate, currentUserId(req), currentUserId(req)]);
    await logPayrollAudit(pool, req, 'logistics_rate_created', { remarks: `Created ${rate.role} logistics rate`, metadata: { new_value: rate } });
    res.status(201).json({ id: result.insertId, total_trip_pay: computeTripPay(rate), message: 'Logistics rate created.' });
  } catch (err) {
    console.error('[logistics/rates:post]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to create logistics rate.') });
  }
});

router.put('/logistics/rates/:id', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.configure), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const id = logisticsPositiveId(req.params.id, 'Logistics rate');
    const [existing] = await pool.execute('SELECT * FROM logistics_rates WHERE id = ? LIMIT 1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Logistics rate not found.' });
    const rate = await logisticsRatePayload(pool, req.body);
    await pool.execute(`
      UPDATE logistics_rates
         SET truck_type_id = ?, location_id = ?, trip_type = ?, role = ?, base_rate = ?, additional_rate = ?, multiplier = ?,
             special_rule_description = ?, status = ?, effective_date = ?, updated_by = ?
       WHERE id = ?
    `, [rate.truckTypeId, rate.locationId, rate.tripType, rate.role, rate.baseRate, rate.additionalRate, rate.multiplier, rate.specialRuleDescription, rate.status, rate.effectiveDate, currentUserId(req), id]);
    await logPayrollAudit(pool, req, 'logistics_rate_updated', { remarks: `Updated ${rate.role} logistics rate`, metadata: { old_value: existing[0], new_value: rate } });
    res.json({ total_trip_pay: computeTripPay(rate), message: 'Logistics rate updated.' });
  } catch (err) {
    console.error('[logistics/rates:put]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to update logistics rate.') });
  }
});

router.delete('/logistics/rates/:id', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.configure), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const id = logisticsPositiveId(req.params.id, 'Logistics rate');
    const [existing] = await pool.execute('SELECT * FROM logistics_rates WHERE id = ? LIMIT 1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Logistics rate not found.' });
    await pool.execute("UPDATE logistics_rates SET status = 'Inactive', updated_by = ? WHERE id = ?", [currentUserId(req), id]);
    await logPayrollAudit(pool, req, 'logistics_rate_deactivated', { remarks: `Deactivated logistics rate ${id}`, metadata: { old_value: existing[0], new_value: { status: 'Inactive' } } });
    res.json({ message: 'Logistics rate deactivated. Existing trip history was retained.' });
  } catch (err) {
    console.error('[logistics/rates:delete]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to deactivate logistics rate.') });
  }
});

router.get('/logistics/rates/preview', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const tripDate = logisticsDate(req.query.trip_date || new Date().toISOString().slice(0, 10), 'Trip date');
    const rate = await findActiveLogisticsRate(pool, {
      truckTypeId: logisticsPositiveId(req.query.truck_type_id, 'Truck type'),
      locationId: logisticsPositiveId(req.query.location_id, 'Location'),
      tripType: req.query.trip_type,
      role: req.query.role,
      tripDate
    });
    if (!rate) return res.status(404).json({ error: 'No active logistics rate matches this truck, location, trip type, role, and date.' });
    res.json({ ...rate, total_trip_pay: computeTripPay({ baseRate: rate.base_rate, multiplier: rate.multiplier, additionalRate: rate.additional_rate }) });
  } catch (err) {
    console.error('[logistics/rates:preview]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to preview logistics rate.') });
  }
});

router.get('/logistics/employees', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute(`
      SELECT e.id, e.employee_code, e.first_name, e.last_name, e.position, w.name AS wage_type
        FROM employees e
        JOIN wage_types w ON w.id = e.wage_type_id
       WHERE (LOWER(w.name) LIKE '%trip%' OR LOWER(w.name) LIKE '%logistics%')
         AND COALESCE(e.status, 'Active') = 'Active'
       ORDER BY e.last_name, e.first_name
    `);
    res.json(rows);
  } catch (err) {
    console.error('[logistics/employees:get]', err.message);
    res.status(500).json({ error: 'Failed to load trip-based employees.' });
  }
});

async function logisticsTripPayload(pool, body) {
  const employeeId = logisticsPositiveId(body.employee_id, 'Employee');
  const truckTypeId = logisticsPositiveId(body.truck_type_id, 'Truck type');
  const locationId = logisticsPositiveId(body.location_id, 'Location');
  const tripDate = logisticsDate(body.trip_date, 'Trip date');
  const tripType = normalizeTripType(body.trip_type);
  const role = normalizeTripRole(body.role);
  const outputQuantity = Math.max(1, numeric(body.output_quantity || 1));
  const plateNumber = logisticsText(body.plate_number, 'Plate number', 30);
  if (plateNumber && !/^[A-Za-z0-9 -]+$/.test(plateNumber)) throw new Error('Plate number may contain letters, numbers, spaces, and hyphens only.');
  const [employees] = await pool.execute(`
    SELECT e.id, e.employee_code, e.position, e.status, w.name AS wage_type
      FROM employees e
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
     WHERE e.id = ?
     LIMIT 1
  `, [employeeId]);
  const employee = employees[0];
  if (!employee || String(employee.status || 'Active').toLowerCase() !== 'active') throw new Error('Employee must be active.');
  if (!isTripBasedWageType(employee.wage_type)) throw new Error('Employee must use the Trip-Based or Logistics wage type.');
  if (logisticsPositionKind(employee.position) !== role) throw new Error(`Employee position must be ${role} for this trip entry.`);
  const rate = await findActiveLogisticsRate(pool, { truckTypeId, locationId, tripType, role, tripDate });
  if (!rate) throw new Error('No active logistics rate matches this truck, location, trip type, role, and date.');
  return {
    employeeId, truckTypeId, locationId, tripDate, tripType, role, plateNumber,
    rateId: rate.id,
    baseRate: logisticsMoney(rate.base_rate, 'Base rate'),
    additionalRate: logisticsMoney(rate.additional_rate, 'Additional rate'),
    multiplier: Number(rate.multiplier),
    outputQuantity,
    unitTripPay: computeTripPay({ baseRate: rate.base_rate, multiplier: rate.multiplier, additionalRate: rate.additional_rate }),
    totalTripPay: roundMoney(computeTripPay({ baseRate: rate.base_rate, multiplier: rate.multiplier, additionalRate: rate.additional_rate }) * outputQuantity),
    specialRuleDescription: rate.special_rule_description || null,
    employeeCode: employee.employee_code
  };
}

router.get('/logistics/trips', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const where = ['1 = 1'];
    const values = [];
    if (req.query.status) { where.push('dt.status = ?'); values.push(String(req.query.status)); }
    if (req.query.start_date) { where.push('dt.trip_date >= ?'); values.push(logisticsDate(req.query.start_date, 'Start date')); }
    if (req.query.end_date) { where.push('dt.trip_date <= ?'); values.push(logisticsDate(req.query.end_date, 'End date')); }
    if (req.query.employee_id) { where.push('dt.employee_id = ?'); values.push(logisticsPositiveId(req.query.employee_id, 'Employee')); }
    const [rows] = await pool.execute(`
      SELECT dt.*, e.employee_code, CONCAT(e.last_name, ', ', e.first_name) AS employee_name,
             tt.name AS truck_type, ll.name AS location_name, ll.location_category,
             creator.username AS created_by_username, approver.username AS approved_by_username
        FROM delivery_trips dt
        JOIN employees e ON e.id = dt.employee_id
        JOIN truck_types tt ON tt.id = dt.truck_type_id
        JOIN logistics_locations ll ON ll.id = dt.location_id
        LEFT JOIN users creator ON creator.id = dt.created_by
        LEFT JOIN users approver ON approver.id = dt.approved_by
       WHERE ${where.join(' AND ')}
       ORDER BY dt.trip_date DESC, dt.id DESC
       LIMIT 500
    `, values);
    res.json(rows);
  } catch (err) {
    console.error('[logistics/trips:get]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to load delivery trips.') });
  }
});

router.post('/logistics/trips', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.encode), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const trip = await logisticsTripPayload(pool, req.body);
    const submitNow = String(req.body.status || '').toLowerCase() === 'submitted';
    const [result] = await pool.execute(`
      INSERT INTO delivery_trips
        (employee_id, truck_type_id, location_id, logistics_rate_id, trip_date, trip_type, role, plate_number,
         output_quantity, base_rate, additional_rate, multiplier, total_trip_pay, special_rule_description, status,
         submitted_by, submitted_at, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [trip.employeeId, trip.truckTypeId, trip.locationId, trip.rateId, trip.tripDate, trip.tripType, trip.role, trip.plateNumber,
      trip.outputQuantity, trip.baseRate, trip.additionalRate, trip.multiplier, trip.totalTripPay, trip.specialRuleDescription, submitNow ? 'Submitted' : 'Draft',
      submitNow ? currentUserId(req) : null, submitNow ? new Date() : null, currentUserId(req), currentUserId(req)]);
    await logPayrollAudit(pool, req, submitNow ? 'delivery_trip_submitted' : 'delivery_trip_drafted', {
      employee_id: trip.employeeId,
      remarks: `${submitNow ? 'Submitted' : 'Drafted'} ${trip.tripType} delivery trip for ${trip.employeeCode}`,
      metadata: { delivery_trip_id: result.insertId, new_value: trip }
    });
    res.status(201).json({ id: result.insertId, status: submitNow ? 'Submitted' : 'Draft', total_trip_pay: trip.totalTripPay, message: submitNow ? 'Delivery trip submitted for approval.' : 'Delivery trip saved as draft.' });
  } catch (err) {
    console.error('[logistics/trips:post]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to create delivery trip.') });
  }
});

router.put('/logistics/trips/:id', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.encode), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const id = logisticsPositiveId(req.params.id, 'Delivery trip');
    const [existing] = await pool.execute('SELECT * FROM delivery_trips WHERE id = ? LIMIT 1', [id]);
    const oldTrip = existing[0];
    if (!oldTrip) return res.status(404).json({ error: 'Delivery trip not found.' });
    if (oldTrip.status !== 'Draft') return res.status(409).json({ error: 'Only Draft delivery trips can be edited.' });
    if (!canManageTrip(req, oldTrip)) return res.status(403).json({ error: 'You may edit only delivery trips that you created.' });
    const trip = await logisticsTripPayload(pool, { ...oldTrip, ...req.body });
    await pool.execute(`
      UPDATE delivery_trips
         SET employee_id = ?, truck_type_id = ?, location_id = ?, logistics_rate_id = ?, trip_date = ?, trip_type = ?, role = ?, plate_number = ?,
             output_quantity = ?, base_rate = ?, additional_rate = ?, multiplier = ?, total_trip_pay = ?, special_rule_description = ?, updated_by = ?
       WHERE id = ?
    `, [trip.employeeId, trip.truckTypeId, trip.locationId, trip.rateId, trip.tripDate, trip.tripType, trip.role, trip.plateNumber,
      trip.outputQuantity, trip.baseRate, trip.additionalRate, trip.multiplier, trip.totalTripPay, trip.specialRuleDescription, currentUserId(req), id]);
    await logPayrollAudit(pool, req, 'delivery_trip_updated', { employee_id: trip.employeeId, remarks: `Updated delivery trip ${id}`, metadata: { delivery_trip_id: id, old_value: oldTrip, new_value: trip } });
    res.json({ total_trip_pay: trip.totalTripPay, message: 'Delivery trip updated.' });
  } catch (err) {
    console.error('[logistics/trips:put]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to update delivery trip.') });
  }
});

router.post('/logistics/trips/:id/submit', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.encode), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const id = logisticsPositiveId(req.params.id, 'Delivery trip');
    const [rows] = await pool.execute('SELECT * FROM delivery_trips WHERE id = ? LIMIT 1', [id]);
    const trip = rows[0];
    if (!trip) return res.status(404).json({ error: 'Delivery trip not found.' });
    if (trip.status !== 'Draft') return res.status(409).json({ error: 'Only Draft delivery trips can be submitted.' });
    if (!canManageTrip(req, trip)) return res.status(403).json({ error: 'You may submit only delivery trips that you created.' });
    await pool.execute("UPDATE delivery_trips SET status = 'Submitted', submitted_by = ?, submitted_at = NOW(), updated_by = ? WHERE id = ?", [currentUserId(req), currentUserId(req), id]);
    await logPayrollAudit(pool, req, 'delivery_trip_submitted', { employee_id: trip.employee_id, remarks: `Submitted delivery trip ${id} for approval.`, metadata: { delivery_trip_id: id, old_value: { status: 'Draft' }, new_value: { status: 'Submitted' } } });
    res.json({ message: 'Delivery trip submitted for approval.' });
  } catch (err) {
    console.error('[logistics/trips:submit]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to submit delivery trip.') });
  }
});

router.post('/logistics/trips/:id/approve', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.approve), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const id = logisticsPositiveId(req.params.id, 'Delivery trip');
    const [rows] = await pool.execute('SELECT * FROM delivery_trips WHERE id = ? LIMIT 1', [id]);
    const trip = rows[0];
    if (!trip) return res.status(404).json({ error: 'Delivery trip not found.' });
    if (trip.status !== 'Submitted') return res.status(409).json({ error: 'Only Submitted delivery trips can be approved.' });
    await pool.execute("UPDATE delivery_trips SET status = 'Approved', approved_by = ?, approved_at = NOW(), updated_by = ? WHERE id = ?", [currentUserId(req), currentUserId(req), id]);
    await logPayrollAudit(pool, req, 'delivery_trip_approved', { employee_id: trip.employee_id, remarks: `Approved delivery trip ${id}.`, metadata: { delivery_trip_id: id, old_value: { status: 'Submitted' }, new_value: { status: 'Approved' } } });
    res.json({ message: 'Delivery trip approved and ready for payroll.' });
  } catch (err) {
    console.error('[logistics/trips:approve]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to approve delivery trip.') });
  }
});

router.post('/logistics/trips/:id/reject', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.approve), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const id = logisticsPositiveId(req.params.id, 'Delivery trip');
    const reason = logisticsText(req.body.reason, 'Rejection reason', 500, { required: true });
    const [rows] = await pool.execute('SELECT * FROM delivery_trips WHERE id = ? LIMIT 1', [id]);
    const trip = rows[0];
    if (!trip) return res.status(404).json({ error: 'Delivery trip not found.' });
    if (trip.status !== 'Submitted') return res.status(409).json({ error: 'Only Submitted delivery trips can be rejected.' });
    await pool.execute("UPDATE delivery_trips SET status = 'Rejected', updated_by = ? WHERE id = ?", [currentUserId(req), id]);
    await logPayrollAudit(pool, req, 'delivery_trip_rejected', { employee_id: trip.employee_id, remarks: `Rejected delivery trip ${id}: ${reason}`, metadata: { delivery_trip_id: id, old_value: { status: 'Submitted' }, new_value: { status: 'Rejected', reason } } });
    res.json({ message: 'Delivery trip rejected.' });
  } catch (err) {
    console.error('[logistics/trips:reject]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to reject delivery trip.') });
  }
});

router.delete('/logistics/trips/:id', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.encode), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const id = logisticsPositiveId(req.params.id, 'Delivery trip');
    const [rows] = await pool.execute('SELECT * FROM delivery_trips WHERE id = ? LIMIT 1', [id]);
    const trip = rows[0];
    if (!trip) return res.status(404).json({ error: 'Delivery trip not found.' });
    if (trip.status !== 'Draft') return res.status(409).json({ error: 'Only Draft delivery trips can be deleted.' });
    if (!canManageTrip(req, trip)) return res.status(403).json({ error: 'You may delete only delivery trips that you created.' });
    await pool.execute('DELETE FROM delivery_trips WHERE id = ? AND status = \'Draft\'', [id]);
    await logPayrollAudit(pool, req, 'delivery_trip_deleted', { employee_id: trip.employee_id, remarks: `Deleted draft delivery trip ${id}.`, metadata: { delivery_trip_id: id, old_value: trip } });
    res.json({ message: 'Draft delivery trip deleted.' });
  } catch (err) {
    console.error('[logistics/trips:delete]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to delete delivery trip.') });
  }
});

router.get('/logistics/payroll-summary', requireAuth, requireRole(LOGISTICS_TRIP_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    await assertLogisticsTripSchema(pool);
    const startDate = logisticsDate(req.query.start_date || monthRange(req.query.month_year).start, 'Start date');
    const endDate = logisticsDate(req.query.end_date || monthRange(req.query.month_year).end, 'End date');
    const [rows] = await pool.execute(`
      SELECT dt.employee_id, e.employee_code, CONCAT(e.last_name, ', ', e.first_name) AS employee_name, e.position,
             COUNT(*) AS approved_trip_count, COALESCE(SUM(dt.total_trip_pay), 0) AS total_logistics_pay
        FROM delivery_trips dt
        JOIN employees e ON e.id = dt.employee_id
       WHERE dt.status IN ('Approved', 'Included in Payroll', 'Paid')
         AND dt.trip_date BETWEEN ? AND ?
       GROUP BY dt.employee_id, e.employee_code, e.last_name, e.first_name, e.position
       ORDER BY e.last_name, e.first_name
    `, [startDate, endDate]);
    const totalLogisticsPay = rows.reduce((sum, row) => sum + numeric(row.total_logistics_pay), 0);
    res.json({ start_date: startDate, end_date: endDate, rows, total_logistics_pay: totalLogisticsPay });
  } catch (err) {
    console.error('[logistics/payroll-summary:get]', err.message);
    res.status(400).json({ error: safePayrollError(err, 'Failed to load logistics payroll summary.') });
  }
});

// Get employee wage rate configuration
router.get('/employees/:id/wage-config', requireAuth, async (req, res) => {
  try {
    const pool = require('../config/db');
    const empId = req.params.id;

    console.log('\n=== GET /api/payroll/employees/:id/wage-config ===');
    console.log('Employee ID:', empId);
    console.log('Request user:', req.user?.username);

    // Get employee with current wage type
    const [empRows] = await pool.execute(`
      SELECT e.id, e.employee_code, e.first_name, e.last_name, 
             e.wage_type_id, w.name AS wage_type, w.id AS wage_type_id_val,
             e.department_id, d.name AS department,
             e.employment_type, e.hiring_type, e.agency_name
      FROM employees e
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.id = ?
    `, [empId]);

    if (!empRows.length) {
      console.error('❌ Employee not found with ID:', empId);
      return res.status(404).json({ error: 'Employee not found' });
    }

    const emp = empRows[0];
    console.log('✅ Employee found:', emp.employee_code, '| Wage type ID:', emp.wage_type_id, '| Wage type name:', emp.wage_type);

    // Get rates for this employee
    const [rates] = await pool.execute(`
      SELECT ewr.*, st.name AS sewing_type, lr.name AS region
      FROM employee_wage_rates ewr
      LEFT JOIN sewing_types st ON st.id = ewr.sewing_type_id
      LEFT JOIN logistics_regions lr ON lr.id = ewr.logistics_region_id
      WHERE ewr.employee_id = ? AND ewr.end_date IS NULL
      ORDER BY ewr.effective_date DESC
    `, [empId]);

    console.log('✅ Query result - Found', rates.length, 'active rate(s)');
    if (rates.length > 0) {
      console.log('✅ First rate details:', {
        rate: rates[0].rate,
        base_rate: rates[0].base_rate,
        hourly_rate: rates[0].hourly_rate,
        overtime_rate: rates[0].overtime_rate,
        sewing_type_id: rates[0].sewing_type_id,
        logistics_region_id: rates[0].logistics_region_id,
        effective_date: rates[0].effective_date,
        end_date: rates[0].end_date
      });
    }

    // Calculate current rate (use first rate if exists, else default)
    let currentRate = 0;
    if (rates.length > 0) {
      currentRate = parseFloat(rates[0].rate) || parseFloat(rates[0].base_rate) || 0;
    }

    // If no wage type is set, check if rates exist and infer the type
    let wageTypeToReturn = emp.wage_type;
    if (!emp.wage_type && rates.length > 0) {
      // Infer wage type from rates
      const firstRate = rates[0];
      if (firstRate.sewing_type_id) {
        wageTypeToReturn = 'Per-Piece';
      } else if (firstRate.logistics_region_id) {
        wageTypeToReturn = 'Per-Trip';
      }
      console.log('✅ Inferred wage type from rates:', wageTypeToReturn);
    }

    console.log('✅ Final response - wage_type:', wageTypeToReturn, '| current_rate:', currentRate);

    res.json({
      // Return fields at top level for frontend compatibility
      wage_type: wageTypeToReturn || null,
      current_rate: currentRate,
      wage_type_id: emp.wage_type_id_val,
      // Also include nested structure for reference
      employee: emp,
      rates: rates,
      availableSewingTypes: [],
      availableRegions: []
    });
  } catch (err) {
    console.error('Error fetching wage config:', err);
    res.status(500).json({ error: 'Failed to fetch wage configuration' });
  }
});

// Set employee wage type and rates (ADMIN only)
router.post('/employees/:id/wage-config', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
  try {
    const pool = require('../config/db');
    const empId = req.params.id;
    const { wage_type_id, rates } = req.body;

    console.log('\n=== POST /api/payroll/employees/:id/wage-config ===');
    console.log('Employee ID:', empId);
    console.log('Wage Type ID:', wage_type_id);
    console.log('Rates to save:', rates);

    const [wageTypeRows] = await pool.execute('SELECT name FROM wage_types WHERE id = ? LIMIT 1', [wage_type_id]);
    if (!wageTypeRows.length) {
      return res.status(400).json({ error: 'Invalid wage type.' });
    }
    const normalizedWageType = normalizePayrollWageType(wageTypeRows[0].name);
    const usesBaseRate = normalizedWageType === 'Daily' || normalizedWageType === 'Hourly';
    if (!Array.isArray(rates) || rates.length === 0) {
      return res.status(400).json({ error: 'At least one wage rate is required.' });
    }

    // First verify employee exists
    const [empCheck] = await pool.execute(
      'SELECT id, employee_code, first_name, last_name FROM employees WHERE id = ?',
      [empId]
    );
    
    if (!empCheck.length) {
      console.error('❌ Employee not found with ID:', empId);
      return res.status(404).json({ error: 'Employee not found' });
    }
    
    console.log('✅ Employee found:', empCheck[0].employee_code);

    // Update employee wage type
    const [updateRes] = await pool.execute(
      'UPDATE employees SET wage_type_id = ? WHERE id = ?',
      [wage_type_id, empId]
    );
    
    console.log('✅ Updated wage_type_id. Rows affected:', updateRes.affectedRows);

    // Clear old rates
    const [clearRes] = await pool.execute(
      'UPDATE employee_wage_rates SET end_date = NOW() WHERE employee_id = ? AND end_date IS NULL',
      [empId]
    );
    
    console.log('✅ Cleared old rates. Rows affected:', clearRes.affectedRows);

    // Add new rates
    for (const rate of rates) {
      console.log('Adding rate:', rate);
      const baseRate = usesBaseRate ? (rate.base_rate || rate.rate || null) : null;
      const [insertRes] = await pool.execute(`
        INSERT INTO employee_wage_rates 
        (employee_id, wage_type_id, base_rate, hourly_rate, overtime_rate, sewing_type_id, logistics_region_id, rate, effective_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE())
      `, [
        empId,
        wage_type_id,
        baseRate,
        rate.hourly_rate || null,
        rate.overtime_rate || null,
        rate.sewing_type_id || null,
        rate.logistics_region_id || null,
        rate.rate
      ]);
      
      console.log('✅ Rate inserted. ID:', insertRes.insertId);
    }
    
    // Verify saved data
    const [verifyRates] = await pool.execute(
      'SELECT * FROM employee_wage_rates WHERE employee_id = ? AND end_date IS NULL',
      [empId]
    );
    
    console.log('✅ Verification - Active rates count:', verifyRates.length);
    console.log('✅ Verification - First rate:', verifyRates[0]);

    res.json({ success: true, message: 'Wage configuration updated', ratesSaved: verifyRates.length });
  } catch (err) {
    console.error('❌ Error updating wage config:', err);
    res.status(500).json({ error: 'Failed to update wage configuration.' });
  }
});

// Record production transaction (pieces produced)
router.post('/transactions/production', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const { employee_id, sewing_type_id, quantity, rate, transaction_date, calculation_status } = req.body;

    // Calculate week and month
    const date = new Date(transaction_date);
    const week = Math.ceil((date.getDate() + new Date(date.getFullYear(), date.getMonth(), 1).getDay()) / 7);
    const monthYear = date.toISOString().slice(0, 7);

    // Source rows store earnings only. Salary calculation submission owns deductions.
    const grossPay = quantity * rate;

    // Save to production_transactions
    const [prodResult] = await pool.execute(`
      INSERT INTO production_transactions 
      (employee_id, sewing_type_id, quantity, rate, transaction_date, week_number, month_year)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [employee_id, sewing_type_id, quantity, rate, transaction_date, week, monthYear]);

    // Update the one salary calculation for this employee and period.
    const wage_type_id = 3; // Per-Piece wage type ID
    const requestedStatus = ['Calculated', 'Submitted'].includes(calculation_status) ? calculation_status : 'Draft';
    const shouldPersistDeductions = requestedStatus === 'Submitted';
    const deductions = shouldPersistDeductions
      ? await calculateSalaryDeductionSnapshot(pool, employee_id, grossPay, transaction_date)
      : { total: 0, employeeTotal: 0, rows: [], configuredBreakdown: { sss: 0, pagibig: 0, philhealth: 0 } };
    const totalDeductions = roundMoney(deductions.total || 0);
    const [existingRows] = await pool.execute(`
      SELECT id, status, gross_pay
        FROM salary_calculations
       WHERE employee_id = ? AND payroll_period = ? AND wage_type_id = ?
         AND status <> 'Superseded'
       ORDER BY id DESC
       LIMIT 1
    `, [employee_id, monthYear, wage_type_id]);
    let salaryCalculationId = existingRows[0]?.id || null;
    if (existingRows[0] && ['Finalized', 'Paid', 'Released'].includes(existingRows[0].status)) {
      return res.status(409).json({ error: 'A finalized or paid salary calculation cannot be updated.' });
    }

    // Preserve the deduction snapshot when a submitted calculation is requeued before approval.
    const retainSubmittedDeductions = shouldPersistDeductions || existingRows[0]?.status === 'Submitted';
    const periodGrossPay = roundMoney(numeric(existingRows[0]?.gross_pay) + grossPay);
    const periodDeductions = retainSubmittedDeductions
      ? await calculateSalaryDeductionSnapshot(pool, employee_id, periodGrossPay, transaction_date)
      : deductions;
    const periodTotalDeductions = roundMoney(periodDeductions.total || 0);

    if (salaryCalculationId) {
      const nextStatus = ['Draft', 'Calculated'].includes(existingRows[0].status) && ['Calculated', 'Submitted'].includes(requestedStatus)
        ? requestedStatus
        : existingRows[0].status;
      await pool.execute(`
        UPDATE salary_calculations
           SET base_rate = 0,
               quantity = quantity + ?,
               gross_pay = gross_pay + ?,
               sss_deduction = ?,
               pagibig_deduction = ?,
               philhealth_deduction = ?,
               total_deductions = ?,
               employee_deduction_total = ?,
               net_pay = (gross_pay + ?) - ?,
               calculation_date = ?,
               payroll_period = ?,
               status = ?,
               calculated_by = ?,
               source_type = 'production_transaction',
               updated_at = NOW()
         WHERE id = ?
      `, [
        quantity,
        grossPay,
        periodDeductions.configuredBreakdown.sss || 0,
        periodDeductions.configuredBreakdown.pagibig || 0,
        periodDeductions.configuredBreakdown.philhealth || 0,
        periodTotalDeductions,
        periodDeductions.employeeTotal || 0,
        grossPay,
        periodTotalDeductions,
        transaction_date,
        monthYear,
        nextStatus,
        currentUserId(req),
        salaryCalculationId
      ]);
    } else {
      const [salCalcResult] = await pool.execute(`
        INSERT INTO salary_calculations
          (employee_id, wage_type_id, base_rate, quantity, gross_pay, sss_deduction,
           pagibig_deduction, philhealth_deduction, total_deductions, employee_deduction_total,
           net_pay, calculation_date, payroll_period, status, calculated_by, source_type)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'production_transaction')
      `, [
        employee_id,
        wage_type_id,
        quantity,
        grossPay,
        deductions.configuredBreakdown.sss || 0,
        deductions.configuredBreakdown.pagibig || 0,
        deductions.configuredBreakdown.philhealth || 0,
        totalDeductions,
        deductions.employeeTotal || 0,
        grossPay - totalDeductions,
        transaction_date,
        monthYear,
        requestedStatus,
        currentUserId(req)
      ]);
      salaryCalculationId = salCalcResult.insertId;
    }
    if (retainSubmittedDeductions) {
      await applySalaryCalculationDeductionSnapshot(pool, salaryCalculationId, periodDeductions.rows);
    } else {
      await clearSalaryCalculationDeductions(pool, salaryCalculationId);
    }

    const blockchainQueue = await queueSubmittedPayrollRecord(pool, req, salaryCalculationId);
    if (blockchainQueue) {
      await logPayrollAudit(pool, req, 'salary_calculation_submitted', {
        employee_id,
        salary_calculation_id: salaryCalculationId,
        remarks: 'Submitted production payroll calculation for approval.',
        metadata: { source_type: 'production_transaction', blockchain_queue: blockchainQueue }
      });
    }

    res.json({ 
      success: true, 
      id: prodResult.insertId,
      amount: quantity * rate,
      message: `Recorded ${quantity} pieces at ₱${rate} each`,
      salary_calculation_id: salaryCalculationId,
      blockchain_queue: blockchainQueue
    });
  } catch (err) {
    console.error('Error recording production transaction:', err);
    res.status(500).json({ error: 'Failed to record transaction' });
  }
});

async function upsertLogisticsPeriodCalculation(pool, employeeId, payrollPeriod, wageTypeId, userId, calculationStatus = 'Draft') {
  const requestedStatus = ['Calculated', 'Submitted'].includes(calculationStatus) ? calculationStatus : 'Draft';
  const [totals] = await pool.execute(`
    SELECT COALESCE(SUM(gross_pay), 0) AS gross_pay,
           COALESCE(SUM(CASE WHEN crew_status IS NULL THEN 1 ELSE 1 END), 0) AS transaction_count,
           MAX(transaction_date) AS calculation_date
      FROM logistics_transactions
     WHERE employee_id = ? AND month_year = ?
  `, [employeeId, payrollPeriod]);
  const summary = totals[0];
  const grossPay = roundMoney(summary.gross_pay || 0);
  const calcDate = summary.calculation_date || `${payrollPeriod}-01`;
  const [existingRows] = await pool.execute(`
    SELECT id, status FROM salary_calculations
     WHERE employee_id = ? AND payroll_period = ? AND wage_type_id = ?
       AND COALESCE(status, '') <> 'Superseded'
     ORDER BY id DESC LIMIT 1
  `, [employeeId, payrollPeriod, wageTypeId]);
  if (existingRows[0] && ['Finalized', 'Paid', 'Released'].includes(existingRows[0].status)) {
    throw new Error('A finalized or paid logistics calculation cannot be updated. Reopen it through the authorized correction flow.');
  }
  const shouldPersistDeductions = requestedStatus === 'Submitted' || existingRows[0]?.status === 'Submitted';
  const deductions = shouldPersistDeductions
    ? await calculateSalaryDeductionSnapshot(pool, employeeId, grossPay, calcDate)
    : { total: 0, employeeTotal: 0, rows: [], configuredBreakdown: { sss: 0, pagibig: 0, philhealth: 0 } };
  const totalDeductions = roundMoney(deductions.total || 0);
  const netPay = roundMoney(grossPay - totalDeductions);
  const [sourceRows] = await pool.execute(`
    SELECT id, transaction_date, crew_role, truck_type, base_rate, rate, amount, gross_pay, split_rule_snapshot
      FROM logistics_transactions
     WHERE employee_id = ? AND month_year = ?
     ORDER BY transaction_date, id
  `, [employeeId, payrollPeriod]);
  const dailyTotals = sourceRows.reduce((acc, row) => {
    const key = String(row.transaction_date || '').slice(0, 10);
    acc[key] = roundMoney((acc[key] || 0) + numeric(row.gross_pay));
    return acc;
  }, {});
  const logisticsBreakdown = sourceRows.map(row => {
    const rowSnapshot = parseJsonSafe(row.split_rule_snapshot);
    const tripDate = String(row.transaction_date || '').slice(0, 10);
    const locationText = [rowSnapshot.location_category, rowSnapshot.location_name].filter(Boolean).join(' - ');
    return {
      trip_date: tripDate,
      employee_role: row.crew_role || rowSnapshot.crew_role || '-',
      truck_type: row.truck_type || '-',
      location: locationText || rowSnapshot.location_name || '-',
      trip_number: rowSnapshot.trip_type || '-',
      base_rate: numeric(rowSnapshot.base_rate || row.base_rate),
      multiplier: numeric(rowSnapshot.multiplier || 1),
      rule_applied: rowSnapshot.rule_applied || rowSnapshot.rule || '-',
      computed_trip_pay: numeric(rowSnapshot.computed_trip_pay || row.amount || row.gross_pay),
      daily_total: dailyTotals[tripDate] || numeric(row.gross_pay),
      payroll_period_total: grossPay
    };
  });
  const snapshot = {
    source: 'logistics_transaction',
    logistics_breakdown: logisticsBreakdown,
    deduction_status: shouldPersistDeductions ? 'Applied' : 'Not Applied',
    deductions: deductions.rows || []
  };
  if (existingRows[0]) {
    const nextStatus = ['Draft', 'Calculated'].includes(existingRows[0].status) && ['Calculated', 'Submitted'].includes(requestedStatus)
      ? requestedStatus
      : existingRows[0].status;
    await pool.execute(`
      UPDATE salary_calculations
         SET base_rate = 0, quantity = ?, gross_pay = ?,
             sss_deduction = ?, pagibig_deduction = ?, philhealth_deduction = ?,
             total_deductions = ?, employee_deduction_total = ?, net_pay = ?,
             calculation_date = ?, calculated_by = ?, source_type = 'logistics_transaction',
             validation_snapshot = ?, status = ?
       WHERE id = ?
    `, [
      summary.transaction_count || 0,
      grossPay,
      deductions.configuredBreakdown.sss || 0,
      deductions.configuredBreakdown.pagibig || 0,
      deductions.configuredBreakdown.philhealth || 0,
      totalDeductions,
      deductions.employeeTotal || 0,
      netPay,
      calcDate,
      userId || null,
      JSON.stringify(snapshot),
      nextStatus,
      existingRows[0].id
    ]);
    if (shouldPersistDeductions) {
      await applySalaryCalculationDeductionSnapshot(pool, existingRows[0].id, deductions.rows);
    } else {
      await clearSalaryCalculationDeductions(pool, existingRows[0].id);
    }
    return existingRows[0].id;
  }
  const [created] = await pool.execute(`
    INSERT INTO salary_calculations
      (employee_id, wage_type_id, base_rate, quantity, gross_pay, total_deductions, net_pay,
       sss_deduction, pagibig_deduction, philhealth_deduction, employee_deduction_total,
       calculation_date, payroll_period, status, calculated_by, source_type, validation_snapshot)
    VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'logistics_transaction', ?)
  `, [employeeId, wageTypeId, summary.transaction_count || 0,
    grossPay, totalDeductions, netPay,
    deductions.configuredBreakdown.sss || 0,
    deductions.configuredBreakdown.pagibig || 0,
    deductions.configuredBreakdown.philhealth || 0,
    deductions.employeeTotal || 0,
    calcDate, payrollPeriod, requestedStatus, userId || null, JSON.stringify(snapshot)]);
  if (shouldPersistDeductions) {
    await applySalaryCalculationDeductionSnapshot(pool, created.insertId, deductions.rows);
  }
  return created.insertId;
}

// Record logistics transaction (trips completed)
router.post('/transactions/logistics', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const {
      salary_calculation_id,
      employee_id,
      logistics_region_id,
      rate,
      trip_reference,
      transaction_date,
      driver_employee_id,
      helper1_employee_id,
      helper2_employee_id,
      calculation_status
    } = req.body;

    // Calculate week and month
    const date = new Date(transaction_date || new Date());
    const week = Math.ceil((date.getDate() + new Date(date.getFullYear(), date.getMonth(), 1).getDay()) / 7);
    const monthYear = date.toISOString().slice(0, 7);

    if (driver_employee_id || helper1_employee_id || helper2_employee_id) {
      const crew = await computeLogisticsCrewPayroll(pool, req.body);
      const tripReference = trip_reference || `Trip-${Date.now()}`;
      const wage_type_id = 4; // Per-Trip wage type ID
      const savedRows = [];

      for (const row of crew.rows) {
        const snapshot = {
          ...crew.snapshot,
          crew_role: row.role,
          employee_id: row.employee.id,
          base_rate: row.base_rate,
          multiplier: row.multiplier,
          additional_rate: row.additional_rate,
          configured_trip_pay: row.configured_trip_pay,
          computed_trip_pay: row.computed_trip_pay,
          rule_applied: row.rule_applied,
          daily_total: row.gross_pay,
          deduction_status: 'Not Applied'
        };

        const [logResult] = await pool.execute(`
          INSERT INTO logistics_transactions
            (employee_id, logistics_region_id, truck_type, crew_status, crew_role,
             driver_employee_id, helper1_employee_id, helper2_employee_id,
             driver_rate, helper_rate, missing_helper_share, base_rate, gross_pay, net_pay,
             rate, amount, trip_reference, transaction_date, week_number, month_year, split_rule_snapshot)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          row.employee.id,
          crew.logistics_region_id,
          crew.truck_type,
          crew.crew_status,
          row.role,
          crew.driver_employee_id,
          crew.helper1_employee_id,
          crew.helper2_employee_id,
          crew.driver_rate,
          crew.helper_rate,
          crew.missing_helper_share,
          row.base_rate,
          row.gross_pay,
          row.gross_pay,
          row.computed_trip_pay,
          row.gross_pay,
          tripReference,
          crew.transaction_date,
          week,
          monthYear,
          JSON.stringify(snapshot)
        ]);

        const salaryCalculationId = await upsertLogisticsPeriodCalculation(
          pool, row.employee.id, monthYear, wage_type_id, currentUserId(req), calculation_status
        );
        const blockchainQueue = await queueSubmittedPayrollRecord(pool, req, salaryCalculationId);

        savedRows.push({
          logistics_transaction_id: logResult.insertId,
          salary_calculation_id: salaryCalculationId,
          blockchain_queue: blockchainQueue,
          employee_id: row.employee.id,
          role: row.role,
          base_rate: row.base_rate,
          multiplier: row.multiplier,
          rule_applied: row.rule_applied,
          computed_trip_pay: row.computed_trip_pay,
          gross_pay: row.gross_pay,
          net_pay: row.gross_pay
        });
      }

      await logPayrollAudit(pool, req, 'logistics_crew_transaction_encoded', {
        employee_id: crew.driver_employee_id,
        remarks: `${crew.crew_status} logistics crew encoded`,
        metadata: { ...crew.snapshot, rows: savedRows }
      });

      return res.json({
        success: true,
        message: `${crew.crew_status} crew logistics transaction saved.`,
        crew_status: crew.crew_status,
        missing_helper_share: crew.missing_helper_share,
        rows: savedRows
      });
    }

    // Source rows store earnings only. Deductions are snapshotted once by the salary calculation submit flow.
    const grossPay = rate;
    const netPay = grossPay;

    // Save to logistics_transactions
    const [logResult] = await pool.execute(`
      INSERT INTO logistics_transactions 
      (employee_id, logistics_region_id, rate, amount, trip_reference, transaction_date, week_number, month_year, gross_pay, net_pay, base_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [employee_id, logistics_region_id, rate, rate, trip_reference, transaction_date, week, monthYear, grossPay, netPay, rate]);

    // Recalculate the one logistics payroll record for this employee and period.
    const wage_type_id = 4; // Per-Trip wage type ID
    const salaryCalculationId = await upsertLogisticsPeriodCalculation(
      pool, employee_id, monthYear, wage_type_id, currentUserId(req), calculation_status
    );
    const blockchainQueue = await queueSubmittedPayrollRecord(pool, req, salaryCalculationId);

    res.json({ 
      success: true, 
      id: logResult.insertId,
      amount: rate,
      message: `Recorded 1 trip to ${trip_reference || 'destination'} at ₱${rate}`,
      salary_calculation_id: salaryCalculationId,
      blockchain_queue: blockchainQueue
    });
  } catch (err) {
    console.error('Error recording logistics transaction:', err);
    res.status(500).json({ error: 'Failed to record transaction' });
  }
});

router.get('/piece-rate-config', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const [sewTypes] = await pool.execute('SELECT * FROM payroll_sew_types ORDER BY is_active DESC, code');
    const [sizeRanges] = await pool.execute('SELECT * FROM payroll_size_ranges ORDER BY is_active DESC, size_range');
    const [pieceRates] = await pool.execute('SELECT * FROM payroll_piece_rates ORDER BY is_active DESC, effective_date DESC, product_type, product_category');
    const [splitConfigs] = await pool.execute('SELECT * FROM payroll_production_split_configs ORDER BY is_active DESC, effective_date DESC, split_name');
    const [shares] = await pool.execute('SELECT * FROM payroll_production_shares ORDER BY is_active DESC, effective_date DESC, worker_category');
    const [pairRules] = await pool.execute('SELECT * FROM payroll_production_share_rules ORDER BY is_active DESC, effective_date DESC, pairing_type');
    const [incentives] = await pool.execute('SELECT * FROM payroll_piece_incentives ORDER BY is_active DESC, effective_date DESC, incentive_category, incentive_name');
    const [incentiveEntries] = await pool.execute(`
      SELECT pie.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code
        FROM payroll_piece_incentive_entries pie
        LEFT JOIN employees e ON e.id = pie.employee_id
       ORDER BY pie.created_at DESC, pie.id DESC
       LIMIT 100
    `);
    const [outputs] = await pool.execute(`
      SELECT po.*, CONCAT(e.first_name, ' ', e.last_name) AS employee_name, e.employee_code
        FROM payroll_production_outputs po
        LEFT JOIN employees e ON e.id = po.employee_id
       ORDER BY po.output_date DESC, po.id DESC
       LIMIT 100
    `);
    const [pairs] = await pool.execute(`
      SELECT pp.*,
             CONCAT(w1.first_name, ' ', w1.last_name) AS worker1_name,
             CONCAT(w2.first_name, ' ', w2.last_name) AS worker2_name
        FROM payroll_production_pairs pp
        LEFT JOIN employees w1 ON w1.id = pp.worker1_employee_id
        LEFT JOIN employees w2 ON w2.id = pp.worker2_employee_id
       ORDER BY pp.production_date DESC, pp.id DESC
       LIMIT 100
    `);
    res.json({
      sew_types: sewTypes,
      size_ranges: sizeRanges,
      piece_rates: pieceRates,
      production_split_configs: splitConfigs,
      production_shares: shares,
      production_share_rules: pairRules,
      incentives,
      incentive_entries: incentiveEntries,
      production_outputs: outputs,
      production_pairs: pairs
    });
  } catch (err) {
    console.error('Error fetching piece-rate config:', err);
    res.status(500).json({ error: 'Failed to fetch piece-rate payroll configuration' });
  }
});

router.post('/sew-types', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const { id, code, description, effective_date, is_active } = req.body;
    const sewCode = String(code || '').trim().toUpperCase();
    if (!sewCode) return res.status(400).json({ error: 'Type of Sew code is required.' });
    if (!effective_date) return res.status(400).json({ error: 'Effective date is required.' });
    let oldValue = null;
    if (id) {
      const [oldRows] = await pool.execute('SELECT * FROM payroll_sew_types WHERE id = ?', [id]);
      oldValue = oldRows[0] || null;
      await pool.execute(`
        UPDATE payroll_sew_types
           SET code = ?, description = ?, effective_date = ?, is_active = ?, updated_by = ?
         WHERE id = ?
      `, [sewCode, description || null, effective_date, Number(is_active) === 0 ? 0 : 1, currentUserId(req), id]);
    } else {
      await pool.execute(`
        INSERT INTO payroll_sew_types (code, description, effective_date, is_active, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [sewCode, description || null, effective_date, Number(is_active) === 0 ? 0 : 1, currentUserId(req), currentUserId(req)]);
    }
    await logPayrollAudit(pool, req, 'sew_type_configuration_saved', {
      remarks: `Saved Type of Sew: ${sewCode}`,
      metadata: { old_value: oldValue, new_value: req.body }
    });
    res.json({ message: 'Type of Sew saved.' });
  } catch (err) {
    console.error('Error saving sew type:', err);
    res.status(500).json({ error: 'Failed to save Type of Sew.' });
  }
});

router.post('/size-ranges', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const { id, size_range, description, is_active } = req.body;
    const range = String(size_range || '').trim();
    if (!range) return res.status(400).json({ error: 'Size range is required.' });
    let oldValue = null;
    if (id) {
      const [oldRows] = await pool.execute('SELECT * FROM payroll_size_ranges WHERE id = ?', [id]);
      oldValue = oldRows[0] || null;
      await pool.execute(`
        UPDATE payroll_size_ranges
           SET size_range = ?, description = ?, is_active = ?, updated_by = ?
         WHERE id = ?
      `, [range, description || null, Number(is_active) === 0 ? 0 : 1, currentUserId(req), id]);
    } else {
      await pool.execute(`
        INSERT INTO payroll_size_ranges (size_range, description, is_active, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?)
      `, [range, description || null, Number(is_active) === 0 ? 0 : 1, currentUserId(req), currentUserId(req)]);
    }
    await logPayrollAudit(pool, req, 'size_range_configuration_saved', {
      remarks: `Saved size range: ${range}`,
      metadata: { old_value: oldValue, new_value: req.body }
    });
    res.json({ message: 'Size range saved.' });
  } catch (err) {
    console.error('Error saving size range:', err);
    res.status(500).json({ error: 'Failed to save size range.' });
  }
});

router.post('/production-share-rules', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const { id, pairing_type, worker1_share, worker2_share, effective_date, is_active } = req.body;
    if (!['Standard Sewer-Fixer', 'Substitute Sewer-Sewer'].includes(pairing_type)) {
      return res.status(400).json({ error: 'Valid pairing type is required.' });
    }
    const total = Number(worker1_share || 0) + Number(worker2_share || 0);
    if (Math.abs(total - 100) > 0.001) return res.status(400).json({ error: 'Worker shares must total exactly 100%.' });
    if (!effective_date) return res.status(400).json({ error: 'Effective date is required.' });

    let oldValue = null;
    if (id) {
      const [oldRows] = await pool.execute('SELECT * FROM payroll_production_share_rules WHERE id = ?', [id]);
      oldValue = oldRows[0] || null;
      await pool.execute(`
        UPDATE payroll_production_share_rules
           SET pairing_type = ?, worker1_share = ?, worker2_share = ?, effective_date = ?, is_active = ?, updated_by = ?
         WHERE id = ?
      `, [pairing_type, worker1_share, worker2_share, effective_date, Number(is_active) === 0 ? 0 : 1, currentUserId(req), id]);
    } else {
      await pool.execute(`
        INSERT INTO payroll_production_share_rules
          (pairing_type, worker1_share, worker2_share, effective_date, is_active, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [pairing_type, worker1_share, worker2_share, effective_date, Number(is_active) === 0 ? 0 : 1, currentUserId(req), currentUserId(req)]);
    }
    await logPayrollAudit(pool, req, 'production_pair_share_rule_saved', {
      remarks: `Saved production pair rule: ${pairing_type}`,
      metadata: { old_value: oldValue, new_value: req.body }
    });
    res.json({ message: 'Production share rule saved.' });
  } catch (err) {
    console.error('Error saving production share rule:', err);
    res.status(500).json({ error: 'Failed to save production share rule.' });
  }
});

router.post('/piece-rates', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const { id, product_type, product_category, sew_type_code, size_range, piece_rate, effective_date, is_active } = req.body;
    const sewCode = String(sew_type_code || product_type || '').trim().toUpperCase();
    const range = String(size_range || product_category || '').trim();
    if (!sewCode) return res.status(400).json({ error: 'Type of Sew is required.' });
    if (!range) return res.status(400).json({ error: 'Size Range is required.' });
    if (!(Number(piece_rate) > 0)) return res.status(400).json({ error: 'Piece rate must be greater than zero.' });
    if (!effective_date) return res.status(400).json({ error: 'Effective date is required.' });

    let oldValue = null;
    if (Number(is_active) !== 0) {
      await pool.execute(`
        UPDATE payroll_piece_rates
           SET is_active = 0, updated_by = ?
         WHERE is_active = 1
           AND COALESCE(sew_type_code, product_type) = ?
           AND COALESCE(size_range, product_category, '') = ?
           AND id <> COALESCE(?, 0)
      `, [currentUserId(req), sewCode, range, id || 0]);
    }
    if (id) {
      const [oldRows] = await pool.execute('SELECT * FROM payroll_piece_rates WHERE id = ?', [id]);
      oldValue = oldRows[0] || null;
      await pool.execute(`
        UPDATE payroll_piece_rates
           SET product_type = ?, product_category = ?, sew_type_code = ?, size_range = ?,
               piece_rate = ?, effective_date = ?, is_active = ?, updated_by = ?
         WHERE id = ?
      `, [sewCode, range, sewCode, range, piece_rate, effective_date, Number(is_active) === 0 ? 0 : 1, currentUserId(req), id]);
    } else {
      await pool.execute(`
        INSERT INTO payroll_piece_rates
          (product_type, product_category, sew_type_code, size_range, piece_rate, effective_date, is_active, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [sewCode, range, sewCode, range, piece_rate, effective_date, Number(is_active) === 0 ? 0 : 1, currentUserId(req), currentUserId(req)]);
    }
    await logPayrollAudit(pool, req, 'piece_rate_configuration_saved', {
      remarks: `Saved piece rate: ${sewCode} / ${range}`,
      metadata: { old_value: oldValue, new_value: req.body }
    });
    res.json({ message: 'Piece rate saved.' });
  } catch (err) {
    console.error('Error saving piece rate:', err);
    res.status(500).json({ error: 'Failed to save piece rate.' });
  }
});

router.post('/production-splits', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
  const pool = require('../config/db');
  const connection = await pool.getConnection();
  try {
    await ensurePieceRatePayrollSchema(pool);
    const { id, split_name, sewer_percentage, fixer_percentage, effective_date, is_active } = req.body;
    const splitName = String(split_name || '').trim();
    const sewer = Number(sewer_percentage || 0);
    const fixer = Number(fixer_percentage || 0);
    const active = Number(is_active) === 0 ? 0 : 1;
    if (!splitName) return res.status(400).json({ error: 'Split Name is required.' });
    if (!(sewer > 0)) return res.status(400).json({ error: 'Sewer Percentage must be greater than zero.' });
    if (!(fixer > 0)) return res.status(400).json({ error: 'Fixer Percentage must be greater than zero.' });
    if (Math.abs(sewer + fixer - 100) > 0.001) return res.status(400).json({ error: 'Total Percentage must equal 100%.' });
    if (!effective_date) return res.status(400).json({ error: 'Effective Date is required.' });

    await connection.beginTransaction();
    let oldValue = null;
    if (id) {
      const [oldRows] = await connection.execute('SELECT * FROM payroll_production_split_configs WHERE id = ?', [id]);
      oldValue = oldRows[0] || null;
    }
    if (active) {
      await connection.execute('UPDATE payroll_production_split_configs SET is_active = 0, updated_by = ? WHERE is_active = 1 AND id <> COALESCE(?, 0)', [currentUserId(req), id || 0]);
    }
    if (id) {
      await connection.execute(`
        UPDATE payroll_production_split_configs
           SET split_name = ?, sewer_percentage = ?, fixer_percentage = ?, effective_date = ?, is_active = ?, updated_by = ?
         WHERE id = ?
      `, [splitName, sewer, fixer, effective_date, active, currentUserId(req), id]);
    } else {
      await connection.execute(`
        INSERT INTO payroll_production_split_configs
          (split_name, sewer_percentage, fixer_percentage, effective_date, is_active, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [splitName, sewer, fixer, effective_date, active, currentUserId(req), currentUserId(req)]);
    }
    await logPayrollAudit(connection, req, 'production_split_configuration_saved', {
      remarks: `Saved production split: ${splitName}`,
      metadata: { old_value: oldValue, new_value: req.body }
    });
    await connection.commit();
    res.json({ message: 'Production split configuration saved.' });
  } catch (err) {
    await connection.rollback();
    console.error('Error saving production split:', err);
    res.status(500).json({ error: 'Failed to save production split.' });
  } finally {
    connection.release();
  }
});

router.post('/production-shares', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
  const pool = require('../config/db');
  const connection = await pool.getConnection();
  try {
    await ensurePieceRatePayrollSchema(pool);
    const rows = Array.isArray(req.body.shares) ? req.body.shares : [];
    if (!rows.length) return res.status(400).json({ error: 'At least one production share row is required.' });
    const total = rows.reduce((sum, row) => sum + Number(row.percentage_share || 0), 0);
    if (Math.abs(total - 100) > 0.001) return res.status(400).json({ error: 'Production share percentages must total exactly 100%.' });
    if (rows.some(row => !String(row.worker_category || '').trim() || !(Number(row.percentage_share) > 0) || !row.effective_date)) {
      return res.status(400).json({ error: 'Worker category, percentage share, and effective date are required.' });
    }

    await connection.beginTransaction();
    const [oldRows] = await connection.execute('SELECT * FROM payroll_production_shares WHERE is_active = 1 ORDER BY worker_category');
    await connection.execute('UPDATE payroll_production_shares SET is_active = 0, updated_by = ? WHERE is_active = 1', [currentUserId(req)]);
    for (const row of rows) {
      await connection.execute(`
        INSERT INTO payroll_production_shares
          (worker_category, percentage_share, effective_date, is_active, created_by, updated_by)
        VALUES (?, ?, ?, 1, ?, ?)
      `, [String(row.worker_category).trim(), row.percentage_share, row.effective_date, currentUserId(req), currentUserId(req)]);
    }
    await logPayrollAudit(connection, req, 'production_share_configuration_saved', {
      remarks: 'Saved production share percentages',
      metadata: { old_value: oldRows, new_value: rows }
    });
    await connection.commit();
    res.json({ message: 'Production shares saved.' });
  } catch (err) {
    await connection.rollback();
    console.error('Error saving production shares:', err);
    res.status(500).json({ error: 'Failed to save production shares.' });
  } finally {
    connection.release();
  }
});

router.post('/piece-incentives', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const { id, incentive_name, incentive_category, amount, threshold_quantity, sewing_type, computation_type, effective_date, is_active } = req.body;
    const categories = ['Quota Incentive', 'Sunday Work Incentive', 'Special Sewing Type Incentive'];
    if (!String(incentive_name || '').trim()) return res.status(400).json({ error: 'Incentive name is required.' });
    if (!categories.includes(incentive_category)) return res.status(400).json({ error: 'Valid incentive category is required.' });
    if (!(Number(amount) >= 0)) return res.status(400).json({ error: 'Incentive amount is required.' });
    if (!effective_date) return res.status(400).json({ error: 'Effective date is required.' });
    if (incentive_category === 'Quota Incentive' && !(Number(threshold_quantity) > 0)) {
      return res.status(400).json({ error: 'Quota incentive requires a threshold quantity.' });
    }

    let oldValue = null;
    if (id) {
      const [oldRows] = await pool.execute('SELECT * FROM payroll_piece_incentives WHERE id = ?', [id]);
      oldValue = oldRows[0] || null;
      await pool.execute(`
        UPDATE payroll_piece_incentives
           SET incentive_name = ?, incentive_category = ?, amount = ?, threshold_quantity = ?,
               sewing_type = ?, computation_type = ?, effective_date = ?, is_active = ?, updated_by = ?
         WHERE id = ?
      `, [incentive_name.trim(), incentive_category, amount, threshold_quantity || null, sewing_type || null, computation_type || 'Fixed Amount', effective_date, Number(is_active) === 0 ? 0 : 1, currentUserId(req), id]);
    } else {
      await pool.execute(`
        INSERT INTO payroll_piece_incentives
          (incentive_name, incentive_category, amount, threshold_quantity, sewing_type, computation_type, effective_date, is_active, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [incentive_name.trim(), incentive_category, amount, threshold_quantity || null, sewing_type || null, computation_type || 'Fixed Amount', effective_date, Number(is_active) === 0 ? 0 : 1, currentUserId(req), currentUserId(req)]);
    }
    await logPayrollAudit(pool, req, 'piece_incentive_configuration_saved', {
      remarks: `Saved incentive: ${incentive_name}`,
      metadata: { old_value: oldValue, new_value: req.body }
    });
    res.json({ message: 'Piece-rate incentive saved.' });
  } catch (err) {
    console.error('Error saving piece-rate incentive:', err);
    res.status(500).json({ error: 'Failed to save piece-rate incentive.' });
  }
});

async function deactivatePayrollConfigRecord(req, res, table, idColumn, auditAction, label) {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const recordId = Number(req.params.id);
    if (!Number.isInteger(recordId) || recordId <= 0) {
      return res.status(400).json({ error: 'Valid record id is required.' });
    }

    const [oldRows] = await pool.execute(`SELECT * FROM ${table} WHERE ${idColumn} = ? LIMIT 1`, [recordId]);
    const oldValue = oldRows[0] || null;
    if (!oldValue) return res.status(404).json({ error: `${label} not found.` });

    await pool.execute(
      `UPDATE ${table}
          SET is_active = 0,
              updated_by = ?
        WHERE ${idColumn} = ?`,
      [currentUserId(req), recordId]
    );

    await logPayrollAudit(pool, req, auditAction, {
      remarks: `Deleted ${label} record ID ${recordId}`,
      metadata: { old_value: oldValue, soft_delete: true }
    });

    return res.json({ message: `${label} deleted.` });
  } catch (err) {
    console.error(`Error deleting ${label}:`, err);
    return res.status(500).json({ error: `Failed to delete ${label}.` });
  }
}

router.delete('/sew-types/:id', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), (req, res) =>
  deactivatePayrollConfigRecord(req, res, 'payroll_sew_types', 'id', 'sew_type_configuration_deleted', 'Type of Sew')
);

router.delete('/size-ranges/:id', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), (req, res) =>
  deactivatePayrollConfigRecord(req, res, 'payroll_size_ranges', 'id', 'size_range_configuration_deleted', 'Size range')
);

router.delete('/production-share-rules/:id', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), (req, res) =>
  deactivatePayrollConfigRecord(req, res, 'payroll_production_share_rules', 'id', 'production_pair_share_rule_deleted', 'Sharing rule')
);

router.delete('/production-splits/:id', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), (req, res) =>
  deactivatePayrollConfigRecord(req, res, 'payroll_production_split_configs', 'id', 'production_split_configuration_deleted', 'Production split')
);

router.delete('/piece-incentives/:id', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), (req, res) =>
  deactivatePayrollConfigRecord(req, res, 'payroll_piece_incentives', 'id', 'piece_incentive_configuration_deleted', 'Incentive rule')
);

router.delete('/piece-rates/:id', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), (req, res) =>
  deactivatePayrollConfigRecord(req, res, 'payroll_piece_rates', 'id', 'piece_rate_configuration_deleted', 'Piece rate')
);

router.post('/piece-incentive-entries', requireAuth, requireRole(ROLES.payroll_any), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const { employee_id, payroll_period, incentive_type, amount, remarks } = req.body;
    const types = ['Quota Incentive', 'Sunday Work Incentive', 'Special Sewing Incentive'];
    if (!employee_id) return res.status(400).json({ error: 'Employee is required.' });
    if (!payroll_period) return res.status(400).json({ error: 'Payroll period is required.' });
    if (!types.includes(incentive_type)) return res.status(400).json({ error: 'Valid incentive type is required.' });
    if (!(Number(amount) > 0)) return res.status(400).json({ error: 'Amount must be greater than zero.' });
    const [result] = await pool.execute(`
      INSERT INTO payroll_piece_incentive_entries
        (employee_id, payroll_period, incentive_type, amount, remarks, created_by)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [employee_id, payroll_period, incentive_type, amount, remarks || null, currentUserId(req)]);
    await logPayrollAudit(pool, req, 'piece_incentive_encoded', {
      employee_id,
      remarks: `Encoded ${incentive_type}`,
      metadata: { id: result.insertId, new_value: req.body }
    });
    res.json({ id: result.insertId, message: 'Incentive encoded.' });
  } catch (err) {
    console.error('Error encoding piece incentive:', err);
    res.status(500).json({ error: 'Failed to encode incentive.' });
  }
});

async function resolveDailyPieceOutput(pool, input) {
  const outputDate = String(input.output_date || input.production_date || '').slice(0, 10);
  const payrollPeriod = String(input.payroll_period || input.payroll_period_id || '').trim();
  const operationType = String(input.operation_type || input.sew_type_code || '').trim().toUpperCase();
  const sizeRange = String(input.size_range || '').trim();
  const quantity = Number(input.quantity_produced || 0);
  const outputMode = String(input.output_mode || (input.partner_employee_id || input.worker2_employee_id ? 'partner' : 'solo')).toLowerCase();
  const primaryEmployeeId = Number(input.employee_id || input.worker1_employee_id || 0);
  const partnerEmployeeId = Number(input.partner_employee_id || input.worker2_employee_id || 0) || null;
  if (!/^\d{4}-\d{2}$/.test(payrollPeriod)) throw new Error('A valid payroll period is required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(outputDate)) throw new Error('A valid output date is required.');
  if (outputDate.slice(0, 7) !== payrollPeriod) throw new Error('Output date must fall within the selected payroll period.');
  if (!operationType || !sizeRange || !(quantity > 0) || !primaryEmployeeId) {
    throw new Error('Employee, output date, Type of Sew, Size Range, and quantity are required.');
  }
  if (!['solo', 'partner'].includes(outputMode)) throw new Error('Output mode must be solo or partner.');
  if (outputMode === 'partner' && (!partnerEmployeeId || partnerEmployeeId === primaryEmployeeId)) {
    throw new Error('A different partner employee is required for partner output.');
  }
  const rate = await activePieceRate(pool, operationType, sizeRange, outputDate);
  if (!rate) throw new Error('No active configured rate exists for this Type of Sew, Size Range, and output date.');
  const fullAmount = roundMoney(quantity * Number(rate.piece_rate));
  if (outputMode === 'solo') {
    return { payrollPeriod, outputDate, operationType, sizeRange, quantity, rate, fullAmount, outputMode, splitRule: 'SOLO', shares: [{ employee_id: primaryEmployeeId, partner_role: 'Solo', share_percentage: 100, share_amount: fullAmount }] };
  }
  const pairingType = String(input.split_rule || input.pairing_type || 'Standard Sewer-Fixer');
  const pair = await computeProductionPairPayroll(pool, {
    payroll_period: payrollPeriod,
    production_date: outputDate,
    worker1_employee_id: primaryEmployeeId,
    worker2_employee_id: partnerEmployeeId,
    pairing_type: pairingType,
    sew_type_code: operationType,
    size_range: sizeRange,
    quantity_produced: quantity
  });
  return {
    payrollPeriod, outputDate, operationType, sizeRange, quantity, rate, fullAmount,
    outputMode, splitRule: pairingType,
    shares: [
      { employee_id: pair.worker1_employee_id, partner_role: pairingType === 'Substitute Sewer-Sewer' ? 'Sewer 1' : 'Sewer', share_percentage: pair.worker1_share, share_amount: roundMoney(pair.worker1_earnings) },
      { employee_id: pair.worker2_employee_id, partner_role: pairingType === 'Substitute Sewer-Sewer' ? 'Sewer 2' : 'Fixer', share_percentage: pair.worker2_share, share_amount: roundMoney(pair.worker2_earnings) }
    ]
  };
}

async function assertPieceCalculationsMutable(pool, employeeIds, payrollPeriod) {
  const uniqueIds = [...new Set(employeeIds.map(Number).filter(Boolean))];
  if (!uniqueIds.length) return;
  const placeholders = uniqueIds.map(() => '?').join(',');
  const [rows] = await pool.execute(`
    SELECT id, employee_id, status FROM salary_calculations
     WHERE payroll_period = ? AND employee_id IN (${placeholders})
       AND status IN ('Finalized', 'Paid', 'Released')
  `, [payrollPeriod, ...uniqueIds]);
  if (rows.length) throw new Error('A finalized or paid salary calculation exists for this output. Reopen it through an authorized correction flow before editing production.');
}

async function recomputePieceRateCalculations(pool, employeeIds, payrollPeriod, userId, calculationStatus = 'Draft') {
  const uniqueIds = [...new Set(employeeIds.map(Number).filter(Boolean))];
  const requestedStatus = calculationStatus === 'Submitted' ? 'Submitted' : 'Draft';
  const [wageTypes] = await pool.execute(`
    SELECT id FROM wage_types
     WHERE LOWER(name) IN ('per-piece', 'piece rate')
     ORDER BY CASE WHEN LOWER(name) = 'per-piece' THEN 0 ELSE 1 END
     LIMIT 1
  `);
  if (!wageTypes[0]) throw new Error('Piece Rate wage type is not configured.');
  for (const employeeId of uniqueIds) {
    const [totals] = await pool.execute(`
      SELECT COALESCE(SUM(s.share_amount), 0) AS gross_pay,
             COALESCE(SUM(o.quantity_produced), 0) AS total_output
        FROM piece_rate_output_shares s
        JOIN piece_rate_outputs o ON o.id = s.piece_rate_output_id
       WHERE s.employee_id = ? AND o.payroll_period_id = ?
         AND o.status NOT IN ('Voided')
    `, [employeeId, payrollPeriod]);
    const outputGrossPay = roundMoney(totals[0]?.gross_pay || 0);
    const outputTotal = Number(totals[0]?.total_output || 0);
    const [existing] = await pool.execute(`
      SELECT id, status, source_record_ids, total_deductions FROM salary_calculations
       WHERE employee_id = ? AND payroll_period = ? AND wage_type_id = ?
         AND status <> 'Superseded'
       ORDER BY id DESC LIMIT 1
    `, [employeeId, payrollPeriod, wageTypes[0].id]);
    if (existing[0]) {
      if (['Finalized', 'Paid', 'Released'].includes(existing[0].status)) throw new Error('A finalized or paid salary calculation cannot be recomputed.');
      let baseline = { gross_pay: 0, total_output: 0 };
      try {
        const source = existing[0].source_record_ids ? JSON.parse(existing[0].source_record_ids) : {};
        baseline = { ...baseline, ...(source.legacy_baseline || {}) };
      } catch (_) {}
      const grossPay = roundMoney(Number(baseline.gross_pay || 0) + outputGrossPay);
      const totalOutput = Number(baseline.total_output || 0) + outputTotal;
      const shouldPersistDeductions = requestedStatus === 'Submitted' || existing[0].status === 'Submitted';
      const deductions = shouldPersistDeductions
        ? await calculateSalaryDeductionSnapshot(pool, employeeId, grossPay, `${payrollPeriod}-01`)
        : { total: 0, employeeTotal: 0, rows: [], configuredBreakdown: { sss: 0, pagibig: 0, philhealth: 0 } };
      const totalDeductions = roundMoney(deductions.total || 0);
      const nextStatus = ['Draft', 'Calculated'].includes(existing[0].status) && ['Calculated', 'Submitted'].includes(requestedStatus)
        ? requestedStatus
        : existing[0].status;
      await pool.execute(`
        UPDATE salary_calculations
           SET base_rate = 0, quantity = ?, gross_pay = ?, net_pay = ?,
               sss_deduction = ?, pagibig_deduction = ?, philhealth_deduction = ?,
               total_deductions = ?, employee_deduction_total = ?, calculation_date = ?, calculated_by = ?,
               source_type = 'piece_rate_output', source_record_ids = ?, validation_snapshot = ?, status = ?
         WHERE id = ?
      `, [totalOutput, grossPay, grossPay - totalDeductions, totalDeductions, `${payrollPeriod}-01`, userId || null,
        JSON.stringify({ legacy_baseline: baseline }), nextStatus, existing[0].id]);
    } else {
      await pool.execute(`
        INSERT INTO salary_calculations
          (employee_id, wage_type_id, base_rate, quantity, hours_worked, days_worked,
           total_allowances, overtime_hours, overtime_amount, gross_pay, sss_deduction,
           pagibig_deduction, philhealth_deduction, total_deductions, net_pay,
           calculation_date, payroll_period, status, calculated_by)
        VALUES (?, ?, 0, ?, 0, 0, 0, 0, 0, ?, 0, 0, 0, 0, ?, ?, ?, ?, ?)
      `, [employeeId, wageTypes[0].id, outputTotal, outputGrossPay, outputGrossPay, `${payrollPeriod}-01`, payrollPeriod, requestedStatus, userId || null]);
    }
  }
}

router.post('/piece-rate-outputs', requireAuth, requireRole(ROLES.payroll_any), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  const pool = require('../config/db');
  let connection;
  try {
    await ensurePieceRatePayrollSchema(pool);
    const output = await resolveDailyPieceOutput(pool, req.body);
    await assertPieceCalculationsMutable(pool, output.shares.map(row => row.employee_id), output.payrollPeriod);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.execute(`
      INSERT INTO piece_rate_outputs
        (payroll_period_id, output_date, operation_type, size_range, quantity_produced,
         rate_per_piece, full_amount, output_mode, split_rule, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?)
    `, [output.payrollPeriod, output.outputDate, output.operationType, output.sizeRange, output.quantity,
      output.rate.piece_rate, output.fullAmount, output.outputMode, output.splitRule, currentUserId(req)]);
    for (const share of output.shares) {
      await connection.execute(`
        INSERT INTO piece_rate_output_shares
          (piece_rate_output_id, employee_id, partner_role, share_percentage, share_amount)
        VALUES (?, ?, ?, ?, ?)
      `, [result.insertId, share.employee_id, share.partner_role, share.share_percentage, share.share_amount]);
    }
    const recalculated = await recomputePieceRateCalculations(
      connection, output.shares.map(row => row.employee_id), output.payrollPeriod,
      currentUserId(req), req.body.calculation_status
    );
    const queuedCalculations = [];
    for (const calculation of recalculated.filter(row => row.status === 'Submitted')) {
      const blockchainQueue = await queueSubmittedPayrollRecord(connection, req, calculation.salary_calculation_id);
      queuedCalculations.push(blockchainQueue);
      await logPayrollAudit(connection, req, calculation.submitted_now ? 'salary_calculation_submitted' : 'salary_calculation_requeued', {
        employee_id: calculation.employee_id,
        salary_calculation_id: calculation.salary_calculation_id,
        remarks: calculation.submitted_now
          ? 'Submitted per-piece payroll calculation for approval.'
          : 'Refreshed submitted piece-rate payroll calculation in the integrity queue.',
        metadata: { blockchain_queue: blockchainQueue, source_type: 'piece_rate_output' }
      });
    }
    await logPayrollAudit(connection, req, 'piece_rate_daily_output_encoded', {
      employee_id: output.shares[0].employee_id,
      remarks: `Encoded ${output.operationType} daily output for ${output.outputDate}`,
      metadata: { piece_rate_output_id: result.insertId, output, queued_calculations: queuedCalculations }
    });
    await connection.commit();
    res.status(201).json({ id: result.insertId, ...output, queued_calculations: queuedCalculations });
  } catch (err) {
    if (connection) await connection.rollback();
    console.error('Error encoding daily piece-rate output:', err);
    res.status(400).json({ error: safePayrollError(err, 'Failed to encode daily piece-rate output.') });
  } finally { if (connection) connection.release(); }
});

router.patch('/piece-rate-outputs/:id', requireAuth, requireRole(ROLES.payroll_any), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  const pool = require('../config/db');
  let connection;
  try {
    await ensurePieceRatePayrollSchema(pool);
    const [existingRows] = await pool.execute('SELECT * FROM piece_rate_outputs WHERE id = ? LIMIT 1', [req.params.id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'Daily piece-rate output was not found.' });
    if (['Finalized', 'Paid', 'Released'].includes(existing.status)) return res.status(409).json({ error: 'Finalized or paid output cannot be edited.' });
    const [oldShares] = await pool.execute('SELECT employee_id FROM piece_rate_output_shares WHERE piece_rate_output_id = ?', [existing.id]);
    const output = await resolveDailyPieceOutput(pool, req.body);
    const affectedEmployees = [...oldShares.map(row => row.employee_id), ...output.shares.map(row => row.employee_id)];
    await assertPieceCalculationsMutable(pool, affectedEmployees, existing.payroll_period_id);
    await assertPieceCalculationsMutable(pool, affectedEmployees, output.payrollPeriod);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute(`
      UPDATE piece_rate_outputs
         SET payroll_period_id = ?, output_date = ?, operation_type = ?, size_range = ?,
             quantity_produced = ?, rate_per_piece = ?, full_amount = ?, output_mode = ?,
             split_rule = ?, updated_at = NOW()
       WHERE id = ?
    `, [output.payrollPeriod, output.outputDate, output.operationType, output.sizeRange, output.quantity,
      output.rate.piece_rate, output.fullAmount, output.outputMode, output.splitRule, existing.id]);
    await connection.execute('DELETE FROM piece_rate_output_shares WHERE piece_rate_output_id = ?', [existing.id]);
    for (const share of output.shares) {
      await connection.execute(`INSERT INTO piece_rate_output_shares
        (piece_rate_output_id, employee_id, partner_role, share_percentage, share_amount) VALUES (?, ?, ?, ?, ?)`,
      [existing.id, share.employee_id, share.partner_role, share.share_percentage, share.share_amount]);
    }
    const oldEmployeeIds = oldShares.map(row => row.employee_id);
    const newEmployeeIds = output.shares.map(row => row.employee_id);
    const recalculated = await recomputePieceRateCalculations(
      connection,
      existing.payroll_period_id === output.payrollPeriod ? affectedEmployees : oldEmployeeIds,
      existing.payroll_period_id,
      currentUserId(req)
    );
    if (existing.payroll_period_id !== output.payrollPeriod) {
      recalculated.push(...await recomputePieceRateCalculations(connection, newEmployeeIds, output.payrollPeriod, currentUserId(req)));
    }
    const queuedCalculations = [];
    for (const calculation of recalculated.filter(row => row.status === 'Submitted')) {
      queuedCalculations.push(await queueSubmittedPayrollRecord(connection, req, calculation.salary_calculation_id));
    }
    await connection.commit();
    await logPayrollAudit(pool, req, 'piece_rate_daily_output_updated', {
      remarks: `Updated daily piece-rate output ${existing.id}`,
      metadata: { output, queued_calculations: queuedCalculations }
    });
    res.json({ id: existing.id, ...output, queued_calculations: queuedCalculations });
  } catch (err) {
    if (connection) await connection.rollback();
    res.status(400).json({ error: safePayrollError(err, 'Failed to update daily piece-rate output.') });
  } finally { if (connection) connection.release(); }
});

router.delete('/piece-rate-outputs/:id', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  const pool = require('../config/db');
  let connection;
  try {
    await ensurePieceRatePayrollSchema(pool);
    const [rows] = await pool.execute('SELECT * FROM piece_rate_outputs WHERE id = ? LIMIT 1', [req.params.id]);
    const output = rows[0];
    if (!output) return res.status(404).json({ error: 'Daily piece-rate output was not found.' });
    if (['Finalized', 'Paid', 'Released'].includes(output.status)) return res.status(409).json({ error: 'Finalized or paid output cannot be deleted.' });
    const [shares] = await pool.execute('SELECT employee_id FROM piece_rate_output_shares WHERE piece_rate_output_id = ?', [output.id]);
    await assertPieceCalculationsMutable(pool, shares.map(row => row.employee_id), output.payroll_period_id);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    await connection.execute('DELETE FROM piece_rate_outputs WHERE id = ?', [output.id]);
    const recalculated = await recomputePieceRateCalculations(
      connection,
      shares.map(row => row.employee_id),
      output.payroll_period_id,
      currentUserId(req)
    );
    const queuedCalculations = [];
    for (const calculation of recalculated.filter(row => row.status === 'Submitted')) {
      queuedCalculations.push(await queueSubmittedPayrollRecord(connection, req, calculation.salary_calculation_id));
    }
    await connection.commit();
    await logPayrollAudit(pool, req, 'piece_rate_daily_output_deleted', {
      remarks: `Deleted daily piece-rate output ${output.id}`,
      metadata: { queued_calculations: queuedCalculations }
    });
    res.json({ success: true, queued_calculations: queuedCalculations });
  } catch (err) {
    if (connection) await connection.rollback();
    res.status(400).json({ error: safePayrollError(err, 'Failed to delete daily piece-rate output.') });
  } finally { if (connection) connection.release(); }
});

router.post('/production-output', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const payroll = await computePieceRatePayroll(pool, req.body);
    const payrollPeriod = req.body.payroll_period || payroll.output_date.slice(0, 7);
    const [result] = await pool.execute(`
      INSERT INTO payroll_production_outputs
        (employee_id, payroll_period, product_type, product_category, sew_type_code, size_range, worker_category, quantity_produced,
         piece_rate, production_value, share_percentage, quota_incentive, sunday_incentive, special_incentive,
         final_gross_pay, output_date, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      req.body.employee_id || null,
      payrollPeriod,
      payroll.product_type,
      payroll.product_category || null,
      payroll.sew_type_code || payroll.product_type,
      payroll.size_range || payroll.product_category || null,
      payroll.worker_category,
      payroll.quantity_produced,
      payroll.piece_rate,
      payroll.production_value,
      payroll.share_percentage,
      payroll.quota_incentive,
      payroll.sunday_incentive,
      payroll.special_incentive,
      payroll.final_gross_pay,
      payroll.output_date,
      currentUserId(req)
    ]);
    await logPayrollAudit(pool, req, 'production_output_encoded', {
      employee_id: req.body.employee_id || null,
      remarks: `Encoded ${payroll.quantity_produced} pieces for ${payroll.product_type}`,
      metadata: { id: result.insertId, payroll }
    });
    res.json({ id: result.insertId, ...payroll });
  } catch (err) {
    console.error('Error encoding production output:', err);
    res.status(400).json({ error: safePayrollError(err, 'Failed to encode production output.') });
  }
});

router.post('/production-pairs', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const pair = await computeProductionPairPayroll(pool, req.body);
    const [result] = await pool.execute(`
      INSERT INTO payroll_production_pairs
        (production_date, payroll_period, worker1_employee_id, worker2_employee_id, pairing_type,
         product_type, product_category, sew_type_code, size_range, quantity_produced, piece_rate, production_value,
         worker1_share, worker2_share, worker1_earnings, worker2_earnings, rule_snapshot, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      pair.production_date,
      pair.payroll_period,
      pair.worker1_employee_id,
      pair.worker2_employee_id,
      pair.pairing_type,
      pair.product_type,
      pair.product_category || null,
      pair.sew_type_code,
      pair.size_range,
      pair.quantity_produced,
      pair.piece_rate,
      pair.production_value,
      pair.worker1_share,
      pair.worker2_share,
      pair.worker1_earnings,
      pair.worker2_earnings,
      JSON.stringify(pair.rule_snapshot),
      currentUserId(req)
    ]);
    await logPayrollAudit(pool, req, 'production_pair_assignment_encoded', {
      employee_id: pair.worker1_employee_id,
      remarks: `Encoded ${pair.pairing_type} pair output for ${pair.sew_type_code} / ${pair.size_range}`,
      metadata: { id: result.insertId, pair }
    });
    res.json({ id: result.insertId, ...pair });
  } catch (err) {
    console.error('Error encoding production pair:', err);
    res.status(400).json({ error: safePayrollError(err, 'Failed to encode production pair.') });
  }
});

// Save salary calculation (Base Salary or Hourly)
router.post('/salary-calculation', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const {
      salary_calculation_id,
      employee_id,
      wage_type_id,
      base_rate,
      quantity,
      hours_worked,
      days_worked,
      housing_allowance,
      meal_allowance,
      transport_allowance,
      bonus_allowance,
      total_allowances,
      overtime_hours,
      overtime_amount,
      gross_pay,
      sss_deduction,
      pagibig_deduction,
      philhealth_deduction,
      total_deductions,
      net_pay,
      calculation_date,
      payroll_period,
      agency_name,
      status,
      product_type,
      product_category,
      sew_type_code,
      size_range,
      worker_category,
      quantity_produced,
      is_sunday,
      partner_employee_id,
      pairing_type,
      production_date,
      piece_rows,
      quota_incentive,
      sunday_incentive,
      special_incentive
    } = req.body;

    console.log('\n=== POST /api/payroll/salary-calculation ===');
    console.log('Employee ID:', employee_id);
    console.log('Wage Type ID:', wage_type_id);
    console.log('Gross:', gross_pay, '| Net:', net_pay);
    console.log('Hours Worked:', hours_worked, '| Days Worked:', days_worked);

    const calcDate = calculation_date || new Date().toISOString().split('T')[0];
    await ensurePieceRatePayrollSchema(pool);
    const [employeeStatusRows] = await pool.execute(
      "SELECT status FROM employees WHERE id = ? LIMIT 1",
      [employee_id]
    );
    if (!employeeStatusRows.length || String(employeeStatusRows[0].status || 'Active') !== 'Active') {
      return res.status(400).json({ error: 'Payroll can only be processed for active employees.' });
    }
    const [wageRows] = await pool.execute('SELECT name FROM wage_types WHERE id = ? LIMIT 1', [wage_type_id]);
    const wageTypeName = wageRows[0]?.name || '';
    const isPieceRate = /piece/i.test(wageTypeName);
    const normalizedWageType = normalizePayrollWageType(wageTypeName);
    if (isPieceRate) {
      return res.status(400).json({
        error: 'Per-Piece payroll must be encoded as daily output records. Use the Piece-Rate Daily Output workflow.'
      });
    }
    if (isTripBasedWageType(wageTypeName)) {
      return res.status(400).json({
        error: 'Trip-Based and Logistics payroll must be generated from approved delivery trips. Use the Logistics Trip Payroll workflow.'
      });
    }
    const isDailyRate = normalizedWageType === 'Daily';
    const isMonthlyRate = normalizedWageType === 'Monthly';
    const isHourlyRate = normalizedWageType === 'Hourly';
    let serverGrossPay = parseFloat(gross_pay || 0);
    let serverBaseRate = parseFloat(base_rate || 0);
    let serverQuantity = quantity || 1;
    let pieceComputation = null;
    let validationSnapshot = null;

    if ((isDailyRate || isMonthlyRate || isHourlyRate) && status !== 'Draft') {
      validationSnapshot = await validateDailyHourlyPayroll(pool, {
        employee_id,
        payroll_period,
        calculation_date: calcDate,
        wage_type: normalizedWageType
      });
      if (!validationSnapshot.ok) {
        await logPayrollAudit(pool, req, 'payroll_validation_failure', {
          employee_id,
          remarks: validationSnapshot.errors.join('; '),
          metadata: validationSnapshot
        });
        return res.status(400).json({
          error: validationSnapshot.errors.join(' '),
          validation: validationSnapshot
        });
      }
      serverBaseRate = validationSnapshot.rate;
      if (isDailyRate || isMonthlyRate) {
        serverQuantity = validationSnapshot.days_worked;
      } else {
        serverQuantity = validationSnapshot.hours_worked;
      }
      serverGrossPay = validationSnapshot.gross_pay + parseFloat(total_allowances || 0);
    }

    if (isPieceRate) {
      const rows = Array.isArray(piece_rows) ? piece_rows : [];
      if (rows.length) {
        if (!partner_employee_id) throw new Error('Partner employee is required for per-piece salary calculation.');
        const pairRows = [];
        for (const row of rows) {
          if (!(Number(row.quantity_produced) > 0)) continue;
          const pair = await computeProductionPairPayroll(pool, {
            production_date: production_date || calcDate,
            payroll_period: payroll_period || calcDate.slice(0, 7),
            worker1_employee_id: employee_id,
            worker2_employee_id: partner_employee_id,
            pairing_type: pairing_type || 'Standard Sewer-Fixer',
            sew_type_code: row.sew_type_code || row.product_type,
            size_range: row.size_range || row.product_category,
            quantity_produced: row.quantity_produced
          });
          pairRows.push(pair);
        }
        if (!pairRows.length) throw new Error('At least one valid per-piece output row is required.');
        const rawTotal = pairRows.reduce((sum, row) => sum + Number(row.production_value || 0), 0);
        const worker1Earnings = pairRows.reduce((sum, row) => sum + Number(row.worker1_earnings || 0), 0);
        const worker2Earnings = pairRows.reduce((sum, row) => sum + Number(row.worker2_earnings || 0), 0);
        const incentiveTotal = Number(quota_incentive || 0) + Number(sunday_incentive || 0) + Number(special_incentive || 0);
        pieceComputation = {
          mode: 'pair_rows',
          rows: pairRows,
          product_type: pairRows[0].product_type,
          product_category: pairRows[0].product_category,
          sew_type_code: pairRows[0].sew_type_code,
          size_range: pairRows[0].size_range,
          worker_category: 'Sewer',
          quantity_produced: pairRows.reduce((sum, row) => sum + Number(row.quantity_produced || 0), 0),
          piece_rate: pairRows[0].piece_rate,
          production_value: rawTotal,
          share_percentage: pairRows[0].worker1_share,
          worker2_share_percentage: pairRows[0].worker2_share,
          worker1_earnings: worker1Earnings,
          worker2_earnings: worker2Earnings,
          quota_incentive: Number(quota_incentive || 0),
          sunday_incentive: Number(sunday_incentive || 0),
          special_incentive: Number(special_incentive || 0),
          final_gross_pay: worker1Earnings + incentiveTotal,
          output_date: production_date || calcDate,
          config_snapshot: { pair_rows: pairRows }
        };
      } else {
        pieceComputation = await computePieceRatePayroll(pool, {
          product_type,
          product_category,
          sew_type_code,
          size_range,
          worker_category,
          quantity_produced: quantity_produced || quantity,
          is_sunday,
          calculation_date: calcDate
        });
      }
      serverBaseRate = 0;
      serverQuantity = pieceComputation.quantity_produced;
      serverGrossPay = pieceComputation.final_gross_pay + parseFloat(total_allowances || 0);
    }

    const calculationStatus = ['Draft', 'Calculated', 'Submitted'].includes(status) ? status : 'Submitted';
    const shouldPersistDeductions = calculationStatus === 'Submitted';

    // Validate required fields. Drafts may be incomplete so officers can
    // return later; submitted calculations must have a computed gross pay.
    if (!employee_id || !wage_type_id || (!isPieceRate && !serverBaseRate) || (calculationStatus === 'Submitted' && !serverGrossPay)) {
      return res.status(400).json({ 
        error: isPieceRate
          ? 'Required fields: employee_id, wage_type_id, Type of Sew, Size Range, worker category, quantity produced'
          : 'Required fields: employee_id, wage_type_id, base_rate, gross_pay'
      });
    }

    const submittedAt = calculationStatus === 'Submitted' ? new Date() : null;
    const lateDeduction = numeric(validationSnapshot?.late_deduction);
    const undertimeDeduction = numeric(validationSnapshot?.undertime_deduction);
    const attendanceDeductionRows = [
      ...(lateDeduction > 0 ? [{
        id: null,
        name: 'Late Deduction',
        category: 'Attendance',
        computation_type: validationSnapshot?.policy?.late_deduction_method || 'Auto-compute from employee rate',
        amount: lateDeduction
      }] : []),
      ...(undertimeDeduction > 0 ? [{
        id: null,
        name: 'Undertime Deduction',
        category: 'Attendance',
        computation_type: validationSnapshot?.policy?.undertime_deduction_method || 'Auto-compute from employee rate',
        amount: undertimeDeduction
      }] : [])
    ];
    const computedDeductions = shouldPersistDeductions
      ? await calculateSalaryDeductionSnapshot(pool, employee_id, serverGrossPay, calcDate, attendanceDeductionRows)
      : { total: 0, employeeTotal: 0, employee: [], configured: [], applied: [], rows: [], configuredBreakdown: { sss: 0, pagibig: 0, philhealth: 0 } };
    const computedTotalDeductions = shouldPersistDeductions ? computedDeductions.total : 0;
    const computedNetPay = serverGrossPay - computedTotalDeductions;
    if (calculationStatus === 'Submitted') {
      const submittedComputedFields = [
        ['gross_pay', gross_pay, serverGrossPay],
        ['total_deductions', total_deductions, computedTotalDeductions],
        ['net_pay', net_pay, computedNetPay],
        ['sss_deduction', sss_deduction, computedDeductions.configuredBreakdown.sss || 0],
        ['pagibig_deduction', pagibig_deduction, computedDeductions.configuredBreakdown.pagibig || 0],
        ['philhealth_deduction', philhealth_deduction, computedDeductions.configuredBreakdown.philhealth || 0],
      ].filter(([field, submitted, computed]) => (
        submitted !== undefined
        && submitted !== null
        && submitted !== ''
        && Math.abs(numeric(submitted) - numeric(computed)) > 0.01
      ));
      if (submittedComputedFields.length) {
        await auditSecurityEvent(req, {
          action: 'blocked_salary_calculation_parameter_tampering_attempt',
          module: 'PAYROLL_SECURITY',
          targetTable: 'salary_calculations',
          targetRecord: salary_calculation_id || null,
          newValue: {
            fields: submittedComputedFields.map(([field]) => field),
            submitted: Object.fromEntries(submittedComputedFields.map(([field, submitted]) => [field, submitted])),
            computed: Object.fromEntries(submittedComputedFields.map(([field, , computed]) => [field, computed])),
          },
          result: 'blocked',
        });
        return res.status(403).json({ error: 'Submitted payroll totals do not match server computation.' });
      }
    }
    const snapshotForStorage = {
      ...(validationSnapshot || {}),
      deduction_status: shouldPersistDeductions ? 'Applied' : 'Not Applied',
      deductions: computedDeductions.rows.map(item => ({
        id: item.deduction_config_id || null,
        name: item.name,
        category: item.category,
        computation_type: item.computation_type,
        amount: item.amount
      }))
    };

    const calculationValues = [
      employee_id,
      wage_type_id,
      serverBaseRate,
      serverQuantity,
      isHourlyRate && validationSnapshot ? validationSnapshot.hours_worked : hours_worked || 0,
      (isDailyRate || isMonthlyRate) && validationSnapshot ? validationSnapshot.days_worked : days_worked || 0,
      housing_allowance || 0,
      meal_allowance || 0,
      transport_allowance || 0,
      bonus_allowance || 0,
      total_allowances || 0,
      overtime_hours || 0,
      overtime_amount || 0,
      serverGrossPay,
      computedDeductions.configuredBreakdown.sss || 0,
      computedDeductions.configuredBreakdown.pagibig || 0,
      computedDeductions.configuredBreakdown.philhealth || 0,
      computedTotalDeductions,
      computedDeductions.employeeTotal,
      computedNetPay,
      calcDate,
      payroll_period || calcDate.slice(0, 7),
      agency_name || null,
      JSON.stringify(snapshotForStorage),
      calculationStatus,
      currentUserId(req),
      submittedAt
    ];

    let salaryCalculationId = null;
    if (salary_calculation_id) {
      const [draftRows] = await pool.execute(
        'SELECT id, status FROM salary_calculations WHERE id = ? AND employee_id = ? LIMIT 1',
        [salary_calculation_id, employee_id]
      );
      if (!draftRows.length) return res.status(404).json({ error: 'Draft salary calculation was not found.' });
      if (['Finalized', 'Paid', 'Released'].includes(draftRows[0].status)) {
        await auditSecurityEvent(req, {
          action: 'blocked_locked_salary_calculation_update_attempt',
          module: 'PAYROLL_SECURITY',
          targetTable: 'salary_calculations',
          targetRecord: salary_calculation_id,
          oldValue: { status: draftRows[0].status },
          newValue: { requested_status: calculationStatus },
          result: 'blocked',
        });
        return res.status(409).json({ error: 'Finalized or paid salary calculations are locked.' });
      }
      await pool.execute(`
        UPDATE salary_calculations
           SET wage_type_id = ?, base_rate = ?, quantity = ?, hours_worked = ?, days_worked = ?,
               housing_allowance = ?, meal_allowance = ?, transport_allowance = ?, bonus_allowance = ?,
               total_allowances = ?, overtime_hours = ?, overtime_amount = ?, gross_pay = ?,
               sss_deduction = ?, pagibig_deduction = ?, philhealth_deduction = ?,
               total_deductions = ?, employee_deduction_total = ?, net_pay = ?, calculation_date = ?,
               payroll_period = ?, agency_name = ?, validation_snapshot = ?, status = ?,
               calculated_by = ?, submitted_at = ?, updated_at = NOW()
         WHERE id = ?
      `, [
        wage_type_id,
        serverBaseRate,
        serverQuantity,
        isHourlyRate && validationSnapshot ? validationSnapshot.hours_worked : hours_worked || 0,
        (isDailyRate || isMonthlyRate) && validationSnapshot ? validationSnapshot.days_worked : days_worked || 0,
        housing_allowance || 0,
        meal_allowance || 0,
        transport_allowance || 0,
        bonus_allowance || 0,
        total_allowances || 0,
        overtime_hours || 0,
        overtime_amount || 0,
        serverGrossPay,
        computedDeductions.configuredBreakdown.sss || 0,
        computedDeductions.configuredBreakdown.pagibig || 0,
        computedDeductions.configuredBreakdown.philhealth || 0,
        computedTotalDeductions,
        computedDeductions.employeeTotal,
        computedNetPay,
        calcDate,
        payroll_period || calcDate.slice(0, 7),
        agency_name || null,
        JSON.stringify(snapshotForStorage),
        calculationStatus,
        currentUserId(req),
        submittedAt,
        salary_calculation_id
      ]);
      salaryCalculationId = Number(salary_calculation_id);
    } else {
      if (calculationStatus === 'Submitted') {
        const [duplicates] = await pool.execute(
          `SELECT id, status
             FROM salary_calculations
            WHERE employee_id = ?
              AND payroll_period = ?
              AND COALESCE(status, '') IN ('Submitted', 'Approved', 'Finalized', 'Released', 'Paid')
            LIMIT 1`,
          [employee_id, payroll_period || calcDate.slice(0, 7)]
        );
        if (duplicates.length) {
          await auditSecurityEvent(req, {
            action: 'blocked_duplicate_salary_calculation_submission',
            module: 'PAYROLL_SECURITY',
            targetTable: 'salary_calculations',
            targetRecord: duplicates[0].id,
            oldValue: { status: duplicates[0].status },
            newValue: { employee_id, payroll_period: payroll_period || calcDate.slice(0, 7) },
            result: 'blocked',
          });
          return res.status(409).json({ error: 'A submitted payroll calculation already exists for this employee and period.' });
        }
      }
      const [result] = await pool.execute(`
        INSERT INTO salary_calculations (
          employee_id,
          wage_type_id,
          base_rate,
          quantity,
          hours_worked,
          days_worked,
          housing_allowance,
          meal_allowance,
          transport_allowance,
          bonus_allowance,
          total_allowances,
          overtime_hours,
          overtime_amount,
          gross_pay,
          sss_deduction,
          pagibig_deduction,
          philhealth_deduction,
          total_deductions,
          employee_deduction_total,
          net_pay,
          calculation_date,
          payroll_period,
          agency_name,
          validation_snapshot,
          status,
          calculated_by,
          submitted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, calculationValues);
      salaryCalculationId = result.insertId;
    }

    if (shouldPersistDeductions) {
      await applySalaryCalculationDeductionSnapshot(pool, salaryCalculationId, computedDeductions.rows);
    } else {
      await clearSalaryCalculationDeductions(pool, salaryCalculationId);
    }

    if (calculationStatus === 'Submitted' && computedDeductions.employee.length) {
      await applyEmployeeDeductionBalances(
        pool,
        req,
        employee_id,
        salaryCalculationId,
        payroll_period || calcDate.slice(0, 7),
        computedDeductions.employee
      );
    }

    if (pieceComputation?.mode === 'pair_rows') {
      for (const pair of pieceComputation.rows) {
        await pool.execute(`
          INSERT INTO payroll_production_pairs
            (production_date, payroll_period, worker1_employee_id, worker2_employee_id, pairing_type,
             product_type, product_category, sew_type_code, size_range, quantity_produced, piece_rate, production_value,
             worker1_share, worker2_share, worker1_earnings, worker2_earnings, rule_snapshot, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          pair.production_date,
          pair.payroll_period,
          pair.worker1_employee_id,
          pair.worker2_employee_id,
          pair.pairing_type,
          pair.product_type,
          pair.product_category || null,
          pair.sew_type_code,
          pair.size_range,
          pair.quantity_produced,
          pair.piece_rate,
          pair.production_value,
          pair.worker1_share,
          pair.worker2_share,
          pair.worker1_earnings,
          pair.worker2_earnings,
          JSON.stringify({ ...pair.rule_snapshot, salary_calculation_id: salaryCalculationId }),
          currentUserId(req)
        ]);
      }
    } else if (pieceComputation) {
      await pool.execute(`
        INSERT INTO payroll_production_outputs
          (employee_id, payroll_period, product_type, product_category, sew_type_code, size_range, worker_category, quantity_produced,
           piece_rate, production_value, share_percentage, quota_incentive, sunday_incentive, special_incentive,
           final_gross_pay, output_date, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        employee_id,
        payroll_period || calcDate.slice(0, 7),
        pieceComputation.product_type,
        pieceComputation.product_category || null,
        pieceComputation.sew_type_code || pieceComputation.product_type,
        pieceComputation.size_range || pieceComputation.product_category || null,
        pieceComputation.worker_category,
        pieceComputation.quantity_produced,
        pieceComputation.piece_rate,
        pieceComputation.production_value,
        pieceComputation.share_percentage,
        pieceComputation.quota_incentive,
        pieceComputation.sunday_incentive,
        pieceComputation.special_incentive,
        pieceComputation.final_gross_pay,
        pieceComputation.output_date,
        currentUserId(req)
      ]);
    }

    console.log('✅ Salary calculation saved with ID:', salaryCalculationId);
    const blockchainQueue = calculationStatus === 'Submitted'
      ? await queueSubmittedPayrollRecord(pool, req, salaryCalculationId)
      : null;

    await logPayrollAudit(pool, req, calculationStatus === 'Draft' ? 'salary_calculation_draft' : 'salary_calculation_submitted', {
      employee_id,
      salary_calculation_id: salaryCalculationId,
      remarks: `${calculationStatus} salary calculation`,
      metadata: {
        gross_pay: serverGrossPay,
        net_pay: computedNetPay,
        payroll_period,
        agency_name: agency_name || null,
        deductions: computedDeductions.applied,
        piece_rate: pieceComputation,
        blockchain_queue: blockchainQueue
      }
    });
    
    res.json({ 
      success: true, 
      id: salaryCalculationId,
      message: `Salary calculation saved for employee ID ${employee_id}`,
      gross_pay: serverGrossPay,
      net_pay: computedNetPay,
      calculation_id: salaryCalculationId,
      blockchain_queue: blockchainQueue
    });
  } catch (err) {
    console.error('❌ Error saving salary calculation:', err);
    res.status(500).json({ error: 'Failed to save salary calculation.' });
  }
});

// Get payroll data for a month
router.get('/payroll/:monthYear', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const monthYear = req.params.monthYear; // Format: YYYY-MM

    const [payrollRun] = await pool.execute(
      'SELECT * FROM payroll_runs WHERE month_year = ?',
      [monthYear]
    );

    if (!payrollRun.length) {
      return res.status(404).json({ error: 'No payroll run for this month' });
    }

    const [payslips] = await pool.execute(`
      SELECT ps.*, e.employee_code, e.first_name, e.last_name, 
             d.name AS department, w.name AS wage_type
      FROM payslips ps
      JOIN employees e ON e.id = ps.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN wage_types w ON w.id = ps.wage_type_id
      WHERE ps.payroll_run_id = ?
      ORDER BY e.employee_code
    `, [payrollRun[0].id]);

    res.json({
      payrollRun: payrollRun[0],
      payslips: payslips
    });
  } catch (err) {
    console.error('Error fetching payroll:', err);
    res.status(500).json({ error: 'Failed to fetch payroll' });
  }
});

router.get('/dashboard', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const period = monthRange(req.query.month_year);
    const statusFilter = String(req.query.status || '').trim();
    const statusParams = [];
    const salaryStatusSql = statusFilter ? ' AND sc.status = ?' : '';
    const payslipStatusSql = statusFilter ? ' AND ps.status = ?' : '';
    if (statusFilter) statusParams.push(statusFilter);

    const scalar = async (sql, params = []) => {
      const [rows] = await pool.execute(sql, params);
      return Number(Object.values(rows[0] || { value: 0 })[0] || 0);
    };

    const runFilter = periodFilterSql('month_year', period.month_year);
    const [runRows] = await pool.execute(
      `SELECT * FROM payroll_runs WHERE ${runFilter.sql} ORDER BY start_date DESC, id DESC LIMIT 1`,
      runFilter.params
    );
    const payrollRun = runRows[0] || null;
    const activeEmployeeWhere = await employeeActiveCondition(pool);

    const totalEmployees = await scalar(
      `SELECT COUNT(*) AS value FROM employees WHERE ${activeEmployeeWhere}`
    );
    const payrollReadyEmployees = await scalar(
      `SELECT COUNT(DISTINCT employee_id) AS value
         FROM attendance_summary
        WHERE attendance_date BETWEEN ? AND ?
          AND verification_status = 'PAYROLL_READY'
          AND COALESCE(payroll_eligible, 0) = 1`,
      [period.start, period.end]
    );
    const pendingAttendanceValidation = await scalar(
      `SELECT COUNT(*) AS value
         FROM attendance_summary
        WHERE attendance_date BETWEEN ? AND ?
          AND verification_status IN ('PENDING_VALIDATION','NEEDS_REVIEW','INCOMPLETE')`,
      [period.start, period.end]
    );
    const employeesWithAnyAttendance = await scalar(
      `SELECT COUNT(DISTINCT employee_id) AS value
         FROM attendance_summary
        WHERE attendance_date BETWEEN ? AND ?`,
      [period.start, period.end]
    );
    const missingAttendanceRecords = Math.max(0, totalEmployees - employeesWithAnyAttendance);
    const calcPeriodColumn = 'COALESCE(sc.payroll_period, DATE_FORMAT(sc.calculation_date, \'%Y-%m\'))';
    const calcPeriodFilter = periodFilterSql(calcPeriodColumn, period.month_year);
    const draftPayrolls = await scalar(
      `SELECT COUNT(*) AS value
         FROM salary_calculations sc
        WHERE ${calcPeriodFilter.sql}
          AND sc.status = 'Draft'`,
      calcPeriodFilter.params
    );
    const submittedPayrolls = await scalar(
      `SELECT COUNT(*) AS value
         FROM salary_calculations sc
        WHERE ${calcPeriodFilter.sql}
          AND sc.status = 'Submitted'`,
      calcPeriodFilter.params
    );

    const [estimateRows] = await pool.execute(
      `SELECT COALESCE(SUM(sc.gross_pay), 0) AS gross,
              COALESCE(SUM(sc.total_deductions), 0) AS deductions,
              COALESCE(SUM(sc.net_pay), 0) AS net
         FROM salary_calculations sc
        WHERE ${calcPeriodFilter.sql}
          ${salaryStatusSql}`,
      [...calcPeriodFilter.params, ...statusParams]
    );
    const estimate = estimateRows[0] || {};

    const [payslipRows] = await pool.execute(
      `SELECT ps.id, ps.payroll_run_id, ps.employee_id, ps.total_earning, ps.total_deduction, ps.net_pay,
              ps.status, pr.month_year, e.employee_code,
              CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
              d.name AS department, w.name AS wage_type
         FROM payslips ps
         JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
         JOIN employees e ON e.id = ps.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN wage_types w ON w.id = ps.wage_type_id
        WHERE ${periodFilterSql('pr.month_year', period.month_year).sql}
          ${payslipStatusSql}
        ORDER BY ps.created_at DESC, ps.id DESC
        LIMIT 15`,
      [...periodFilterSql('pr.month_year', period.month_year).params, ...statusParams]
    );

    res.json({
      period: {
        month_year: period.month_year,
        start_date: payrollRun?.start_date || period.start,
        end_date: payrollRun?.end_date || period.end,
        status: payrollRun?.status || 'Not Generated'
      },
      metrics: {
        totalEmployees,
        payrollReadyEmployees,
        pendingAttendanceValidation,
        missingAttendanceRecords,
        draftPayrolls,
        submittedPayrolls
      },
      estimates: {
        gross: numeric(estimate.gross),
        deductions: numeric(estimate.deductions),
        net: numeric(estimate.net)
      },
      records: payslipRows
    });
  } catch (err) {
    console.error('Error loading payroll dashboard:', err);
    res.status(500).json({ error: 'Failed to load payroll dashboard.' });
  }
});

async function buildWeeklyPayrollRegistry(pool, query = {}) {
  await ensurePieceRatePayrollSchema(pool);
  const params = [];
  const where = ['1 = 1'];
  if (query.payroll_run_id) {
    where.push('pr.id = ?');
    params.push(Number(query.payroll_run_id));
  } else if (query.month_year) {
    const filter = periodFilterSql('pr.month_year', query.month_year);
    where.push(filter.sql);
    params.push(...filter.params);
  }
  if (query.department) {
    where.push('d.name = ?');
    params.push(String(query.department).trim());
  }
  if (query.employee) {
    where.push('(CONCAT(e.first_name, " ", e.last_name) LIKE ? OR e.employee_code LIKE ?)');
    params.push(`%${query.employee}%`, `%${query.employee}%`);
  }
  if (query.employee_id) {
    where.push('e.id = ?');
    params.push(Number(query.employee_id));
  }
  if (query.pay_type || query.wage_type) {
    const pattern = payrollTypePattern(query.pay_type || query.wage_type);
    if (pattern) {
      if (normalizePayrollWageType(query.pay_type || query.wage_type) === 'Per-Trip') {
        where.push('(LOWER(w.name) LIKE ? OR LOWER(w.name) LIKE ?)');
        params.push('%trip%', '%logistics%');
      } else {
        where.push('LOWER(w.name) LIKE ?');
        params.push(pattern);
      }
    }
  }

  const [rows] = await pool.execute(`
    SELECT pr.id AS payroll_run_id,
           pr.month_year,
           pr.period_label,
           pr.start_date,
           pr.end_date,
           pr.status AS payroll_run_status,
           pr.created_at AS date_processed,
           processor.username AS processed_by,
           ps.id AS payslip_id,
           ps.status AS payroll_status,
           ps.total_earning,
           ps.total_deduction,
           ps.net_pay,
           sc.id AS salary_calculation_id,
           sc.days_worked,
           sc.hours_worked,
           sc.quantity,
           sc.total_allowances,
           sc.bonus_allowance,
           sc.validation_snapshot,
           e.id AS employee_id,
           e.employee_code,
           CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
           d.name AS department,
           w.name AS wage_type
      FROM payslips ps
      JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
      JOIN employees e ON e.id = ps.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN wage_types w ON w.id = ps.wage_type_id
      LEFT JOIN users processor ON processor.id = COALESCE(pr.processed_by, pr.created_by)
      LEFT JOIN salary_calculations sc
        ON sc.id = ps.salary_calculation_id
        OR (sc.payroll_run_id = pr.id AND sc.employee_id = ps.employee_id)
     WHERE ${where.join(' AND ')}
     ORDER BY pr.start_date DESC, pr.id DESC, d.name, e.last_name, e.first_name
     LIMIT 1000
  `, params);

  const registry = rows.map(row => {
    const snapshot = parseJsonSafe(row.validation_snapshot);
    const payType = normalizePayrollWageType(row.wage_type || snapshot.wage_type);
    return {
      payroll_run_id: row.payroll_run_id,
      salary_calculation_id: row.salary_calculation_id,
      payslip_id: row.payslip_id,
      employee_id: row.employee_id,
      employee_code: row.employee_code,
      employee_name: row.employee_name,
      department: row.department || '-',
      pay_type: payType,
      payroll_period: row.period_label || `${String(row.start_date).slice(0, 10)} to ${String(row.end_date).slice(0, 10)}`,
      approved_days_worked: numeric(row.days_worked) || numeric(snapshot.days_worked),
      approved_hours_worked: numeric(row.hours_worked) || numeric(snapshot.hours_worked),
      approved_output_quantity: payType === 'Per-Piece' ? numeric(row.quantity) || numeric(snapshot.output_quantity || snapshot.quantity) : 0,
      approved_logistics_trips: payType === 'Per-Trip' ? numeric(snapshot.trip_count || row.quantity) : 0,
      gross_pay: numeric(row.total_earning),
      allowances: numeric(row.total_allowances),
      bonuses: numeric(row.bonus_allowance),
      deductions: numeric(row.total_deduction),
      net_pay: numeric(row.net_pay),
      payroll_status: row.payroll_status || row.payroll_run_status,
      processed_by: row.processed_by || '-',
      date_processed: row.date_processed
    };
  });

  return {
    rows: registry,
    totals: {
      employees: registry.length,
      gross_pay: roundMoney(registry.reduce((sum, row) => sum + numeric(row.gross_pay), 0)),
      allowances: roundMoney(registry.reduce((sum, row) => sum + numeric(row.allowances), 0)),
      deductions: roundMoney(registry.reduce((sum, row) => sum + numeric(row.deductions), 0)),
      net_pay: roundMoney(registry.reduce((sum, row) => sum + numeric(row.net_pay), 0))
    }
  };
}

router.get('/registry', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const registry = await buildWeeklyPayrollRegistry(pool, req.query);
    res.json(registry);
  } catch (err) {
    console.error('Error loading weekly payroll registry:', err);
    res.status(500).json({ error: 'Failed to load weekly payroll registry.' });
  }
});

router.get('/filter-options', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const activeEmployeeWhere = await employeeActiveCondition(pool, 'e');
    const [departments] = await pool.execute(`
      SELECT DISTINCT d.id, d.name
        FROM employees e
        JOIN departments d ON d.id = e.department_id
       WHERE ${activeEmployeeWhere}
       ORDER BY d.name
    `);
    const [wageTypes] = await pool.execute('SELECT id, name FROM wage_types ORDER BY name');
    const [employees] = await pool.execute(`
      SELECT e.id,
             e.employee_code,
             e.first_name,
             e.last_name,
             e.position,
             e.department_id,
             d.name AS department,
             e.wage_type_id,
             w.name AS wage_type
        FROM employees e
        LEFT JOIN departments d ON d.id = e.department_id
        LEFT JOIN wage_types w ON w.id = e.wage_type_id
       WHERE ${activeEmployeeWhere}
       ORDER BY d.name, e.last_name, e.first_name, e.employee_code
       LIMIT 1000
    `);
    res.json({
      departments,
      pay_types: wageTypes.map(row => ({ id: row.id, name: row.name, normalized: normalizePayrollWageType(row.name) })),
      employees: employees.map(row => ({
        id: row.id,
        employee_code: row.employee_code,
        first_name: row.first_name,
        last_name: row.last_name,
        employee_name: `${row.last_name || ''}, ${row.first_name || ''}`.replace(/^,\s*/, '').trim(),
        position: row.position,
        department_id: row.department_id,
        department: row.department,
        wage_type_id: row.wage_type_id,
        wage_type: row.wage_type,
        normalized_wage_type: normalizePayrollWageType(row.wage_type)
      }))
    });
  } catch (err) {
    console.error('Error loading payroll filter options:', err);
    res.status(500).json({ error: 'Failed to load payroll filter options.' });
  }
});

// Generate weekly/monthly payroll by employee pay type.
router.post('/generate', requireAuth, requireRole(ROLES.payroll_any), PAYROLL_COMPUTED_FIELD_GUARD, async (req, res) => {
  const pool = require('../config/db');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await ensurePieceRatePayrollSchema(connection);
    const payTypeFilter = String(req.body.pay_type || req.body.payroll_type || '').trim();
    const period = {
      ...payrollPeriodFromRequest(req.body),
      payroll_type: payTypeFilter ? normalizePayrollWageType(payTypeFilter) : 'All Pay Types',
      filters: {
        employee_id: req.body.employee_id || null,
        department_id: req.body.department_id || null,
        department: req.body.department || null,
        pay_type: payTypeFilter || null
      }
    };

    if (!period.month_year || !period.start || !period.end) {
      throw new Error('Payroll period, start date, and end date are required.');
    }

    const payrollRun = await findOrCreatePayrollRun(connection, req, period);
    const payrollRunId = payrollRun.id;
    const activeEmployeeWhere = await employeeActiveCondition(connection, 'e');
    const employeeWhere = [activeEmployeeWhere];
    const employeeParams = [];
    if (req.body.employee_id) {
      employeeWhere.push('e.id = ?');
      employeeParams.push(Number(req.body.employee_id));
    }
    if (req.body.employee_code) {
      employeeWhere.push('e.employee_code = ?');
      employeeParams.push(String(req.body.employee_code).trim());
    }
    if (req.body.department_id) {
      employeeWhere.push('e.department_id = ?');
      employeeParams.push(Number(req.body.department_id));
    }
    if (req.body.department) {
      employeeWhere.push('d.name = ?');
      employeeParams.push(String(req.body.department).trim());
    }
    const payTypeLike = payrollTypePattern(payTypeFilter);
    if (payTypeLike) {
      if (normalizePayrollWageType(payTypeFilter) === 'Per-Trip') {
        employeeWhere.push('(LOWER(w.name) LIKE ? OR LOWER(w.name) LIKE ?)');
        employeeParams.push('%trip%', '%logistics%');
      } else {
        employeeWhere.push('LOWER(w.name) LIKE ?');
        employeeParams.push(payTypeLike);
      }
    }

    const [employees] = await connection.execute(`
      SELECT e.id, e.employee_code, e.first_name, e.last_name, e.position, e.department_id,
             COALESCE(NULLIF(e.agency_name, ''), NULL) AS agency_name,
             e.wage_type_id, w.name AS wage_type, d.name AS department
      FROM employees e
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE ${employeeWhere.join(' AND ')}
      ORDER BY e.employee_code, e.id
    `, employeeParams);

    let processedCount = 0;
    let skippedCount = 0;
    const skipped = [];
    const registry = [];

    for (const emp of employees) {
      try {
        const normalizedWageType = normalizePayrollWageType(emp.wage_type);
        const skipEmployee = reason => {
          skippedCount++;
          skipped.push({
            employee_id: emp.id,
            employee_code: emp.employee_code,
            employee_name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
            department: emp.department || '-',
            pay_type: normalizedWageType || emp.wage_type || '-',
            reason
          });
        };
        const [duplicate] = await connection.execute(
          'SELECT id FROM payslips WHERE payroll_run_id = ? AND employee_id = ? LIMIT 1',
          [payrollRunId, emp.id]
        );
        if (duplicate.length) {
          skipEmployee('Payroll record already exists for this period.');
          continue;
        }

        let totalEarning = 0;
        let totalDeduction = 0;
        let netPay = 0;
        let salaryCalculationId = null;
        let employeeDeductions = [];
        let sourceType = '';
        let sourceRecordIds = [];
        let quantity = 0;
        let baseRate = 0;
        let daysWorked = 0;
        let hoursWorked = 0;
        let overtimeHours = 0;
        let overtimePay = 0;
        let dailyRate = 0;
        let hourlyRate = 0;
        let allowances = { total: 0, applied: [] };
        let payrollDeductions = { total: 0, employeeTotal: 0, employee: [], applied: [] };
        let snapshot = {};
        let finalizeSourceRecords = async () => {};

        if (['Daily', 'Hourly', 'Monthly'].includes(normalizedWageType)) {
          const validation = await validateDailyHourlyPayroll(connection, {
            employee_id: emp.id,
            payroll_period: period.month_year,
            calculation_date: period.end,
            start_date: period.start,
            end_date: period.end,
            wage_type: emp.wage_type
          });
          if (!validation.ok) {
            skipEmployee(validation.errors.join(' ') || 'Attendance is not payroll-ready.');
            continue;
          }

          overtimePay = numeric(validation.overtime_hours) * numeric(validation.hourly_rate);
          const baseGross = numeric(validation.gross_pay) + overtimePay;
          allowances = await computeConfiguredAllowances(connection, baseGross, period.end);
          const grossWithAllowances = baseGross + allowances.total;
          payrollDeductions = await computePayrollDeductions(connection, emp.id, grossWithAllowances, period.end);
          totalEarning = grossWithAllowances;
          totalDeduction = payrollDeductions.total + numeric(validation.tardy_ut_deduction);
          netPay = totalEarning - totalDeduction;
          employeeDeductions = payrollDeductions.employee;
          sourceType = 'attendance';
          sourceRecordIds = sourceIdList(validation.attendance_rows || [], 'attendance:');
          quantity = normalizedWageType === 'Hourly' ? validation.hours_worked : validation.days_worked;
          baseRate = normalizedWageType === 'Monthly' ? validation.monthly_salary : validation.rate;
          daysWorked = validation.days_worked;
          hoursWorked = validation.hours_worked;
          overtimeHours = validation.overtime_hours;
          dailyRate = validation.daily_rate;
          hourlyRate = validation.hourly_rate;
          snapshot = {
            ...validation,
            monthly_salary: validation.monthly_salary,
            base_rate: baseRate,
            attendance_rows: validation.attendance_rows,
            allowances: allowances.applied
          };
          finalizeSourceRecords = async () => markAttendanceRowsPaid(connection, validation.attendance_rows || [], payrollRunId);
        } else if (normalizedWageType === 'Per-Piece') {
          const piecePayroll = await getApprovedPieceRatePayroll(connection, emp.id, period);
          if (!piecePayroll.records.length) {
            skipEmployee('No approved unpaid piece-rate output exists for this payroll period.');
            continue;
          }
          allowances = await computeConfiguredAllowances(connection, piecePayroll.total, period.end);
          totalEarning = piecePayroll.total + allowances.total;
          payrollDeductions = await computePayrollDeductions(connection, emp.id, totalEarning, period.end);
          totalDeduction = payrollDeductions.total;
          netPay = totalEarning - totalDeduction;
          employeeDeductions = payrollDeductions.employee;
          sourceType = 'piece_rate_output';
          sourceRecordIds = [
            ...sourceIdList(piecePayroll.outputs, 'output:'),
            ...sourceIdList(piecePayroll.pairs, 'pair:')
          ];
          quantity = piecePayroll.quantity;
          baseRate = piecePayroll.average_rate;
          snapshot = {
            wage_type: normalizedWageType,
            output_quantity: piecePayroll.quantity,
            quantity: piecePayroll.quantity,
            piece_rate: piecePayroll.average_rate,
            records: piecePayroll.records,
            allowances: allowances.applied
          };
          finalizeSourceRecords = async () => markPieceRecordsPaid(connection, piecePayroll, payrollRunId, currentUserId(req));
        } else if (isTripBasedWageType(emp.wage_type)) {
          await assertLogisticsTripSchema(connection);
          const approvedTrips = await getApprovedDeliveryTripPayroll(connection, emp.id, period);
          if (!approvedTrips.trips.length) {
            skipEmployee('No approved delivery trips exist for this payroll period.');
            continue;
          }
          allowances = await computeConfiguredAllowances(connection, approvedTrips.total, period.end);
          totalEarning = approvedTrips.total + allowances.total;
          payrollDeductions = await computePayrollDeductions(connection, emp.id, totalEarning, period.end);
          totalDeduction = payrollDeductions.total;
          netPay = totalEarning - totalDeduction;
          employeeDeductions = payrollDeductions.employee;
          sourceType = 'logistics_trips';
          sourceRecordIds = sourceIdList(approvedTrips.trips, 'trip:');
          quantity = approvedTrips.quantity || approvedTrips.trips.length;
          baseRate = approvedTrips.trips.length ? roundMoney(approvedTrips.total / approvedTrips.trips.length) : 0;
          snapshot = {
            wage_type: normalizedWageType,
            trip_count: approvedTrips.trips.length,
            output_quantity: approvedTrips.quantity,
            logistics_total: approvedTrips.total,
            trips: approvedTrips.trips,
            allowances: allowances.applied
          };
          finalizeSourceRecords = async () => markDeliveryTripsPaid(connection, approvedTrips.trips, payrollRunId, currentUserId(req));
        } else {
          skipEmployee(`Unsupported or unconfigured pay type: ${emp.wage_type || 'Not set'}.`);
          continue;
        }

        salaryCalculationId = await createSalaryCalculationRecord(connection, req, {
          employee_id: emp.id,
          wage_type_id: emp.wage_type_id || 1,
          wage_type: normalizedWageType,
          payroll_run_id: payrollRunId,
          period,
          base_rate: baseRate,
          quantity,
          gross_pay: totalEarning,
          total_deductions: totalDeduction,
          net_pay: netPay,
          allowances,
          deductions: payrollDeductions,
          overtime_hours: overtimeHours,
          overtime_amount: overtimePay,
          hours_worked: hoursWorked,
          days_worked: daysWorked,
          daily_rate: dailyRate,
          hourly_rate: hourlyRate,
          source_type: sourceType,
          source_record_ids: sourceRecordIds,
          agency_name: emp.agency_name,
          snapshot
        });

        const payslipColumns = await payrollTableColumns(connection, 'payslips');
        const payslipFields = ['payroll_run_id', 'employee_id', 'wage_type_id', 'total_earning', 'total_deduction', 'net_pay'];
        const payslipValues = [payrollRunId, emp.id, emp.wage_type_id || 1, roundMoney(totalEarning), roundMoney(totalDeduction), roundMoney(netPay)];
        if (payslipColumns.has('salary_calculation_id')) {
          payslipFields.splice(1, 0, 'salary_calculation_id');
          payslipValues.splice(1, 0, salaryCalculationId);
        }
        if (payslipColumns.has('payroll_period')) {
          payslipFields.push('payroll_period');
          payslipValues.push(period.month_year);
        }
        if (payslipColumns.has('source_summary')) {
          payslipFields.push('source_summary');
          payslipValues.push(JSON.stringify({ source_type: sourceType, source_record_ids: sourceRecordIds, snapshot }));
        }
        await connection.execute(`
          INSERT INTO payslips (${payslipFields.join(', ')})
          VALUES (${payslipFields.map(() => '?').join(', ')})
        `, payslipValues);

        if (employeeDeductions.length) {
          await applyEmployeeDeductionBalances(connection, req, emp.id, salaryCalculationId, period.month_year, employeeDeductions);
        }
        await finalizeSourceRecords();

        await logPayrollAudit(connection, req, 'salary_calculation_generated', {
          employee_id: emp.id,
          payroll_run_id: payrollRunId,
          salary_calculation_id: salaryCalculationId,
          remarks: `Generated ${normalizedWageType} payroll for ${emp.employee_code}`,
          metadata: { source_type: sourceType, source_record_ids: sourceRecordIds, gross_pay: totalEarning, net_pay: netPay }
        });

        registry.push({
          employee_id: emp.id,
          employee_code: emp.employee_code,
          employee_name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
          department: emp.department,
          pay_type: normalizedWageType,
          payroll_period: period.period_label,
          approved_days_worked: daysWorked,
          approved_hours_worked: hoursWorked,
          approved_output_quantity: normalizedWageType === 'Per-Piece' ? quantity : 0,
          approved_logistics_trips: normalizedWageType === 'Per-Trip' ? quantity : 0,
          gross_pay: roundMoney(totalEarning),
          allowances: roundMoney(allowances.total),
          bonuses: 0,
          deductions: roundMoney(totalDeduction),
          net_pay: roundMoney(netPay),
          payroll_status: 'Pending',
          processed_by: req.user?.username || req.user?.email || currentUserId(req),
          date_processed: new Date().toISOString()
        });

        processedCount++;
      } catch (slipErr) {
        console.error(`Error creating payroll record for employee ${emp.id}:`, slipErr);
        skippedCount++;
        skipped.push({
          employee_id: emp.id,
          employee_code: emp.employee_code,
          employee_name: `${emp.first_name || ''} ${emp.last_name || ''}`.trim(),
          department: emp.department || '-',
          pay_type: normalizePayrollWageType(emp.wage_type) || emp.wage_type || '-',
          reason: slipErr.message
        });
      }
    }

    const summary = await updatePayrollRunTotals(connection, payrollRunId);
    await logPayrollAudit(connection, req, 'payroll_generated', {
      payroll_run_id: payrollRunId,
      remarks: `Generated payroll for ${period.period_label || period.month_year}`,
      metadata: { processedCount, skippedCount, totalEmployees: employees.length, skipped }
    });
    await connection.commit();

    res.json({ 
      success: true, 
      payrollRunId,
      payroll_period: period.month_year,
      period_start: period.start,
      period_end: period.end,
      employeesProcessed: processedCount,
      totalEmployees: employees.length,
      skippedCount,
      skipped,
      summary,
      registry,
      message: `Payroll generated for ${period.period_label || period.month_year}. ${processedCount} employee(s) processed, ${skippedCount} skipped.`
    });
  } catch (err) {
    try { await connection.rollback(); } catch (_) {}
    console.error('Error generating payroll:', err);
    const status = /required|must|period|invalid/i.test(err.message) ? 400 : 500;
    res.status(status).json({ error: status === 400 ? err.message : 'Failed to generate payroll.' });
  } finally {
    connection.release();
  }
});

// Get employee personal and employment details for payroll officer (READ-ONLY)
router.get('/employees/:id/readonly', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const empId = req.params.id;

    const [rows] = await pool.execute(`
      SELECT 
        e.id, e.employee_code, e.first_name, e.last_name, e.email,
        e.contact_number, e.residential_address, e.birth_date,
        d.name AS department, e.position AS position, s.id AS supervisor_id,
        CONCAT(s.first_name, ' ', s.last_name) AS supervisor_name,
        e.date_hired, e.employment_status, e.wage_type_id, w.name AS wage_type,
        e.sss_number, e.philhealth_number, e.pagibig_number, e.tin,
        e.bank_name, e.bank_account, e.status
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN employees s ON s.id = e.supervisor_id
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
      WHERE e.id = ?
    `, [empId]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error fetching employee readonly:', err);
    res.status(500).json({ error: 'Failed to fetch employee details' });
  }
});

// Get employee government contributions for payroll deductions
router.get('/employees/:id/government-contributions', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const empId = req.params.id;

    // Get employee government info
    const [empRows] = await pool.execute(`
      SELECT e.id, e.sss_number, e.philhealth_number, e.pagibig_number, e.tin
      FROM employees e
      WHERE e.id = ?
    `, [empId]);

    if (!empRows.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Get employee deductions
    const [deductions] = await pool.execute(`
      SELECT id, deduction_type, amount, description, start_date, end_date, is_active
      FROM employee_deductions
      WHERE employee_id = ? AND is_active = 1
      ORDER BY deduction_type
    `, [empId]);

    res.json({
      employee_id: empRows[0].id,
      government_ids: {
        sss_number: empRows[0].sss_number || 'Not provided',
        philhealth_number: empRows[0].philhealth_number || 'Not provided',
        pagibig_number: empRows[0].pagibig_number || 'Not provided',
        tin: empRows[0].tin || 'Not provided'
      },
      deductions: deductions || []
    });
  } catch (err) {
    console.error('Error fetching government contributions:', err);
    res.status(500).json({ error: 'Failed to fetch government contributions' });
  }
});

// Get all payroll records for a specific month (table view)
router.get('/payroll-records/:monthYear', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { monthYear } = req.params;

    const [payslips] = await pool.execute(`
      SELECT ps.id, ps.payroll_run_id, ps.employee_id, ps.total_earning, ps.total_deduction, ps.net_pay,
             e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
             d.name AS department, w.name AS wage_type, pr.month_year, pr.start_date, pr.end_date,
             ps.created_at, ps.status
      FROM payslips ps
      JOIN employees e ON e.id = ps.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN wage_types w ON w.id = ps.wage_type_id
      LEFT JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
      WHERE pr.month_year = ?
      ORDER BY e.employee_code
    `, [monthYear]);

    // Calculate summary stats
    const totalPayroll = payslips.reduce((sum, p) => sum + p.total_earning, 0);
    const totalDeductions = payslips.reduce((sum, p) => sum + p.total_deduction, 0);
    const avgSalary = payslips.length > 0 ? totalPayroll / payslips.length : 0;
    const employeesPaid = payslips.filter(p => p.status === 'Disbursed').length;

    res.json({
      summary: {
        totalPayroll,
        totalDeductions,
        avgSalary,
        employeesPaid,
        totalEmployees: payslips.length,
        monthYear
      },
      payslips
    });
  } catch (err) {
    console.error('Error fetching payroll records:', err);
    res.status(500).json({ error: 'Failed to fetch payroll records' });
  }
});

// Get employee transaction history for a specific month
router.get('/employees/:id/transactions/:monthYear', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { id: empId, monthYear } = req.params;

    // Get employee wage type
    const [empData] = await pool.execute(`
      SELECT e.wage_type_id, w.name AS wage_type, e.department_id, d.name AS department
      FROM employees e
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.id = ?
    `, [empId]);

    if (!empData.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const wageType = empData[0].wage_type;
    const department = empData[0].department;
    let transactions = [];

    if (wageType === 'Per-Piece') {
      // Get production transactions
      const [prods] = await pool.execute(`
        SELECT pt.id, pt.quantity, pt.rate, pt.amount, pt.transaction_date, pt.week_number,
               st.name AS transaction_type
        FROM production_transactions pt
        JOIN sewing_types st ON st.id = pt.sewing_type_id
        WHERE pt.employee_id = ? AND pt.month_year = ?
        ORDER BY pt.transaction_date DESC
      `, [empId, monthYear]);
      transactions = prods;
    } else if (wageType === 'Per-Trip') {
      // Get logistics transactions
      const [trips] = await pool.execute(`
        SELECT lt.id, lt.rate, lt.amount, lt.trip_reference, lt.transaction_date, lt.week_number,
               lt.truck_type, lt.crew_status, lt.crew_role, lt.base_rate, lt.missing_helper_share,
               lt.gross_pay, lt.net_pay, lr.name AS transaction_type
        FROM logistics_transactions lt
        JOIN logistics_regions lr ON lr.id = lt.logistics_region_id
        WHERE lt.employee_id = ? AND lt.month_year = ?
        ORDER BY lt.transaction_date DESC
      `, [empId, monthYear]);
      transactions = trips;
    }

    const totalAmount = transactions.reduce((sum, t) => sum + t.amount, 0);

    res.json({
      wageType,
      department,
      monthYear,
      transactions,
      totalAmount,
      transactionCount: transactions.length
    });
  } catch (err) {
    console.error('Error fetching employee transactions:', err);
    res.status(500).json({ error: 'Failed to fetch employee transactions' });
  }
});

// Get employee monthly summary for salary calculation
router.get('/employees/:id/monthly-summary/:monthYear', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { id: empId, monthYear } = req.params;

    // Get employee info
    const [empData] = await pool.execute(`
      SELECT e.id, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS name, 
             e.wage_type_id, e.department_id, w.name AS wage_type, d.name AS department,
             e.position, e.sss_number, e.philhealth_number, e.pagibig_number
      FROM employees e
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.id = ?
    `, [empId]);

    if (!empData.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const emp = empData[0];
    let totalEarning = 0;
    let earnings = {};

    // Calculate earnings based on wage type
    if (emp.wage_type === 'Per-Piece') {
      const [prods] = await pool.execute(`
        SELECT st.name AS type, SUM(pt.quantity) AS quantity, SUM(pt.amount) AS amount
        FROM production_transactions pt
        JOIN sewing_types st ON st.id = pt.sewing_type_id
        WHERE pt.employee_id = ? AND pt.month_year = ?
        GROUP BY pt.sewing_type_id
        ORDER BY st.name
      `, [empId, monthYear]);
      earnings.production = prods;
      totalEarning = prods.reduce((sum, p) => sum + (p.amount || 0), 0);
    } else if (isTripBasedWageType(emp.wage_type)) {
      await assertLogisticsTripSchema(pool);
      const range = monthRange(monthYear);
      const [trips] = await pool.execute(`
        SELECT ll.name AS location,
               ll.location_category,
               tt.name AS truck_type,
               dt.trip_type,
               dt.role,
               COUNT(*) AS trips,
               MAX(dt.base_rate) AS base_rate,
               MAX(dt.additional_rate) AS additional_rate,
               MAX(dt.multiplier) AS multiplier,
               SUM(dt.total_trip_pay) AS total_trip_pay
          FROM delivery_trips dt
          JOIN truck_types tt ON tt.id = dt.truck_type_id
          JOIN logistics_locations ll ON ll.id = dt.location_id
         WHERE dt.employee_id = ?
           AND dt.trip_date BETWEEN ? AND ?
           AND dt.status IN ('Approved', 'Included in Payroll', 'Paid')
         GROUP BY ll.name, ll.location_category, tt.name, dt.trip_type, dt.role
         ORDER BY ll.name, tt.name, dt.trip_type, dt.role
      `, [empId, range.start, range.end]);
      earnings.logistics = trips;
      totalEarning = trips.reduce((sum, trip) => sum + Number(trip.total_trip_pay || 0), 0);
    }

    // Get deductions
    const [deductions] = await pool.execute(`
      SELECT deduction_type, amount, description
      FROM employee_deductions
      WHERE employee_id = ? AND is_active = 1
      ORDER BY deduction_type
    `, [empId]);

    const totalDeduction = deductions.reduce((sum, d) => sum + d.amount, 0);

    res.json({
      employee: {
        id: emp.id,
        code: emp.employee_code,
        name: emp.name,
        department: emp.department,
        position: emp.position,
        wageType: emp.wage_type,
        governmentIds: {
          sss: emp.sss_number || 'Not provided',
          philhealth: emp.philhealth_number || 'Not provided',
          pagibig: emp.pagibig_number || 'Not provided'
        }
      },
      earnings,
      totalEarning,
      deductions,
      totalDeduction,
      netPay: totalEarning - totalDeduction,
      monthYear
    });
  } catch (err) {
    console.error('Error fetching monthly summary:', err);
    res.status(500).json({ error: 'Failed to fetch monthly summary' });
  }
});

// Get all salary calculation records (for audit trail and record keeping)
router.get('/salary-calculations', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const { employee_id, status, from_date, to_date, limit = 100 } = req.query;

    let query = `
      SELECT 
        sc.id,
        sc.employee_id,
        CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
        e.employee_code,
        d.name AS department,
        e.position,
        w.name AS wage_type,
        sc.base_rate,
        sc.quantity,
        sc.hours_worked,
        sc.days_worked,
        sc.housing_allowance,
        sc.meal_allowance,
        sc.transport_allowance,
        sc.bonus_allowance,
        sc.total_allowances,
        sc.overtime_hours,
        sc.gross_pay,
        sc.sss_deduction,
        sc.pagibig_deduction,
        sc.philhealth_deduction,
        sc.total_deductions,
        sc.net_pay,
        sc.status,
        sc.calculation_date,
        sc.payroll_period,
        sc.agency_name,
        sc.validation_snapshot,
        sc.created_at,
        sc.updated_at
      FROM salary_calculations sc
      JOIN employees e ON e.id = sc.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN wage_types w ON w.id = sc.wage_type_id
      WHERE 1=1
        AND COALESCE(sc.status, '') <> 'Superseded'
        AND COALESCE(sc.status, '') <> ''
    `;
    const params = [];

    if (employee_id) {
      query += ' AND sc.employee_id = ?';
      params.push(employee_id);
    }

    if (status) {
      query += ' AND sc.status = ?';
      params.push(status);
    } else {
      query += " AND sc.status IN ('Submitted', 'Approved', 'Finalized', 'Paid', 'Released')";
    }

    if (from_date) {
      query += ' AND sc.calculation_date >= ?';
      params.push(from_date);
    }

    if (to_date) {
      query += ' AND sc.calculation_date <= ?';
      params.push(to_date);
    }
    const safeLimit = Number.parseInt(limit, 10) || 100;
 
    query += ` ORDER BY sc.created_at DESC LIMIT ${safeLimit}`;

    const [records] = await pool.execute(query, params);

    // Calculate summary statistics
    const totalRecords = records.length;
    const totalGross = records.reduce((sum, r) => sum + parseFloat(r.gross_pay || 0), 0);
    const totalNet = records.reduce((sum, r) => sum + parseFloat(r.net_pay || 0), 0);
    const totalDeductions = records.reduce((sum, r) => sum + parseFloat(r.total_deductions || 0), 0);

    res.json({
      records,
      summary: {
        totalRecords,
        totalGross,
        totalNet,
        totalDeductions,
        averageGross: totalRecords > 0 ? totalGross / totalRecords : 0,
        averageNet: totalRecords > 0 ? totalNet / totalRecords : 0
      }
    });
  } catch (err) {
    console.error('Error fetching salary calculations:', err);
    res.status(500).json({ error: 'Failed to fetch salary calculations.' });
  }
});

router.get('/salary-calculations/:id/payslip', requireAuth, async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const record = await getSalaryCalculationForPayslip(pool, req.params.id);
    if (!record) return res.status(404).json({ error: 'Salary calculation not found.' });
    if (!canAccessPayslip(req, record)) return res.status(403).json({ error: 'You can only access your own payslip.' });

    const payslip = buildPayslipPayload(record);
    await logPayrollAudit(pool, req, 'payslip_generated', {
      employee_id: record.employee_id,
      salary_calculation_id: record.id,
      remarks: `Generated payslip preview ${payslip.reference_no}`,
      metadata: { reference_no: payslip.reference_no }
    });
    res.json(payslip);
  } catch (err) {
    console.error('Error generating payslip preview:', err);
    res.status(500).json({ error: 'Failed to generate payslip.' });
  }
});

router.get('/salary-calculations/:id/payslip.pdf', requireAuth, async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const record = await getSalaryCalculationForPayslip(pool, req.params.id);
    if (!record) return res.status(404).json({ error: 'Salary calculation not found.' });
    if (!canAccessPayslip(req, record)) return res.status(403).json({ error: 'You can only access your own payslip.' });

    const payslip = buildPayslipPayload(record);
    const action = req.query.print === '1' ? 'payslip_printed' : 'payslip_exported';
    await logPayrollAudit(pool, req, action, {
      employee_id: record.employee_id,
      salary_calculation_id: record.id,
      remarks: `${req.query.print === '1' ? 'Printed' : 'Exported'} payslip ${payslip.reference_no}`,
      metadata: { reference_no: payslip.reference_no, format: 'pdf' }
    });

    const pdfBuffer = await renderPayslipPdfBuffer(payslip);

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader(
      'Content-Disposition',
      `${req.query.print === '1' ? 'inline' : 'attachment'}; filename="${payslip.reference_no}-${record.employee_code}.pdf"`
    );
    res.end(pdfBuffer);
  } catch (err) {
    console.error('Error exporting payslip PDF:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to export payslip PDF.' });
    } else {
      res.end();
    }
  }
});

// Convert pending salary calculations to payslips for a specific period
router.post('/convert-calculations-to-payslips', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { month_year } = req.body;

    console.log('📊 Converting salary calculations to payslips for:', month_year);

    if (!month_year) {
      return res.status(400).json({ error: 'month_year is required' });
    }

    // Get or create payroll run for this month
    let payrollRunId;
    try {
      const [existing] = await pool.execute(
        'SELECT id FROM payroll_runs WHERE month_year = ?',
        [month_year]
      );

      if (existing.length) {
        payrollRunId = existing[0].id;
        console.log('✅ Using existing payroll run ID:', payrollRunId);
      } else {
        // Create new payroll run
        const firstDay = new Date(month_year + '-01');
        const lastDay = new Date(new Date(firstDay).setMonth(firstDay.getMonth() + 1));
        lastDay.setDate(0);
        
        const startDate = firstDay.toISOString().split('T')[0];
        const endDate = lastDay.toISOString().split('T')[0];

        const [runResult] = await pool.execute(`
          INSERT INTO payroll_runs (month_year, start_date, end_date, created_by)
          VALUES (?, ?, ?, ?)
        `, [month_year, startDate, endDate, req.user.id || req.user.userId]);

        payrollRunId = runResult.insertId;
        console.log('✅ Created new payroll run ID:', payrollRunId);
      }
    } catch (dbErr) {
      console.error('❌ Error with payroll run:', dbErr);
      throw new Error(`Failed to get/create payroll run: ${dbErr.message}`);
    }

    // Find pending salary calculations for this month
    let convertedCount = 0;
    try {
      const [calculations] = await pool.execute(`
        SELECT sc.id, sc.employee_id, sc.wage_type_id, sc.gross_pay, sc.total_deductions, sc.net_pay
        FROM salary_calculations sc
        WHERE COALESCE(sc.payroll_period, DATE_FORMAT(sc.calculation_date, '%Y-%m')) = ?
          AND sc.status IN ('Submitted', 'Approved', 'Released', 'Paid')
        AND NOT EXISTS (
          SELECT 1 FROM payslips p 
          WHERE p.payroll_run_id = ? AND p.employee_id = sc.employee_id
        )
      `, [month_year, payrollRunId]);

      console.log(`Found ${calculations.length} pending calculations to convert`);

      for (const calc of calculations) {
        try {
          // Create payslip from salary calculation
          await pool.execute(`
            INSERT INTO payslips (payroll_run_id, employee_id, wage_type_id, total_earning, total_deduction, net_pay, status)
            VALUES (?, ?, ?, ?, ?, ?, 'Approved')
          `, [payrollRunId, calc.employee_id, calc.wage_type_id, calc.gross_pay || 0, calc.total_deductions || 0, calc.net_pay || 0]);

          convertedCount++;
          console.log(`✅ Converted calculation for employee ${calc.employee_id}`);
        } catch (convertErr) {
          console.error(`❌ Error converting calculation for employee ${calc.employee_id}:`, convertErr);
        }
      }
    } catch (dbErr) {
      console.error('❌ Error fetching calculations:', dbErr);
      throw new Error(`Failed to fetch calculations: ${dbErr.message}`);
    }

    res.json({
      success: true,
      payrollRunId,
      convertedCount,
      message: `Converted ${convertedCount} salary calculations to payslips for ${month_year}`
    });
  } catch (err) {
    console.error('❌ Error converting calculations:', err);
    res.status(500).json({
      error: 'Failed to convert calculations to payslips.'
    });
  }
});

router.get('/deduction-settings', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute('SELECT * FROM payroll_deduction_settings ORDER BY is_active DESC, category, name');
    res.json(rows);
  } catch (err) {
    console.error('Error fetching deduction settings:', err);
    res.status(500).json({ error: 'Failed to fetch deduction settings' });
  }
});

router.post('/deduction-settings', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    const { name, category, computation_type, rate_or_amount, apply_schedule, is_active, effective_date, remarks } = req.body;
    if (!name || !effective_date) return res.status(400).json({ error: 'Deduction name and effective date are required.' });
    const employeeSpecificNames = ['cash advance', 'employee loan', 'cooperative loan', 'salary loan', 'equipment loan', 'loan'];
    if (employeeSpecificNames.some(item => String(name).toLowerCase().includes(item))) {
      return res.status(400).json({
        error: 'Cash advances and loans must be assigned per employee. Use Employee Cash Advance or Employee Loan instead.'
      });
    }
    if (/withholding\s*tax|income\s*tax/i.test(String(name))) {
      return res.status(400).json({
        error: 'Income tax and withholding tax are outside this payroll module. Only SSS, PhilHealth, and Pag-IBIG are computed here.'
      });
    }

    const [result] = await pool.execute(`
      INSERT INTO payroll_deduction_settings
        (name, category, computation_type, rate_or_amount, apply_schedule, is_active, effective_date, remarks, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      name,
      category || 'Other',
      computation_type || 'Manual Amount',
      rate_or_amount || 0,
      apply_schedule || 'Every Payroll',
      is_active === '0' || is_active === 0 ? 0 : 1,
      effective_date,
      remarks || null,
      currentUserId(req),
      currentUserId(req)
    ]);

    await logPayrollAudit(pool, req, 'deduction_setting_updated', {
      remarks: `Saved deduction setting: ${name}`,
      metadata: req.body
    });
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('Error saving deduction setting:', err);
    res.status(500).json({ error: 'Failed to save deduction setting' });
  }
});

// Deleting a setting affects only future payroll calculations. Historical
// payroll snapshots retain their original deductions, and the deletion is
// retained in the payroll audit trail.
router.delete('/deduction-settings/:id', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
  try {
    const pool = require('../config/db');
    const settingId = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(settingId) || settingId <= 0) {
      return res.status(400).json({ error: 'Invalid deduction setting ID.' });
    }

    const [rows] = await pool.execute(
      'SELECT * FROM payroll_deduction_settings WHERE id = ? LIMIT 1',
      [settingId]
    );
    const setting = rows[0];
    if (!setting) return res.status(404).json({ error: 'Deduction setting not found.' });

    await pool.execute('DELETE FROM payroll_deduction_settings WHERE id = ?', [settingId]);
    await logPayrollAudit(pool, req, 'deduction_setting_deleted', {
      remarks: `Deleted deduction setting: ${setting.name}`,
      metadata: {
        id: setting.id,
        name: setting.name,
        category: setting.category,
        computation_type: setting.computation_type,
        rate_or_amount: setting.rate_or_amount,
        apply_schedule: setting.apply_schedule,
        effective_date: setting.effective_date,
      },
    });

    return res.json({ success: true, message: 'Deduction setting deleted.' });
  } catch (err) {
    console.error('Error deleting deduction setting:', err);
    return res.status(500).json({ error: 'Failed to delete deduction setting.' });
  }
});

router.get('/employee-deductions', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const params = [];
    const where = [];
    if (req.query.type) {
      where.push('eda.module_type = ?');
      params.push(req.query.type === 'cash_advance' ? 'Cash Advance' : 'Employee Loan');
    }
    if (req.query.employee_id) {
      where.push('eda.employee_id = ?');
      params.push(req.query.employee_id);
    }
    if (req.query.status) {
      where.push('eda.status = ?');
      params.push(req.query.status);
    }

    const [rows] = await pool.execute(`
      SELECT eda.*,
             e.employee_code,
             CONCAT(e.first_name, ' ', COALESCE(e.middle_name, ''), ' ', e.last_name) AS employee_name
      FROM employee_deduction_accounts eda
      JOIN employees e ON e.id = eda.employee_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY eda.status = 'Active' DESC, eda.start_date DESC, eda.id DESC
      LIMIT 300
    `, params);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching employee deductions:', err);
    res.status(500).json({ error: 'Failed to fetch employee deductions' });
  }
});

async function saveEmployeeDeduction(req, res, moduleType) {
  try {
    const pool = require('../config/db');
    const {
      id,
      employee_id,
      deduction_name,
      loan_type,
      amount,
      remaining_balance,
      installment_amount,
      start_date,
      end_date,
      status,
      remarks
    } = req.body;

    if (!employee_id || !deduction_name || !amount || !installment_amount || !start_date) {
      return res.status(400).json({ error: 'Employee, deduction name, amount, installment amount, and start date are required.' });
    }
    if (numeric(amount) <= 0 || numeric(installment_amount) <= 0) {
      return res.status(400).json({ error: 'Amount and installment amount must be greater than zero.' });
    }

    const [employees] = await pool.execute('SELECT id, status FROM employees WHERE id = ? LIMIT 1', [employee_id]);
    if (!employees.length) return res.status(404).json({ error: 'Employee not found.' });
    if (String(employees[0].status || '').toLowerCase() !== 'active') {
      return res.status(400).json({ error: 'Employee must be active before assigning deductions.' });
    }

    const balance = remaining_balance === undefined || remaining_balance === ''
      ? numeric(amount)
      : numeric(remaining_balance);
    if (balance < 0) return res.status(400).json({ error: 'Remaining balance cannot be negative.' });

    if (id) {
      await pool.execute(`
        UPDATE employee_deduction_accounts
        SET deduction_name = ?,
            loan_type = ?,
            original_amount = ?,
            remaining_balance = ?,
            installment_amount = ?,
            start_date = ?,
            end_date = ?,
            status = ?,
            remarks = ?,
            updated_by = ?
        WHERE id = ? AND module_type = ?
      `, [
        deduction_name,
        moduleType === 'Employee Loan' ? (loan_type || 'Employee Loan') : null,
        numeric(amount),
        balance,
        numeric(installment_amount),
        start_date,
        end_date || null,
        status || 'Active',
        remarks || null,
        currentUserId(req),
        id,
        moduleType
      ]);
      await logPayrollAudit(pool, req, 'employee_deduction_updated', {
        employee_id,
        remarks: `Updated ${moduleType}: ${deduction_name}`,
        metadata: req.body
      });
      return res.json({ success: true, id });
    }

    const [result] = await pool.execute(`
      INSERT INTO employee_deduction_accounts
        (employee_id, module_type, deduction_name, loan_type, original_amount, remaining_balance,
         installment_amount, start_date, end_date, status, remarks, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      employee_id,
      moduleType,
      deduction_name,
      moduleType === 'Employee Loan' ? (loan_type || 'Employee Loan') : null,
      numeric(amount),
      balance,
      numeric(installment_amount),
      start_date,
      end_date || null,
      status || 'Active',
      remarks || null,
      currentUserId(req),
      currentUserId(req)
    ]);

    await logPayrollAudit(pool, req, 'employee_deduction_created', {
      employee_id,
      remarks: `Created ${moduleType}: ${deduction_name}`,
      metadata: req.body
    });
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('Error saving employee deduction:', err);
    res.status(500).json({ error: 'Failed to save employee deduction' });
  }
}

router.post('/employee-cash-advances', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), PAYROLL_SETTINGS_GUARD, (req, res) => {
  saveEmployeeDeduction(req, res, 'Cash Advance');
});

router.post('/employee-loans', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), PAYROLL_SETTINGS_GUARD, (req, res) => {
  saveEmployeeDeduction(req, res, 'Employee Loan');
});

router.patch('/employee-deductions/:id/status', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    const allowed = ['Active', 'Paused', 'Paid', 'Cancelled'];
    const status = allowed.includes(req.body.status) ? req.body.status : null;
    if (!status) return res.status(400).json({ error: 'Invalid deduction status.' });

    await pool.execute(
      'UPDATE employee_deduction_accounts SET status = ?, updated_by = ? WHERE id = ?',
      [status, currentUserId(req), req.params.id]
    );
    await logPayrollAudit(pool, req, 'employee_deduction_status_changed', {
      remarks: `Employee deduction status changed to ${status}`,
      metadata: { id: req.params.id, status }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating employee deduction status:', err);
    res.status(500).json({ error: 'Failed to update deduction status' });
  }
});

router.get('/allowance-settings', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute('SELECT * FROM payroll_allowance_settings ORDER BY is_active DESC, name');
    res.json(rows);
  } catch (err) {
    console.error('Error fetching allowance settings:', err);
    res.status(500).json({ error: 'Failed to fetch allowance settings' });
  }
});

router.post('/allowance-settings', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), PAYROLL_SETTINGS_GUARD, async (req, res) => {
  try {
    const pool = require('../config/db');
    const { name, allowance_type, amount_or_rate, is_taxable, is_active, effective_date } = req.body;
    if (!name || !effective_date) return res.status(400).json({ error: 'Allowance name and effective date are required.' });

    const [result] = await pool.execute(`
      INSERT INTO payroll_allowance_settings
        (name, allowance_type, amount_or_rate, is_taxable, is_active, effective_date, created_by, updated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      name,
      allowance_type || 'Fixed',
      amount_or_rate || 0,
      is_taxable === '1' || is_taxable === 1 ? 1 : 0,
      is_active === '0' || is_active === 0 ? 0 : 1,
      effective_date,
      currentUserId(req),
      currentUserId(req)
    ]);

    await logPayrollAudit(pool, req, 'allowance_setting_updated', {
      remarks: `Saved allowance setting: ${name}`,
      metadata: req.body
    });
    res.json({ success: true, id: result.insertId });
  } catch (err) {
    console.error('Error saving allowance setting:', err);
    res.status(500).json({ error: 'Failed to save allowance setting' });
  }
});

router.patch('/salary-calculations/:id/status', requireAuth, requireRole(PAYROLL_PERMISSIONS.approve), PAYROLL_COMPUTED_FIELD_GUARD, async (req, res) => {
  let connection;
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const { id } = req.params;
    const { status, remarks } = req.body;
    const allowed = ['Approved', 'Released', 'Paid'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid payroll status.' });

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [records] = await connection.execute(`
      SELECT id, employee_id, gross_pay, calculation_date, payroll_period, status, validation_snapshot
        FROM salary_calculations
       WHERE id = ?
       FOR UPDATE
    `, [id]);
    const record = records[0];
    if (!record) {
      await connection.rollback();
      return res.status(404).json({ error: 'Salary calculation not found.' });
    }

    const transitions = {
      Submitted: ['Approved'],
      Approved: ['Released', 'Paid'],
      Released: ['Paid'],
    };
    if (!transitions[record.status]?.includes(status)) {
      await connection.rollback();
      await auditSecurityEvent(req, {
        action: ['Finalized', 'Paid', 'Released'].includes(record.status)
          ? 'blocked_finalized_payroll_status_update_attempt'
          : 'blocked_invalid_payroll_status_transition_attempt',
        module: 'PAYROLL_SECURITY',
        targetTable: 'salary_calculations',
        targetRecord: id,
        oldValue: { status: record.status },
        newValue: { requested_status: status },
        result: 'blocked',
      });
      return res.status(409).json({ error: `Cannot change a ${record.status} payroll calculation to ${status}.` });
    }

    if (status === 'Approved') {
      const existingSnapshot = parseJsonSafe(record.validation_snapshot);
      const extraDeductionRows = [
        ...(numeric(existingSnapshot.late_deduction) > 0 ? [{
          name: 'Late Deduction',
          category: 'Attendance',
          computation_type: existingSnapshot?.policy?.late_deduction_method || 'Auto-compute from employee rate',
          amount: numeric(existingSnapshot.late_deduction)
        }] : []),
        ...(numeric(existingSnapshot.undertime_deduction) > 0 ? [{
          name: 'Undertime Deduction',
          category: 'Attendance',
          computation_type: existingSnapshot?.policy?.undertime_deduction_method || 'Auto-compute from employee rate',
          amount: numeric(existingSnapshot.undertime_deduction)
        }] : [])
      ];
      const deductions = await calculateSalaryDeductionSnapshot(
        connection,
        record.employee_id,
        record.gross_pay,
        record.calculation_date || `${record.payroll_period || new Date().toISOString().slice(0, 7)}-01`,
        extraDeductionRows
      );
      const totalDeductions = roundMoney(deductions.total || 0);
      const deductionSnapshot = {
        ...existingSnapshot,
        deduction_status: 'Applied',
        deductions: deductions.rows || []
      };
      await connection.execute(`
        UPDATE salary_calculations
           SET sss_deduction = ?,
               pagibig_deduction = ?,
               philhealth_deduction = ?,
               total_deductions = ?,
               employee_deduction_total = ?,
               net_pay = ?,
               validation_snapshot = ?
         WHERE id = ?
      `, [
        deductions.configuredBreakdown.sss || 0,
        deductions.configuredBreakdown.pagibig || 0,
        deductions.configuredBreakdown.philhealth || 0,
        totalDeductions,
        deductions.employeeTotal || 0,
        roundMoney(numeric(record.gross_pay) - totalDeductions),
        JSON.stringify(deductionSnapshot),
        id
      ]);
      await applySalaryCalculationDeductionSnapshot(connection, id, deductions.rows);
    }

    const userId = currentUserId(req);
    const fields = ['status = ?'];
    const params = [status];
    if (status === 'Approved') {
      fields.push('approved_by = ?', 'approved_at = NOW()');
      params.push(userId);
    }
    if (status === 'Released') {
      fields.push('released_by = ?', 'released_at = NOW()');
      params.push(userId);
    }

    params.push(id);
    await connection.execute(`UPDATE salary_calculations SET ${fields.join(', ')} WHERE id = ?`, params);
    const blockchainSnapshot = await syncFinalizedPayrollRecord(connection, req, id);
    await logPayrollAudit(connection, req, `payroll_${status.toLowerCase()}`, {
      salary_calculation_id: id,
      remarks: remarks || `Marked payroll as ${status}`,
      metadata: blockchainSnapshot ? { blockchain_snapshot: blockchainSnapshot } : null
    });
    await connection.commit();
    res.json({ success: true, blockchain_snapshot: blockchainSnapshot });
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Error updating payroll status:', err);
    res.status(500).json({ error: 'Failed to update payroll status' });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/audit', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute(`
      SELECT pat.*, u.username, CONCAT(e.first_name, ' ', e.last_name) AS employee_name
      FROM payroll_audit_trail pat
      LEFT JOIN users u ON u.id = pat.user_id
      LEFT JOIN employees e ON e.id = pat.employee_id
      ORDER BY pat.created_at DESC
      LIMIT 100
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching payroll audit:', err);
    res.status(500).json({ error: 'Failed to fetch payroll audit trail' });
  }
});

async function buildPiecePayrollRegister(pool, monthYear) {
  await ensurePieceRatePayrollSchema(pool);
  const values = [];
  let where = 'WHERE 1=1';
  if (monthYear) {
    where += ' AND pp.payroll_period = ?';
    values.push(monthYear);
  }
  const [production] = await pool.execute(`
    SELECT pp.id,
           pp.worker1_employee_id,
           pp.worker2_employee_id,
           pp.production_date,
           pp.payroll_period,
           w1.employee_code AS sewer_code,
           CONCAT(w1.last_name, ', ', w1.first_name) AS sewer,
           COALESCE(NULLIF(w1.agency_name, ''), 'Direct') AS sewer_agency,
           w2.employee_code AS fixer_code,
           CONCAT(w2.last_name, ', ', w2.first_name) AS fixer,
           COALESCE(NULLIF(w2.agency_name, ''), 'Direct') AS fixer_agency,
           pp.sew_type_code,
           pp.size_range,
           pp.quantity_produced,
           pp.piece_rate,
           pp.production_value AS production_amount,
           pp.worker1_share AS sewer_percentage,
           pp.worker2_share AS fixer_percentage,
           pp.worker1_earnings AS sewer_share,
           pp.worker2_earnings AS fixer_share,
           pp.rule_snapshot
      FROM payroll_production_pairs pp
      JOIN employees w1 ON w1.id = pp.worker1_employee_id
      JOIN employees w2 ON w2.id = pp.worker2_employee_id
      ${where}
     ORDER BY pp.production_date DESC, pp.id DESC
  `, values);

  const employeeTotals = new Map();
  const addEmployee = (employeeId, employeeCode, employee, agency, role, amount, productionDate) => {
    const key = `${employeeId}:${role}`;
    const current = employeeTotals.get(key) || {
      employee_id: employeeId,
      employee_code: employeeCode,
      employee,
      agency: agency || 'Direct',
      role,
      payroll_amount: 0,
      work_dates: new Set()
    };
    current.payroll_amount += Number(amount || 0);
    if (productionDate) current.work_dates.add(String(productionDate).slice(0, 10));
    employeeTotals.set(key, current);
  };

  for (const row of production) {
    addEmployee(row.worker1_employee_id, row.sewer_code, row.sewer, row.sewer_agency, 'Sewer', row.sewer_share, row.production_date);
    addEmployee(row.worker2_employee_id, row.fixer_code, row.fixer, row.fixer_agency, 'Fixer', row.fixer_share, row.production_date);
  }

  const normalizedEmployees = [...employeeTotals.values()].map(row => ({
    ...row,
    no_of_days: row.work_dates.size,
    work_dates: undefined,
    payroll_amount: Number(row.payroll_amount.toFixed(2))
  }));
  const sewer = normalizedEmployees.filter(row => row.role === 'Sewer').sort((a, b) => a.agency.localeCompare(b.agency) || a.employee.localeCompare(b.employee));
  const fixer = normalizedEmployees.filter(row => row.role === 'Fixer').sort((a, b) => a.agency.localeCompare(b.agency) || a.employee.localeCompare(b.employee));
  const combined = [...normalizedEmployees].sort((a, b) => a.agency.localeCompare(b.agency) || a.employee.localeCompare(b.employee) || a.role.localeCompare(b.role));
  const agencyMap = new Map();
  for (const row of combined) {
    const current = agencyMap.get(row.agency) || { agency: row.agency, sewer_amount: 0, fixer_amount: 0, total_amount: 0 };
    if (row.role === 'Sewer') current.sewer_amount += row.payroll_amount;
    if (row.role === 'Fixer') current.fixer_amount += row.payroll_amount;
    current.total_amount += row.payroll_amount;
    agencyMap.set(row.agency, current);
  }
  const agency_totals = [...agencyMap.values()]
    .map(row => ({ ...row, sewer_amount: Number(row.sewer_amount.toFixed(2)), fixer_amount: Number(row.fixer_amount.toFixed(2)), total_amount: Number(row.total_amount.toFixed(2)) }))
    .sort((a, b) => a.agency.localeCompare(b.agency));
  const swr_fxr_rows = Array.from({ length: Math.max(sewer.length, fixer.length) }, (_, index) => ({
    line_number: index + 1,
    sewer: sewer[index] || null,
    fixer: fixer[index] || null,
    combined_amount: Number(((sewer[index]?.payroll_amount || 0) + (fixer[index]?.payroll_amount || 0)).toFixed(2))
  }));
  const totals = {
    production_amount: production.reduce((sum, row) => sum + Number(row.production_amount || 0), 0),
    sewer_share: production.reduce((sum, row) => sum + Number(row.sewer_share || 0), 0),
    fixer_share: production.reduce((sum, row) => sum + Number(row.fixer_share || 0), 0),
    combined_payroll: combined.reduce((sum, row) => sum + Number(row.payroll_amount || 0), 0)
  };

  return {
    period: monthYear || null,
    production_register: production,
    sewer_register: sewer,
    fixer_register: fixer,
    combined_register: combined,
    swr_fxr_rows,
    agency_totals,
    totals
  };
}

async function buildSewingRegistry(pool, payrollPeriod, kind = 'main') {
  await ensurePieceRatePayrollSchema(pool);
  if (!/^\d{4}-\d{2}$/.test(String(payrollPeriod || ''))) throw new Error('A valid payroll period is required.');
  const registryDateKey = value => {
    if (!value) return '';
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
    const text = String(value).trim();
    const mysqlDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
    if (mysqlDate) return mysqlDate[1];
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
  };
  const shareFilter = kind === '55' ? 'AND s.share_percentage = 55.00' : kind === '45' ? 'AND s.share_percentage = 45.00' : '';
  const [rows] = await pool.execute(`
    SELECT o.id, o.output_date, o.operation_type, o.size_range, o.quantity_produced,
           o.rate_per_piece, o.full_amount, o.output_mode, o.split_rule,
           s.employee_id, s.partner_role, s.share_percentage, s.share_amount,
           e.employee_code, CONCAT(e.last_name, ', ', e.first_name) AS employee_name,
           COALESCE(NULLIF(e.agency_name, ''), 'Direct') AS agency
      FROM piece_rate_outputs o
      JOIN piece_rate_output_shares s ON s.piece_rate_output_id = o.id
      JOIN employees e ON e.id = s.employee_id
     WHERE o.payroll_period_id = ? AND o.status <> 'Voided' ${shareFilter}
     ORDER BY e.last_name, e.first_name, o.operation_type, o.size_range, o.output_date, o.id
  `, [payrollPeriod]);
  const dates = [...new Set(rows.map(row => registryDateKey(row.output_date)).filter(Boolean))].sort();
  const grouped = new Map();
  for (const row of rows) {
    const outputDate = registryDateKey(row.output_date);
    if (!outputDate) continue;
    const key = [row.employee_id, row.operation_type, row.size_range || '', row.rate_per_piece].join('|');
    const current = grouped.get(key) || {
      employee_id: row.employee_id, employee_name: row.employee_name, employee_code: row.employee_code,
      agency: row.agency, operation_type: row.operation_type, size_range: row.size_range,
      rate_per_piece: Number(row.rate_per_piece), partner_roles: new Set(), daily: {}, total_output: 0, amount: 0
    };
    const dayValue = kind === 'main' ? Number(row.quantity_produced) : Number(row.share_amount);
    current.daily[outputDate] = roundMoney((current.daily[outputDate] || 0) + dayValue);
    current.total_output += Number(row.quantity_produced);
    current.amount += kind === 'main' ? Number(row.full_amount) : Number(row.share_amount);
    current.partner_roles.add(row.partner_role);
    grouped.set(key, current);
  }
  const employees = new Map();
  for (const row of grouped.values()) {
    const employee = employees.get(row.employee_id) || {
      employee_id: row.employee_id,
      employee_name: row.employee_name,
      employee_code: row.employee_code,
      agency: row.agency,
      rows: [],
      daily_totals: {},
      total_output: 0,
      total_amount: 0
    };
    row.partner_roles = [...row.partner_roles].join(', ');
    row.total_output = roundMoney(row.total_output);
    row.amount = roundMoney(row.amount);
    employee.rows.push(row);
    dates.forEach(date => {
      employee.daily_totals[date] = roundMoney((employee.daily_totals[date] || 0) + Number(row.daily[date] || 0));
    });
    employee.total_output += row.total_output;
    employee.total_amount += row.amount;
    employees.set(row.employee_id, employee);
  }
  const employeeRows = [...employees.values()].map(employee => ({ ...employee, total_output: roundMoney(employee.total_output), total_amount: roundMoney(employee.total_amount) }));
  const dailyTotals = dates.reduce((totals, date) => {
    totals[date] = roundMoney(employeeRows.reduce((sum, employee) => sum + Number(employee.daily_totals?.[date] || 0), 0));
    return totals;
  }, {});
  return {
    payroll_period: payrollPeriod, kind, dates, employees: employeeRows,
    totals: {
      daily_totals: dailyTotals,
      total_output: roundMoney(employeeRows.reduce((sum, row) => sum + row.total_output, 0)),
      total_amount: roundMoney(employeeRows.reduce((sum, row) => sum + row.total_amount, 0))
    }
  };
}

async function buildSwrFxrSummary(pool, payrollPeriod) {
  await ensurePieceRatePayrollSchema(pool);
  const [rows] = await pool.execute(`
    SELECT o.id, o.output_date, o.split_rule, o.full_amount,
           sewer.employee_id AS sewer_id, sewer.share_amount AS sewer_amount,
           CONCAT(es.last_name, ', ', es.first_name) AS sewer_employee,
           COALESCE(NULLIF(es.agency_name, ''), 'Direct') AS agency,
           fixer.employee_id AS fixer_id, fixer.share_amount AS fixer_amount,
           CONCAT(ef.last_name, ', ', ef.first_name) AS fixer_employee
      FROM piece_rate_outputs o
      JOIN piece_rate_output_shares sewer ON sewer.piece_rate_output_id = o.id AND sewer.partner_role = 'Sewer'
      JOIN piece_rate_output_shares fixer ON fixer.piece_rate_output_id = o.id AND fixer.partner_role = 'Fixer'
      JOIN employees es ON es.id = sewer.employee_id
      JOIN employees ef ON ef.id = fixer.employee_id
     WHERE o.payroll_period_id = ? AND o.output_mode = 'partner'
       AND o.split_rule = 'Standard Sewer-Fixer' AND o.status <> 'Voided'
     ORDER BY agency, sewer_employee, fixer_employee, o.output_date
  `, [payrollPeriod]);
  const pairs = new Map();
  for (const row of rows) {
    const key = `${row.sewer_id}|${row.fixer_id}|${row.agency}`;
    const current = pairs.get(key) || { agency: row.agency, no_of_days: new Set(), sewer_employee: row.sewer_employee, sewer_amount: 0, fixer_employee: row.fixer_employee, fixer_amount: 0, partner_information: 'Sewer + Fixer (55% / 45%)' };
    current.no_of_days.add(String(row.output_date).slice(0, 10));
    current.sewer_amount += Number(row.sewer_amount);
    current.fixer_amount += Number(row.fixer_amount);
    pairs.set(key, current);
  }
  const summaryRows = [...pairs.values()].map(row => ({ ...row, no_of_days: row.no_of_days.size, sewer_amount: roundMoney(row.sewer_amount), fixer_amount: roundMoney(row.fixer_amount), combined_total: roundMoney(row.sewer_amount + row.fixer_amount) }));
  return { payroll_period: payrollPeriod, rows: summaryRows, totals: { sewer_amount: roundMoney(summaryRows.reduce((sum, row) => sum + row.sewer_amount, 0)), fixer_amount: roundMoney(summaryRows.reduce((sum, row) => sum + row.fixer_amount, 0)), combined_total: roundMoney(summaryRows.reduce((sum, row) => sum + row.combined_total, 0)) } };
}

router.get('/sewing-registries', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const kind = String(req.query.kind || 'main');
    if (!['main', '55', '45'].includes(kind)) return res.status(400).json({ error: 'Registry kind must be main, 55, or 45.' });
    res.json(await buildSewingRegistry(require('../config/db'), req.query.month_year, kind));
  } catch (err) { res.status(400).json({ error: safePayrollError(err, 'Failed to build sewing registry.') }); }
});

router.get('/swr-fxr-summary', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try { res.json(await buildSwrFxrSummary(require('../config/db'), req.query.month_year)); }
  catch (err) { res.status(400).json({ error: safePayrollError(err, 'Failed to build SWR-FXR summary.') }); }
});

async function listSwrFxrProductionPeriods(pool) {
  await ensurePieceRatePayrollSchema(pool);
  const [rows] = await pool.execute(`
    SELECT payroll_period, MIN(start_date) AS start_date, MAX(end_date) AS end_date,
           SUM(production_pair_count) AS production_pair_count
      FROM (
        SELECT payroll_period_id AS payroll_period, MIN(output_date) AS start_date,
               MAX(output_date) AS end_date, COUNT(*) AS production_pair_count
          FROM piece_rate_outputs
         WHERE output_mode = 'partner' AND split_rule = 'Standard Sewer-Fixer'
           AND payroll_period_id REGEXP '^[0-9]{4}-[0-9]{2}$'
         GROUP BY payroll_period_id
        UNION ALL
        SELECT payroll_period, MIN(production_date) AS start_date,
               MAX(production_date) AS end_date, COUNT(*) AS production_pair_count
          FROM payroll_production_pairs
         WHERE payroll_period REGEXP '^[0-9]{4}-[0-9]{2}$'
         GROUP BY payroll_period
      ) periods
     GROUP BY payroll_period
     ORDER BY payroll_period DESC
     LIMIT 24
  `);
  return rows;
}

router.get('/swr-fxr-sum/periods', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    res.json({ periods: await listSwrFxrProductionPeriods(pool) });
  } catch (err) {
    console.error('Error loading SWR-FXR-SUM production periods:', err);
    res.status(500).json({ error: 'Failed to load SWR-FXR-SUM production periods.' });
  }
});

router.post('/swr-fxr-sum/generate', requireAuth, requireRole(PAYROLL_PERMISSIONS.reports), async (req, res) => {
  try {
    const monthYear = String(req.body.month_year || '').trim();
    if (!/^\d{4}-\d{2}$/.test(monthYear)) return res.status(400).json({ error: 'A valid payroll period is required.' });

    const pool = require('../config/db');
    const register = await buildPiecePayrollRegister(pool, monthYear);
    if (!register.production_register.length) {
      return res.status(422).json({
        error: `No Sewer/Fixer production pairs were encoded for ${monthYear}. Encode production pairs for this payroll period before generating its registry.`,
        available_periods: await listSwrFxrProductionPeriods(pool)
      });
    }

    await logPayrollAudit(pool, req, 'swr_fxr_sum_registry_generated', {
      remarks: `Generated SWR-FXR-SUM payroll registry for ${monthYear}`,
      metadata: { month_year: monthYear, totals: register.totals, production_pair_count: register.production_register.length }
    });
    res.json({
      message: 'SWR-FXR-SUM payroll registry generated.',
      payroll_period: monthYear,
      rows: register.swr_fxr_rows,
      agency_totals: register.agency_totals,
      totals: register.totals,
      production_pair_count: register.production_register.length
    });
  } catch (err) {
    console.error('Error generating SWR-FXR-SUM registry:', err);
    res.status(500).json({ error: 'Failed to generate SWR-FXR-SUM payroll registry.' });
  }
});

router.get('/piece-payroll-register', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const register = await buildPiecePayrollRegister(pool, req.query.month_year);
    res.json(register);
  } catch (err) {
    console.error('Error building piece payroll register:', err);
    res.status(500).json({ error: 'Failed to build piece payroll register.' });
  }
});

router.get('/swr-fxr-sum', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const monthYear = String(req.query.month_year || '').trim();
    if (!/^\d{4}-\d{2}$/.test(monthYear)) return res.status(400).json({ error: 'Payroll period is required.' });
    const register = await buildPiecePayrollRegister(pool, monthYear);
    res.json({
      payroll_period: monthYear,
      sewer_register: register.sewer_register,
      fixer_register: register.fixer_register,
      rows: register.swr_fxr_rows,
      agency_totals: register.agency_totals,
      totals: register.totals
    });
  } catch (err) {
    console.error('Error building SWR-FXR-SUM registry:', err);
    res.status(500).json({ error: 'Failed to build SWR-FXR-SUM payroll registry.' });
  }
});

router.post('/piece-payroll-register/generate', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const monthYear = req.body.month_year || new Date().toISOString().slice(0, 7);
    const register = await buildPiecePayrollRegister(pool, monthYear);
    if (!register.production_register.length) {
      return res.status(400).json({ error: 'No production entries found for this payroll period.' });
    }
    await logPayrollAudit(pool, req, 'piece_payroll_register_generated', {
      remarks: `Generated per-piece payroll register for ${monthYear}`,
      metadata: { month_year: monthYear, totals: register.totals }
    });
    res.json({ message: 'Per-piece payroll register generated.', ...register });
  } catch (err) {
    console.error('Error generating piece payroll register:', err);
    res.status(500).json({ error: 'Failed to generate piece payroll register.' });
  }
});

router.get('/reports/:report.:format', requireAuth, requireRole(PAYROLL_PERMISSIONS.reports), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { report, format } = req.params;
    const { month_year, department, wage_type, employee } = req.query;

    const params = [];
    let where = 'WHERE 1=1';
    if (month_year) {
      where += ' AND COALESCE(sc.payroll_period, DATE_FORMAT(sc.calculation_date, "%Y-%m")) = ?';
      params.push(month_year);
    }
    if (department) {
      where += ' AND d.name = ?';
      params.push(department);
    }
    if (wage_type) {
      where += ' AND w.name = ?';
      params.push(wage_type);
    }
    if (employee) {
      where += ' AND (CONCAT(e.first_name, " ", e.last_name) LIKE ? OR e.employee_code LIKE ?)';
      params.push(`%${employee}%`, `%${employee}%`);
    }

    let rows = [];
    if (report === 'audit') {
      const [auditRows] = await pool.execute(`
        SELECT pat.created_at AS date_time,
               u.username AS user,
               pat.action,
               CONCAT(e.first_name, ' ', e.last_name) AS employee,
               pat.remarks
          FROM payroll_audit_trail pat
          LEFT JOIN users u ON u.id = pat.user_id
          LEFT JOIN employees e ON e.id = pat.employee_id
         ORDER BY pat.created_at DESC
         LIMIT 1000
      `);
      rows = auditRows;
    } else if (report === 'deductions' || report === 'government') {
      const [settings] = await pool.execute(`
        SELECT name, category, computation_type, rate_or_amount, apply_schedule, is_active, effective_date
        FROM payroll_deduction_settings
        ${report === 'government' ? 'WHERE category = "Government"' : ''}
        ORDER BY category, name
      `);
      rows = settings;
    } else if (report === 'swr-fxr-summary') {
      const summary = await buildSwrFxrSummary(pool, month_year);
      rows = summary.rows.map(row => ({
        agency: row.agency, no_of_days: row.no_of_days, sewer_employee: row.sewer_employee,
        sewer_amount: row.sewer_amount, fixer_employee: row.fixer_employee, fixer_amount: row.fixer_amount,
        combined_total: row.combined_total, partner_information: row.partner_information
      }));
      rows.push({ agency: 'TOTAL', sewer_amount: summary.totals.sewer_amount, fixer_amount: summary.totals.fixer_amount, combined_total: summary.totals.combined_total });
    } else if (['sewing-registry', 'sewing-55-registry', 'sewing-45-registry'].includes(report)) {
      const kind = report === 'sewing-55-registry' ? '55' : report === 'sewing-45-registry' ? '45' : 'main';
      const registry = await buildSewingRegistry(pool, month_year, kind);
      rows = registry.employees.flatMap(employee => employee.rows.map(row => ({
        employee: employee.employee_name,
        agency: employee.agency,
        operation_type: row.operation_type,
        size_range: row.size_range,
        rate_per_piece: row.rate_per_piece,
        total_output: row.total_output,
        amount: row.amount,
        partner_role: row.partner_roles,
        ...Object.fromEntries(registry.dates.map(date => [date, row.daily[date] || 0]))
      })));
      rows.push({ employee: 'TOTAL', total_output: registry.totals.total_output, amount: registry.totals.total_amount });
    } else if ([
      'piece-production-register',
      'piece-sewer-register',
      'piece-fixer-register',
      'piece-combined-register'
    ].includes(report)) {
      const register = await buildPiecePayrollRegister(pool, month_year);
      if (report === 'piece-production-register') {
        rows = register.production_register.map(row => ({
          production_date: row.production_date,
          sewer: row.sewer,
          fixer: row.fixer,
          sew_type: row.sew_type_code,
          size_range: row.size_range,
          quantity: row.quantity_produced,
          piece_rate: row.piece_rate,
          production_amount: row.production_amount
        }));
      } else if (report === 'piece-sewer-register') {
        rows = register.sewer_register.map(row => ({
          employee: row.employee,
          production_amount: row.payroll_amount,
          sewer_percentage: 'As configured',
          sewer_share: row.payroll_amount
        }));
      } else if (report === 'piece-fixer-register') {
        rows = register.fixer_register.map(row => ({
          employee: row.employee,
          production_amount: row.payroll_amount,
          fixer_percentage: 'As configured',
          fixer_share: row.payroll_amount
        }));
      } else {
        rows = register.combined_register.map(row => ({
          employee: row.employee,
          role: row.role,
          payroll_amount: row.payroll_amount
        }));
        rows.push({ employee: 'TOTAL', role: '', payroll_amount: register.totals.combined_payroll });
      }
    } else if (report === 'weekly-payroll-registry') {
      const registry = await buildWeeklyPayrollRegistry(pool, {
        month_year,
        department,
        pay_type: wage_type,
        employee
      });
      rows = registry.rows.map(row => ({
        employee_code: row.employee_code,
        employee: row.employee_name,
        department: row.department,
        pay_type: row.pay_type,
        payroll_period: row.payroll_period,
        approved_days_worked: row.approved_days_worked,
        approved_hours_worked: row.approved_hours_worked,
        approved_output_quantity: row.approved_output_quantity,
        approved_logistics_trips: row.approved_logistics_trips,
        gross_pay: row.gross_pay,
        allowances: row.allowances,
        deductions: row.deductions,
        net_pay: row.net_pay,
        payroll_status: row.payroll_status,
        processed_by: row.processed_by,
        date_processed: row.date_processed
      }));
      rows.push({
        employee_code: 'TOTAL',
        employee: '',
        department: '',
        pay_type: '',
        payroll_period: '',
        approved_days_worked: '',
        approved_hours_worked: '',
        approved_output_quantity: '',
        approved_logistics_trips: '',
        gross_pay: registry.totals.gross_pay,
        allowances: registry.totals.allowances,
        deductions: registry.totals.deductions,
        net_pay: registry.totals.net_pay,
        payroll_status: '',
        processed_by: '',
        date_processed: ''
      });
    } else if ([
      'daily-rate-register',
      'daily-rate-summary',
      'per-hour-register',
      'per-hour-summary',
      'attendance-payroll-validation'
    ].includes(report)) {
      const wageFilter = report.startsWith('daily') ? 'day|daily' : report.startsWith('per-hour') || report === 'attendance-payroll-validation' ? 'hour|day|daily' : '';
      const [records] = await pool.execute(`
        SELECT sc.id AS payroll_id,
               e.employee_code,
               CONCAT(e.first_name, ' ', e.last_name) AS employee,
               d.name AS department,
               e.position,
               COALESCE(sc.payroll_period, DATE_FORMAT(sc.calculation_date, "%Y-%m")) AS period,
               w.name AS wage_type,
               sc.base_rate,
               sc.days_worked,
               sc.hours_worked,
               sc.overtime_hours,
               sc.gross_pay,
               sc.total_deductions,
               sc.net_pay,
               sc.status,
               sc.validation_snapshot
          FROM salary_calculations sc
          JOIN employees e ON e.id = sc.employee_id
          LEFT JOIN departments d ON d.id = e.department_id
          LEFT JOIN wage_types w ON w.id = sc.wage_type_id
          ${where}
          ${wageFilter ? ` AND LOWER(w.name) REGEXP ?` : ''}
         ORDER BY d.name, e.last_name, e.first_name, sc.created_at DESC
      `, wageFilter ? [...params, wageFilter] : params);
      rows = records.map(row => {
        let snapshot = {};
        try { snapshot = row.validation_snapshot ? JSON.parse(row.validation_snapshot) : {}; } catch (_) {}
        if (report === 'attendance-payroll-validation') {
          return {
            payroll_id: row.payroll_id,
            employee_code: row.employee_code,
            employee: row.employee,
            department: row.department,
            period: row.period,
            wage_type: row.wage_type,
            validation_status: snapshot.validation_status || '-',
            attendance_count: snapshot.attendance_count || 0,
            excluded_attendance_count: snapshot.excluded_attendance_count || 0,
            days_worked: snapshot.days_worked || row.days_worked || 0,
            hours_worked: snapshot.hours_worked || row.hours_worked || 0,
            errors: (snapshot.errors || []).join('; '),
            warnings: (snapshot.warnings || []).join('; ')
          };
        }
        return {
          payroll_id: row.payroll_id,
          employee_code: row.employee_code,
          employee: row.employee,
          department: row.department,
          position: row.position,
          period: row.period,
          wage_type: row.wage_type,
          rate: row.base_rate,
          days_worked: row.days_worked,
          hours_worked: row.hours_worked,
          overtime_hours: row.overtime_hours,
          gross_pay: row.gross_pay,
          deductions: row.total_deductions,
          net_pay: row.net_pay,
          status: row.status
        };
      });
    } else {
      const [records] = await pool.execute(`
        SELECT sc.id AS payroll_id, CONCAT(e.first_name, ' ', e.last_name) AS employee,
               COALESCE(sc.payroll_period, DATE_FORMAT(sc.calculation_date, "%Y-%m")) AS period,
               w.name AS wage_type, sc.gross_pay, sc.total_allowances, sc.total_deductions, sc.net_pay, sc.status
        FROM salary_calculations sc
        JOIN employees e ON e.id = sc.employee_id
        LEFT JOIN wage_types w ON w.id = sc.wage_type_id
        ${where}
        ORDER BY sc.created_at DESC
      `, params);
      rows = records;
    }

    const csv = toCsv(rows);
    const extension = format === 'excel' ? 'xls' : format;
    res.setHeader('Content-Disposition', `attachment; filename="${report}-report.${extension}"`);
    res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : 'text/csv');
    res.send(csv);
  } catch (err) {
    console.error('Error exporting payroll report:', err);
    res.status(500).json({ error: 'Failed to export payroll report' });
  }
});

function toCsv(rows) {
  if (!rows.length) return 'No data\n';
  const headers = Object.keys(rows[0]);
  const escape = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return [
    headers.map(escape).join(','),
    ...rows.map(row => headers.map(header => escape(row[header])).join(','))
  ].join('\n');
}

module.exports = router;
