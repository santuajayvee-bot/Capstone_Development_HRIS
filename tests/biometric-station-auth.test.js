const assert = require('assert');
const fs = require('fs');
const path = require('path');

const biometricSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'biometric.js'), 'utf8');
const attendanceSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'attendance.js'), 'utf8');
const awsDoc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'aws-biometric-deployment.md'), 'utf8');

assert.match(
  biometricSource,
  /device\.auth_type === 'NONE'\)\s+return allowUnauthenticatedDevice;/,
  'Station biometric devices using NONE auth must be allowed only by the explicit non-production escape hatch.'
);

assert.match(
  biometricSource,
  /if \(!secret\) return allowUnauthenticatedDevice;/,
  'Station biometric devices without a secret must not authenticate by default.'
);

assert.match(
  biometricSource,
  /process\.env\.NODE_ENV !== 'production'[\s\S]*ALLOW_UNAUTHENTICATED_BIOMETRIC_WEBHOOK === 'true'/,
  'Unauthenticated station biometric traffic must be blocked in production.'
);

assert.match(
  attendanceSource,
  /process\.env\.NODE_ENV === 'production' && authType === 'NONE'/,
  'Biometric device management must reject NONE authentication in production.'
);

assert.match(
  awsDoc,
  /Do not upload fingerprint templates or fingerprint images to AWS\./,
  'AWS biometric documentation must preserve privacy-preserving storage boundaries.'
);

console.log('Biometric station auth regression tests: PASS');
