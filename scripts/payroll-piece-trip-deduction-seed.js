const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const argon2 = require('argon2');
const pool = require('../config/db');

const TEST_MARK = 'PIECE_TRIP_DEDUCTION_TEST_20260624';
const DEPARTMENT_NAME = 'TEST Piece Trip Deduction QA';
const OUTPUT_DIR = path.join(__dirname, '..', 'artifacts', 'payroll-piece-trip-deduction-test');

const PERIOD = {
  start: '2026-06-29',
  end: '2026-06-30',
  payrollPeriod: '2026-06-W5',
  payrollFrequency: 'Weekly',
  weekNumber: 5,
};

const GROSS_TARGETS = [
  { suffix: '01', segment: 'Below floor', weeklyGross: 1500 },
  { suffix: '02', segment: 'Above floor', weeklyGross: 3125 },
  { suffix: '03', segment: 'Above floor high', weeklyGross: 5000 },
  { suffix: '04', segment: 'Near ceiling', weeklyGross: 17000 },
  { suffix: '05', segment: 'Above ceiling', weeklyGross: 25000 },
];

const PIECE_EMPLOYEES = GROSS_TARGETS.map(row => ({
  ...row,
  code: `EMP-PP${row.suffix}`,
  partnerCode: `EMP-PF${row.suffix}`,
  payType: 'Per-Piece',
}));

const PIECE_PARTNERS = PIECE_EMPLOYEES.map(row => ({
  ...row,
  code: row.partnerCode,
  payType: 'Per-Piece',
  partnerRole: 'Fixer',
}));

const TRIP_EMPLOYEES = GROSS_TARGETS.map(row => ({
  ...row,
  code: `EMP-PT${row.suffix}`,
  payType: 'Per-Trip',
}));

