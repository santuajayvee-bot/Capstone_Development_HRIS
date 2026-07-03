const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const attendance = fs.readFileSync(path.join(root, 'server', 'attendance.js'), 'utf8');
const biometric = fs.readFileSync(path.join(root, 'server', 'biometric.js'), 'utf8');

assert(attendance.includes('function safeAttendanceText(value)'), 'Attendance routes must use safe decrypt fallback.');
assert(attendance.includes('catch (_error)') && attendance.includes("row?.employee_code"), 'Attendance names must fall back when decrypt fails.');
assert(!/const first = decryptColumnValue\(row\?\.first_name\)/.test(attendance), 'Attendance names must not decrypt directly.');

assert(biometric.includes('function safeBiometricText(value)'), 'Biometric routes must use safe decrypt fallback.');
assert(biometric.includes('catch (_error)') && biometric.includes("row?.employee_code"), 'Biometric names must fall back when decrypt fails.');
assert(!/const first = decryptColumnValue\(row\?\.first_name\)/.test(biometric), 'Biometric names must not decrypt directly.');

console.log('Attendance decrypt fallback checks passed.');
