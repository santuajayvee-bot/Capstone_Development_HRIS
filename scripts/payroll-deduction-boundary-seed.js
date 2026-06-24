const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const argon2 = require('argon2');
const pool = require('../config/db');
const { computeLateUndertimeDeductions } = require('../server/payroll-attendance-deductions');

const PERIOD = {
  start: '2026-06-22',
  end: '2026-06-26',
  payrollPeriod: '2026-06-W4',
  payrollFrequency: 'Weekly',
  workingDays: 5,
  standardHours: 8,
};

const NEW_TEST_MARK = 'DEDUCTION_BOUNDARY_TEST_20260624';
const OLD_TEST_MARKS = ['CONTROLLED_PAYROLL_TEST', 'MANUAL_DEDUCTION_TEST_20260624'];
const DEPARTMENT_NAME = 'TEST Deduction Boundary QA';
const OUTPUT_DIR = path.join(__dirname, '..', 'artifacts', 'payroll-deduction-boundary-test');

const PRESENT_EMPLOYEES = [
  { code: 'EMP-DB01', segment: 'Below floor', attendance: 'Present', target: 'below_floor' },
  { code: 'EMP-DB02', segment: 'Above floor', attendance: 'Present', target: 'above_floor' },
  { code: 'EMP-DB03', segment: 'Above floor', attendance: 'Present', target: 'above_floor_high' },
  { code: 'EMP-DB04', segment: 'Near ceiling', attendance: 'Present', target: 'near_ceiling' },
  { code: 'EMP-DB05', segment: 'Above ceiling', attendance: 'Present', target: 'above_ceiling' },
];

const TARDY_EMPLOYEES = [
  { code: 'EMP-DU01', segment: 'Below floor', attendance: 'Late only', target: 'below_floor', late: 30, undertime: 0 },
  { code: 'EMP-DU02', segment: 'Above floor', attendance: 'Late + UT', target: 'above_floor', late: 45, undertime: 30 },
  { code: 'EMP-DU03', segment: 'Above floor', attendance: 'Late + UT', target: 'above_floor_high', late: 60, undertime: 60 },
  { code: 'EMP-DU04', segment: 'Near ceiling', attendance: 'Late + UT', target: 'near_ceiling', late: 90, undertime: 45 },
  { code: 'EMP-DU05', segment: 'Above ceiling', attendance: 'Late + UT', target: 'above_ceiling', late: 120, undertime: 60 },
];

