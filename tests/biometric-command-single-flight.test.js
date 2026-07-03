const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const frontend = fs.readFileSync(path.join(root, 'public', 'js', 'attendance.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'public', 'pages', 'attendance.html'), 'utf8');
const backend = fs.readFileSync(path.join(root, 'server', 'biometric.js'), 'utf8');
const bridge = fs.readFileSync(path.join(root, 'tools', 'biometric-bridge', 'LgsvZk9500Bridge.cs'), 'utf8');

assert.match(page, /id="bio-enroll-button"[^>]*type="button"/, 'Enrollment action must expose a disableable button.');
assert.match(page, /id="bio-verify-button"[^>]*type="button"/, 'Verification action must expose a disableable button.');
assert.match(page, /id="bio-remove-button"[^>]*type="button"/, 'Removal action must expose a disableable button.');
assert.match(frontend, /ACTIVE_BIOMETRIC_COMMAND_TYPE/, 'Frontend must keep a single in-flight biometric command state.');
assert.match(frontend, /activeFingerprintMapping\(employeeId\)/, 'Frontend must check enrollment state before issuing a command.');
assert.match(frontend, /setBiometricCommandBusy\('ENROLL'\)/, 'Enrollment must lock repeat actions while processing.');
assert.match(frontend, /setBiometricCommandBusy\('VERIFY'\)/, 'Verification must lock repeat actions while processing.');
assert.match(frontend, /createBiometricBridgeCommand\('DELETE'/, 'Remote fingerprint removal must issue a station-side delete command.');
assert.match(frontend, /\/delete`, \{[\s\S]*employee_id: Number\(mapping\.employee_id\)/, 'Local fingerprint removal must delete the bridge template before disabling the mapping.');
assert.match(frontend, /res\.status === 429[\s\S]*Retry-After/, 'AWS polling must honor API rate-limit retry timing.');

assert.match(backend, /BRIDGE_COMMAND_TYPES = new Set\(\['VERIFY', 'ENROLL', 'DELETE'\]\)/, 'Backend must accept station-side delete commands.');
assert.match(backend, /command_type ENUM\('VERIFY','ENROLL','DELETE'\)/, 'Bridge command schema must include DELETE.');
assert.match(backend, /command\.command_type === 'DELETE'[\s\S]*UPDATE biometric_employee_mapping/, 'Successful station-side deletion must disable the HRIS mapping.');
assert.match(backend, /FROM biometric_device[\s\S]*FOR UPDATE/, 'Command creation must serialize on the selected scanner.');
assert.match(backend, /command_status IN \('PENDING','IN_PROGRESS'\)[\s\S]*FOR UPDATE/, 'Command creation must lock active scanner commands.');
assert.match(backend, /Duplicate queued command canceled; only one scanner command may run at a time\./, 'Duplicate queued commands must be canceled.');
assert.match(backend, /reused: true/, 'A repeated request for the same employee/action must reuse the active command.');
assert.match(backend, /biometric station is busy with another enrollment, verification, or removal/i, 'A different command must receive a clear busy response.');

assert.match(bridge, /path == "delete"[\s\S]*DeleteFingerprint\(context\)/, 'Bridge must expose a local delete endpoint.');
assert.match(bridge, /commandType == "DELETE"[\s\S]*DeleteForCommand/, 'Bridge must process AWS DELETE commands.');
assert.match(bridge, /store\.templates\.RemoveAll\(t => t\.employee_id == employeeId\)/, 'Bridge deletion must remove the local fingerprint template.');

console.log('Biometric command single-flight tests: PASS');
