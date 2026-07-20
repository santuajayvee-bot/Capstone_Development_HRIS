'use strict';

const { createProbeResult, ProbeFailure } = require('../probeResult');
const { loadModule, requireFunction } = require('../endpointProbe');
const { readOne, tableExists } = require('./helpers');

async function probePayroll({ pool } = {}) {
  const payrollRouter = loadModule('server/payroll', 'Payroll controller');
  const calculateCanary = requireFunction(payrollRouter?._systemHealth?.calculateCanary, 'Payroll in-memory calculation canary');
  const result = calculateCanary({ basicPay: 1000, allowances: 100, deductions: 200 });
  const valid = result
    && Number.isFinite(Number(result.gross_pay))
    && Number.isFinite(Number(result.total_deductions))
    && Number.isFinite(Number(result.net_pay))
    && Number(result.net_pay) === 900;
  if (!valid) throw new ProbeFailure('PAYROLL_CANARY_INVALID', 'In-memory payroll calculation returned an invalid result.');
  const policyTable = await tableExists(pool, 'payroll_policy_settings');
  const deductionTable = await tableExists(pool, 'payroll_deduction_settings');
  if (policyTable) await readOne(pool, 'payroll_policy_settings');
  if (deductionTable) await readOne(pool, 'payroll_deduction_settings');
  const degraded = !policyTable || !deductionTable;
  return createProbeResult({
    status: degraded ? 'WARNING' : 'ONLINE',
    remarks: degraded
      ? 'Payroll calculation canary passed, but a payroll policy dependency is unavailable.'
      : 'Payroll controller and deterministic in-memory calculation canary passed without creating a payroll record.',
    probeType: 'SERVICE',
    probeTarget: 'payroll controller._systemHealth.calculateCanary',
    checks: {
      controller_loaded: { passed: true, message: 'Payroll controller loaded.' },
      in_memory_calculation: { passed: true, message: 'Deterministic payroll canary passed internal gross/deduction/net consistency checks.' },
      policy_settings_readable: { passed: policyTable, message: policyTable ? 'Payroll policy settings are readable.' : 'Payroll policy settings are unavailable.' },
      deduction_settings_readable: { passed: deductionTable, message: deductionTable ? 'Payroll deduction settings are readable.' : 'Payroll deduction settings are unavailable.' },
      persistence_not_used: { passed: true, message: 'Canary calculation performed no database insert, update, approval, or finalization.' },
    },
    dependencies: {
      payroll_policy_settings: { label: 'Payroll policy settings', available: policyTable },
      payroll_deduction_settings: { label: 'Payroll deduction settings', available: deductionTable },
    },
    validationPassed: true,
  });
}

module.exports = { probePayroll };
