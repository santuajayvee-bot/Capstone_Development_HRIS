/* ============================================================
   server/payroll.js — Payroll endpoints (wages, rates, transactions)
   ============================================================ */

const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, ROLES } = require('./middleware');

const PAYROLL_PERMISSIONS = {
  view: ['payroll_officer', 'payroll_manager', 'hr_manager', 'hr_admin', 'admin', 'system_admin'],
  calculate: ROLES.payroll_any,
  approve: ['payroll_manager', 'hr_manager'],
  release: ['payroll_manager', 'hr_manager'],
  settings: ['payroll_officer', 'payroll_manager', 'hr_manager', 'hr_admin', 'admin'],
  reports: ['payroll_officer', 'payroll_manager', 'hr_manager', 'hr_admin', 'admin']
};

function currentUserId(req) {
  return req.user?.id || req.user?.userId || req.user?.sub || null;
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

function payrollWeekFromDate(dateValue) {
  const date = dateValue ? new Date(dateValue) : new Date();
  return Math.min(5, Math.max(1, Math.ceil(date.getDate() / 7)));
}

function settingAppliesThisWeek(setting, weekNumber) {
  return setting.apply_schedule === 'Every Payroll' || setting.apply_schedule === `${weekNumber}${weekNumber === 1 ? 'st' : weekNumber === 2 ? 'nd' : weekNumber === 3 ? 'rd' : 'th'} Week`;
}

async function computeConfiguredDeductions(pool, grossPay, calculationDate) {
  const weekNumber = payrollWeekFromDate(calculationDate);
  const [settings] = await pool.execute(`
    SELECT name, category, computation_type, rate_or_amount, apply_schedule
    FROM payroll_deduction_settings
    WHERE is_active = 1 AND effective_date <= ?
    ORDER BY category, name
  `, [calculationDate || new Date().toISOString().split('T')[0]]);

  const applied = [];
  let total = 0;

  for (const setting of settings) {
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

function normalizePayrollWageType(value) {
  const text = String(value || '').toLowerCase();
  if (text.includes('hour')) return 'Hourly';
  if (text.includes('day') || text.includes('daily')) return 'Daily';
  if (text.includes('piece')) return 'Per-Piece';
  if (text.includes('trip')) return 'Per-Trip';
  if (text.includes('salary') || text.includes('base')) return 'Base Salary';
  return String(value || '');
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
      require_hr_validation: bool('daily_require_hr_validation'),
      use_payroll_ready_only: bool('daily_use_payroll_ready_only'),
      count_late: bool('daily_count_late'),
      count_undertime: bool('daily_count_undertime'),
      allow_half_day: bool('daily_allow_half_day'),
      half_day_threshold_hours: num('daily_half_day_threshold_hours', 4),
    },
    hourly: {
      standard_hours_per_day: num('hourly_standard_hours_per_day', 8),
      break_deduction_hours: num('hourly_break_deduction_hours', 0),
      overtime_threshold: num('hourly_overtime_threshold', 8),
      maximum_regular_hours: num('hourly_maximum_regular_hours', 8),
      round_off_rule: map.hourly_round_off_rule || 'none',
      require_hr_validation: bool('hourly_require_hr_validation'),
      require_payroll_ready_attendance: bool('hourly_require_payroll_ready_attendance'),
    }
  };
}

function applyHourRoundOff(hours, rule) {
  const value = Number(hours || 0);
  if (rule === 'nearest_quarter') return Math.round(value * 4) / 4;
  if (rule === 'nearest_half') return Math.round(value * 2) / 2;
  return value;
}

async function validateDailyHourlyPayroll(pool, options) {
  await ensurePieceRatePayrollSchema(pool);
  const employeeId = Number(options.employee_id);
  const payrollPeriod = options.payroll_period || options.calculation_date?.slice(0, 7);
  const calcDate = options.calculation_date || new Date().toISOString().slice(0, 10);
  const range = periodRange(payrollPeriod, calcDate);
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
  const isHourly = wageType === 'Hourly';
  if (!isDaily && !isHourly) {
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
    errors.push(isDaily ? 'No Daily Rate configured.' : 'No Hourly Rate configured.');
  }
  if (rateRows.length > 1) {
    errors.push(isDaily ? 'Multiple active Daily Rates exist.' : 'Multiple active Hourly Rates exist.');
  }

  const rateRow = rateRows[0] || {};
  const rate = isDaily
    ? Number(rateRow.rate || rateRow.base_rate || 0)
    : Number(rateRow.hourly_rate || rateRow.rate || rateRow.base_rate || 0);
  if (!(rate > 0)) {
    errors.push(isDaily ? 'Daily Rate must be greater than zero.' : 'Hourly Rate must be greater than zero.');
  }
  if (!rateRow.effective_date) errors.push('Effective Date is required.');

  const attendanceWhere = [
    'ats.employee_id = ?',
    'ats.attendance_date BETWEEN ? AND ?',
    "ats.verification_status IN ('VALIDATED','PAYROLL_READY')"
  ];
  const attendanceValues = [employeeId, range.start, range.end];
  if ((isDaily && policy.daily.use_payroll_ready_only) || (isHourly && policy.hourly.require_payroll_ready_attendance)) {
    attendanceWhere.push('ats.payroll_eligible = 1');
  }
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
         OR (? = 'Hourly' AND (al.time_in IS NULL OR al.time_out IS NULL))
       )
     ORDER BY ats.attendance_date
     LIMIT 20
  `, [employeeId, range.start, range.end, wageType]);

  if (!attendanceRows.length) {
    errors.push(isDaily ? 'No validated payroll-ready attendance exists.' : 'No validated payroll-ready attendance with complete Time In and Time Out exists.');
  }
  if (blockedRows.length) {
    warnings.push(`${blockedRows.length} attendance record(s) excluded because they are pending, rejected, incomplete, needs review, or not payroll ready.`);
  }

  const attendanceDays = attendanceRows.length;
  const lateDays = attendanceRows.filter(row => String(row.attendance_status || row.log_status || '').toLowerCase().includes('late')).length;
  const absentDays = attendanceRows.filter(row => String(row.attendance_status || '').toLowerCase().includes('absent')).length;
  const rawRegularHours = attendanceRows.reduce((sum, row) => sum + Number(row.regular_minutes || 0) / 60, 0);
  const overtimeHours = attendanceRows.reduce((sum, row) => sum + Number(row.overtime_minutes || 0) / 60, 0);

  let daysWorked = attendanceDays;
  if (isDaily && policy.daily.allow_half_day) {
    daysWorked = attendanceRows.reduce((sum, row) => {
      const hours = Number(row.regular_minutes || 0) / 60;
      return sum + (hours > 0 && hours < policy.daily.half_day_threshold_hours ? 0.5 : 1);
    }, 0);
  }
  const breakDeduction = isHourly ? attendanceDays * Number(policy.hourly.break_deduction_hours || 0) : 0;
  let hoursWorked = isHourly ? Math.max(0, rawRegularHours - breakDeduction) : 0;
  hoursWorked = applyHourRoundOff(hoursWorked, policy.hourly.round_off_rule);

  if (isDaily && !(daysWorked > 0)) errors.push('Days Worked must be greater than zero.');
  if (isHourly && !(hoursWorked > 0)) errors.push('Hours Worked must be greater than zero.');

  const grossPay = isDaily ? rate * daysWorked : rate * hoursWorked;
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
    active_rate_count: rateRows.length,
    effective_date: rateRow.effective_date || null,
    attendance_count: attendanceRows.length,
    excluded_attendance_count: blockedRows.length,
    days_worked: Number(daysWorked.toFixed(2)),
    absent_days: absentDays,
    late_days: lateDays,
    undertime_days: 0,
    hours_worked: Number(hoursWorked.toFixed(2)),
    regular_hours: Number(hoursWorked.toFixed(2)),
    overtime_hours: Number(overtimeHours.toFixed(2)),
    gross_pay: Number(grossPay.toFixed(2)),
    validation_status: errors.length ? 'Blocked' : 'Ready',
    policy: isDaily ? policy.daily : policy.hourly,
    attendance_rows: attendanceRows.map(row => ({
      attendance_date: row.attendance_date,
      attendance_status: row.attendance_status,
      verification_status: row.verification_status,
      payroll_eligible: Number(row.payroll_eligible || 0) === 1,
      regular_hours: Number(row.regular_minutes || 0) / 60,
      overtime_hours: Number(row.overtime_minutes || 0) / 60,
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

async function getLogisticsRate(pool, { logistics_region_id, truck_type, position, calculation_date }) {
  const truckType = String(truck_type || 'Standard Truck').trim() || 'Standard Truck';
  const role = position === 'Driver' ? 'Driver' : 'Helper';
  const [rates] = await pool.execute(`
    SELECT *
      FROM payroll_logistics_rates
     WHERE logistics_region_id = ?
       AND LOWER(truck_type) = LOWER(?)
       AND LOWER(position) = LOWER(?)
       AND is_active = 1
       AND effective_date <= ?
     ORDER BY effective_date DESC, id DESC
     LIMIT 1
  `, [logistics_region_id, truckType, role, calculation_date || new Date().toISOString().split('T')[0]]);
  if (rates.length) return Number(rates[0].rate || 0);
  return 0;
}

async function computeLogisticsCrewPayroll(pool, body) {
  const logisticsRegionId = Number(body.logistics_region_id);
  const driverId = Number(body.driver_employee_id);
  const helper1Id = Number(body.helper1_employee_id);
  const helper2Id = body.helper2_employee_id ? Number(body.helper2_employee_id) : null;
  const tripDate = body.transaction_date || new Date().toISOString().split('T')[0];
  const truckType = String(body.truck_type || 'Standard Truck').trim() || 'Standard Truck';
  const tripCount = Math.max(1, Number(body.trip_count || body.trips || 1));

  if (!logisticsRegionId) throw new Error('Region is required.');
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

  const driverRate = await getLogisticsRate(pool, {
    logistics_region_id: logisticsRegionId,
    truck_type: truckType,
    position: 'Driver',
    calculation_date: tripDate
  });
  const helperRate = await getLogisticsRate(pool, {
    logistics_region_id: logisticsRegionId,
    truck_type: truckType,
    position: 'Helper',
    calculation_date: tripDate
  });
  if (!(driverRate > 0) || !(helperRate > 0)) throw new Error('Active logistics Driver and Helper rates are required.');

  const crewStatus = helper2 ? 'Complete' : 'Incomplete';
  const missingHelperShare = helper2 ? 0 : helperRate / 2;
  const rows = [
    { employee: driver, role: 'Driver', base_rate: driverRate, gross_pay: (driverRate + missingHelperShare) * tripCount },
    { employee: helper1, role: 'Helper 1', base_rate: helperRate, gross_pay: (helperRate + missingHelperShare) * tripCount }
  ];
  if (helper2) rows.push({ employee: helper2, role: 'Helper 2', base_rate: helperRate, gross_pay: helperRate * tripCount });

  return {
    logistics_region_id: logisticsRegionId,
    truck_type: truckType,
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
    ['hourly_require_payroll_ready_attendance', 'true', 'Hourly Rules', 'Hourly payroll requires payroll-ready attendance.']
  ];
  for (const row of policyDefaults) {
    await pool.execute(`
      INSERT INTO payroll_policy_settings (setting_key, setting_value, setting_group, description)
      SELECT ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM payroll_policy_settings WHERE setting_key = ?)
    `, [...row, row[0]]);
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

  await ensureColumn('payroll_production_outputs', 'sew_type_code', 'VARCHAR(40) NULL AFTER product_category');
  await ensureColumn('payroll_production_outputs', 'size_range', 'VARCHAR(40) NULL AFTER sew_type_code');
  await ensureColumn('payroll_production_pairs', 'sew_type_code', 'VARCHAR(40) NULL AFTER product_category');
  await ensureColumn('payroll_production_pairs', 'size_range', 'VARCHAR(40) NULL AFTER sew_type_code');

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
         ('MT', 'MT sewing operation', ?, 1),
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
    res.status(500).json({ error: 'Failed to validate payroll: ' + err.message });
  }
});

router.post('/logistics-rates', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
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
    res.status(500).json({ error: 'Failed to save logistics rate: ' + err.message });
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
      const [insertRes] = await pool.execute(`
        INSERT INTO employee_wage_rates 
        (employee_id, wage_type_id, base_rate, hourly_rate, overtime_rate, sewing_type_id, logistics_region_id, rate, effective_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE())
      `, [
        empId,
        wage_type_id,
        rate.base_rate || null,
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
    res.status(500).json({ error: 'Failed to update wage configuration: ' + err.message });
  }
});

// Record production transaction (pieces produced)
router.post('/transactions/production', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { employee_id, sewing_type_id, quantity, rate, transaction_date } = req.body;

    // Calculate week and month
    const date = new Date(transaction_date);
    const week = Math.ceil((date.getDate() + new Date(date.getFullYear(), date.getMonth(), 1).getDay()) / 7);
    const monthYear = date.toISOString().slice(0, 7);

    // Calculate gross and net pay
    const grossPay = quantity * rate;
    const sssDeduction = grossPay * 0.045;
    const pagibigDeduction = grossPay * 0.02;
    const philhealthDeduction = grossPay * 0.0275;
    const totalDeductions = sssDeduction + pagibigDeduction + philhealthDeduction;
    const netPay = grossPay - totalDeductions;

    // Save to production_transactions
    const [prodResult] = await pool.execute(`
      INSERT INTO production_transactions 
      (employee_id, sewing_type_id, quantity, rate, transaction_date, week_number, month_year)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [employee_id, sewing_type_id, quantity, rate, transaction_date, week, monthYear]);

    // Also save to salary_calculations for display in records
    const wage_type_id = 3; // Per-Piece wage type ID
    const [salCalcResult] = await pool.execute(`
      INSERT INTO salary_calculations 
      (employee_id, wage_type_id, base_rate, quantity, gross_pay, sss_deduction, pagibig_deduction, philhealth_deduction, total_deductions, net_pay, calculation_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [employee_id, wage_type_id, rate, quantity, grossPay, sssDeduction, pagibigDeduction, philhealthDeduction, totalDeductions, netPay, transaction_date, 'Submitted']);

    res.json({ 
      success: true, 
      id: prodResult.insertId,
      amount: quantity * rate,
      message: `Recorded ${quantity} pieces at ₱${rate} each`,
      salary_calculation_id: salCalcResult.insertId
    });
  } catch (err) {
    console.error('Error recording production transaction:', err);
    res.status(500).json({ error: 'Failed to record transaction' });
  }
});

// Record logistics transaction (trips completed)
router.post('/transactions/logistics', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    await ensurePieceRatePayrollSchema(pool);
    const {
      employee_id,
      logistics_region_id,
      rate,
      trip_reference,
      transaction_date,
      driver_employee_id,
      helper1_employee_id,
      helper2_employee_id
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
        const configuredDeductions = await computeConfiguredDeductions(pool, row.gross_pay, crew.transaction_date);
        const totalDeductions = configuredDeductions.total;
        const netPay = row.gross_pay - totalDeductions;
        const snapshot = {
          ...crew.snapshot,
          crew_role: row.role,
          employee_id: row.employee.id,
          deductions: configuredDeductions.applied
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
          netPay,
          row.base_rate,
          row.gross_pay,
          tripReference,
          crew.transaction_date,
          week,
          monthYear,
          JSON.stringify(snapshot)
        ]);

        const [salCalcResult] = await pool.execute(`
          INSERT INTO salary_calculations
            (employee_id, wage_type_id, base_rate, quantity, gross_pay, total_deductions, net_pay,
             calculation_date, payroll_period, notes, status, calculated_by, submitted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Submitted', ?, NOW())
        `, [
          row.employee.id,
          wage_type_id,
          row.base_rate,
          crew.trip_count,
          row.gross_pay,
          totalDeductions,
          netPay,
          crew.transaction_date,
          monthYear,
          JSON.stringify(snapshot),
          currentUserId(req)
        ]);

        savedRows.push({
          logistics_transaction_id: logResult.insertId,
          salary_calculation_id: salCalcResult.insertId,
          employee_id: row.employee.id,
          role: row.role,
          base_rate: row.base_rate,
          gross_pay: row.gross_pay,
          net_pay: netPay
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

    // Calculate gross and net pay
    const grossPay = rate;
    const sssDeduction = grossPay * 0.045;
    const pagibigDeduction = grossPay * 0.02;
    const philhealthDeduction = grossPay * 0.0275;
    const totalDeductions = sssDeduction + pagibigDeduction + philhealthDeduction;
    const netPay = grossPay - totalDeductions;

    // Save to logistics_transactions
    const [logResult] = await pool.execute(`
      INSERT INTO logistics_transactions 
      (employee_id, logistics_region_id, rate, amount, trip_reference, transaction_date, week_number, month_year, gross_pay, net_pay, base_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [employee_id, logistics_region_id, rate, rate, trip_reference, transaction_date, week, monthYear, grossPay, netPay, rate]);

    // Also save to salary_calculations for display in records
    const wage_type_id = 4; // Per-Trip wage type ID
    const [salCalcResult] = await pool.execute(`
      INSERT INTO salary_calculations 
      (employee_id, wage_type_id, base_rate, quantity, gross_pay, sss_deduction, pagibig_deduction, philhealth_deduction, total_deductions, net_pay, calculation_date, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [employee_id, wage_type_id, rate, 1, grossPay, sssDeduction, pagibigDeduction, philhealthDeduction, totalDeductions, netPay, transaction_date, 'Submitted']);

    res.json({ 
      success: true, 
      id: logResult.insertId,
      amount: rate,
      message: `Recorded 1 trip to ${trip_reference || 'destination'} at ₱${rate}`,
      salary_calculation_id: salCalcResult.insertId
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

router.post('/piece-rates', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
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

router.post('/piece-incentives', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
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

router.post('/piece-incentive-entries', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
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
    res.status(400).json({ error: err.message || 'Failed to encode production output.' });
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
    res.status(400).json({ error: err.message || 'Failed to encode production pair.' });
  }
});

// Save salary calculation (Base Salary or Hourly)
router.post('/salary-calculation', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const {
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
    const [wageRows] = await pool.execute('SELECT name FROM wage_types WHERE id = ? LIMIT 1', [wage_type_id]);
    const wageTypeName = wageRows[0]?.name || '';
    const isPieceRate = /piece/i.test(wageTypeName);
    const normalizedWageType = normalizePayrollWageType(wageTypeName);
    const isDailyRate = normalizedWageType === 'Daily';
    const isHourlyRate = normalizedWageType === 'Hourly';
    let serverGrossPay = parseFloat(gross_pay || 0);
    let serverBaseRate = parseFloat(base_rate || 0);
    let serverQuantity = quantity || 1;
    let pieceComputation = null;
    let validationSnapshot = null;

    if ((isDailyRate || isHourlyRate) && status !== 'Draft') {
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
      if (isDailyRate) {
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

    // Validate required fields
    if (!employee_id || !wage_type_id || (!isPieceRate && !serverBaseRate) || !serverGrossPay) {
      return res.status(400).json({ 
        error: isPieceRate
          ? 'Required fields: employee_id, wage_type_id, Type of Sew, Size Range, worker category, quantity produced'
          : 'Required fields: employee_id, wage_type_id, base_rate, gross_pay'
      });
    }

    const calculationStatus = ['Draft', 'Submitted'].includes(status) ? status : 'Submitted';
    const submittedAt = calculationStatus === 'Submitted' ? new Date() : null;
    const configuredDeductions = await computeConfiguredDeductions(pool, serverGrossPay, calcDate);
    const computedTotalDeductions = configuredDeductions.total;
    const computedNetPay = serverGrossPay - computedTotalDeductions;
    const deductionByName = configuredDeductions.applied.reduce((acc, item) => {
      acc[item.name.toLowerCase()] = item.amount;
      return acc;
    }, {});

    // Insert into salary_calculations table
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
        net_pay,
        calculation_date,
        payroll_period,
        agency_name,
        validation_snapshot,
        status,
        calculated_by,
        submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      employee_id,
      wage_type_id,
      serverBaseRate,
      serverQuantity,
      isHourlyRate && validationSnapshot ? validationSnapshot.hours_worked : hours_worked || 0,
      isDailyRate && validationSnapshot ? validationSnapshot.days_worked : days_worked || 0,
      housing_allowance || 0,
      meal_allowance || 0,
      transport_allowance || 0,
      bonus_allowance || 0,
      total_allowances || 0,
      overtime_hours || 0,
      overtime_amount || 0,
      serverGrossPay,
      deductionByName.sss || 0,
      deductionByName['pag-ibig'] || deductionByName.pagibig || 0,
      deductionByName.philhealth || 0,
      computedTotalDeductions,
      computedNetPay,
      calcDate,
      payroll_period || calcDate.slice(0, 7),
      agency_name || null,
      validationSnapshot ? JSON.stringify(validationSnapshot) : null,
      calculationStatus,
      currentUserId(req),
      submittedAt
    ]);

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
          JSON.stringify({ ...pair.rule_snapshot, salary_calculation_id: result.insertId }),
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

    console.log('✅ Salary calculation saved with ID:', result.insertId);
    await logPayrollAudit(pool, req, calculationStatus === 'Draft' ? 'salary_calculation_draft' : 'salary_calculation_submitted', {
      employee_id,
      salary_calculation_id: result.insertId,
      remarks: `${calculationStatus} salary calculation`,
      metadata: { gross_pay: serverGrossPay, net_pay: computedNetPay, payroll_period, agency_name: agency_name || null, deductions: configuredDeductions.applied, piece_rate: pieceComputation }
    });
    
    res.json({ 
      success: true, 
      id: result.insertId,
      message: `Salary calculation saved for employee ID ${employee_id}`,
      gross_pay: serverGrossPay,
      net_pay: computedNetPay,
      calculation_id: result.insertId
    });
  } catch (err) {
    console.error('❌ Error saving salary calculation:', err);
    res.status(500).json({ error: 'Failed to save salary calculation: ' + err.message });
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

// Generate payroll for a month
router.post('/generate', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { month_year, start_date, end_date } = req.body;

    console.log('📊 Starting payroll generation for:', { month_year, start_date, end_date });

    // Validate inputs
    if (!month_year || !start_date || !end_date) {
      return res.status(400).json({ error: 'month_year, start_date, and end_date are required' });
    }

    // Check if payroll already exists
    try {
      const [existing] = await pool.execute(
        'SELECT id FROM payroll_runs WHERE month_year = ?',
        [month_year]
      );

      if (existing.length) {
        return res.status(400).json({ error: `Payroll already generated for ${month_year}` });
      }
    } catch (dbErr) {
      console.error('❌ Error checking existing payroll:', dbErr);
      throw new Error(`Failed to check existing payroll: ${dbErr.message}`);
    }

    // Create payroll run
    let payrollRunId;
    try {
      const [runResult] = await pool.execute(`
        INSERT INTO payroll_runs (month_year, start_date, end_date, created_by)
        VALUES (?, ?, ?, ?)
      `, [month_year, start_date, end_date, req.user.id || req.user.userId]);

      payrollRunId = runResult.insertId;
      console.log('✅ Payroll run created with ID:', payrollRunId);
    } catch (dbErr) {
      console.error('❌ Error creating payroll run:', dbErr);
      throw new Error(`Failed to create payroll run: ${dbErr.message}`);
    }

    // Get all active employees
    let employees = [];
    try {
      const [empData] = await pool.execute(`
        SELECT e.id, e.wage_type_id, w.name AS wage_type
        FROM employees e
        LEFT JOIN wage_types w ON w.id = e.wage_type_id
        WHERE e.status = 'Active'
      `);
      employees = empData;
      console.log(`✅ Found ${employees.length} active employees`);
    } catch (dbErr) {
      console.error('❌ Error fetching employees:', dbErr);
      throw new Error(`Failed to fetch employees: ${dbErr.message}`);
    }

    // Generate payslips for each employee
    let processedCount = 0;
    for (const emp of employees) {
      try {
        let totalEarning = 0;

        if (emp.wage_type === 'Per-Piece') {
          // Sum production transactions
          const [prods] = await pool.execute(`
            SELECT COALESCE(SUM(amount), 0) AS total
            FROM production_transactions
            WHERE employee_id = ? AND month_year = ?
          `, [emp.id, month_year]);
          totalEarning = prods[0]?.total || 0;
        } else if (emp.wage_type === 'Per-Trip') {
          // Sum logistics transactions
          const [trips] = await pool.execute(`
            SELECT COALESCE(SUM(amount), 0) AS total
            FROM logistics_transactions
            WHERE employee_id = ? AND month_year = ?
          `, [emp.id, month_year]);
          totalEarning = trips[0]?.total || 0;
        } else {
          // Base Salary or Hourly - use a default or configured amount
          totalEarning = 0; // Can be customized
        }

        // Get deductions
        const [deducts] = await pool.execute(`
          SELECT COALESCE(SUM(amount), 0) AS total
          FROM employee_deductions
          WHERE employee_id = ? AND is_active = 1
        `, [emp.id]);
        const totalDeduction = deducts[0]?.total || 0;

        // Create payslip
        await pool.execute(`
          INSERT INTO payslips (payroll_run_id, employee_id, wage_type_id, total_earning, total_deduction, net_pay)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [payrollRunId, emp.id, emp.wage_type_id || 1, totalEarning, totalDeduction, totalEarning - totalDeduction]);

        processedCount++;
      } catch (slipErr) {
        console.error(`❌ Error creating payslip for employee ${emp.id}:`, slipErr);
        // Continue with next employee instead of failing entire payroll
      }
    }

    console.log(`✅ Payroll generation completed. Processed ${processedCount} out of ${employees.length} employees`);

    res.json({ 
      success: true, 
      payrollRunId: payrollRunId,
      employeesProcessed: processedCount,
      totalEmployees: employees.length,
      message: `Payroll generated for ${month_year} - ${processedCount} employees processed` 
    });
  } catch (err) {
    console.error('❌ Error generating payroll:', err);
    res.status(500).json({ 
      error: 'Failed to generate payroll',
      details: err.message,
      message: err.message
    });
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
    } else if (emp.wage_type === 'Per-Trip') {
      const [trips] = await pool.execute(`
        SELECT lr.name AS region,
               lt.truck_type,
               lt.crew_role,
               COUNT(*) AS trips,
               MAX(lt.base_rate) AS base_rate,
               MAX(lt.missing_helper_share) AS missing_helper_share,
               SUM(COALESCE(lt.gross_pay, lt.amount)) AS gross_pay,
               SUM(COALESCE(lt.net_pay, lt.amount)) AS net_pay,
               SUM(lt.amount) AS amount
        FROM logistics_transactions lt
        JOIN logistics_regions lr ON lr.id = lt.logistics_region_id
        WHERE lt.employee_id = ? AND lt.month_year = ?
        GROUP BY lt.logistics_region_id, lt.truck_type, lt.crew_role
        ORDER BY lr.name, lt.truck_type, lt.crew_role
      `, [empId, monthYear]);
      earnings.logistics = trips;
      totalEarning = trips.reduce((sum, t) => sum + Number(t.gross_pay || t.amount || 0), 0);
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
        sc.agency_name,
        sc.created_at,
        sc.updated_at
      FROM salary_calculations sc
      JOIN employees e ON e.id = sc.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN wage_types w ON w.id = sc.wage_type_id
      WHERE 1=1
    `;
    const params = [];

    if (employee_id) {
      query += ' AND sc.employee_id = ?';
      params.push(employee_id);
    }

    if (status) {
      query += ' AND sc.status = ?';
      params.push(status);
    }

    if (from_date) {
      query += ' AND sc.calculation_date >= ?';
      params.push(from_date);
    }

    if (to_date) {
      query += ' AND sc.calculation_date <= ?';
      params.push(to_date);
    }

    query += ' ORDER BY sc.created_at DESC LIMIT ?';
    params.push(parseInt(limit) || 100);

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
    res.status(500).json({ error: 'Failed to fetch salary calculations: ' + err.message });
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
        SELECT sc.id, sc.employee_id, sc.wage_type_id, sc.gross_pay, sc.deductions, sc.net_pay
        FROM salary_calculations sc
        WHERE sc.month_year = ? AND sc.status = 'Submitted'
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
          `, [payrollRunId, calc.employee_id, calc.wage_type_id, calc.gross_pay, calc.deductions, calc.net_pay]);

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
      error: 'Failed to convert calculations to payslips',
      details: err.message
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

