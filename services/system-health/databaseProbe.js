'use strict';

const { ProbeFailure, createProbeResult } = require('./probeResult');
const { boundedInteger } = require('./probeRunner');

function poolState(pool) {
  const core = pool?.pool;
  if (!core) return { available: false, status: 'Not exposed by driver' };
  return {
    available: true,
    status: 'Available',
    active: Number(core._allConnections?.length || 0),
    free: Number(core._freeConnections?.length || 0),
    queued: Number(core._connectionQueue?.length || 0),
    configured_limit: Number(core.config?.connectionLimit || 0) || null,
  };
}

async function probeDatabase({ pool, slowWarningMs = process.env.SYSTEM_HEALTH_SLOW_WARNING_MS } = {}) {
  if (!pool?.getConnection) throw new ProbeFailure('DATABASE_POOL_UNAVAILABLE', 'Database connection pool is unavailable.');
  const warningAt = boundedInteger(slowWarningMs, 1000, 100, 60000);
  const started = Date.now();
  let connection;
  try {
    connection = await pool.getConnection();
    const acquiredAt = Date.now();
    const [rows] = await connection.execute('SELECT 1 AS ok');
    const latency = Date.now() - started;
    if (Number(rows?.[0]?.ok) !== 1) throw new ProbeFailure('DATABASE_INVALID_RESPONSE', 'Database probe returned an invalid response.');
    const status = latency > warningAt ? 'WARNING' : 'ONLINE';
    return createProbeResult({
      status,
      remarks: status === 'ONLINE' ? 'Database connection acquisition and read-only query succeeded.' : 'Database is reachable but the read-only query was slow.',
      probeType: 'DATABASE',
      probeTarget: 'mysql2 pool.getConnection + SELECT 1',
      checks: {
        connection_acquired: { passed: true, message: 'A pooled connection was acquired.' },
        select_one: { passed: true, message: 'Read-only SELECT 1 returned the expected result.' },
        connection_released: { passed: true, message: 'Connection release is scheduled after the probe.' },
        latency_within_threshold: { passed: latency <= warningAt, message: latency <= warningAt ? 'Query latency is within the configured threshold.' : 'Query latency exceeded the configured warning threshold.' },
      },
      dependencies: {
        database_connection: { label: 'MySQL / RDS connection', available: true, latency_ms: latency, acquire_ms: acquiredAt - started },
        connection_pool: { label: 'Connection pool', ...poolState(pool) },
      },
      validationPassed: true,
    });
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure('DATABASE_QUERY_FAILED', 'Database connection or read-only query failed.', { cause: error });
  } finally {
    connection?.release?.();
  }
}

module.exports = { poolState, probeDatabase };
