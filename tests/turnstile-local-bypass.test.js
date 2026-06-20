const assert = require('assert');

async function run() {
  process.env.NODE_ENV = 'development';
  process.env.TURNSTILE_BYPASS_LOCAL_DEVELOPMENT = 'true';
  delete require.cache[require.resolve('../services/turnstileService')];
  const developmentService = require('../services/turnstileService');
  const result = await developmentService.verifyTurnstileToken('');
  assert.strictEqual(result.localDevelopmentBypass, true);

  process.env.NODE_ENV = 'production';
  delete require.cache[require.resolve('../services/turnstileService')];
  const productionService = require('../services/turnstileService');
  assert.strictEqual(productionService.getTurnstileClientConfig().localDevelopmentBypass, false);

  console.log('Turnstile local-development bypass test: PASS');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
