const PAYROLL_SCHEDULE_LABELS = Object.freeze([
  'Monthly',
  'Semi-Monthly',
  'Bi-Weekly',
  'Weekly',
]);

const PAYROLL_SCHEDULE_ALIASES = new Map([
  ['monthly', 'Monthly'],
  ['semi_monthly', 'Semi-Monthly'],
  ['semimonthly', 'Semi-Monthly'],
  ['bi_weekly', 'Bi-Weekly'],
  ['biweekly', 'Bi-Weekly'],
  ['weekly', 'Weekly'],
]);

function normalizePayrollScheduleValue(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;

  const key = String(value)
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

  return PAYROLL_SCHEDULE_ALIASES.get(key) || null;
}

module.exports = {
  PAYROLL_SCHEDULE_LABELS,
  normalizePayrollScheduleValue,
};