const TEST_CODES = [...PIECE_EMPLOYEES, ...PIECE_PARTNERS, ...TRIP_EMPLOYEES].map(row => row.code);

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function peso(value) {
  return `PHP ${money(value).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
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

async function ensureDepartment(connection) {
  const [rows] = await connection.execute('SELECT id FROM departments WHERE name = ? LIMIT 1', [DEPARTMENT_NAME]);
  if (rows.length) return rows[0].id;
  const [result] = await connection.execute('INSERT INTO departments (name, is_active) VALUES (?, 1)', [DEPARTMENT_NAME]);
  return result.insertId;
}

async function wageTypeId(connection, names) {
  const placeholders = names.map(() => '?').join(',');
  const [rows] = await connection.execute(
    `SELECT id, name FROM wage_types WHERE LOWER(name) IN (${placeholders}) ORDER BY id LIMIT 1`,
    names.map(name => name.toLowerCase())
  );
  if (!rows.length) throw new Error(`Missing wage type: ${names.join(' / ')}`);
  return rows[0].id;
}

async function nextEmployeeNumber(connection) {
  const [rows] = await connection.execute(
    'SELECT COALESCE(MAX(Employee_ID), 990000) + 1 AS next_number FROM employees'
  );
  return Number(rows[0]?.next_number || 990001);
}

async function cleanupTestData(connection) {
  const placeholders = TEST_CODES.map(() => '?').join(',');
  const [employees] = await connection.execute(
    `SELECT id FROM employees WHERE employee_code IN (${placeholders})`,
    TEST_CODES
  );
  const employeeIds = employees.map(row => row.id);
  const cleanup = { employees: employeeIds.length };
  if (!employeeIds.length) return cleanup;

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
  cleanup.production_pairs = await deleteIfExists(connection, `
    DELETE FROM payroll_production_pairs
     WHERE worker1_employee_id IN (${idSql}) OR worker2_employee_id IN (${idSql})
  `, [...employeeIds, ...employeeIds], 'payroll_production_pairs');
  cleanup.production_outputs = await deleteIfExists(connection, `DELETE FROM payroll_production_outputs WHERE employee_id IN (${idSql})`, employeeIds, 'payroll_production_outputs');
  cleanup.delivery_trips = await deleteIfExists(connection, `DELETE FROM delivery_trips WHERE employee_id IN (${idSql})`, employeeIds, 'delivery_trips');
  cleanup.employee_wage_rates = await deleteIfExists(connection, `DELETE FROM employee_wage_rates WHERE employee_id IN (${idSql})`, employeeIds, 'employee_wage_rates');
  cleanup.payroll_audit_trail = await deleteIfExists(connection, `DELETE FROM payroll_audit_trail WHERE employee_id IN (${idSql})`, employeeIds, 'payroll_audit_trail');
  cleanup.test_trucks = await deleteIfExists(connection, 'DELETE FROM truck_types WHERE description = ?', [TEST_MARK], 'truck_types');
  cleanup.test_locations = await deleteIfExists(connection, 'DELETE FROM logistics_locations WHERE description = ?', [TEST_MARK], 'logistics_locations');
  const [archived] = await connection.execute(
    `UPDATE employees
        SET status = 'Inactive',
            position = CONCAT('Archived test fixture - ', COALESCE(position, ''))
      WHERE id IN (${idSql})`,
    employeeIds
  );
  cleanup.employee_rows_archived = archived.affectedRows || 0;
  return cleanup;
}

async function createEmployee(connection, { code, payType, wageTypeId, departmentId, employeeNumber, productionRole }) {
  const passwordHash = await argon2.hash(crypto.randomBytes(32).toString('base64url'), {
    type: argon2.argon2id,
  });
  const position = productionRole
    ? `${productionRole} ${payType} deduction boundary`
    : `${payType} deduction boundary`;
  const [existing] = await connection.execute('SELECT id FROM employees WHERE employee_code = ? LIMIT 1', [code]);
  if (existing.length) {
    await connection.execute(
      `UPDATE employees
          SET first_name = 'PIECE TRIP TEST',
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
              daily_rate = 0,
              hourly_rate = 0,
              Password_Hash = ?,
              Password_Changed_At = NOW(),
              Failed_Login_Attempts = 0,
              Locked_Until = NULL,
              force_password_change = 1
        WHERE id = ?`,
      [
        code,
        `${code.toLowerCase()}@piece-trip-deduction-test.local`,
        departmentId,
        position,
        wageTypeId,
        PERIOD.start,
        passwordHash,
        existing[0].id,
      ]
    );
    return existing[0].id;
  }
  const [result] = await connection.execute(
    `INSERT INTO employees
       (employee_code, first_name, middle_name, last_name, email, contact_number,
        department_id, position, employment_type, wage_type_id, date_hired, status,
        daily_rate, hourly_rate, Employee_ID, Password_Hash, Password_Changed_At,
        Failed_Login_Attempts, force_password_change)
     VALUES (?, 'PIECE TRIP TEST', NULL, ?, ?, '09999999999',
        ?, ?, 'Full-time', ?, ?, 'Active',
        0, 0, ?, ?, NOW(), 0, 1)`,
    [
      code,
      code,
      `${code.toLowerCase()}@piece-trip-deduction-test.local`,
      departmentId,
      position,
      wageTypeId,
      PERIOD.start,
      employeeNumber,
      passwordHash,
    ]
  );
  return result.insertId;
}

async function createWageRate(connection, employeeId, wageTypeId, role) {
  await connection.execute(
    `INSERT INTO employee_wage_rates
       (employee_id, wage_type_id, base_rate, monthly_salary, daily_rate, hourly_rate,
        overtime_rate, default_role, rate, effective_date, end_date, is_active, notes)
     VALUES (?, ?, 0, 0, 0, 0, 0, ?, 0, ?, NULL, 1, ?)`,
    [employeeId, wageTypeId, role, PERIOD.start, TEST_MARK]
  );
}

async function createPiecePairOutput(connection, sewerId, fixerId, sewerGrossPay) {
  const quantity = 1000;
  const worker1Share = 55;
  const worker2Share = 45;
  const productionValue = money(sewerGrossPay / (worker1Share / 100));
  const pieceRate = money(productionValue / quantity);
  const fixerGrossPay = money(productionValue * (worker2Share / 100));
  const [result] = await connection.execute(
    `INSERT INTO payroll_production_pairs
       (production_date, payroll_period, worker1_employee_id, worker2_employee_id,
        pairing_type, product_type, product_category, sew_type_code, size_range,
        quantity_produced, piece_rate, production_value, worker1_share, worker2_share,
        worker1_earnings, worker2_earnings, rule_snapshot, status, payroll_run_id,
        approved_by, approved_at, paid_at, created_by)
     VALUES (?, ?, ?, ?, 'Standard Sewer-Fixer', 'Boundary Sew', 'TEST',
        'BOUNDARY', 'TEST', ?, ?, ?, ?, ?, ?, ?, ?, 'Payroll Ready', NULL,
        NULL, NOW(), NULL, NULL)`,
    [
      PERIOD.start,
      PERIOD.payrollPeriod,
      sewerId,
      fixerId,
      quantity,
      pieceRate,
      productionValue,
      worker1Share,
      worker2Share,
      sewerGrossPay,
      fixerGrossPay,
      JSON.stringify({
        test_mark: TEST_MARK,
        rule: 'Standard Sewer-Fixer',
        worker1_role: 'Sewer',
        worker2_role: 'Fixer',
        worker1_share: worker1Share,
        worker2_share: worker2Share,
      }),
    ]
  );
  return {
    id: result.insertId,
    quantity,
    pieceRate,
    productionValue,
    worker1Share,
    worker2Share,
    sewerGrossPay,
    fixerGrossPay,
  };
}

async function ensureTruckAndLocation(connection) {
  await connection.execute(
    `INSERT INTO truck_types (name, description, is_active)
     VALUES (?, ?, 1)
     ON DUPLICATE KEY UPDATE description = VALUES(description), is_active = 1`,
    ['TEST Deduction Boundary Truck', TEST_MARK]
  );
  await connection.execute(
    `INSERT INTO logistics_locations (location_category, name, description, is_active)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE description = VALUES(description), is_active = 1`,
    ['Province', 'TEST Deduction Boundary Route', TEST_MARK]
  );
  const [truckRows] = await connection.execute('SELECT id FROM truck_types WHERE name = ? LIMIT 1', ['TEST Deduction Boundary Truck']);
  const [locationRows] = await connection.execute(
    'SELECT id FROM logistics_locations WHERE location_category = ? AND name = ? LIMIT 1',
    ['Province', 'TEST Deduction Boundary Route']
  );
  return { truckId: truckRows[0].id, locationId: locationRows[0].id };
}

async function createTripOutput(connection, employeeId, truckId, locationId, grossPay) {
  const trips = 5;
  const baseRate = money(grossPay / trips);
  const [result] = await connection.execute(
    `INSERT INTO delivery_trips
       (employee_id, truck_type_id, location_id, logistics_rate_id, trip_date, trip_type,
        role, plate_number, output_quantity, base_rate, additional_rate, multiplier,
        total_trip_pay, special_rule_description, status, payroll_run_id, approved_by,
        approved_at, paid_at, submitted_by, submitted_at, created_by, updated_by)
     VALUES (?, ?, ?, NULL, ?, 'Regular', 'Driver', ?, ?, ?, 0, 1,
        ?, ?, 'Payroll Ready', NULL, NULL, NOW(), NULL, NULL, NOW(), NULL, NULL)`,
    [
      employeeId,
      truckId,
      locationId,
      PERIOD.start,
      `TEST-${employeeId}`,
      trips,
      baseRate,
      grossPay,
      TEST_MARK,
    ]
  );
  return { id: result.insertId, trips, baseRate };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const connection = await pool.getConnection();
  const evidence = {
    generated_at: new Date().toISOString(),
    test_mark: TEST_MARK,
    department: DEPARTMENT_NAME,
    period: PERIOD,
    cleanup: {},
    employees: [],
    expected_fixed_divisor_behavior: [
      'If Fixed Divisor is 2, statutory deductions apply only on weekly runs W1 and W2; W3-W5 should be zero for that setting.',
      'If Fixed Divisor is 3, statutory deductions apply only on W1-W3; W4-W5 should be zero for that setting.',
      'If Fixed Divisor is 5, statutory deductions apply on W1-W5 and each amount is the monthly amount divided by 5.',
      'If Calendar-Based Payroll Date Range is selected in a 5-week month, statutory deductions apply on each weekly run and are divided by 5.',
    ],
    instructions: [
      'Go to Payroll Run.',
      `Use Start Date ${PERIOD.start} and End Date ${PERIOD.end}.`,
      `Filter Department to ${DEPARTMENT_NAME}.`,
      'Set Payroll Frequency to Weekly.',
      'Preview Payroll first. In W5, Fixed Divisor 2/3/4 should skip statutory deductions; Fixed Divisor 5 or Calendar-Based should show deductions.',
    ],
  };

  try {
    await connection.beginTransaction();
    evidence.cleanup = await cleanupTestData(connection);
    const departmentId = await ensureDepartment(connection);
    const pieceWageTypeId = await wageTypeId(connection, ['Per-Piece', 'Piece Rate']);
    const tripWageTypeId = await wageTypeId(connection, ['Per-Trip', 'Trip-Based', 'Logistics']);
    const { truckId, locationId } = await ensureTruckAndLocation(connection);
    let employeeNumber = await nextEmployeeNumber(connection);

    for (const row of PIECE_EMPLOYEES) {
      const employeeId = await createEmployee(connection, {
        ...row,
        wageTypeId: pieceWageTypeId,
        departmentId,
        employeeNumber: employeeNumber++,
        productionRole: 'Sewer',
      });
      const partnerId = await createEmployee(connection, {
        ...row,
        code: row.partnerCode,
        wageTypeId: pieceWageTypeId,
        departmentId,
        employeeNumber: employeeNumber++,
        productionRole: 'Fixer',
      });
      await createWageRate(connection, employeeId, pieceWageTypeId, 'Sewer');
      await createWageRate(connection, partnerId, pieceWageTypeId, 'Fixer');
      const source = await createPiecePairOutput(connection, employeeId, partnerId, row.weeklyGross);
      evidence.employees.push({
        employee_code: row.code,
        pay_type: row.payType,
        role: 'Sewer',
        segment: row.segment,
        partner_employee_code: row.partnerCode,
        source_table: 'payroll_production_pairs',
        source_record_id: source.id,
        source_quantity: source.quantity,
        source_rate: source.pieceRate,
        source_status: 'Payroll Ready',
        split: `${source.worker1Share}/${source.worker2Share}`,
        weekly_gross_before_deductions: money(source.sewerGrossPay),
        projected_monthly_base_divisor_2: money(row.weeklyGross * 2),
        projected_monthly_base_divisor_3: money(row.weeklyGross * 3),
        projected_monthly_base_divisor_5: money(row.weeklyGross * 5),
      });
      evidence.employees.push({
        employee_code: row.partnerCode,
        pay_type: row.payType,
        role: 'Fixer',
        segment: `${row.segment} partner`,
        partner_employee_code: row.code,
        source_table: 'payroll_production_pairs',
        source_record_id: source.id,
        source_quantity: source.quantity,
        source_rate: source.pieceRate,
        source_status: 'Payroll Ready',
        split: `${source.worker2Share}/${source.worker1Share}`,
        weekly_gross_before_deductions: money(source.fixerGrossPay),
        projected_monthly_base_divisor_2: money(source.fixerGrossPay * 2),
        projected_monthly_base_divisor_3: money(source.fixerGrossPay * 3),
        projected_monthly_base_divisor_5: money(source.fixerGrossPay * 5),
      });
    }

    for (const row of TRIP_EMPLOYEES) {
      const employeeId = await createEmployee(connection, {
        ...row,
        wageTypeId: tripWageTypeId,
        departmentId,
        employeeNumber: employeeNumber++,
        productionRole: 'Driver',
      });
      await createWageRate(connection, employeeId, tripWageTypeId, 'Driver');
      const source = await createTripOutput(connection, employeeId, truckId, locationId, row.weeklyGross);
      evidence.employees.push({
        employee_code: row.code,
        pay_type: row.payType,
        role: 'Driver',
        segment: row.segment,
        partner_employee_code: '',
        source_table: 'delivery_trips',
        source_record_id: source.id,
        source_quantity: source.trips,
        source_rate: source.baseRate,
        source_status: 'Payroll Ready',
        weekly_gross_before_deductions: money(row.weeklyGross),
        projected_monthly_base_divisor_2: money(row.weeklyGross * 2),
        projected_monthly_base_divisor_3: money(row.weeklyGross * 3),
        projected_monthly_base_divisor_5: money(row.weeklyGross * 5),
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

  const jsonPath = path.join(OUTPUT_DIR, 'piece-trip-deduction-test-checklist.json');
  const csvPath = path.join(OUTPUT_DIR, 'piece-trip-deduction-test-employees.csv');
  fs.writeFileSync(jsonPath, JSON.stringify(evidence, null, 2));

  const headers = [
    'Employee Code',
    'Pay Type',
    'Role',
    'Segment',
    'Partner Employee Code',
    'Source Table',
    'Source Record ID',
    'Source Status',
    'Split',
    'Weekly Gross Before Deductions',
    'Projected Monthly Base Divisor 2',
    'Projected Monthly Base Divisor 3',
    'Projected Monthly Base Divisor 5',
  ];
  const rows = evidence.employees.map(row => [
    row.employee_code,
    row.pay_type,
    row.role,
    row.segment,
    row.partner_employee_code,
    row.source_table,
    row.source_record_id,
    row.source_status,
    row.split || '',
    row.weekly_gross_before_deductions,
    row.projected_monthly_base_divisor_2,
    row.projected_monthly_base_divisor_3,
    row.projected_monthly_base_divisor_5,
  ]);
  fs.writeFileSync(csvPath, [headers, ...rows].map(row => row.map(csvEscape).join(',')).join('\n'));

  console.log('Piece/trip deduction test data is ready.');
  console.log(`Department: ${DEPARTMENT_NAME}`);
  console.log(`Payroll period: ${PERIOD.start} to ${PERIOD.end} (${PERIOD.payrollPeriod})`);
  console.log('No payroll calculations, payroll runs, or payslips were created.');
  console.log(`Checklist: ${jsonPath}`);
  console.log(`CSV: ${csvPath}`);
  console.table(evidence.employees.map(row => ({
    employee: row.employee_code,
    pay_type: row.pay_type,
    role: row.role,
    partner: row.partner_employee_code,
    segment: row.segment,
    source: `${row.source_table}#${row.source_record_id}`,
    status: row.source_status,
    weekly_gross: peso(row.weekly_gross_before_deductions),
    monthly_x2: peso(row.projected_monthly_base_divisor_2),
    monthly_x3: peso(row.projected_monthly_base_divisor_3),
    monthly_x5: peso(row.projected_monthly_base_divisor_5),
  })));
}

main().catch(error => {
  console.error('Piece/trip deduction seed failed:', error);
  process.exit(1);
});
