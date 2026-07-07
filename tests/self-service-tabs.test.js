const assert = require('assert');
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'public', 'js', 'self-service.js');
const source = fs.readFileSync(filePath, 'utf8');

assert.match(source, /function initSelfServiceTabs\(\) \{/);
assert.match(source, /dataset\.selfServiceBound === 'true'/);
assert.match(source, /dataset\.selfServiceSaveBound === 'true'/);
assert.match(source, /dataset\.selfServiceSensitiveBound === 'true'/);
assert.match(source, /dataset\.selfServiceMobileBound === 'true'/);
assert.match(source, /document\.addEventListener\('partialsLoaded'/);

console.log('self-service tab wiring regression test passed');
