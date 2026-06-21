const assert = require('assert');
process.env.NODE_ENV = 'test';
const { validateRequestBody, NAME_MESSAGE, NUMERIC_MESSAGE, EMAIL_MESSAGE, UNSAFE_INPUT_MESSAGE } = require('../validators/inputValidation');

function validate(body) {
  const req = { method: 'POST', body: structuredClone(body) };
  let response = null;
  let nextCalled = false;
  const res = {
    status(code) {
      response = { code };
      return this;
    },
    json(payload) {
      response.payload = payload;
      return payload;
    },
  };
  validateRequestBody(req, res, () => { nextCalled = true; });
  return { req, response, nextCalled };
}

const accepted = validate({
  first_name: ' Anne-Marie ',
  middle_name: "O'Connor",
  last_name: 'Dela Cruz',
  contact_number: '09171234567',
  base_rate: '15000.50',
  hours_worked: '8.5',
  email: 'anne@example.com',
});
assert.strictEqual(accepted.nextCalled, true);
assert.strictEqual(accepted.req.body.first_name, 'Anne-Marie');

const multiWordName = validate({ first_name: '  Juan   Dela Cruz  ' });
assert.strictEqual(multiWordName.nextCalled, true);
assert.strictEqual(multiWordName.req.body.first_name, 'Juan Dela Cruz');

const authenticationSecret = validate({ password: '  Exact password value  ' });
assert.strictEqual(authenticationSecret.nextCalled, true);
assert.strictEqual(authenticationSecret.req.body.password, '  Exact password value  ');

const invalidName = validate({ first_name: 'Juan123' });
assert.strictEqual(invalidName.response.code, 400);
assert.strictEqual(invalidName.response.payload.message, NAME_MESSAGE);

const invalidNumber = validate({ sss_number: '12ABC' });
assert.strictEqual(invalidNumber.response.payload.message, NUMERIC_MESSAGE);

const invalidDecimal = validate({ overtime_hours: 'eight' });
assert.strictEqual(invalidDecimal.response.payload.message, NUMERIC_MESSAGE);

const invalidEmail = validate({ work_email: 'not-an-email' });
assert.strictEqual(invalidEmail.response.payload.message, EMAIL_MESSAGE);

const unsafe = validate({ emergency_contact_name: '<script>alert(1)</script>' });
assert.strictEqual(unsafe.response.payload.message, UNSAFE_INPUT_MESSAGE);

const unsafeSql = validate({ remarks: "' OR 1=1 --" });
assert.strictEqual(unsafeSql.response.payload.message, UNSAFE_INPUT_MESSAGE);

const unsafeEventHandler = validate({ residential_address: '<img src=x onerror=alert(1)>' });
assert.strictEqual(unsafeEventHandler.response.payload.message, UNSAFE_INPUT_MESSAGE);

const invalidInfinity = validate({ base_rate: 'Infinity' });
assert.strictEqual(invalidInfinity.response.payload.message, NUMERIC_MESSAGE);

const excessivePayrollAmount = validate({ gross_pay: '999999999999' });
assert.strictEqual(excessivePayrollAmount.response.code, 400);

console.log('Input validation tests: PASS');

require('../config/db').end();
