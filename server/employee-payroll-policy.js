const SCOPE_PRIORITY = {
  EMPLOYEE: 500,
  DEPARTMENT: 300,
  WAGE_TYPE: 250,
  EMPLOYMENT_TYPE: 200,
  DEFAULT: 100,
};

function toNumber(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toBool(value, fallback = false) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function timeValue(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return `${String(match[1]).padStart(2, '0')}:${match[2]}`;
}

function dateValue(value) {
  const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
}

function scopeType(value) {
  const text = String(value || 'DEFAULT').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(SCOPE_PRIORITY, text) ? text : 'DEFAULT';
}

function scopeRank(row) {
  return SCOPE_PRIORITY[row.scope_type] || 0;
}

async function ensurePayrollAttendanceConfigurationSchema(pool) {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS payroll_attendance_configurations (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      config_name VARCHAR(120) NOT NULL,
      scope_type ENUM('DEFAULT','DEPARTMENT','EMPLOYMENT_TYPE','WAGE_TYPE','EMPLOYEE') NOT NULL DEFAULT 'DEFAULT',
      employee_id BIGINT NULL,
      department_id BIGINT NULL,
      wage_type_id BIGINT NULL,
      scope_value VARCHAR(120) NULL,
      work_start_time TIME NULL,
      work_end_time TIME NULL,
      break_start_time TIME NULL,
      break_end_time TIME NULL,
      daily_hours DECIMAL(5,2) NULL,
      standard_work_hours DECIMAL(5,2) NULL,
      working_days_per_month DECIMAL(6,2) NULL,
      working_days_per_year INT NULL,
      grace_period_minutes INT NOT NULL DEFAULT 0,
      late_threshold_minutes INT NOT NULL DEFAULT 0,
      habitual_tardiness_threshold INT NOT NULL DEFAULT 5,
      habitual_tardiness_period ENUM('MONTHLY','PAYROLL_PERIOD') NOT NULL DEFAULT 'MONTHLY',
      tardiness_alert_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      priority INT NOT NULL DEFAULT 0,
      effective_date DATE NOT NULL,
      end_date DATE NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      notes TEXT NULL,
      created_by BIGINT NULL,
      updated_by BIGINT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_payroll_att_config_scope (scope_type, employee_id, department_id, wage_type_id, scope_value, is_active),
      INDEX idx_payroll_att_config_effective (effective_date, end_date, is_active),
      INDEX idx_payroll_att_config_priority (priority, effective_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function normalizeConfigInput(body = {}) {
  const type = scopeType(body.scope_type);
  const employeeId = type === 'EMPLOYEE' ? Number(body.employee_id || 0) : null;
  const departmentId = type === 'DEPARTMENT' ? Number(body.department_id || 0) : null;
  const wageTypeId = type === 'WAGE_TYPE' ? Number(body.wage_type_id || 0) : null;
  const scopeValue = type === 'EMPLOYMENT_TYPE' ? String(body.scope_value || '').trim().slice(0, 120) : null;
  const configName = String(body.config_name || '').trim().slice(0, 120);

  if (!configName) throw new Error('Configuration name is required.');
  if (type === 'EMPLOYEE' && !(employeeId > 0)) throw new Error('Employee is required for employee-specific configuration.');
  if (type === 'DEPARTMENT' && !(departmentId > 0)) throw new Error('Department is required for department configuration.');
  if (type === 'WAGE_TYPE' && !(wageTypeId > 0)) throw new Error('Wage type is required for wage type configuration.');
  if (type === 'EMPLOYMENT_TYPE' && !scopeValue) throw new Error('Employment type is required for employment type configuration.');

  const dailyHours = toNumber(body.daily_hours, null);
  const standardHours = toNumber(body.standard_work_hours, dailyHours);
  const workingDaysPerMonth = toNumber(body.working_days_per_month, null);
  const workingDaysPerYear = Math.floor(toNumber(body.working_days_per_year, 0) || 0);
  if (!(dailyHours > 0) && !(standardHours > 0)) throw new Error('Daily hours is required.');
  if (!(workingDaysPerMonth > 0) && !(workingDaysPerYear > 0)) throw new Error('Working days per month or year is required.');
  if (dailyHours > 24 || standardHours > 24) throw new Error('Daily hours must not exceed 24.');
  if (workingDaysPerMonth !== null && (workingDaysPerMonth < 1 || workingDaysPerMonth > 31)) {
    throw new Error('Working days per month must be between 1 and 31.');
  }
  if (workingDaysPerYear && (workingDaysPerYear < 1 || workingDaysPerYear > 366)) {
    throw new Error('Working days per year must be between 1 and 366.');
  }

  const timeFields = ['work_start_time', 'work_end_time', 'break_start_time', 'break_end_time'];
  for (const field of timeFields) {
    if (body[field] && !timeValue(body[field])) throw new Error(`${field} is invalid.`);
  }
  const effectiveDate = dateValue(body.effective_date);
  const endDate = body.end_date ? dateValue(body.end_date) : null;
  if (!effectiveDate) throw new Error('Effective date is required.');
  if (body.end_date && !endDate) throw new Error('End date is invalid.');
  if (endDate && endDate < effectiveDate) throw new Error('End date cannot be earlier than effective date.');

  return {
    id: Number(body.id || 0) || null,
    config_name: configName,
    scope_type: type,
    employee_id: employeeId,
    department_id: departmentId,
    wage_type_id: wageTypeId,
    scope_value: scopeValue,
    work_start_time: timeValue(body.work_start_time),
    work_end_time: timeValue(body.work_end_time),
    break_start_time: timeValue(body.break_start_time),
    break_end_time: timeValue(body.break_end_time),
    daily_hours: dailyHours || standardHours,
    standard_work_hours: standardHours || dailyHours,
    working_days_per_month: workingDaysPerMonth,
    working_days_per_year: workingDaysPerYear || null,
    grace_period_minutes: Math.min(1440, Math.max(0, Math.floor(toNumber(body.grace_period_minutes, 0)))),
    late_threshold_minutes: Math.max(0, Math.floor(toNumber(body.late_threshold_minutes, 0))),
    habitual_tardiness_threshold: Math.min(31, Math.max(1, Math.floor(toNumber(body.habitual_tardiness_threshold, 5)))),
    habitual_tardiness_period: 'MONTHLY',
    tardiness_alert_enabled: toBool(body.tardiness_alert_enabled, true) ? 1 : 0,
    priority: Math.min(1000, Math.max(0, Math.floor(toNumber(body.priority, 0)))),
    effective_date: effectiveDate,
    end_date: endDate,
    is_active: toBool(body.is_active, true) ? 1 : 0,
    notes: String(body.notes || '').trim().slice(0, 1000) || null,
  };
}

function applyConfigToPolicy(basePolicy, config) {
  if (!config) {
    return {
      ...basePolicy,
      late_deduction_method: 'auto_compute',
      undertime_deduction_method: 'auto_compute',
    };
  }
  const workingDaysPerMonth = toNumber(config.working_days_per_month, null)
    || (toNumber(config.working_days_per_year, null) ? toNumber(config.working_days_per_year) / 12 : null);
  const standardHours = toNumber(config.standard_work_hours, null) || toNumber(config.daily_hours, null);
  const merged = {
    ...basePolicy,
    work_start_time: timeValue(config.work_start_time) || basePolicy.work_start_time,
    work_end_time: timeValue(config.work_end_time) || basePolicy.work_end_time,
    break_start_time: timeValue(config.break_start_time) || basePolicy.break_start_time,
    break_end_time: timeValue(config.break_end_time) || basePolicy.break_end_time,
    standard_work_hours: standardHours || basePolicy.standard_work_hours,
    daily_hours: toNumber(config.daily_hours, standardHours || basePolicy.standard_work_hours),
    working_days_per_month: workingDaysPerMonth || basePolicy.working_days_per_month,
    working_days_per_year: toNumber(config.working_days_per_year, null),
    grace_period_minutes: Math.max(0, Math.floor(toNumber(config.grace_period_minutes, basePolicy.grace_period_minutes || 0))),
    late_threshold_minutes: Math.max(0, Math.floor(toNumber(config.late_threshold_minutes, basePolicy.late_threshold_minutes || 0))),
    late_deduction_method: 'auto_compute',
    undertime_deduction_method: 'auto_compute',
    payroll_config_id: config.id,
    payroll_config_name: config.config_name,
    payroll_config_scope_type: config.scope_type,
    habitual_tardiness_threshold: Math.max(1, Math.floor(toNumber(config.habitual_tardiness_threshold, 5))),
    habitual_tardiness_period: config.habitual_tardiness_period || 'MONTHLY',
    tardiness_alert_enabled: toBool(config.tardiness_alert_enabled, true),
  };
  merged.work_schedule = `${merged.work_start_time}-${merged.work_end_time}`;
  return merged;
}

async function resolveEmployeePayrollAttendancePolicy(pool, options = {}) {
  const employeeId = Number(options.employeeId || options.employee_id || 0);
  const basePolicy = options.basePolicy || {};
  if (!(employeeId > 0)) return applyConfigToPolicy(basePolicy, null);
  await ensurePayrollAttendanceConfigurationSchema(pool);
  const asOfDate = dateValue(options.asOfDate || options.as_of) || new Date().toISOString().slice(0, 10);

  const [employees] = await pool.execute(`
    SELECT e.id, e.department_id, e.employment_type, e.wage_type_id, wt.name AS wage_type
      FROM employees e
      LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
     WHERE e.id = ?
     LIMIT 1
  `, [employeeId]);
  if (!employees.length) return applyConfigToPolicy(basePolicy, null);
  const employee = employees[0];

  const [rows] = await pool.execute(`
    SELECT *
      FROM payroll_attendance_configurations
     WHERE is_active = 1
       AND effective_date <= ?
       AND (end_date IS NULL OR end_date >= ?)
       AND (
         scope_type = 'DEFAULT'
         OR (scope_type = 'EMPLOYEE' AND employee_id = ?)
         OR (scope_type = 'DEPARTMENT' AND department_id = ?)
         OR (scope_type = 'WAGE_TYPE' AND wage_type_id = ?)
         OR (scope_type = 'EMPLOYMENT_TYPE' AND LOWER(scope_value) = LOWER(?))
       )
  `, [
    asOfDate,
    asOfDate,
    employeeId,
    employee.department_id || 0,
    employee.wage_type_id || 0,
    employee.employment_type || '',
  ]);

  rows.sort((a, b) => {
    const rankDiff = scopeRank(b) - scopeRank(a);
    if (rankDiff) return rankDiff;
    const priorityDiff = Number(b.priority || 0) - Number(a.priority || 0);
    if (priorityDiff) return priorityDiff;
    return String(b.effective_date || '').localeCompare(String(a.effective_date || '')) || Number(b.id) - Number(a.id);
  });

  // Global attendance settings are the canonical fallback. DEFAULT rows are
  // retained for legacy/direct callers, but only employee or group scopes may
  // override a resolved global attendance policy.
  const hasGlobalAttendancePolicy = Object.keys(basePolicy).length > 0;
  const applicableRows = hasGlobalAttendancePolicy
    ? rows.filter(row => row.scope_type !== 'DEFAULT')
    : rows;
  return applyConfigToPolicy(basePolicy, applicableRows[0] || null);
}

async function listPayrollAttendanceConfigurations(pool) {
  await ensurePayrollAttendanceConfigurationSchema(pool);
  const [rows] = await pool.execute(`
    SELECT pac.*,
           e.employee_code,
           d.name AS department_name,
           wt.name AS wage_type_name
      FROM payroll_attendance_configurations pac
      LEFT JOIN employees e ON e.id = pac.employee_id
      LEFT JOIN departments d ON d.id = pac.department_id
      LEFT JOIN wage_types wt ON wt.id = pac.wage_type_id
     ORDER BY pac.is_active DESC, pac.scope_type, pac.priority DESC, pac.effective_date DESC, pac.id DESC
     LIMIT 500
  `);
  return rows;
}

async function savePayrollAttendanceConfiguration(pool, body, userId) {
  await ensurePayrollAttendanceConfigurationSchema(pool);
  const config = normalizeConfigInput(body);
  const referenceChecks = {
    EMPLOYEE: ['employees', 'id', config.employee_id],
    DEPARTMENT: ['departments', 'id', config.department_id],
    WAGE_TYPE: ['wage_types', 'id', config.wage_type_id],
  };
  const reference = referenceChecks[config.scope_type];
  if (reference) {
    const [rows] = await pool.execute(
      `SELECT ${reference[1]} FROM ${reference[0]} WHERE ${reference[1]} = ? LIMIT 1`,
      [reference[2]]
    );
    if (!rows.length) throw new Error(`Selected ${config.scope_type.toLowerCase().replace('_', ' ')} is invalid.`);
  }
  const values = [
    config.config_name,
    config.scope_type,
    config.employee_id,
    config.department_id,
    config.wage_type_id,
    config.scope_value,
    config.work_start_time,
    config.work_end_time,
    config.break_start_time,
    config.break_end_time,
    config.daily_hours,
    config.standard_work_hours,
    config.working_days_per_month,
    config.working_days_per_year,
    config.grace_period_minutes,
    config.late_threshold_minutes,
    config.habitual_tardiness_threshold,
    config.habitual_tardiness_period,
    config.tardiness_alert_enabled,
    config.priority,
    config.effective_date,
    config.end_date,
    config.is_active,
    config.notes,
    userId || null,
    userId || null,
  ];

  if (config.id) {
    await pool.execute(`
      UPDATE payroll_attendance_configurations
         SET config_name = ?, scope_type = ?, employee_id = ?, department_id = ?, wage_type_id = ?,
             scope_value = ?, work_start_time = ?, work_end_time = ?, break_start_time = ?, break_end_time = ?,
             daily_hours = ?, standard_work_hours = ?, working_days_per_month = ?, working_days_per_year = ?,
             grace_period_minutes = ?, late_threshold_minutes = ?, habitual_tardiness_threshold = ?,
             habitual_tardiness_period = ?, tardiness_alert_enabled = ?, priority = ?, effective_date = ?,
             end_date = ?, is_active = ?, notes = ?, updated_by = ?
       WHERE id = ?
    `, [...values.slice(0, -2), userId || null, config.id]);
    return config.id;
  }

  const [result] = await pool.execute(`
    INSERT INTO payroll_attendance_configurations
      (config_name, scope_type, employee_id, department_id, wage_type_id, scope_value,
       work_start_time, work_end_time, break_start_time, break_end_time,
       daily_hours, standard_work_hours, working_days_per_month, working_days_per_year,
       grace_period_minutes, late_threshold_minutes, habitual_tardiness_threshold,
       habitual_tardiness_period, tardiness_alert_enabled, priority, effective_date,
       end_date, is_active, notes, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, values);
  return result.insertId;
}

async function deactivatePayrollAttendanceConfiguration(pool, id, userId) {
  await ensurePayrollAttendanceConfigurationSchema(pool);
  const [result] = await pool.execute(
    'UPDATE payroll_attendance_configurations SET is_active = 0, updated_by = ? WHERE id = ?',
    [userId || null, Number(id)]
  );
  return result.affectedRows > 0;
}

module.exports = {
  ensurePayrollAttendanceConfigurationSchema,
  resolveEmployeePayrollAttendancePolicy,
  listPayrollAttendanceConfigurations,
  savePayrollAttendanceConfiguration,
  deactivatePayrollAttendanceConfiguration,
};
