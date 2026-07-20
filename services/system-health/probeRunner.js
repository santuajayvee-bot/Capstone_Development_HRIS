'use strict';

const { ProbeFailure, createProbeResult, safeText } = require('./probeResult');

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function timeoutError(timeoutMs) {
  return new ProbeFailure('SYSTEM_HEALTH_PROBE_TIMEOUT', `Read-only diagnostic did not finish within ${timeoutMs} ms.`, { status: 'WARNING' });
}

function withTimeout(work, timeoutMs) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve().then(work), timeout]).finally(() => clearTimeout(timer));
}

async function runWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const result = new Array(list.length);
  let index = 0;
  const count = Math.min(Math.max(Number(concurrency) || 1, 1), Math.max(list.length, 1));
  async function consume() {
    while (index < list.length) {
      const current = index++;
      result[current] = await worker(list[current], current);
    }
  }
  await Promise.all(Array.from({ length: count }, consume));
  return result;
}

class ProbeRunner {
  constructor({ timeoutMs, cacheMs, logger } = {}) {
    this.defaultTimeoutMs = boundedInteger(timeoutMs ?? process.env.SYSTEM_HEALTH_MODULE_TIMEOUT_MS, 5000, 10, 60000);
    this.defaultCacheMs = boundedInteger(cacheMs ?? process.env.SYSTEM_HEALTH_PROBE_CACHE_MS, 3000, 0, 60000);
    this.logger = logger || console;
    this.inFlight = new Map();
    this.cache = new Map();
  }

  clear(moduleKey) {
    if (moduleKey) this.cache.delete(moduleKey);
    else this.cache.clear();
  }

  async run(moduleKey, work, options = {}) {
    const key = String(moduleKey || 'unknown').slice(0, 100);
    const now = Date.now();
    const cacheMs = boundedInteger(options.cacheMs, this.defaultCacheMs, 0, 60000);
    const cached = this.cache.get(key);
    if (cached && cacheMs > 0 && now - cached.at < cacheMs) return { ...cached.value, cached: true };
    if (this.inFlight.has(key)) return this.inFlight.get(key);

    const timeoutMs = boundedInteger(options.timeoutMs, this.defaultTimeoutMs, 10, 60000);
    const started = Date.now();
    const promise = withTimeout(work, timeoutMs)
      .then(value => {
        const result = createProbeResult({ ...value, responseTimeMs: Date.now() - started });
        this.cache.set(key, { at: Date.now(), value: result });
        return result;
      })
      .catch(error => {
        const known = error instanceof ProbeFailure;
        const result = createProbeResult({
          status: known ? error.status : 'OFFLINE',
          remarks: known ? error.message : 'Read-only diagnostic failed. Review protected server logs.',
          probeType: options.probeType || 'SERVICE',
          probeTarget: options.probeTarget || key,
          responseTimeMs: Date.now() - started,
          checks: { probe_execution: { passed: false, message: known ? error.message : 'Read-only diagnostic failed.' } },
          failureCode: known ? error.code : 'SYSTEM_HEALTH_PROBE_FAILED',
          errorMessage: known ? error.message : 'Read-only diagnostic failed. Review protected server logs.',
        });
        this.logger.error?.(`[system-health] ${key} probe failed:`, safeText(error?.message, 'unknown failure'));
        this.cache.set(key, { at: Date.now(), value: result });
        return result;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    return promise;
  }

  runAll(items, worker, { concurrency } = {}) {
    return runWithConcurrency(items, concurrency || 4, worker);
  }
}

const systemHealthProbeRunner = new ProbeRunner();

module.exports = {
  ProbeRunner,
  boundedInteger,
  runWithConcurrency,
  systemHealthProbeRunner,
  withTimeout,
};
