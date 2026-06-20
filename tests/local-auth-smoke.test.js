const assert = require('assert');

async function run() {
  const response = await fetch('http://localhost:3000/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'hr.admin',
      password: 'hr123admin',
      turnstileToken: 'local-development-bypass',
    }),
  });
  const body = await response.json();
  assert.strictEqual(response.status, 200, body.message || body.error || 'Local admin login failed.');
  assert.strictEqual(body.success, true);
  assert.strictEqual(body.mfaRequired, false);
  console.log('Local HR admin authentication smoke test: PASS');
}

run().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
