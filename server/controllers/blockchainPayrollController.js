const pool = require('../../config/db');
const {
  buildFinalizedPayrollHashPayload,
  buildPayrollLedgerRecord,
  computePayrollHash,
  stableStringify,
} = require('../utils/payrollHash');
const {
  getPayrollHistory,
  queryPayrollRecord,
  submitPayrollAdjustmentRecord,
  submitPayrollRecord,
  verifyPayrollHash: verifyPayrollHashOnFabric,
} = require('../services/fabricService');

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

async function writeSystemAuditLog(executor, req, action, module, employeeId = null, metadata = null) {
  await executor.execute(
    `INSERT INTO system_audit_log
       (user_id, employee_id, action_performed, module, new_value, ip_address, user_agent, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      req.user?.id || null,
      employeeId,
      action,
      module,
      metadata ? JSON.stringify(metadata) : null,
      clientIp(req),
      req.headers['user-agent'] || 'unknown',
    ]
  );
}

async function writeBlockchainAuditLog(executor, req, payrollId, eventType, status, txHash = null, payloadHash = null, details = null) {
  await executor.execute(
    `INSERT INTO BLOCKCHAIN_AUDIT_LOG
       (Payroll_ID, Event_Type, Actor_User_ID, Actor_Role, Transaction_Hash, Payload_Hash, Status, IP_Address, Details, Created_At)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      payrollId,
      eventType,
      req.user?.id || null,
      req.user?.role || null,
      txHash,
      payloadHash,
      status,
      clientIp(req),
      details ? JSON.stringify(details) : null,
    ]
  ).catch(() => {});
}

async function fetchPayrollRecord(executor, payrollId) {
  const [rows] = await executor.execute(
    `SELECT Payroll_ID, Employee_ID, Gross_Pay, Total_Statutory_Deductions,
            Net_Pay, Non_Taxable_Allowance, Approval_Status,
            Transaction_Hash, Blockchain_Status, Finalized_At,
            Approved_By, created_at, updated_at
       FROM PAYROLL_RECORD
      WHERE Payroll_ID = ?
      LIMIT 1`,
    [payrollId]
  );
  return rows[0] || null;
}

function assertFinalizedPayroll(row) {
  if (!row) {
    const error = new Error('Payroll record not found.');
    error.statusCode = 404;
    throw error;
  }
  if (row.Approval_Status !== 'Finalized') {
    const error = new Error('Only finalized payroll records can be recorded on-chain.');
    error.statusCode = 409;
    throw error;
  }
}

