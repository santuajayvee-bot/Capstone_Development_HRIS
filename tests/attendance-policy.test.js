const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  computeAttendanceMetrics,
  getAttendanceStatusForTimeIn,
  getInitialVerificationStatus,
} = require('../server/attendance-policy-engine');
const { classifyDtrPunch, dtrUpdateValues } = require('../server/dtr-punch');
const { computeLateUndertimeDeductions } = require('../server/payroll-attendance-deductions');
const { recordTardinessPolicyAlert } = require('../server/tardiness-policy');

const basePolicy = {
  work_start_time: '08:00',
  work_end_time: '17:00',
  break_start_time: '12:00',
  break_end_time: '13:00',
  standard_work_hours: 8,
  grace_period_minutes: 10,
  late_threshold_minutes: 0,
  enable_late_tracking: true,
  enable_undertime_tracking: true,
  enable_half_day_rule: true,
  half_day_threshold_hours: 4,
  enable_overtime: false,
  overtime_threshold_minutes: 480,
  missing_timeout_handling: 'Needs Review',
};

function test(name, callback) {
  try {
    callback();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

test('work start and grace period control late status', () => {
  assert.strictEqual(getAttendanceStatusForTimeIn('08:10', basePolicy), 'Present');
  assert.strictEqual(getAttendanceStatusForTimeIn('08:11', basePolicy), 'Late');
});

test('work end controls undertime minutes', () => {
  const result = computeAttendanceMetrics({
    time_in: '08:00',
    time_out: '16:30',
  }, basePolicy);
  assert.strictEqual(result.undertimeMinutes, 30);
});

test('automatic attendance uses first scan for time in and next scan for time out', () => {
  const timeInPunch = classifyDtrPunch(null, '08:13', basePolicy);
  assert.strictEqual(timeInPunch.slot, 'time_in');
  assert.strictEqual(timeInPunch.attendanceType, 'TIME_IN');

  const timeOutPunch = classifyDtrPunch({ time_in: '08:13' }, '17:00', basePolicy);
  assert.strictEqual(timeOutPunch.slot, 'time_out');
  assert.strictEqual(timeOutPunch.attendanceType, 'TIME_OUT');
});

test('two-punch updates keep legacy AM out and PM in fields empty', () => {
  const afterTimeIn = dtrUpdateValues({}, 'time_in', '08:13');
  const completed = dtrUpdateValues(afterTimeIn, 'time_out', '17:00');
  assert.strictEqual(completed.time_in, '08:13');
  assert.strictEqual(completed.time_out, '17:00');
  assert.strictEqual(completed.am_time_in, '08:13');
  assert.strictEqual(completed.am_time_out, null);
  assert.strictEqual(completed.pm_time_in, null);
  assert.strictEqual(completed.pm_time_out, '17:00');
});

test('complete time in and time out compute worked minutes without lunch', () => {
  const result = computeAttendanceMetrics({
    time_in: '08:00',
    time_out: '17:00',
  }, basePolicy);
  assert.strictEqual(result.netWorkedMinutes, 480);
});

test('overtime flag appears only after minimum overtime minutes are met', () => {
  const overtimePolicy = {
    ...basePolicy,
    enable_overtime: true,
    minimum_overtime_minutes: 30,
  };
  const belowMinimum = computeAttendanceMetrics({
    time_in: '08:08',
    time_out: '17:09',
  }, overtimePolicy);
  assert.strictEqual(belowMinimum.overtimeMinutes, 9);
  assert.ok(!belowMinimum.flags.includes('Overtime'));

  const meetsMinimum = computeAttendanceMetrics({
    time_in: '08:00',
    time_out: '17:30',
  }, overtimePolicy);
  assert.strictEqual(meetsMinimum.overtimeMinutes, 30);
  assert.ok(meetsMinimum.flags.includes('Overtime'));
});

test('missing time out produces zero regular minutes', () => {
  const result = computeAttendanceMetrics({
    time_in: '08:00',
  }, basePolicy);
  assert.strictEqual(result.attendanceStatus, 'Incomplete');
  assert.strictEqual(result.regularMinutes, 0);
});

test('required daily hours controls daily-rate minute divisor', () => {
  const result = computeLateUndertimeDeductions({
    attendanceRows: [{ time_in: '08:30', late_minutes: 30, undertime_minutes: 0 }],
    policy: {
      ...basePolicy,
      standard_work_hours: 6,
      late_apply_grace_period: true,
      count_late_for_payroll: true,
      count_undertime_for_payroll: true,
      late_deduction_method: 'auto_compute',
      undertime_deduction_method: 'auto_compute',
    },
    wageType: 'Daily',
    rate: 600,
  });
  assert.strictEqual(result.hourly_rate_used, 100);
  assert.strictEqual(result.deductible_late_minutes, 20);
});

test('HR validation and auto payroll ready control initial status', () => {
  assert.strictEqual(getInitialVerificationStatus('TIME_OUT', {
    require_hr_validation: true,
    auto_payroll_ready: false,
  }), 'PENDING_VALIDATION');
  assert.strictEqual(getInitialVerificationStatus('TIME_OUT', {
    require_hr_validation: false,
    auto_payroll_ready: true,
  }), 'PAYROLL_READY');
});

test('runtime routes enforce duplicate, manual, and correction policies', () => {
  const attendanceService = fs.readFileSync(path.join(__dirname, '../server/attendance-service.js'), 'utf8');
  const attendanceRoutes = fs.readFileSync(path.join(__dirname, '../server/attendance.js'), 'utf8');
  assert.match(attendanceService, /policy\.duplicate_scan_window_seconds > 0/);
  assert.match(attendanceRoutes, /if \(!policy\.allow_manual_attendance\)/);
  assert.match(attendanceRoutes, /if \(!policy\.allow_hr_correction\)/);
});

async function testTardinessAlerts() {
  const calls = [];
  const connection = {
    async execute(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('COUNT(*) AS late_count')) return [[{ late_count: 3 }]];
      if (sql.includes("Action_Type = 'ATTENDANCE_TARDINESS_POLICY_TRIGGERED'")) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  await recordTardinessPolicyAlert(connection, {
    employee_id: 77,
    date: '2026-06-25',
  }, {
    habitual_tardiness_threshold: 3,
    habitual_tardiness_period: 'MONTHLY',
    tardiness_alert_enabled: true,
    payroll_config_id: 9,
    payroll_config_name: 'Monthly tardiness policy',
  });
  assert.ok(calls.some(call => call.sql.includes("ATTENDANCE_TARDINESS_POLICY_TRIGGERED")));
  console.log('PASS enabled monthly tardiness threshold creates an audited HR alert');

  const disabledCalls = [];
  await recordTardinessPolicyAlert({
    async execute(sql, values) {
      disabledCalls.push({ sql, values });
      return [[]];
    },
  }, {
    employee_id: 77,
    date: '2026-06-25',
  }, {
    habitual_tardiness_threshold: 3,
    habitual_tardiness_period: 'MONTHLY',
    tardiness_alert_enabled: false,
  });
  assert.strictEqual(disabledCalls.length, 0);
  console.log('PASS disabled tardiness alert creates no audit alert');
}

testTardinessAlerts()
  .then(() => console.log('Attendance policy regression tests completed.'))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
