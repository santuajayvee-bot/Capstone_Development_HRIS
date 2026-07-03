const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const payrollApi = fs.readFileSync(path.join(root, 'server', 'payroll.js'), 'utf8');
const logisticsUi = fs.readFileSync(path.join(root, 'public', 'js', 'logistics-payroll.js'), 'utf8');
const payrollPage = fs.readFileSync(path.join(root, 'public', 'pages', 'payroll.html'), 'utf8');

assert.match(payrollApi, /encode:\s*ROLES\.payroll_any/, 'Payroll Officer must be authorized to encode delivery trips.');
assert.match(payrollApi, /router\.post\('\/logistics\/trips', requireAuth, requireRole\(LOGISTICS_TRIP_PERMISSIONS\.encode\)/);
assert.match(payrollApi, /dt\.status IN \('Payroll Ready', 'Approved', 'Included in Payroll', 'Paid'\)/, 'Payroll-ready trip logs must appear in the logistics summary.');
assert.match(payrollPage, /id="delivery-trip-form"/, 'The Logistics Trips tab must expose the delivery-trip encoding form.');
assert.match(payrollPage, /data-logistics-configure-only/, 'Manager-only rate configuration must be distinguishable from trip encoding.');
assert.doesNotMatch(logisticsUi, /removeDeliveryTripSections/, 'The frontend must not remove the Payroll Officer delivery-trip workflow.');
assert.match(logisticsUi, /currentRole\(\) === 'payroll_manager'/, 'Configuration and approval controls must stay manager-only.');
assert.match(logisticsUi, /saveDeliveryTrip, submitDeliveryTripForm/, 'Payroll Officer trip encoding functions must be available to the page.');

console.log('Logistics trip Payroll Officer access tests: PASS');
