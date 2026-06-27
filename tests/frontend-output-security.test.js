const assert = require('assert');

const { escapeHTML, setSafeText } = require('../public/js/security-utils');

const attack = `<img src=x onerror="alert('xss')"> & 'quoted'`;
const encoded = escapeHTML(attack);
assert.strictEqual(encoded.includes('<'), false);
assert.strictEqual(encoded.includes('>'), false);
assert.strictEqual(encoded.includes('onerror=&quot;'), true);
assert.strictEqual(encoded.includes('&amp;'), true);

const element = { textContent: '' };
setSafeText(element, attack);
assert.strictEqual(element.textContent, attack);
assert.strictEqual(Object.prototype.hasOwnProperty.call(element, 'innerHTML'), false);

console.log('Frontend output encoding tests: PASS');
