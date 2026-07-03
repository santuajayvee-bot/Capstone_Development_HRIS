function toNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeDeductionMethod(value) {
  const text = String(value || 'auto_compute').trim().toLowerCase().replace(/[_-]+/g, ' ');
  if (text.includes('none') || text.includes('no deduction')) return 'No deduction';
  return 'Mandated minute-rate deduction';
}

function deriveHourlyRate({ wageType, rate, standardHoursPerDay }) {
  const numericRate = toNumber(rate);
  const normalizedWageType = String(wageType || '').toLowerCase();
  if (normalizedWageType.includes('daily') || normalizedWageType.includes('month') || normalizedWageType.includes('salary')) {
    return numericRate / Math.max(1, toNumber(standardHoursPerDay, 8));
  }
  return numericRate;
}

function minutesFromClock(value) {
  const match = String(value || '').match(/(?:T|\s|^)(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function computeTimeDeduction({ deductionMethod, minutes, hourlyRate }) {
  const method = normalizeDeductionMethod(deductionMethod);
  const minuteCount = Math.max(0, toNumber(minutes));
  const employeeHourlyRate = Math.max(0, toNumber(hourlyRate));
  if (!minuteCount || method === 'No deduction') return 0;
  return (employeeHourlyRate / 60) * minuteCount;
}

function computeScheduledHourlyBase({ attendanceRows, policy }) {
  const rows = Array.isArray(attendanceRows) ? attendanceRows : [];
  const standardHoursPerDay = Math.max(0, toNumber(
    policy?.standard_hours_per_day || policy?.standard_work_hours,
    8
  ));
  const breakDeductionHours = Math.max(0, toNumber(policy?.break_deduction_hours, 0));
  const scheduledHoursPerDay = Math.max(0, standardHoursPerDay - breakDeductionHours);
  const payableDays = rows.filter((row) => {
    const status = String(row.attendance_status || row.status || '').trim().toLowerCase();
    return !status.includes('absent') && toNumber(row.regular_minutes) > 0;
  }).length;

  return {
    payable_days: payableDays,
    scheduled_hours_per_day: scheduledHoursPerDay,
    scheduled_hours: payableDays * scheduledHoursPerDay,
    approved_regular_hours: rows.reduce(
      (sum, row) => sum + Math.max(0, toNumber(row.regular_minutes)) / 60,
      0
    ),
  };
}

function computeLateUndertimeDeductions({ attendanceRows, policy, wageType, rate }) {
  const rows = Array.isArray(attendanceRows) ? attendanceRows : [];
  const standardHours = toNumber(policy?.standard_hours_per_day || policy?.standard_work_hours, 8);
  const hourlyRate = deriveHourlyRate({ wageType, rate, standardHoursPerDay: standardHours });
  const graceMinutes = Math.max(0, Math.floor(toNumber(policy?.grace_period_minutes, 0)));
  const applyGrace = Boolean(policy?.late_apply_grace_period);

  let lateMinutes = 0;
  let deductibleLateMinutes = 0;
  let undertimeMinutes = 0;
  let overtimeMinutes = 0;

  for (const row of rows) {
    const scheduledStart = minutesFromClock(policy?.work_start_time);
    const actualStart = minutesFromClock(row.time_in);
    const derivedRawLate = scheduledStart != null && actualStart != null
      ? Math.max(0, actualStart - scheduledStart)
      : null;
    const rowLate = derivedRawLate == null
      ? Math.max(0, toNumber(row.late_minutes))
      : derivedRawLate;
    const rowUndertime = Math.max(0, toNumber(row.undertime_minutes));
    const reportedLate = applyGrace && rowLate <= graceMinutes ? 0 : rowLate;
    lateMinutes += reportedLate;
    undertimeMinutes += rowUndertime;
    overtimeMinutes += Math.max(0, toNumber(row.overtime_minutes));
    deductibleLateMinutes += applyGrace ? Math.max(0, rowLate - graceMinutes) : rowLate;
  }

  const countLate = Boolean(policy?.count_late_for_payroll);
  const countUndertime = Boolean(policy?.count_undertime_for_payroll);
  const lateDeduction = countLate
    ? computeTimeDeduction({
      deductionMethod: policy?.late_deduction_method,
      minutes: deductibleLateMinutes,
      hourlyRate
    })
    : 0;
  const undertimeDeduction = countUndertime
    ? computeTimeDeduction({
      deductionMethod: policy?.undertime_deduction_method,
      minutes: undertimeMinutes,
      hourlyRate
    })
    : 0;

  return {
    late_minutes: lateMinutes,
    deductible_late_minutes: deductibleLateMinutes,
    undertime_minutes: undertimeMinutes,
    overtime_minutes: overtimeMinutes,
    late_deduction: Number(lateDeduction.toFixed(2)),
    undertime_deduction: Number(undertimeDeduction.toFixed(2)),
    tardy_ut_deduction: Number((lateDeduction + undertimeDeduction).toFixed(2)),
    hourly_rate_used: Number(hourlyRate.toFixed(2)),
    minute_rate_used: Number((hourlyRate / 60).toFixed(4)),
  };
}

module.exports = {
  normalizeDeductionMethod,
  computeTimeDeduction,
  computeScheduledHourlyBase,
  computeLateUndertimeDeductions,
};
