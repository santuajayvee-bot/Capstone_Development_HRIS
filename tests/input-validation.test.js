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

function assertFieldError(result, field, message) {
  assert.strictEqual(result.response.code, 400);
  assert.strictEqual(result.response.payload.errors[0].field, field);
  assert.ok(result.response.payload.message.includes(message));
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

const acceptedPayrollNumbers = validate({
  salary: '15000',
  rate: '610.00',
  piece_rate: '0.42',
  allowance: '250',
  deduction: '75.50',
  output_quantity: '2322',
  trip_count: '3',
  gross_pay: '16750.25',
  net_pay: '15500.00',
});
assert.strictEqual(acceptedPayrollNumbers.nextCalled, true);

const multiWordName = validate({ first_name: '  Juan   Dela Cruz  ' });
assert.strictEqual(multiWordName.nextCalled, true);
assert.strictEqual(multiWordName.req.body.first_name, 'Juan Dela Cruz');

const authenticationSecret = validate({ password: '  Exact password value  ' });
assert.strictEqual(authenticationSecret.nextCalled, true);
assert.strictEqual(authenticationSecret.req.body.password, '  Exact password value  ');

const authenticationSecretWithInjectionMarkers = validate({
  password: 'Valid#Secret--With\'OR1=1<script>',
});
assert.strictEqual(authenticationSecretWithInjectionMarkers.nextCalled, true);
assert.strictEqual(
  authenticationSecretWithInjectionMarkers.req.body.password,
  'Valid#Secret--With\'OR1=1<script>'
);

const invalidName = validate({ first_name: 'Juan123' });
assertFieldError(invalidName, 'first_name', NAME_MESSAGE);

const invalidNumber = validate({ sss_number: '12ABC' });
assertFieldError(invalidNumber, 'sss_number', NUMERIC_MESSAGE);

const invalidDecimal = validate({ overtime_hours: 'eight' });
assertFieldError(invalidDecimal, 'overtime_hours', NUMERIC_MESSAGE);

const invalidEmail = validate({ work_email: 'not-an-email' });
assertFieldError(invalidEmail, 'work_email', EMAIL_MESSAGE);

const unsafe = validate({ emergency_contact_name: '<script>alert(1)</script>' });
assert.strictEqual(unsafe.response.payload.message, UNSAFE_INPUT_MESSAGE);

const unsafeSql = validate({ remarks: "' OR 1=1 --" });
assert.strictEqual(unsafeSql.response.payload.message, UNSAFE_INPUT_MESSAGE);

const unsafePayrollNumberSql = validate({ piece_rate: "' OR '1'='1" });
assert.strictEqual(unsafePayrollNumberSql.response.code, 400);
assert.strictEqual(unsafePayrollNumberSql.response.payload.message, UNSAFE_INPUT_MESSAGE);

const unsafePayrollDrop = validate({ allowance: '0; DROP TABLE employees' });
assert.strictEqual(unsafePayrollDrop.response.code, 400);
assert.strictEqual(unsafePayrollDrop.response.payload.message, UNSAFE_INPUT_MESSAGE);

const unsafeEventHandler = validate({ residential_address: '<img src=x onerror=alert(1)>' });
assert.strictEqual(unsafeEventHandler.response.payload.message, UNSAFE_INPUT_MESSAGE);

const invalidInfinity = validate({ base_rate: 'Infinity' });
assertFieldError(invalidInfinity, 'base_rate', NUMERIC_MESSAGE);

const excessivePayrollAmount = validate({ gross_pay: '999999999999' });
assert.strictEqual(excessivePayrollAmount.response.code, 400);

console.log('Input validation tests: PASS');

require('../config/db').end();
