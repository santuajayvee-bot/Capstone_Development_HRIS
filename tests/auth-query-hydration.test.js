const assert = require('assert');
process.env.NODE_ENV = 'test';
const { _hydrateUserRowForTest } = require('../db/authQueries');

const malformedEncryptedEmail = {
  id: 1,
  username: 'employee.account',
  Email: null,
  User_Email_Encrypted: 'not-a-valid-aes-payload',
};

assert.doesNotThrow(() => _hydrateUserRowForTest(malformedEncryptedEmail));
assert.strictEqual(malformedEncryptedEmail.Email, null);
assert.strictEqual(Object.prototype.hasOwnProperty.call(malformedEncryptedEmail, 'User_Email_Encrypted'), false);

const plaintextEmail = {
  id: 2,
  username: 'employee.with.email',
  Email: 'employee@example.com',
  User_Email_Encrypted: 'not-needed',
};

assert.doesNotThrow(() => _hydrateUserRowForTest(plaintextEmail));
assert.strictEqual(plaintextEmail.Email, 'employee@example.com');
assert.strictEqual(Object.prototype.hasOwnProperty.call(plaintextEmail, 'User_Email_Encrypted'), false);

console.log('Auth query hydration tests: PASS');

require('../config/db').end();
