const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const frontend = fs.readFileSync(path.join(root, 'public', 'js', 'payroll.js'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'server', 'payroll.js'), 'utf8');

assert.match(frontend, /function payrollExactHourLabel\(hours, minutes = null\)/, 'Payroll UI must expose an exact minute-based hour label.');
assert.match(frontend, /net_credited_minutes[\s\S]*payrollExactHourLabel\(netCreditedHours, netCreditedMinutes\)/, 'Work Output must display exact net credited minutes.');
assert.match(frontend, /Clocked Regular Hrs/, 'Hourly breakdown must label raw attendance time separately from payroll work output.');
assert.match(frontend, /Included in work output; only beyond-grace late is deducted/, 'Hourly breakdown must explicitly state that grace is included in work output.');
assert.match(frontend, /minimumFractionDigits:\s*4[\s\S]*maximumFractionDigits:\s*4/, 'Decimal hour display must keep 4 decimals to avoid centavo mismatches.');
assert.match(frontend, /regular_minutes/, 'Attendance source rows must carry exact regular minutes.');
assert.match(backend, /net_credited_minutes:\s*roundedNetCreditedMinutes/, 'Payroll snapshot must store exact net credited minutes.');
assert.match(backend, /approved_regular_minutes:/, 'Payroll snapshot must store approved regular minutes.');
assert.match(backend, /scheduled_minutes:\s*hourlyScheduledMinutes/, 'Payroll snapshot must store scheduled minutes.');

console.log('Payroll hour precision display tests: PASS');
