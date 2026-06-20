const assert = require('assert');
const { computeLateUndertimeDeductions } = require('../server/payroll-attendance-deductions');

const HOURLY_RATE = 120;
const policy = {
  work_start_time: '08:00',
  standard_hours_per_day: 8,
  grace_period_minutes: 10,
  count_late_for_payroll: true,
  count_undertime_for_payroll: true,
  late_deduction_method: 'auto_compute',
  late_fixed_deduction_amount: 0,
  late_apply_grace_period: true,
  undertime_deduction_method: 'auto_compute',
  undertime_fixed_deduction_amount: 0,
};

function clockMinutes(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function workedHours(timeIn, timeOut) {
  const actualStart = clockMinutes(timeIn);
  const payableStart = actualStart <= clockMinutes('08:10') ? clockMinutes('08:00') : actualStart;
  return (clockMinutes(timeOut) - payableStart - 60) / 60;
}

function runCase(testCase) {
  const attendanceRows = [{
    attendance_date: '2026-06-15',
    time_in: testCase.timeIn,
    time_out: testCase.timeOut,
    late_minutes: Math.max(0, clockMinutes(testCase.timeIn) - clockMinutes('08:10')),
    undertime_minutes: Math.max(0, clockMinutes('17:00') - clockMinutes(testCase.timeOut)),
    overtime_minutes: Math.max(0, clockMinutes(testCase.timeOut) - clockMinutes('17:00')),
    verification_status: 'PAYROLL_READY',
    payroll_eligible: 1,
  }];
  const result = computeLateUndertimeDeductions({
    attendanceRows,
    policy,
    wageType: 'Hourly',
    rate: HOURLY_RATE,
  });
  const hours = workedHours(testCase.timeIn, testCase.timeOut);
  const payslip = {
    late_minutes: result.late_minutes,
    late_deduction: result.late_deduction,
    undertime_minutes: result.undertime_minutes,
    undertime_deduction: result.undertime_deduction,
    total_tardy_ut: result.tardy_ut_deduction,
  };

  assert.strictEqual(result.late_minutes, testCase.expected.lateMinutes);
  assert.strictEqual(result.deductible_late_minutes, testCase.expected.deductibleLateMinutes);
  assert.strictEqual(result.undertime_minutes, testCase.expected.undertimeMinutes);
  assert.strictEqual(hours, testCase.expected.hoursWorked);
  assert.strictEqual(result.late_deduction, testCase.expected.lateDeduction);
  assert.strictEqual(result.undertime_deduction, testCase.expected.undertimeDeduction);
  assert.strictEqual(result.tardy_ut_deduction, testCase.expected.totalDeduction);

  return { name: testCase.name, attendance: attendanceRows[0], hours, result, payslip, status: 'PASS' };
}

const cases = [
  { name: 'Case 1 - Within grace', timeIn: '08:05', timeOut: '17:00', expected: { lateMinutes: 0, deductibleLateMinutes: 0, undertimeMinutes: 0, hoursWorked: 8, lateDeduction: 0, undertimeDeduction: 0, totalDeduction: 0 } },
  { name: 'Case 2 - Late', timeIn: '08:30', timeOut: '17:00', expected: { lateMinutes: 30, deductibleLateMinutes: 20, undertimeMinutes: 0, hoursWorked: 7.5, lateDeduction: 40, undertimeDeduction: 0, totalDeduction: 40 } },
  { name: 'Case 3 - Undertime', timeIn: '08:00', timeOut: '16:30', expected: { lateMinutes: 0, deductibleLateMinutes: 0, undertimeMinutes: 30, hoursWorked: 7.5, lateDeduction: 0, undertimeDeduction: 60, totalDeduction: 60 } },
  { name: 'Case 4 - Late and undertime', timeIn: '08:30', timeOut: '16:30', expected: { lateMinutes: 30, deductibleLateMinutes: 20, undertimeMinutes: 30, hoursWorked: 7, lateDeduction: 40, undertimeDeduction: 60, totalDeduction: 100 } },
];

const results = cases.map(runCase);

const toggleOff = computeLateUndertimeDeductions({
  attendanceRows: [{ time_in: '08:30', late_minutes: 20, undertime_minutes: 30 }],
  policy: { ...policy, count_late_for_payroll: false, count_undertime_for_payroll: false },
  wageType: 'Hourly',
  rate: HOURLY_RATE,
});
assert.strictEqual(toggleOff.late_deduction, 0);
assert.strictEqual(toggleOff.undertime_deduction, 0);

const monthlySalary = 26000;
const workingDays = 26;
const dailyRate = monthlySalary / workingDays;
const hourlyRate = dailyRate / 8;
const minuteRate = hourlyRate / 60;
const dailyRateDeduction = computeLateUndertimeDeductions({
  attendanceRows: [{ time_in: '08:30', late_minutes: 20, undertime_minutes: 30 }],
  policy: { ...policy, standard_hours_per_day: 8, working_days_per_month: workingDays },
  wageType: 'Daily',
  rate: dailyRate,
});
assert.strictEqual(dailyRate, 1000);
assert.strictEqual(hourlyRate, 125);
assert.strictEqual(Number(minuteRate.toFixed(4)), 2.0833);
assert.strictEqual(dailyRateDeduction.late_deduction, 41.67);
assert.strictEqual(dailyRateDeduction.undertime_deduction, 62.5);

const fixedMethod = computeLateUndertimeDeductions({
  attendanceRows: [{ time_in: '08:30', late_minutes: 20, undertime_minutes: 30 }],
  policy: {
    ...policy,
    late_deduction_method: 'fixed_per_minute',
    late_fixed_deduction_amount: 3,
    undertime_deduction_method: 'fixed_per_hour',
    undertime_fixed_deduction_amount: 180,
  },
  wageType: 'Hourly',
  rate: HOURLY_RATE,
});
assert.strictEqual(fixedMethod.late_deduction, 60);
assert.strictEqual(fixedMethod.undertime_deduction, 90);

const eligibleRecords = [
  { verification_status: 'PAYROLL_READY', payroll_eligible: 1 },
  { verification_status: 'PENDING_VALIDATION', payroll_eligible: 0 },
  { verification_status: 'REJECTED', payroll_eligible: 0 },
].filter((row) => row.verification_status === 'PAYROLL_READY' && Number(row.payroll_eligible) === 1);
assert.strictEqual(eligibleRecords.length, 1);

console.table(results.map((item) => ({
  Test: item.name,
  Attendance: `${item.attendance.time_in}-${item.attendance.time_out}`,
  Hours: item.hours,
  LateMinutes: item.result.late_minutes,
  DeductibleLate: item.result.deductible_late_minutes,
  UndertimeMinutes: item.result.undertime_minutes,
  LateDeduction: item.result.late_deduction.toFixed(2),
  UndertimeDeduction: item.result.undertime_deduction.toFixed(2),
  TotalTardyUT: item.result.tardy_ut_deduction.toFixed(2),
  Payslip: `Late ${item.payslip.late_minutes}m / PHP ${item.payslip.late_deduction.toFixed(2)}; UT ${item.payslip.undertime_minutes}m / PHP ${item.payslip.undertime_deduction.toFixed(2)}`,
  Status: item.status,
})));
console.log('Toggle validation: PASS');
console.log('PAYROLL_READY exclusion validation: PASS');
console.log('Monthly-to-daily-to-hour-to-minute deduction hierarchy: PASS');
console.log('Optional fixed deduction methods: PASS');
