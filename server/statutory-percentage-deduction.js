function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function roundMoney(value) {
  return Math.round((numeric(value) + Number.EPSILON) * 100) / 100;
}

function dateKey(value) {
  const match = String(value || '').match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : new Date().toISOString().slice(0, 10);
}

function deductionContext(input = {}) {
  const calculationDate = dateKey(input.calculation_date || input.end_date || input.payroll_end_date);
  return {
    ...input,
    calculation_date: calculationDate,
    payroll_start_date: dateKey(input.payroll_start_date || input.start_date || input.period_start || calculationDate),
    payroll_frequency: String(input.payroll_frequency || input.frequency || '').trim(),
  };
}

function monthHasFifthWeeklyCutoff(dateValue) {
  const date = new Date(`${dateKey(dateValue)}T00:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate() >= 29;
}

function deductionMonthlyProjectionDivisor(setting = {}, input = {}) {
  const context = deductionContext(input);
  const fixedDivisor = numeric(setting.fixed_divisor);
  if (String(setting.proration_mode || '').trim() === 'Fixed Divisor' && fixedDivisor > 0) {
    return fixedDivisor;
  }

  const schedule = String(context.payroll_frequency || setting.apply_schedule || setting.deduction_frequency || 'Weekly').trim();
  if (schedule === 'Monthly') return 1;
  if (schedule === 'Semi-Monthly' || schedule === 'First Payroll of Month' || schedule === 'Last Payroll of Month') return 2;
  return monthHasFifthWeeklyCutoff(context.payroll_start_date) ? 5 : 4;
}

function statutoryPercentageDeductionDetails(setting, grossPay, input = {}) {
  const divisor = deductionMonthlyProjectionDivisor(setting, input);
  const name = String(setting?.name || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  const isPagibig = name === 'pagibig' || name === 'hdmf';
  const floor = numeric(setting.minimum_salary_base);
  const ceiling = numeric(setting.maximum_salary_ceiling);
  const cap = numeric(setting.maximum_contribution_cap);
  const configuredRate = numeric(setting.employee_share_rate) || numeric(setting.rate_or_amount);
  const projectedMonthlySalary = numeric(grossPay) * divisor;

  let contributionBase = projectedMonthlySalary;
  let effectiveRate = configuredRate;
  let floorRule = 'not_applied';

  if (isPagibig && floor > 0 && projectedMonthlySalary < floor) {
    effectiveRate = 1;
    floorRule = 'pagibig_below_floor_1_percent';
  } else if (floor > 0 && projectedMonthlySalary < floor) {
    contributionBase = floor;
    floorRule = 'minimum_salary_base';
  }

  if (ceiling > 0) contributionBase = Math.min(contributionBase, ceiling);
  const monthlyAmountBeforeCap = contributionBase * (effectiveRate / 100);
  const monthlyContribution = cap > 0
    ? Math.min(monthlyAmountBeforeCap, cap)
    : monthlyAmountBeforeCap;

  return {
    amount: roundMoney(monthlyContribution / divisor),
    divisor,
    projected_monthly_salary: roundMoney(projectedMonthlySalary),
    contribution_base: roundMoney(contributionBase),
    configured_rate: configuredRate,
    effective_rate: effectiveRate,
    floor,
    ceiling,
    cap,
    floor_rule: floorRule,
    ceiling_applied: ceiling > 0 && projectedMonthlySalary > ceiling,
    cap_applied: cap > 0 && monthlyAmountBeforeCap > cap,
    monthly_contribution: roundMoney(monthlyContribution),
  };
}

function percentageDeductionAmount(setting, grossPay, input = {}) {
  return statutoryPercentageDeductionDetails(setting, grossPay, input).amount;
}

module.exports = {
  deductionMonthlyProjectionDivisor,
  percentageDeductionAmount,
  statutoryPercentageDeductionDetails,
};
