require('dotenv').config();

const crypto = require('crypto');

const failures = [];
const warnings = [];

function value(name) {
  return String(process.env[name] || '').trim();
}

function isPlaceholder(text) {
  return !text || /replace-with|your-|example\.com|localhost|127\.0\.0\.1/i.test(text);
}

function pass(message) {
  console.log(`PASS ${message}`);
}

function fail(message) {
  failures.push(message);
  console.error(`FAIL ${message}`);
}

function warn(message) {
  warnings.push(message);
  console.warn(`WARN ${message}`);
}

function requireHttpsUrl(name) {
  const raw = value(name);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:') fail(`${name} must use HTTPS for AWS biometric deployment.`);
    else if (isPlaceholder(raw)) fail(`${name} must be the real AWS HTTPS application origin.`);
    else pass(`${name} is HTTPS.`);
  } catch {
    fail(`${name} must be a valid HTTPS URL.`);
  }
}

function requireConfiguredSecret(name, minLength = 32) {
  const raw = value(name);
  if (isPlaceholder(raw) || raw.length < minLength) fail(`${name} must be a non-placeholder secret with at least ${minLength} characters.`);
  else pass(`${name} is configured.`);
}

function validateAesKey() {
  const hexKey = value('AES_ENCRYPTION_KEY');
  const base64Key = value('AES_256_SECRET_KEY');

  if (/^[a-f0-9]{64}$/i.test(hexKey)) {
    pass('AES_ENCRYPTION_KEY is 32 bytes in hex.');
    return;
  }

  try {
    const decoded = Buffer.from(base64Key, 'base64');
    if (decoded.length === 32) {
      pass('AES_256_SECRET_KEY is 32 bytes in base64.');
      return;
    }
  } catch {
    // Fall through to the failure below.
  }

  fail('Configure AES_ENCRYPTION_KEY as 64 hex characters or AES_256_SECRET_KEY as 32 base64-encoded bytes.');
}

function validateDb() {
  if (isPlaceholder(value('DB_HOST'))) fail('DB_HOST must point to the AWS RDS MySQL endpoint, not localhost or a placeholder.');
  else pass('DB_HOST is set.');

  ['DB_USER', 'DB_PASSWORD', 'DB_NAME'].forEach(name => {
    if (isPlaceholder(value(name))) fail(`${name} must be configured for AWS RDS.`);
    else pass(`${name} is configured.`);
  });

  if (value('DB_SSL') !== 'true') fail('DB_SSL must be true for AWS RDS transport security.');
  else pass('DB_SSL=true.');

  if (value('DB_SSL_REJECT_UNAUTHORIZED') === 'false') fail('DB_SSL_REJECT_UNAUTHORIZED must not be false in AWS.');
  else pass('RDS certificate verification is enabled.');
}

function validateBiometricFlags() {
  if (value('ALLOW_INSECURE_BIOMETRIC_API') === 'true') fail('ALLOW_INSECURE_BIOMETRIC_API must be false or unset in AWS.');
  else pass('Insecure outbound biometric API URLs are disabled.');

  if (value('ALLOW_UNAUTHENTICATED_BIOMETRIC_WEBHOOK') === 'true') fail('ALLOW_UNAUTHENTICATED_BIOMETRIC_WEBHOOK must be false or unset in AWS.');
  else pass('Unauthenticated biometric station/webhook access is disabled.');

  if (value('NODE_ENV') !== 'production') warn('NODE_ENV is not production. Set NODE_ENV=production on AWS.');

  if (value('MFA_MOCK_MODE') === 'true' || value('DISABLE_SMS_MFA_FOR_LOCAL_DEV') === 'true' || value('MFA_SHOW_MOCK_CODE') === 'true') {
    fail('MFA mock/local bypass flags must be false in AWS.');
  } else {
    pass('MFA local bypass flags are disabled.');
  }
}

function validateTlsTermination() {
  const nodeTerminatesTls = value('TLS_CERT_PATH') && value('TLS_KEY_PATH');
  const proxyTerminatesTls = value('AWS_TLS_TERMINATED_AT_LOAD_BALANCER') === 'true';

  if (nodeTerminatesTls) {
    pass('Node TLS certificate paths are configured.');
  } else if (proxyTerminatesTls) {
    pass('AWS load balancer TLS termination is declared.');
  } else {
    warn('Set TLS_CERT_PATH/TLS_KEY_PATH or AWS_TLS_TERMINATED_AT_LOAD_BALANCER=true after configuring TLS 1.3 at the AWS load balancer.');
  }
}

function printApiKeyHint() {
  const example = crypto.randomBytes(32).toString('base64url');
  console.log(`INFO Example biometric API key format: ${example}`);
  console.log('INFO Store the real biometric API key only in System Administration and the station bridge config, never in Git.');
}

requireHttpsUrl('APP_PUBLIC_URL');
requireConfiguredSecret('JWT_SECRET', 32);
validateAesKey();
validateDb();
validateBiometricFlags();
validateTlsTermination();
printApiKeyHint();

if (failures.length) {
  console.error(`AWS biometric configuration check failed: ${failures.length} issue(s).`);
  process.exitCode = 1;
} else {
  console.log(`AWS biometric configuration check passed with ${warnings.length} warning(s).`);
}
