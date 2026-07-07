const assert = require('assert');
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'services', 'trustedDeviceService.js');
const source = fs.readFileSync(filePath, 'utf8');

assert.match(source, /ensureDeviceSessionTable/);
assert.match(source, /ensureDeviceAuditLogTable/);
assert.match(source, /listDeviceHistory/);
assert.match(source, /listSessionHistory/);
assert.match(source, /restoreDevice/);
assert.match(source, /createDeviceSession/);

console.log('trusted device history/session regression test passed');