router.post('/deduction-settings', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { name, category, computation_type, rate_or_amount, apply_schedule, is_active, effective_date, remarks } = req.body;
    if (!name || !effective_date) return res.status(400).json({ error: 'Deduction name and effective date are required.' });

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

router.post('/allowance-settings', requireAuth, requireRole(PAYROLL_PERMISSIONS.settings), async (req, res) => {
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

router.patch('/salary-calculations/:id/status', requireAuth, requireRole(PAYROLL_PERMISSIONS.approve), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { id } = req.params;
    const { status, remarks } = req.body;
    const allowed = ['Submitted', 'Approved', 'Released', 'Paid'];
    if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid payroll status.' });

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
    await pool.execute(`UPDATE salary_calculations SET ${fields.join(', ')} WHERE id = ?`, params);
    await logPayrollAudit(pool, req, `payroll_${status.toLowerCase()}`, {
      salary_calculation_id: id,
      remarks: remarks || `Marked payroll as ${status}`
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Error updating payroll status:', err);
    res.status(500).json({ error: 'Failed to update payroll status' });
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
           w2.employee_code AS fixer_code,
           CONCAT(w2.last_name, ', ', w2.first_name) AS fixer,
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
  const addEmployee = (employeeId, employeeCode, employee, role, amount) => {
    const key = `${employeeId}:${role}`;
    const current = employeeTotals.get(key) || {
      employee_id: employeeId,
      employee_code: employeeCode,
      employee,
      role,
      payroll_amount: 0
    };
    current.payroll_amount += Number(amount || 0);
    employeeTotals.set(key, current);
  };

  for (const row of production) {
    addEmployee(row.worker1_employee_id, row.sewer_code, row.sewer, 'Sewer', row.sewer_share);
    addEmployee(row.worker2_employee_id, row.fixer_code, row.fixer, 'Fixer', row.fixer_share);
  }

  const sewer = [...employeeTotals.values()].filter(row => row.role === 'Sewer').sort((a, b) => a.employee.localeCompare(b.employee));
  const fixer = [...employeeTotals.values()].filter(row => row.role === 'Fixer').sort((a, b) => a.employee.localeCompare(b.employee));
  const combined = [...employeeTotals.values()].sort((a, b) => a.employee.localeCompare(b.employee) || a.role.localeCompare(b.role));
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
    totals
  };
}

router.get('/piece-payroll-register', requireAuth, requireRole(PAYROLL_PERMISSIONS.view), async (req, res) => {
  try {
    const pool = require('../config/db');
    const register = await buildPiecePayrollRegister(pool, req.query.month_year);
    res.json(register);
  } catch (err) {
    console.error('Error building piece payroll register:', err);
    res.status(500).json({ error: err.message || 'Failed to build piece payroll register.' });
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
    res.status(500).json({ error: err.message || 'Failed to generate piece payroll register.' });
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
