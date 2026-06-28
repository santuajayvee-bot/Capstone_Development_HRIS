const assert = require('assert');
const {
  DEFAULT_BAD_REQUEST_MESSAGE,
  DEFAULT_SERVER_MESSAGE,
  clientErrorResponse,
} = require('../server/error-response');

const unsafeBadRequest = clientErrorResponse({
  status: 400,
  message: 'Invalid value <img src=x onerror=alert(1)>',
});
assert.strictEqual(unsafeBadRequest.status, 400);
assert.strictEqual(unsafeBadRequest.body.error, DEFAULT_BAD_REQUEST_MESSAGE);
assert.strictEqual(unsafeBadRequest.body.message, DEFAULT_BAD_REQUEST_MESSAGE);

const safeBadRequest = clientErrorResponse({
  status: 400,
  message: 'Invalid input. Please remove unsupported characters and try again.',
});
assert.strictEqual(safeBadRequest.status, 400);
assert.strictEqual(safeBadRequest.body.error, 'Invalid input. Please remove unsupported characters and try again.');

const unexpectedFailure = clientErrorResponse({
  status: 500,
  message: 'ER_PARSE_ERROR: SELECT password_hash FROM users',
});
assert.strictEqual(unexpectedFailure.status, 500);
assert.strictEqual(unexpectedFailure.body.error, DEFAULT_SERVER_MESSAGE);

console.log('Error response tests: PASS');
