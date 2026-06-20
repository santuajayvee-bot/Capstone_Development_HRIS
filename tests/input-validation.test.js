const assert = require('assert');
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

console.log('Input validation tests: PASS');
