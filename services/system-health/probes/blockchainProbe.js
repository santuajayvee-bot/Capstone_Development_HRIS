'use strict';

const { createProbeResult, ProbeFailure } = require('../probeResult');
const { loadModule, requireFunction } = require('../endpointProbe');
const { ageMinutes, existingColumns, identifier, tableExists } = require('./helpers');
const { boundedInteger } = require('../probeRunner');

async function probeBlockchain({ fabricService, pool } = {}) {
  const fabric = fabricService || loadModule('server/services/fabricService', 'Hyperledger Fabric service');
  const getStatus = requireFunction(fabric.getFabricConfigStatus, 'Fabric configuration status');
  const config = getStatus();
  if (!config.enabled) {
    return createProbeResult({
      status: 'WARNING',
      remarks: 'Hyperledger Fabric is intentionally disabled in this environment; no ledger transaction was submitted.',
      probeType: 'EXTERNAL_DEPENDENCY',
      probeTarget: 'fabricService.evaluateHealthCheck',
      checks: {
        fabric_enabled: { passed: false, message: 'Fabric is disabled by configuration.' },
        readonly_evaluation: { passed: false, message: 'Read-only Fabric evaluation was skipped because Fabric is disabled.' },
      },
      dependencies: { fabric_mode: { label: 'Fabric mode', available: false, status: 'Disabled by configuration' } },
      validationPassed: false,
      failureCode: 'FABRIC_DISABLED',
    });
  }
  if (!config.ready) throw new ProbeFailure('FABRIC_CONFIG_INCOMPLETE', 'Fabric identity configuration is incomplete.');
  const evaluate = requireFunction(fabric.evaluateHealthCheck, 'Fabric read-only HealthCheck transaction');
  try {
    await evaluate();
  } catch (error) {
    throw new ProbeFailure('FABRIC_READ_ONLY_EVALUATION_FAILED', 'Fabric peer, channel, chaincode, or read-only evaluation is unavailable.', { cause: error });
  }
  let pendingAnchors = 0;
  let oldestPending = null;
  const payrollTable = pool && await tableExists(pool, 'PAYROLL_RECORD');
  if (payrollTable) {
    const columns = await existingColumns(pool, 'PAYROLL_RECORD', ['Blockchain_Status', 'updated_at', 'Updated_At', 'created_at', 'Created_At']);
    if (columns.has('Blockchain_Status')) {
      const timestamp = ['updated_at', 'Updated_At', 'created_at', 'Created_At'].find(column => columns.has(column));
      const [rows] = await pool.execute(
        `SELECT COUNT(*) AS pending${timestamp ? `, MIN(${identifier(timestamp)}) AS oldest_pending` : ''} FROM PAYROLL_RECORD WHERE Blockchain_Status IN ('PENDING','Pending')`
      );
      pendingAnchors = Number(rows[0]?.pending || 0);
      oldestPending = rows[0]?.oldest_pending || null;
    }
  }
  const maxPendingAge = boundedInteger(process.env.SYSTEM_HEALTH_BLOCKCHAIN_MAX_PENDING_AGE_MINUTES, 30, 1, 10080);
  const pendingAge = ageMinutes(oldestPending);
  const stalePending = pendingAnchors > 0 && pendingAge !== null && pendingAge > maxPendingAge;
  return createProbeResult({
    status: stalePending ? 'WARNING' : 'ONLINE',
    remarks: stalePending
      ? 'Fabric read-only HealthCheck succeeded, but finalized payroll anchoring is older than the configured threshold.'
      : 'Fabric gateway connection and read-only chaincode HealthCheck evaluation succeeded.',
    probeType: 'EXTERNAL_DEPENDENCY',
    probeTarget: 'fabricService.evaluateHealthCheck',
    checks: {
      fabric_enabled: { passed: true, message: 'Fabric is enabled.' },
      configuration_ready: { passed: true, message: 'Required Fabric identity configuration is present.' },
      readonly_evaluation: { passed: true, message: 'Read-only chaincode HealthCheck evaluation succeeded.' },
      no_ledger_write: { passed: true, message: 'No payroll, DTR, or health record was submitted to the ledger.' },
      pending_anchor_freshness: { passed: !stalePending, message: stalePending ? 'Pending blockchain anchors exceed the configured age.' : 'No stale pending blockchain anchor was detected.' },
    },
    dependencies: {
      fabric_network: { label: 'Fabric network', available: true, status: 'Read-only evaluation passed' },
      pending_anchors: { label: 'Pending blockchain anchors', count: pendingAnchors, value: oldestPending, age_minutes: pendingAge, max_age_minutes: maxPendingAge },
    },
    validationPassed: true,
  });
}

module.exports = { probeBlockchain };