const NEW_TEST_CODES = [...PRESENT_EMPLOYEES, ...TARDY_EMPLOYEES].map(row => row.code);
const OLD_TEST_CODES = [
  'EMP-T01', 'EMP-T02', 'EMP-T03', 'EMP-T04', 'EMP-T05',
  'EMP-L01', 'EMP-L02', 'EMP-L03', 'EMP-L04', 'EMP-L05',
  'EMP-P01', 'EMP-P02', 'EMP-R01', 'EMP-R02',
  'EMP-MP01', 'EMP-MP02', 'EMP-MP03', 'EMP-MP04', 'EMP-MP05',
  'EMP-MU01', 'EMP-MU02', 'EMP-MU03', 'EMP-MU04', 'EMP-MU05',
];
const ALL_TEST_CODES = [...OLD_TEST_CODES, ...NEW_TEST_CODES];

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function addDays(dateText, days) {
  const [year, month, day] = String(dateText).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function addMinutesToClock(clock, minutes) {
  const [hour, minute] = clock.split(':').map(Number);
  const total = hour * 60 + minute + Number(minutes || 0);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}:00`;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function peso(value) {
  return `PHP ${money(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateKey(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function tableExists(connection, tableName) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function deleteIfExists(connection, sql, params, tableName) {
  if (!(await tableExists(connection, tableName))) return 0;
  const [result] = await connection.execute(sql, params);
  return result.affectedRows || 0;
}

async function cleanupPriorTestData(connection) {
  const placeholders = ALL_TEST_CODES.map(() => '?').join(',');
  const [employees] = await connection.execute(
    `SELECT id FROM employees WHERE employee_code IN (${placeholders})`,
    ALL_TEST_CODES
  );
  const employeeIds = employees.map(row => row.id);
  const cleanup = { employees: employeeIds.length };

  if (employeeIds.length) {
    const idSql = employeeIds.map(() => '?').join(',');
    cleanup.salary_deduction_rows = await deleteIfExists(connection, `
      DELETE scd FROM salary_calculation_deductions scd
      JOIN salary_calculations sc ON sc.id = scd.salary_calculation_id
      WHERE sc.employee_id IN (${idSql})
    `, employeeIds, 'salary_calculation_deductions');
    cleanup.employee_deduction_payments = await deleteIfExists(connection, `
      DELETE edp FROM employee_deduction_payments edp
      JOIN salary_calculations sc ON sc.id = edp.salary_calculation_id
      WHERE sc.employee_id IN (${idSql})
    `, employeeIds, 'employee_deduction_payments');
    cleanup.payslips = await deleteIfExists(connection, `DELETE FROM payslips WHERE employee_id IN (${idSql})`, employeeIds, 'payslips');
    cleanup.salary_calculations = await deleteIfExists(connection, `DELETE FROM salary_calculations WHERE employee_id IN (${idSql})`, employeeIds, 'salary_calculations');
    cleanup.attendance_summary = await deleteIfExists(connection, `DELETE FROM attendance_summary WHERE employee_id IN (${idSql})`, employeeIds, 'attendance_summary');
    cleanup.attendance_log = await deleteIfExists(connection, `DELETE FROM attendance_log WHERE employee_id IN (${idSql})`, employeeIds, 'attendance_log');
    cleanup.employee_wage_rates = await deleteIfExists(connection, `DELETE FROM employee_wage_rates WHERE employee_id IN (${idSql})`, employeeIds, 'employee_wage_rates');
    cleanup.production_outputs = await deleteIfExists(connection, `DELETE FROM payroll_production_outputs WHERE employee_id IN (${idSql})`, employeeIds, 'payroll_production_outputs');
    cleanup.delivery_trips = await deleteIfExists(connection, `DELETE FROM delivery_trips WHERE employee_id IN (${idSql})`, employeeIds, 'delivery_trips');
    cleanup.payroll_audit_trail = await deleteIfExists(connection, `DELETE FROM payroll_audit_trail WHERE employee_id IN (${idSql})`, employeeIds, 'payroll_audit_trail');
    const [archived] = await connection.execute(
      `UPDATE employees
          SET status = 'Inactive',
              position = CONCAT('Archived test fixture - ', COALESCE(position, ''))
        WHERE id IN (${idSql})`,
      employeeIds
    );
    cleanup.employee_rows_archived = archived.affectedRows || 0;
  }

  for (const mark of OLD_TEST_MARKS) {
    await deleteIfExists(connection, 'DELETE FROM payroll_runs WHERE source_summary LIKE ?', [`%${mark}%`], 'payroll_runs');
  }
  await deleteIfExists(connection, 'DELETE FROM payroll_runs WHERE source_summary LIKE ?', [`%${NEW_TEST_MARK}%`], 'payroll_runs');
  await deleteIfExists(connection, 'DELETE FROM logistics_locations WHERE description IN (?, ?, ?)', [...OLD_TEST_MARKS, NEW_TEST_MARK], 'logistics_locations');
  await deleteIfExists(connection, 'DELETE FROM truck_types WHERE description IN (?, ?, ?)', [...OLD_TEST_MARKS, NEW_TEST_MARK], 'truck_types');

  return cleanup;
}

async function ensureDepartment(connection) {
  const [rows] = await connection.execute('SELECT id FROM departments WHERE name = ? LIMIT 1', [DEPARTMENT_NAME]);
  if (rows.length) return rows[0].id;
  const [result] = await connection.execute(
    'INSERT INTO departments (name, is_active) VALUES (?, 1)',
    [DEPARTMENT_NAME]
  );
  return result.insertId;
}

async function dailyWageTypeId(connection) {
  const [rows] = await connection.execute(
    "SELECT id FROM wage_types WHERE LOWER(name) = 'daily' ORDER BY id LIMIT 1"
  );
  if (!rows.length) throw new Error('Daily wage type is not configured.');
  return rows[0].id;
}

async function nextEmployeeNumber(connection) {
  const [rows] = await connection.execute(
    'SELECT COALESCE(MAX(Employee_ID), 990000) + 1 AS next_number FROM employees'
  );
  return Number(rows[0]?.next_number || 990001);
}

async function activeGovernmentSettings(connection) {
  const [rows] = await connection.execute(`
    SELECT id, name, category, computation_type, rate_or_amount, employee_share_rate,
           minimum_salary_base, maximum_salary_ceiling, maximum_contribution_cap,
           apply_schedule, proration_mode, fixed_divisor, effective_date
      FROM payroll_deduction_settings
     WHERE is_active = 1
       AND category = 'Government'
       AND effective_date <= ?
     ORDER BY priority_order ASC, effective_date DESC, id DESC
  `, [PERIOD.end]);
  return rows;
}

function settingDivisor(setting) {
  const fixed = Number(setting?.fixed_divisor || 0);
  if (String(setting?.proration_mode || '') === 'Fixed Divisor' && fixed > 0) return fixed;
  if (String(setting?.apply_schedule || '') === 'Monthly') return 1;
  if (String(setting?.apply_schedule || '') === 'Semi-Monthly') return 2;
  return 4;
}

function boundaryProfile(settings) {
  const percentageSettings = settings.filter(row => String(row.computation_type || '') === 'Percentage');
  const floorValues = percentageSettings.map(row => Number(row.minimum_salary_base || 0)).filter(value => value > 0);
  const ceilingValues = percentageSettings.map(row => Number(row.maximum_salary_ceiling || 0)).filter(value => value > 0);
  const divisorValues = percentageSettings.map(settingDivisor).filter(value => value > 0);
  const divisor = divisorValues[0] || 4;
  const floor = floorValues.length ? Math.max(...floorValues) : 10000;
  const ceiling = ceilingValues.length ? Math.max(...ceilingValues) : 80000;
  const belowFloorWeekly = Math.max(500, floor * 0.6 / divisor);
  const aboveFloorWeekly = Math.max(belowFloorWeekly + 500, floor * 1.25 / divisor);
  const aboveFloorHighWeekly = Math.max(aboveFloorWeekly + 500, floor * 2 / divisor);
  const nearCeilingWeekly = Math.max(aboveFloorHighWeekly + 500, ceiling * 0.85 / divisor);
  const aboveCeilingWeekly = Math.max(nearCeilingWeekly + 500, ceiling * 1.25 / divisor);
  return {
    divisor,
    floor,
    ceiling,
    floor_source: floorValues.length ? 'active deduction settings' : 'fallback reference because active floor is zero/unset',
    ceiling_source: ceilingValues.length ? 'active deduction settings' : 'fallback reference because active ceiling is zero/unset',
    weeklyTargets: {
      below_floor: money(belowFloorWeekly),
      above_floor: money(aboveFloorWeekly),
      above_floor_high: money(aboveFloorHighWeekly),
      near_ceiling: money(nearCeilingWeekly),
      above_ceiling: money(aboveCeilingWeekly),
    },
  };
}

async function createEmployee(connection, { code, wageTypeId, departmentId, employeeNumber, dailyRate, segment, attendance }) {
  const passwordHash = await argon2.hash(crypto.randomBytes(32).toString('base64url'), {
    type: argon2.argon2id,
  });
  const [existingRows] = await connection.execute(
    'SELECT id FROM employees WHERE employee_code = ? LIMIT 1',
    [code]
  );
  if (existingRows.length) {
    await connection.execute(
      `UPDATE employees
          SET first_name = 'DEDUCTION TEST',
              middle_name = NULL,
              last_name = ?,
              email = ?,
              contact_number = '09999999999',
              department_id = ?,
              position = ?,
              employment_type = 'Full-time',
              wage_type_id = ?,
              date_hired = ?,
              status = 'Active',
              daily_rate = ?,
              hourly_rate = ?,
              Password_Hash = ?,
              Password_Changed_At = NOW(),
              Failed_Login_Attempts = 0,
              Locked_Until = NULL,
              force_password_change = 1
        WHERE id = ?`,
      [
        code,
        `${code.toLowerCase()}@deduction-boundary-test.local`,
        departmentId,
        `${segment} / ${attendance}`,
        wageTypeId,
        PERIOD.start,
        dailyRate,
        money(dailyRate / PERIOD.standardHours),
        passwordHash,
        existingRows[0].id,
      ]
    );
    return existingRows[0].id;
  }
  const [result] = await connection.execute(
    `INSERT INTO employees
       (employee_code, first_name, middle_name, last_name, email, contact_number,
        department_id, position, employment_type, wage_type_id, date_hired, status,
        daily_rate, hourly_rate, Employee_ID, Password_Hash, Password_Changed_At,
        Failed_Login_Attempts, force_password_change)
     VALUES (?, 'DEDUCTION TEST', NULL, ?, ?, '09999999999',
        ?, ?, 'Full-time', ?, ?, 'Active',
        ?, ?, ?, ?, NOW(), 0, 1)`,
    [
      code,
      code,
      `${code.toLowerCase()}@deduction-boundary-test.local`,
      departmentId,
      `${segment} / ${attendance}`,
      wageTypeId,
      PERIOD.start,
      dailyRate,
      money(dailyRate / PERIOD.standardHours),
      employeeNumber,
      passwordHash,
    ]
  );
  return result.insertId;
}

async function createWageRate(connection, employeeId, wageTypeId, dailyRate) {
  await connection.execute(
    `INSERT INTO employee_wage_rates
       (employee_id, wage_type_id, base_rate, monthly_salary, daily_rate, hourly_rate,
        overtime_rate, default_role, rate, effective_date, end_date, is_active, notes)
     VALUES (?, ?, ?, 0, ?, ?, ?, NULL, ?, ?, NULL, 1, ?)`,
    [
      employeeId,
      wageTypeId,
      dailyRate,
      dailyRate,
      money(dailyRate / PERIOD.standardHours),
      money(dailyRate / PERIOD.standardHours),
      dailyRate,
      PERIOD.start,
      NEW_TEST_MARK,
    ]
  );
}

async function seedAttendance(connection, employeeId, { late = 0, undertime = 0 }) {
  const attendanceRows = [];
  for (let index = 0; index < PERIOD.workingDays; index += 1) {
    const attendanceDate = addDays(PERIOD.start, index);
    const dayLate = index === 0 ? Number(late || 0) : 0;
    const dayUndertime = index === 0 ? Number(undertime || 0) : 0;
    const timeIn = addMinutesToClock('08:00', dayLate);
    const timeOut = addMinutesToClock('17:00', -dayUndertime);
    const attendanceStatus = dayLate > 0 ? 'Late' : dayUndertime > 0 ? 'Half Day' : 'Present';
    const [logResult] = await connection.execute(
      `INSERT INTO attendance_log
         (employee_id, date, time_in, time_out, overtime_hours, late_minutes,
          undertime_minutes, overtime_minutes, absences, status, verification_status,
          source, first_scan_at, last_scan_at, integrity_hash)
       VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0, ?, 'PAYROLL_READY',
          'HR_MANUAL_ADJUSTMENT', ?, ?, SHA2(?, 256))`,
      [
        employeeId,
        attendanceDate,
        timeIn,
        timeOut,
        dayLate,
        dayUndertime,
        attendanceStatus,
        `${attendanceDate} ${timeIn}`,
        `${attendanceDate} ${timeOut}`,
        `${NEW_TEST_MARK}:LOG:${employeeId}:${attendanceDate}`,
      ]
    );
    await connection.execute(
      `INSERT INTO attendance_summary
         (employee_id, attendance_date, attendance_id, regular_minutes, overtime_minutes,
          late_minutes, undertime_minutes, attendance_status, verification_status,
          payroll_eligible, payroll_run_id, paid_at, integrity_hash, policy_snapshot_json)
       VALUES (?, ?, ?, 480, 0, ?, ?, ?, 'PAYROLL_READY',
          1, NULL, NULL, SHA2(?, 256), ?)`,
      [
        employeeId,
        attendanceDate,
        logResult.insertId,
        dayLate,
        dayUndertime,
        attendanceStatus,
        `${NEW_TEST_MARK}:SUMMARY:${employeeId}:${attendanceDate}`,
        JSON.stringify({ test: NEW_TEST_MARK, source: 'deduction boundary seed' }),
      ]
    );
    attendanceRows.push({
      time_in: timeIn,
      late_minutes: dayLate,
      undertime_minutes: dayUndertime,
      overtime_minutes: 0,
    });
  }
  return attendanceRows;
}

function attendanceDeductionPreview(attendanceRows, dailyRate) {
  return computeLateUndertimeDeductions({
    attendanceRows,
    wageType: 'Daily',
    rate: dailyRate,
    policy: {
      standard_hours_per_day: PERIOD.standardHours,
      grace_period_minutes: 15,
      late_apply_grace_period: true,
      count_late_for_payroll: true,
      count_undertime_for_payroll: true,
      late_deduction_method: 'auto_compute',
      undertime_deduction_method: 'auto_compute',
      work_start_time: '08:00:00',
    },
  });
}

function expectedPercentageDeduction(setting, weeklyGross, divisor) {
  const floor = Number(setting.minimum_salary_base || 0);
  const ceiling = Number(setting.maximum_salary_ceiling || 0);
  const cap = Number(setting.maximum_contribution_cap || 0);
  const rate = Number(setting.employee_share_rate || setting.rate_or_amount || 0);
  let monthlyBase = weeklyGross * divisor;
  if (floor > 0) monthlyBase = Math.max(monthlyBase, floor);
  if (ceiling > 0) monthlyBase = Math.min(monthlyBase, ceiling);
  const monthlyAmount = monthlyBase * (rate / 100);
  return {
    monthlyBase: money(monthlyBase),
    employeeShareRate: rate,
    monthlyAmountBeforeCap: money(monthlyAmount),
    payrollDeduction: money((cap > 0 ? Math.min(monthlyAmount, cap) : monthlyAmount) / divisor),
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const connection = await pool.getConnection();
  const evidence = {
    generated_at: new Date().toISOString(),
    test_mark: NEW_TEST_MARK,
    department: DEPARTMENT_NAME,
    period: PERIOD,
    cleanup: {},
    deduction_settings_snapshot: [],
    boundary_profile: {},
    employees: [],
    instructions: [
      'Go to Payroll Run.',
      `Use Start Date ${PERIOD.start} and End Date ${PERIOD.end}.`,
      `Filter Department to ${DEPARTMENT_NAME}.`,
      'Set Payroll Frequency to Weekly, or the frequency you want to test.',
      'Generate payroll manually from the UI. This seed creates attendance only; no payroll run, salary calculation, or payslip is created here.',
    ],
  };

  try {
    await connection.beginTransaction();
    evidence.cleanup = await cleanupPriorTestData(connection);
    const departmentId = await ensureDepartment(connection);
    const wageTypeId = await dailyWageTypeId(connection);
    const settings = await activeGovernmentSettings(connection);
    const profile = boundaryProfile(settings);
    evidence.deduction_settings_snapshot = settings.map(row => ({
      id: row.id,
      name: row.name,
      type: row.computation_type,
      rate: Number(row.employee_share_rate || row.rate_or_amount || 0),
      floor: Number(row.minimum_salary_base || 0),
      ceiling: Number(row.maximum_salary_ceiling || 0),
      cap: Number(row.maximum_contribution_cap || 0),
      schedule: row.apply_schedule,
      proration_mode: row.proration_mode,
      fixed_divisor: row.fixed_divisor == null ? null : Number(row.fixed_divisor),
      effective_date: dateKey(row.effective_date),
    }));
    evidence.boundary_profile = profile;

    let employeeNumber = await nextEmployeeNumber(connection);
    const rowsToSeed = [...PRESENT_EMPLOYEES, ...TARDY_EMPLOYEES];
    for (const row of rowsToSeed) {
      const weeklyGross = profile.weeklyTargets[row.target];
      const dailyRate = money(weeklyGross / PERIOD.workingDays);
      const employeeId = await createEmployee(connection, {
        ...row,
        wageTypeId,
        departmentId,
        employeeNumber: employeeNumber++,
        dailyRate,
      });
      await createWageRate(connection, employeeId, wageTypeId, dailyRate);
      const attendanceRows = await seedAttendance(connection, employeeId, row);
      const attendancePreview = attendanceDeductionPreview(attendanceRows, dailyRate);
      const projectedMonthlyBase = money(weeklyGross * profile.divisor);
      const percentagePreviews = settings
        .filter(setting => String(setting.computation_type || '') === 'Percentage')
        .map(setting => ({
          name: setting.name,
          ...expectedPercentageDeduction(setting, weeklyGross, settingDivisor(setting)),
        }));
      evidence.employees.push({
        employee_code: row.code,
        segment: row.segment,
        attendance_case: row.attendance,
        daily_rate: dailyRate,
        weekly_gross_before_deductions: money(weeklyGross),
        projected_monthly_base_at_profile_divisor: projectedMonthlyBase,
        late_minutes: Number(row.late || 0),
        undertime_minutes: Number(row.undertime || 0),
        expected_attendance_deduction_preview: attendancePreview.tardy_ut_deduction,
        percentage_deduction_preview_from_current_config: percentagePreviews,
        payroll_status_before_processing: 'Source Ready',
      });
    }

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }

  const jsonPath = path.join(OUTPUT_DIR, 'deduction-boundary-test-checklist.json');
  const csvPath = path.join(OUTPUT_DIR, 'deduction-boundary-test-employees.csv');
  fs.writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  const headers = [
    'Employee Code',
    'Segment',
    'Attendance Case',
    'Daily Rate',
    'Weekly Gross Before Deductions',
    'Projected Monthly Base',
    'Late Minutes',
    'Undertime Minutes',
    'Expected Attendance Deduction Preview',
    'Status Before Processing',
  ];
  const rows = evidence.employees.map(row => [
    row.employee_code,
    row.segment,
    row.attendance_case,
    row.daily_rate,
    row.weekly_gross_before_deductions,
    row.projected_monthly_base_at_profile_divisor,
    row.late_minutes,
    row.undertime_minutes,
    row.expected_attendance_deduction_preview,
    row.payroll_status_before_processing,
  ]);
  fs.writeFileSync(csvPath, [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\n'));

  console.log('Deduction boundary test data is ready.');
  console.log(`Department: ${DEPARTMENT_NAME}`);
  console.log(`Payroll period: ${PERIOD.start} to ${PERIOD.end}`);
  console.log('No payroll calculations, payroll runs, or payslips were created.');
  console.log(`Checklist: ${jsonPath}`);
  console.log(`CSV: ${csvPath}`);
  console.table(evidence.employees.map(row => ({
    employee: row.employee_code,
    segment: row.segment,
    attendance: row.attendance_case,
    weekly_gross: peso(row.weekly_gross_before_deductions),
    monthly_base: peso(row.projected_monthly_base_at_profile_divisor),
    late: row.late_minutes,
    undertime: row.undertime_minutes,
    attendance_deduction_preview: peso(row.expected_attendance_deduction_preview),
  })));
}

main().catch(error => {
  console.error('Deduction boundary seed failed:', error);
  process.exit(1);
});
