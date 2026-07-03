const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const payrollApi = fs.readFileSync(path.join(root, 'server', 'payroll.js'), 'utf8');
const logisticsUi = fs.readFileSync(path.join(root, 'public', 'js', 'logistics-payroll.js'), 'utf8');
const payrollPage = fs.readFileSync(path.join(root, 'public', 'pages', 'payroll.html'), 'utf8');

assert.match(payrollApi, /encode:\s*ROLES\.payroll_any/, 'Payroll Officer must be authorized to encode delivery trips.');
assert.match(payrollApi, /configure:\s*\[\.\.\.ROLES\.payroll_any, \.\.\.ROLES\.hr_final_approval\]/, 'Payroll Officer and Payroll Manager must be authorized to configure logistics rates.');
assert.match(payrollApi, /LOGISTICS_RATE_ALLOWED_FIELDS[\s\S]*?'role'[\s\S]*?rejectUnexpectedFields\([\s\S]*?LOGISTICS_RATE_ALLOWED_FIELDS/, 'Logistics rate role and rate fields must pass a route-specific allowlist.');
assert.match(payrollApi, /router\.post\('\/logistics\/trips', requireAuth, requireRole\(LOGISTICS_TRIP_PERMISSIONS\.encode\)/);
assert.match(payrollApi, /dt\.status IN \('Payroll Ready', 'Approved', 'Included in Payroll', 'Paid'\)/, 'Payroll-ready trip logs must appear in the logistics summary.');
assert.match(payrollPage, /id="delivery-trip-form"/, 'The Logistics Trips tab must expose the delivery-trip encoding form.');
assert.doesNotMatch(payrollPage, /Delivery Trip Queue|delivery-trips-grid/, 'The Logistics Trips tab must not show the delivery trip queue.');
assert.doesNotMatch(payrollPage, /Logistics Payroll Summary|logistics-payroll-summary-grid/, 'The Logistics Trips tab must not show the logistics payroll summary.');
assert.match(payrollPage, /data-logistics-configure-only/, 'Role-controlled rate configuration must be distinguishable from trip encoding.');
assert.doesNotMatch(logisticsUi, /removeDeliveryTripSections/, 'The frontend must not remove the Payroll Officer delivery-trip workflow.');
assert.match(logisticsUi, /normalizeClientRole\(rawRole\)/, 'Logistics role checks must normalize AWS role labels before hiding configuration.');
assert.match(logisticsUi, /new Set\(\['payroll_officer', 'payroll_manager', 'hr_manager', 'hr_admin'\]\)/, 'Configuration controls must include Payroll Officer and Payroll Manager.');
assert.match(logisticsUi, /hasPermission\('payroll\.settings\.manage'\)/, 'Configuration visibility must honor the authenticated permission list for existing AWS sessions.');
assert.match(logisticsUi, /saveDeliveryTrip, submitDeliveryTripForm/, 'Payroll Officer trip encoding functions must be available to the page.');
assert.match(logisticsUi, /Object\.fromEntries\(fields\.map\(field => \[field, formData\.get\(field\) \?\? ''\]\)\)/, 'The browser must submit only approved logistics rate fields.');
assert.doesNotMatch(logisticsUi.match(/async function loadLogisticsPayrollModule\(\)[\s\S]*?\n  }/)?.[0] || '', /\/logistics\/trips|loadLogisticsPayrollSummary/, 'Loading the Logistics tab must not request removed queue or summary data.');
assert.doesNotMatch(logisticsUi, /renderTrips|loadLogisticsPayrollSummary|approveDeliveryTrip|rejectDeliveryTrip/, 'Removed queue and summary controls must not retain dead frontend handlers.');

console.log('Logistics trip Payroll Officer access tests: PASS');
