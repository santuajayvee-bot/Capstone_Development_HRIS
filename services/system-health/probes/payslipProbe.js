'use strict';

const crypto = require('crypto');
const { createProbeResult, ProbeFailure } = require('../probeResult');
const { loadModule } = require('../endpointProbe');
const { tableExists, readOne } = require('./helpers');

async function probePayslip({ pool, dataProtection } = {}) {
  loadModule('server/payroll', 'Payslip controller');
  const protection = dataProtection || loadModule('server/data-protection', 'At-rest encryption service');
  const canary = `health-${crypto.randomBytes(18).toString('hex')}`;
  let encrypted;
  try {
    encrypted = protection.encryptColumnValue(canary);
    if (!protection.isEncryptedValue(encrypted) || protection.decryptColumnValue(encrypted) !== canary) {
      throw new Error('Encryption round trip did not preserve the in-memory canary.');
    }
    JSON.stringify({ period: 'health-canary', encrypted_payload: encrypted });
  } catch (error) {
    throw new ProbeFailure('PAYSLIP_ENCRYPTION_CANARY_FAILED', 'Payslip encryption integrity canary failed.', { cause: error });
  }
  const payslipTable = await tableExists(pool, 'payslips');
  if (payslipTable) await readOne(pool, 'payslips');
  return createProbeResult({
    status: payslipTable ? 'ONLINE' : 'WARNING',
    remarks: payslipTable
      ? 'Payslip controller loaded and AES-256-GCM in-memory encryption integrity canary passed.'
      : 'Payslip encryption canary passed, but the payslip storage table is unavailable.',
    probeType: 'INTEGRITY',
    probeTarget: 'payslip controller + data-protection AES-256-GCM round trip',
    checks: {
      controller_loaded: { passed: true, message: 'Payslip controller loaded.' },
      encryption_round_trip: { passed: true, message: 'In-memory payload encrypted and decrypted successfully.' },
      encrypted_shape_valid: { passed: true, message: 'Encrypted payload used the expected protected storage format.' },
      serialization_valid: { passed: true, message: 'Expected payslip metadata can be serialized without storing a payslip.' },
      payslip_storage_readable: { passed: payslipTable, message: payslipTable ? 'Payslip storage is readable.' : 'Payslip storage is unavailable.' },
    },
    dependencies: { payslip_storage: { label: 'Payslip storage', available: payslipTable } },
    validationPassed: true,
  });
}

module.exports = { probePayslip };
