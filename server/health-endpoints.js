'use strict';

function healthReadinessTimeoutMs(value = process.env.HEALTH_READY_TIMEOUT_MS) {
  const parsed = Number.parseInt(String(value || '2000'), 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 250), 10000) : 2000;
}

function withHealthTimeout(work, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('readiness timeout')), timeoutMs);
    timeoutId.unref?.();
  });
  return Promise.race([Promise.resolve().then(work), timeout]).finally(() => clearTimeout(timeoutId));
}

function responseHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

function createHealthHandlers({
  poolProvider,
  encryptColumnValue,
  isEncryptedValue,
  environment = process.env,
  now = () => new Date(),
  logger = console,
} = {}) {
  if (typeof poolProvider !== 'function') throw new Error('Health readiness pool provider is required.');
  if (typeof encryptColumnValue !== 'function' || typeof isEncryptedValue !== 'function') {
    throw new Error('Health readiness encryption functions are required.');
  }
  const timestamp = () => now().toISOString();
  return {
    live(_req, res) {
      responseHeaders(res);
      return res.status(200).json({ status: 'alive', timestamp: timestamp() });
    },
    async ready(_req, res) {
      responseHeaders(res);
      let connection;
      try {
        const hasJwtSecret = Boolean(String(environment.JWT_ACCESS_SECRET || environment.JWT_SECRET || '').trim());
        // Readiness requires a dedicated AES-256 key. A JWT-derived legacy fallback
        // must not make a production instance appear ready to serve sensitive data.
        const hasEncryptionMaterial = Boolean(String(environment.AES_ENCRYPTION_KEY || environment.AES_256_SECRET_KEY || '').trim());
        if (!hasJwtSecret || !hasEncryptionMaterial) throw new Error('essential configuration unavailable');
        const timeoutMs = healthReadinessTimeoutMs(environment.HEALTH_READY_TIMEOUT_MS);
        connection = await withHealthTimeout(() => poolProvider().getConnection(), timeoutMs);
        const [rows] = await withHealthTimeout(() => connection.execute('SELECT 1 AS ok'), timeoutMs);
        if (Number(rows?.[0]?.ok) !== 1) throw new Error('database readiness query failed');
        const encrypted = encryptColumnValue('health-readiness-canary');
        if (!isEncryptedValue(encrypted)) throw new Error('encryption provider unavailable');
        return res.status(200).json({ status: 'ready', timestamp: timestamp() });
      } catch (error) {
        logger.warn?.('[health] readiness check unavailable:', String(error?.code || 'DEPENDENCY_UNAVAILABLE').slice(0, 80));
        res.setHeader('Retry-After', '10');
        return res.status(503).json({ status: 'not_ready', timestamp: timestamp() });
      } finally {
        connection?.release?.();
      }
    },
  };
}

module.exports = { createHealthHandlers, healthReadinessTimeoutMs, withHealthTimeout };
