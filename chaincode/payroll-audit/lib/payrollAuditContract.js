'use strict';

const { Contract } = require('fabric-contract-api');

const FINAL_RECORD_PREFIX = 'PAYROLL_FINAL';
const ADJUSTMENT_OBJECT_TYPE = 'PAYROLL_ADJUSTMENT';

const ALLOWED_FIELDS = [
  'Payroll_ID',
  'Employee_ID',
  'Payroll_Hash',
  'Approval_Status',
  'Approved_By',
  'Approved_At',
  'Recorded_At',
  'Record_Type',
  'Previous_Transaction_Hash',
];

function finalPayrollKey(payrollId) {
  return `${FINAL_RECORD_PREFIX}_${payrollId}`;
}

function parsePayload(payloadJson) {
  try {
    const payload = JSON.parse(payloadJson);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('payload must be a JSON object');
    }
    return payload;
  } catch (error) {
    throw new Error(`Invalid JSON payload: ${error.message}`);
  }
}

function sanitizeRecord(payload, expectedType) {
  const record = {};
  for (const field of ALLOWED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      record[field] = payload[field] == null ? null : String(payload[field]);
    }
  }
  record.Record_Type = expectedType;
  record.Previous_Transaction_Hash = record.Previous_Transaction_Hash || null;
  return record;
}

function validateRecord(record) {
  const required = [
    'Payroll_ID',
    'Employee_ID',
    'Payroll_Hash',
    'Approval_Status',
    'Approved_By',
    'Approved_At',
    'Recorded_At',
    'Record_Type',
  ];

  for (const field of required) {
    if (!record[field]) throw new Error(`${field} is required`);
  }

  if (!/^[a-f0-9]{64}$/i.test(record.Payroll_Hash)) {
    throw new Error('Payroll_Hash must be a 64-character SHA-256 hex digest');
  }

  if (record.Approval_Status !== 'Finalized') {
    throw new Error('Only payroll records with Approval_Status Finalized can be recorded');
  }

  if (!['FINALIZED_PAYROLL', 'ADJUSTMENT'].includes(record.Record_Type)) {
    throw new Error('Record_Type must be FINALIZED_PAYROLL or ADJUSTMENT');
  }
}

async function iteratorToArray(iterator, mapper) {
  const results = [];
  try {
    while (true) {
      const next = await iterator.next();
      if (next.value) results.push(mapper(next.value));
      if (next.done) break;
    }
  } finally {
    await iterator.close();
  }
  return results;
}

class PayrollAuditContract extends Contract {
  async CreatePayrollRecord(ctx, payloadJson) {
    const payload = parsePayload(payloadJson);
    const record = sanitizeRecord(payload, 'FINALIZED_PAYROLL');
    validateRecord(record);

    const key = finalPayrollKey(record.Payroll_ID);
    const exists = await this.PayrollRecordExists(ctx, record.Payroll_ID);
    if (exists) {
      throw new Error(`Finalized payroll record ${record.Payroll_ID} already exists. Create an adjustment record instead.`);
    }

    await ctx.stub.putState(key, Buffer.from(JSON.stringify(record)));

    return JSON.stringify({
      status: 'RECORDED',
      transaction_id: ctx.stub.getTxID(),
      payroll_id: record.Payroll_ID,
      payroll_hash: record.Payroll_Hash,
      record_type: record.Record_Type,
    });
  }

  async ReadPayrollRecord(ctx, payrollId) {
    const key = finalPayrollKey(payrollId);
    const bytes = await ctx.stub.getState(key);
    if (!bytes || bytes.length === 0) {
      throw new Error(`Payroll record ${payrollId} does not exist`);
    }
    return bytes.toString();
  }

  async PayrollRecordExists(ctx, payrollId) {
    const bytes = await ctx.stub.getState(finalPayrollKey(payrollId));
    return Boolean(bytes && bytes.length > 0);
  }

  async GetPayrollHistory(ctx, payrollId) {
    const key = finalPayrollKey(payrollId);
    const historyIterator = await ctx.stub.getHistoryForKey(key);
    const finalizedHistory = await iteratorToArray(historyIterator, item => ({
      tx_id: item.txId,
      timestamp: item.timestamp,
      is_delete: item.isDelete,
      value: item.value && item.value.length ? JSON.parse(item.value.toString('utf8')) : null,
    }));

    const adjustmentIterator = await ctx.stub.getStateByPartialCompositeKey(ADJUSTMENT_OBJECT_TYPE, [String(payrollId)]);
    const adjustments = await iteratorToArray(adjustmentIterator, item => ({
      key: item.key,
      value: item.value && item.value.length ? JSON.parse(item.value.toString('utf8')) : null,
    }));

    return JSON.stringify({
      payroll_id: String(payrollId),
      finalized_history: finalizedHistory,
      adjustments,
    });
  }

  async VerifyPayrollHash(ctx, payrollId, payrollHash) {
    if (!/^[a-f0-9]{64}$/i.test(String(payrollHash))) {
      throw new Error('payrollHash must be a 64-character SHA-256 hex digest');
    }

    const record = JSON.parse(await this.ReadPayrollRecord(ctx, payrollId));
    const match = record.Payroll_Hash === String(payrollHash);

    return JSON.stringify({
      payroll_id: String(payrollId),
      match,
      blockchain_hash: record.Payroll_Hash,
      supplied_hash: String(payrollHash),
      record_type: record.Record_Type,
    });
  }

  async CreatePayrollAdjustmentRecord(ctx, payloadJson) {
    const payload = parsePayload(payloadJson);
    const record = sanitizeRecord(payload, 'ADJUSTMENT');
    validateRecord(record);

    const originalExists = await this.PayrollRecordExists(ctx, record.Payroll_ID);
    if (!originalExists) {
      throw new Error(`Original finalized payroll record ${record.Payroll_ID} must exist before an adjustment can be recorded`);
    }

    const adjustmentKey = ctx.stub.createCompositeKey(ADJUSTMENT_OBJECT_TYPE, [
      record.Payroll_ID,
      ctx.stub.getTxID(),
    ]);

    const existing = await ctx.stub.getState(adjustmentKey);
    if (existing && existing.length > 0) {
      throw new Error(`Adjustment transaction already exists for key ${adjustmentKey}`);
    }

    await ctx.stub.putState(adjustmentKey, Buffer.from(JSON.stringify(record)));

    return JSON.stringify({
      status: 'RECORDED',
      transaction_id: ctx.stub.getTxID(),
      payroll_id: record.Payroll_ID,
      payroll_hash: record.Payroll_Hash,
      record_type: record.Record_Type,
      previous_transaction_hash: record.Previous_Transaction_Hash,
    });
  }
}

module.exports = PayrollAuditContract;
