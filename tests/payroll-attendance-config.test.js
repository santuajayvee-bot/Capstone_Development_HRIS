const assert = require('assert');
const pool = require('../config/db');
const {
  resolveEmployeePayrollAttendancePolicy,
  listPayrollAttendanceConfigurations,
  savePayrollAttendanceConfiguration,
  deactivatePayrollAttendanceConfiguration,
} = require('../server/employee-payroll-policy');

const createdIds = [];
const marker = `POLICY-TEST-${Date.now()}`;

function check(message, condition) {
  assert.ok(condition, message);
  console.log(`PASS ${message}`);
}

async function save(body, userId) {
  const id = await savePayrollAttendanceConfiguration(pool, body, userId);
  if (!createdIds.includes(Number(id))) createdIds.push(Number(id));
  return Number(id);
}

async function run() {
  const [[dates]] = await pool.execute(
    "SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today, DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 DAY), '%Y-%m-%d') AS tomorrow"
  );
  const [employees] = await pool.execute(`
    SELECT e.id, e.department_id, e.wage_type_id, e.employment_type
      FROM employees e
     WHERE COALESCE(e.status, 'Active') = 'Active'
       AND e.department_id IS NOT NULL
       AND e.wage_type_id IS NOT NULL
       AND COALESCE(e.employment_type, '') <> ''
     ORDER BY e.id
     LIMIT 1
  `);
  const [[hrUser]] = await pool.execute(`
    SELECT u.id
      FROM users u
      JOIN roles r ON r.id = u.role_id
     WHERE r.name IN ('hr_manager', 'hr_admin')
     ORDER BY u.id
     LIMIT 1
  `);
  check('test employee and HR owner exist', employees.length === 1 && hrUser?.id);
  const employee = employees[0];

  const common = {
    work_start_time: '08:00',
    work_end_time: '17:00',
    break_start_time: '12:00',
    break_end_time: '13:00',
    daily_hours: 8,
    working_days_per_month: 21.75,
    working_days_per_year: 261,
    grace_period_minutes: 10,
    habitual_tardiness_threshold: 5,
    tardiness_alert_enabled: true,
    priority: 0,
    effective_date: dates.today,
    end_date: dates.tomorrow,
    is_active: true,
    notes: marker,
  };

  const defaultId = await save({
    ...common,
    config_name: `${marker} Default`,
    scope_type: 'DEFAULT',
    work_start_time: '09:00',
    priority: 1000,
  }, hrUser.id);
  const employmentId = await save({
    ...common,
    config_name: `${marker} Employment`,
    scope_type: 'EMPLOYMENT_TYPE',
    scope_value: employee.employment_type,
    work_start_time: '08:45',
  }, hrUser.id);
  const wageId = await save({
    ...common,
    config_name: `${marker} Wage`,
    scope_type: 'WAGE_TYPE',
    wage_type_id: employee.wage_type_id,
    work_start_time: '08:30',
  }, hrUser.id);
  const departmentId = await save({
    ...common,
    config_name: `${marker} Department`,
    scope_type: 'DEPARTMENT',
    department_id: employee.department_id,
    work_start_time: '08:15',
  }, hrUser.id);
  const employeeId = await save({
    ...common,
    config_name: `${marker} Employee`,
    scope_type: 'EMPLOYEE',
    employee_id: employee.id,
    work_start_time: '07:45',
    work_end_time: '16:45',
    break_start_time: '11:45',
    break_end_time: '12:30',
    daily_hours: 7.5,
    working_days_per_month: 22,
    working_days_per_year: 264,
    grace_period_minutes: 7,
    habitual_tardiness_threshold: 3,
    tardiness_alert_enabled: false,
    notes: `${marker} employee note`,
  }, hrUser.id);

  let policy = await resolveEmployeePayrollAttendancePolicy(pool, {
    employeeId: employee.id,
    asOfDate: dates.today,
    basePolicy: {},
  });
  check('employee scope overrides every group and high-priority default', policy.payroll_config_id === employeeId);
  check('schedule and break fields apply', policy.work_start_time === '07:45' && policy.work_end_time === '16:45'
    && policy.break_start_time === '11:45' && policy.break_end_time === '12:30');
  check('daily hours and workday factors apply', policy.daily_hours === 7.5 && policy.working_days_per_month === 22
    && policy.working_days_per_year === 264);
  check('grace and monthly tardiness settings apply', policy.grace_period_minutes === 7
    && policy.habitual_tardiness_threshold === 3 && policy.habitual_tardiness_period === 'MONTHLY'
    && policy.tardiness_alert_enabled === false);

  const inactiveId = await save({
    ...common,
    config_name: `${marker} Inactive Employee`,
    scope_type: 'EMPLOYEE',
    employee_id: employee.id,
    work_start_time: '06:00',
    priority: 1000,
    is_active: false,
  }, hrUser.id);
  policy = await resolveEmployeePayrollAttendancePolicy(pool, {
    employeeId: employee.id,
    asOfDate: dates.today,
    basePolicy: {},
  });
  check('inactive configuration is ignored', policy.payroll_config_id === employeeId && policy.payroll_config_id !== inactiveId);

  const priorityId = await save({
    ...common,
    config_name: `${marker} Employee Priority`,
    scope_type: 'EMPLOYEE',
    employee_id: employee.id,
    work_start_time: '07:30',
    priority: 9,
  }, hrUser.id);
  policy = await resolveEmployeePayrollAttendancePolicy(pool, {
    employeeId: employee.id,
    asOfDate: dates.today,
    basePolicy: {},
  });
  check('priority selects among configurations with the same scope', policy.payroll_config_id === priorityId);

  await save({
    ...common,
    id: priorityId,
    config_name: `${marker} Employee Priority Updated`,
    scope_type: 'EMPLOYEE',
    employee_id: employee.id,
    work_start_time: '07:25',
    priority: 9,
  }, hrUser.id);
  policy = await resolveEmployeePayrollAttendancePolicy(pool, {
    employeeId: employee.id,
    asOfDate: dates.today,
    basePolicy: {},
  });
  check('editing updates the same configuration', policy.payroll_config_id === priorityId
    && policy.payroll_config_name.endsWith('Updated') && policy.work_start_time === '07:25');

  const rows = await listPayrollAttendanceConfigurations(pool);
  const savedRow = rows.find(row => Number(row.id) === employeeId);
  check('configuration name, status, dates, and notes are persisted', savedRow
    && Number(savedRow.is_active) === 1
    && String(savedRow.notes).includes('employee note')
    && String(savedRow.effective_date)
    && String(savedRow.end_date));

  await deactivatePayrollAttendanceConfiguration(pool, priorityId, hrUser.id);
  await deactivatePayrollAttendanceConfiguration(pool, employeeId, hrUser.id);
  policy = await resolveEmployeePayrollAttendancePolicy(pool, {
    employeeId: employee.id,
    asOfDate: dates.today,
    basePolicy: {},
  });
  check('department scope follows employee scope', policy.payroll_config_id === departmentId);

  await deactivatePayrollAttendanceConfiguration(pool, departmentId, hrUser.id);
  policy = await resolveEmployeePayrollAttendancePolicy(pool, {
    employeeId: employee.id,
    asOfDate: dates.today,
    basePolicy: {},
  });
  check('wage type scope follows department scope', policy.payroll_config_id === wageId);

  await deactivatePayrollAttendanceConfiguration(pool, wageId, hrUser.id);
  policy = await resolveEmployeePayrollAttendancePolicy(pool, {
    employeeId: employee.id,
    asOfDate: dates.today,
    basePolicy: {},
  });
  check('employment type scope follows wage type scope', policy.payroll_config_id === employmentId);

  await deactivatePayrollAttendanceConfiguration(pool, employmentId, hrUser.id);
  policy = await resolveEmployeePayrollAttendancePolicy(pool, {
    employeeId: employee.id,
    asOfDate: dates.today,
    basePolicy: {
      work_start_time: '08:00',
      work_end_time: '17:00',
      grace_period_minutes: 15,
    },
  });
  check('global attendance policy supersedes legacy default configuration', !policy.payroll_config_id
    && policy.work_start_time === '08:00' && policy.grace_period_minutes === 15);

  policy = await resolveEmployeePayrollAttendancePolicy(pool, {
    employeeId: employee.id,
    asOfDate: dates.today,
    basePolicy: {},
  });
  check('default fallback applies last', policy.payroll_config_id === defaultId);

  policy = await resolveEmployeePayrollAttendancePolicy(pool, {
    employeeId: employee.id,
    asOfDate: dates.tomorrow,
    basePolicy: {},
  });
  check('end date remains inclusive', policy.payroll_config_id === defaultId);

  await assert.rejects(
    () => savePayrollAttendanceConfiguration(pool, {
      ...common,
      config_name: `${marker} Bad Dates`,
      scope_type: 'DEFAULT',
      effective_date: dates.tomorrow,
      end_date: dates.today,
    }, hrUser.id),
    /End date cannot be earlier/
  );
  console.log('PASS invalid date range is rejected');

  await assert.rejects(
    () => savePayrollAttendanceConfiguration(pool, {
      ...common,
      config_name: `${marker} Bad Employee`,
      scope_type: 'EMPLOYEE',
      employee_id: 999999999,
    }, hrUser.id),
    /invalid/
  );
  console.log('PASS invalid scope reference is rejected');
}

async function cleanup() {
  if (createdIds.length) {
    await pool.execute(
      `DELETE FROM payroll_attendance_configurations WHERE id IN (${createdIds.map(() => '?').join(', ')})`,
      createdIds
    );
  }
  await pool.end();
}

run()
  .then(() => console.log('Payroll attendance configuration integration tests completed.'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(cleanup);
