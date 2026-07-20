'use strict';

const crypto = require('crypto');
const { createProbeResult, ProbeFailure } = require('../probeResult');
const { loadModule, requireFunction } = require('../endpointProbe');
const { readOne, tableExists } = require('./helpers');

async function probeAuthentication({ pool } = {}) {
  const passwordService = loadModule('services/passwordService', 'Password service');
  const tokenService = loadModule('services/tokenService', 'Token service');
  loadModule('server/auth', 'Authentication controller');
  const hashPassword = requireFunction(passwordService.hashPassword, 'Argon2id password hashing');
  const verifyPassword = requireFunction(passwordService.verifyPassword, 'Argon2id password verification');
  const generateAccessToken = requireFunction(tokenService.generateAccessToken, 'JWT access-token signing');
  const verifyAccessToken = requireFunction(tokenService.verifyAccessToken, 'JWT access-token verification');

  const canaryPassword = `Hc!${crypto.randomBytes(24).toString('base64url')}9a`;
  let passwordHash;
  try {
    passwordHash = await hashPassword(canaryPassword);
    const passwordValid = await verifyPassword(passwordHash, canaryPassword);
    if (!passwordValid) throw new ProbeFailure('AUTH_PASSWORD_CANARY_FAILED', 'In-memory password verification failed.');
    const token = generateAccessToken({
      id: 0,
      employeeId: 'system-health-canary',
      username: 'system-health',
      role: 'health_probe',
      roleId: 0,
      accessLevel: 0,
    });
    const claims = verifyAccessToken(token.token);
    if (!claims || claims.sub !== 'system-health-canary') {
      throw new ProbeFailure('AUTH_TOKEN_CANARY_FAILED', 'In-memory access-token verification failed.');
    }
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure('AUTH_CRYPTO_CANARY_FAILED', 'Authentication cryptography canary failed.', { cause: error });
  }

  const sessionsAvailable = await tableExists(pool, 'USER_SESSION');
  const auditAvailable = await tableExists(pool, 'system_audit_log');
  if (sessionsAvailable) await readOne(pool, 'USER_SESSION');
  if (auditAvailable) await readOne(pool, 'system_audit_log');
  const mfaEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.MFA_ENABLED || '').toLowerCase());
  let mfaLoaded = true;
  if (mfaEnabled) {
    try { loadModule('services/mfaService', 'MFA service'); } catch (_) { mfaLoaded = false; }
  }
  const degraded = !sessionsAvailable || !auditAvailable || (mfaEnabled && !mfaLoaded);
  return createProbeResult({
    status: degraded ? 'WARNING' : 'ONLINE',
    remarks: degraded
      ? 'Authentication canary passed, but a non-credential dependency needs review.'
      : 'Authentication controller and in-memory Argon2id/JWT canaries passed without a user login.',
    probeType: 'SERVICE',
    probeTarget: 'auth controller + passwordService + tokenService',
    checks: {
      auth_controller_loaded: { passed: true, message: 'Authentication controller loaded.' },
      password_hash_and_verify: { passed: true, message: 'In-memory Argon2id hash and verification passed.' },
      jwt_sign_and_verify: { passed: true, message: 'In-memory canary token signed and verified.' },
      session_table_readable: { passed: sessionsAvailable, message: sessionsAvailable ? 'Session invalidation table is readable.' : 'Session invalidation table is unavailable.' },
      audit_dependency_readable: { passed: auditAvailable, message: auditAvailable ? 'Authentication audit dependency is readable.' : 'Authentication audit dependency is unavailable.' },
      mfa_service_loaded: { passed: !mfaEnabled || mfaLoaded, message: !mfaEnabled ? 'MFA is disabled in this environment.' : mfaLoaded ? 'MFA service loaded.' : 'MFA service could not be loaded.' },
    },
    dependencies: {
      jwt_signing_secret: { label: 'JWT signing configuration', available: Boolean(process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET), status: 'Configured without revealing its value' },
      session_store: { label: 'Session invalidation store', available: sessionsAvailable },
      authentication_audit: { label: 'Authentication audit dependency', available: auditAvailable },
      mfa: { label: 'MFA service', available: !mfaEnabled || mfaLoaded, status: mfaEnabled ? (mfaLoaded ? 'Enabled' : 'Unavailable') : 'Disabled by configuration' },
    },
    validationPassed: true,
  });
}

module.exports = { probeAuthentication };