async function finalizePayrollAndRecordOnBlockchain(req, res) {
  const payrollId = req.params.payrollId || req.body.payrollId;
  if (!payrollId) return res.status(400).json({ error: 'payrollId is required.' });

  try {
    const payroll = await fetchPayrollRecord(pool, payrollId);
    assertFinalizedPayroll(payroll);

    if (payroll.Blockchain_Status === 'RECORDED' && payroll.Transaction_Hash) {
      return res.status(409).json({
        error: 'Payroll record has already been recorded on the blockchain.',
        transaction_hash: payroll.Transaction_Hash,
      });
    }

    const payrollHash = computePayrollHash(payroll);
    const ledgerRecord = buildPayrollLedgerRecord(payroll, payrollHash);
    const receipt = await submitPayrollRecord(ledgerRecord);
    const transactionHash = receipt?.transaction_id || receipt?.tx_id || receipt?.receipt || payrollHash;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `UPDATE PAYROLL_RECORD
            SET Transaction_Hash = ?,
                Blockchain_Status = 'RECORDED',
                updated_at = NOW()
          WHERE Payroll_ID = ?`,
        [transactionHash, payrollId]
      );

      await writeSystemAuditLog(connection, req, `PAYROLL_BLOCKCHAIN_RECORDED [PAYROLL:${payrollId}]`, 'BLOCKCHAIN_PAYROLL', payroll.Employee_ID, {
        payroll_id: payrollId,
        transaction_hash: transactionHash,
        payroll_hash: payrollHash,
      });
      await writeBlockchainAuditLog(connection, req, payrollId, 'FINALIZE_RECORD', 'RECORDED', transactionHash, payrollHash, receipt);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return res.json({
      status: 'success',
      message: 'Finalized payroll hash recorded on Hyperledger Fabric',
      payroll_id: String(payrollId),
      payroll_hash: payrollHash,
      transaction_hash: transactionHash,
      ledger_record: ledgerRecord,
      receipt,
    });
  } catch (error) {
    console.error('[blockchain/finalizePayrollAndRecordOnBlockchain]', error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}

async function verifyPayrollIntegrity(req, res) {
  const { payrollId } = req.params;
  let auditStatus = 'VERIFIED';
  let payroll = null;
  let payrollHash = null;
  let fabricResult = null;

  try {
    payroll = await fetchPayrollRecord(pool, payrollId);
    if (!payroll) {
      await writeSystemAuditLog(pool, req, `PAYROLL_INTEGRITY_SCAN_NOT_FOUND [PAYROLL:${payrollId}]`, 'BLOCKCHAIN_INTEGRITY', null, {
        payroll_id: payrollId,
        result: 'NOT_FOUND',
      });
      await writeBlockchainAuditLog(pool, req, payrollId, 'VERIFY_INTEGRITY', 'NOT_FOUND', null, null, null);
      return res.status(404).json({ error: 'Payroll record not found.' });
    }

    payrollHash = computePayrollHash(payroll);
    fabricResult = await verifyPayrollHashOnFabric(payrollId, payrollHash);
    const isMatch = Boolean(fabricResult?.match);
    auditStatus = isMatch ? 'VERIFIED' : 'CRITICAL';

    await writeSystemAuditLog(pool, req, isMatch
      ? `PAYROLL_INTEGRITY_VERIFIED [PAYROLL:${payrollId}]`
      : `CRITICAL_PAYROLL_TAMPERING_DETECTED [PAYROLL:${payrollId}]`,
      isMatch ? 'BLOCKCHAIN_INTEGRITY' : 'BLOCKCHAIN_SECURITY',
      payroll.Employee_ID,
      {
        payroll_id: payrollId,
        computed_hash: payrollHash,
        blockchain_hash: fabricResult?.blockchain_hash || null,
        result: auditStatus,
      });
    await writeBlockchainAuditLog(pool, req, payrollId, 'VERIFY_INTEGRITY', auditStatus, payroll.Transaction_Hash, payrollHash, fabricResult);

    if (isMatch) {
      return res.json({
        status: 'success',
        message: 'Payroll record integrity verified',
        payroll_id: String(payrollId),
        computed_hash: payrollHash,
        blockchain_hash: fabricResult.blockchain_hash,
      });
    }

    return res.status(409).json({
      status: 'critical',
      message: 'Tampering detected: off-chain payroll record does not match blockchain ledger',
      payroll_id: String(payrollId),
      computed_hash: payrollHash,
      blockchain_hash: fabricResult?.blockchain_hash || null,
    });
  } catch (error) {
    console.error('[blockchain/verifyPayrollIntegrity]', error);
    if (payroll) {
      await writeSystemAuditLog(pool, req, `PAYROLL_INTEGRITY_SCAN_FAILED [PAYROLL:${payrollId}]`, 'BLOCKCHAIN_INTEGRITY', payroll.Employee_ID, {
        payroll_id: payrollId,
        computed_hash: payrollHash,
        error: error.message,
      }).catch(() => {});
      await writeBlockchainAuditLog(pool, req, payrollId, 'VERIFY_INTEGRITY', 'FAILED', payroll.Transaction_Hash, payrollHash, { error: error.message }).catch(() => {});
    }
    return res.status(500).json({ error: error.message });
  }
}

async function readPayrollLedgerRecord(req, res) {
  try {
    const record = await queryPayrollRecord(req.params.payrollId);
    return res.json(record);
  } catch (error) {
    console.error('[blockchain/readPayrollLedgerRecord]', error);
    return res.status(500).json({ error: error.message });
  }
}

async function getPayrollLedgerHistory(req, res) {
  try {
    const history = await getPayrollHistory(req.params.payrollId);
    return res.json(history);
  } catch (error) {
    console.error('[blockchain/getPayrollLedgerHistory]', error);
    return res.status(500).json({ error: error.message });
  }
}

async function createPayrollAdjustmentRecord(req, res) {
  const { payrollId } = req.params;
  const { adjustmentReference, previousTransactionHash } = req.body;

  try {
    const payroll = await fetchPayrollRecord(pool, payrollId);
    assertFinalizedPayroll(payroll);

    const adjustmentPayload = {
      ...buildFinalizedPayrollHashPayload(payroll),
      Adjustment_Reference: String(adjustmentReference || ''),
      Adjustment_Recorded_By: String(req.user.id),
      Adjustment_Recorded_At: new Date().toISOString(),
    };
    const adjustmentHash = require('../utils/payrollHash').sha256Hex(stableStringify(adjustmentPayload));
    const ledgerRecord = buildPayrollLedgerRecord(payroll, adjustmentHash, 'ADJUSTMENT', previousTransactionHash || payroll.Transaction_Hash || null);
    const receipt = await submitPayrollAdjustmentRecord(ledgerRecord);

    await writeSystemAuditLog(pool, req, `PAYROLL_ADJUSTMENT_BLOCKCHAIN_RECORDED [PAYROLL:${payrollId}]`, 'BLOCKCHAIN_PAYROLL', payroll.Employee_ID, {
      payroll_id: payrollId,
      adjustment_hash: adjustmentHash,
      receipt,
    });
    await writeBlockchainAuditLog(pool, req, payrollId, 'ADJUSTMENT_RECORD', 'RECORDED', receipt?.transaction_id || null, adjustmentHash, receipt);

    return res.status(201).json({
      status: 'success',
      message: 'Payroll adjustment hash recorded on Hyperledger Fabric',
      payroll_id: String(payrollId),
      adjustment_hash: adjustmentHash,
      receipt,
    });
  } catch (error) {
    console.error('[blockchain/createPayrollAdjustmentRecord]', error);
    return res.status(error.statusCode || 500).json({ error: error.message });
  }
}

module.exports = {
  createPayrollAdjustmentRecord,
  finalizePayrollAndRecordOnBlockchain,
  getPayrollLedgerHistory,
  readPayrollLedgerRecord,
  verifyPayrollIntegrity,
};
