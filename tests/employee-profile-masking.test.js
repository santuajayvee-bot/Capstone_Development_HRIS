const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const employeesJs = fs.readFileSync(path.join(root, 'public', 'js', 'employees.js'), 'utf8');
const profilePage = fs.readFileSync(path.join(root, 'public', 'pages', 'employee-profile.html'), 'utf8');

assert.match(
  server,
  /app\.get\('\/api\/employees\/:id'[\s\S]*res\.json\(maskEmployeeDetail\(visibleEmployeeDetail\(employee\)\)\)/,
  'Employee profile detail must be masked by default before HR explicitly reveals sensitive fields.'
);

assert.match(
  server,
  /app\.post\('\/api\/employees\/:id\/reveal-sensitive'[\s\S]*employee_sensitive_fields_revealed/,
  'Sensitive employee profile reveal must use the audited reveal endpoint.'
);

assert.match(
  server,
  /const EMPLOYEE_PROFILE_MASKED_FIELDS = new Set\(\[[\s\S]*'sss_number'[\s\S]*'philhealth_number'[\s\S]*'pagibig_number'[\s\S]*'tin'[\s\S]*'bank_account'[\s\S]*\]\)/,
  'Only government identifiers and the bank account number should be masked in the HR profile.'
);

const profileMaskAllowlist = server.match(/const EMPLOYEE_PROFILE_MASKED_FIELDS = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';
for (const field of ['date_of_birth', 'place_of_birth', 'gender', 'nationality', 'marital_status', 'religion', 'residential_address', 'contact_number', 'email']) {
  assert.ok(
    !profileMaskAllowlist.includes(`'${field}'`),
    `${field} must remain visible in the HR profile.`
  );
}

for (const field of ['sss_number', 'philhealth_number', 'pagibig_number', 'tin', 'bank_account']) {
  assert.match(
    employeesJs,
    new RegExp(`sensitiveField\\('[^']+',\\s*employee\\.${field},\\s*'${field}'\\)`),
    `${field} must render through the masked sensitive-field UI.`
  );
}

assert.match(
  employeesJs,
  /function revealEmployeeSensitiveField\(_fieldName\)[\s\S]*toggleEmployeeSensitiveDetails\(\)/,
  'Government ID eye buttons must reveal through the audited sensitive detail endpoint.'
);

assert.match(
  employeesJs,
  /const actionLabel = isMasked \? `Reveal \$\{label\}` : `Mask \$\{label\}`[\s\S]*profileEyeIcon\(!isMasked\)/,
  'Government ID eye buttons must remain visible and switch between reveal and mask actions.'
);

assert.match(
  employeesJs,
  /if \(currentProfileSensitiveRevealed\) \{[\s\S]*loadEmployeeProfilePage\(/,
  'Clicking a visible government ID eye button again must reload the masked profile response.'
);

assert.match(
  profilePage,
  /\.profile-sensitive-eye[\s\S]*\.profile-sensitive-eye svg/,
  'Employee profile must include visible eye-icon styling for masked government IDs.'
);

console.log('Employee profile masking checks: PASS');
