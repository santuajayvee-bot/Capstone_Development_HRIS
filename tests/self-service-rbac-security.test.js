const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const selfService = fs.readFileSync(path.join(root, 'server', 'self-service.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

assert.match(
  selfService,
  /contact_number:\s*\{\s*column:\s*'contact_number',\s*label:\s*'Contact number'\s*\}/,
  'Self-service contact number changes must be represented as HR-reviewed profile change requests.'
);

assert.match(
  selfService,
  /SELF_SERVICE_REVIEW_REQUIRED_FIELDS\s*=\s*new Set\(\[[\s\S]*'contact_number'[\s\S]*\]\)/,
  'Self-service contact number must not be applied as a direct employee table update.'
);

assert.match(
  selfService,
  /SELF_SERVICE_FORBIDDEN_FIELDS\s*=\s*new Set\(\[[\s\S]*'sss_number'[\s\S]*'philhealth_number'[\s\S]*'pagibig_number'[\s\S]*'tin'[\s\S]*\]\)/,
  'Government IDs must remain forbidden in the direct self-service profile update route.'
);

assert.match(
  selfService,
  /validateSelfChangeRequestValue\(fieldName,\s*req\.body\?\.requested_value\)/,
  'Self-service change requests must validate requested sensitive values before storing them for review.'
);

const employeeUpdateRoute = server.match(
  /app\.put\('\/api\/employees\/:id',\s*requireAuth,\s*requireRole\(ROLES\.staff_management\),[\s\S]*?validateEmployeeRequestBody\(req,\s*res,\s*pool,\s*\{\s*mode:\s*'update'\s*\}\)/
);
assert.ok(
  employeeUpdateRoute,
  'Employee master-data update must require staff-management RBAC before employee validators can run.'
);

console.log('Self-service RBAC security checks: PASS');
