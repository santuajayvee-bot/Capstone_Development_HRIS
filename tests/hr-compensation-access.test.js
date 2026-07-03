const assert = require('assert');
const fs = require('fs');
const path = require('path');

const employeesSource = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'js', 'employees.js'),
  'utf8'
);
const serverSource = fs.readFileSync(
  path.join(__dirname, '..', 'server.js'),
  'utf8'
);
const payrollSource = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'payroll.js'),
  'utf8'
);

const profileRoleMatch = employeesSource.match(
  /function canManageProfilePayrollFields\(\) \{([\s\S]*?)\n\}/
);
const profileRoleFunction = profileRoleMatch?.[1] || '';

assert.match(profileRoleFunction, /'hr_admin'/, 'HR Admin must be able to edit employee compensation setup.');
assert.match(profileRoleFunction, /'hr_manager'/, 'HR Manager must be able to edit employee compensation setup.');
assert.match(profileRoleFunction, /'payroll_officer'/, 'Payroll Officer compensation setup access must remain intact.');
assert.match(profileRoleFunction, /'payroll_manager'/, 'Payroll Manager compensation setup access must remain intact.');

const canManageForRole = role => Function(
  'getUser',
  `${profileRoleMatch[0]}; return canManageProfilePayrollFields();`
)(() => ({ role }));
assert.strictEqual(canManageForRole('hr_admin'), true);
assert.strictEqual(canManageForRole('hr_manager'), true);
assert.strictEqual(canManageForRole('employee'), false);

assert.match(
  serverSource,
  /const canManagePayrollSetup = isPayrollOrAdmin \|\| isHrOrAdmin;/,
  'Backend employee updates must authorize HR compensation setup instead of relying on frontend controls.'
);

const baseRateMatch = employeesSource.match(
  /function usesPayrollBaseRate\(idOrName\) \{([\s\S]*?)\n\}/
);
const baseRateFunction = baseRateMatch?.[1] || '';
assert.match(baseRateFunction, /'Base Salary'/, 'Base Salary must expose its compensation amount input.');

const usesRateFor = wageType => Function(
  'isPayrollWageType',
  `${baseRateMatch[0]}; return usesPayrollBaseRate(${JSON.stringify(wageType)});`
)((value, target) => value === target);
assert.strictEqual(usesRateFor('Base Salary'), true);
assert.strictEqual(usesRateFor('Hourly'), true);
assert.strictEqual(usesRateFor('Per-Piece'), false);

assert.match(employeesSource, /wage_effective_date: document\.getElementById\('profile-edit-wage-effective-date'\)/);
assert.match(serverSource, /'wage_effective_date'/, 'Employee compensation updates must allow a validated effective date.');
assert.match(payrollSource, /payrollDate\(req\.body\.effective_date, 'Compensation effective date'\)/);
assert.match(payrollSource, /employee_wage_configuration_updated/, 'Wage configuration changes must be audited.');

console.log('HR compensation access tests: PASS');
