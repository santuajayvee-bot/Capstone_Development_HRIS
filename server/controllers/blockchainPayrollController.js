const pool = require('../../config/db');
const {
  buildFinalizedPayrollHashPayload,
  buildPayrollLedgerRecord,
  computePayrollHash,
  sha256Hex,
  stableStringify,
} = require('../utils/payrollHash');
const {
  createPayrollAdjustmentRecord: submitPayrollAdjustmentRecord,
  getFabricConfigStatus,
  getPayrollHistory,
  queryPayrollRecord,
  submitPayrollRecord,
  verifyPayrollHash: verifyPayrollHashOnFabric,
} = require('../services/fabricService');

const FABRIC_OFFLINE_MESSAGE = 'Blockchain network is not currently connected. Local audit records are available, but Fabric verification is disabled.';

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

function isFabricUnavailable(error) {
  return Boolean(error?.fabricUnavailable);
}

function safeDetails(details) {
  if (details === undefined || details === null) return null;
  return JSON.stringify(details);
}

function sendSafeError(res, error, fallbackMessage) {
  const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
  const message = statusCode >= 500 ? fallbackMessage : error.message;
  return res.status(statusCode).json({ error: message });
}

function normalizeStatus(status) {
  return String(status || '').trim().toUpperCase();
}

function roleCanViewFinalized(role) {
  return ['payroll_officer', 'payroll_manager', 'system_admin', 'admin'].includes(role);
}

function isSystemAdministrator(req) {
  return ['system_admin', 'admin'].includes(req.user?.role);
}

async function writeSystemAuditLog(executor, req, action, module, employeeId = null, metadata = null) {
  await executor.execute(
    `INSERT INTO system_audit_log
       (user_id, employee_id, target_employee_id, action_performed, module,
        new_value, ip_address, user_agent, timestamp, Action_Type, Description, Created_At)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NOW())`,
    [
      req.user?.id || null,
      req.user?.employeeId || null,
      employeeId,
      action,
      module,
      safeDetails(metadata),
      clientIp(req),
      req.headers['user-agent'] || 'unknown',
      action.slice(0, 100),
      metadata ? safeDetails(metadata) : action,
    ]
  );
}

async function writeBlockchainAuditLog(executor, req, payrollId, eventType, status, txHash = null, payloadHash = null, details = null) {
  await executor.execute(
    `INSERT INTO BLOCKCHAIN_AUDIT_LOG
       (Payroll_ID, Event_Type, Actor_User_ID, Actor_Role, Transaction_Hash,
        Payload_Hash, Status, IP_Address, Details, Created_At)
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
      safeDetails(details),
    ]
  );
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

async function fetchLatestRecordedPayrollAuditHash(executor, payrollId) {
  const [rows] = await executor.execute(
    `SELECT Payload_Hash, Transaction_Hash, Details, Status
       FROM BLOCKCHAIN_AUDIT_LOG
      WHERE Payroll_ID = ?
        AND Event_Type IN ('FINALIZE_RECORD','VERIFY_INTEGRITY')
        AND Status IN ('RECORDED','VERIFIED')
        AND Payload_Hash IS NOT NULL
      ORDER BY Created_At DESC, Audit_ID DESC
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

async function markPendingAnchor(req, payroll, payrollHash, eventType, fabricError, responseMessage = FABRIC_OFFLINE_MESSAGE) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE PAYROLL_RECORD
          SET Blockchain_Status = 'PENDING_ANCHOR',
              updated_at = NOW()
        WHERE Payroll_ID = ?`,
      [payroll.Payroll_ID]
    );

    await writeSystemAuditLog(connection, req, `PAYROLL_BLOCKCHAIN_PENDING_ANCHOR [PAYROLL:${payroll.Payroll_ID}]`, 'BLOCKCHAIN_PAYROLL', payroll.Employee_ID, {
      payroll_id: payroll.Payroll_ID,
      payroll_hash: payrollHash,
      fabric_error: fabricError?.message || responseMessage,
    });
    await writeBlockchainAuditLog(connection, req, payroll.Payroll_ID, eventType, 'PENDING_ANCHOR', null, payrollHash, {
      message: responseMessage,
      fabric_error: fabricError?.message || null,
      fabric_code: fabricError?.code || null,
    });
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return {
    status: 'pending_anchor',
    message: responseMessage,
    payroll_id: String(payroll.Payroll_ID),
    payroll_hash: payrollHash,
    blockchain_status: 'PENDING_ANCHOR',
  };
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

    let receipt;
    try {
      receipt = await submitPayrollRecord(ledgerRecord);
    } catch (error) {
      if (isFabricUnavailable(error)) {
        const pending = await markPendingAnchor(req, payroll, payrollHash, 'FINALIZE_RECORD', error);
        return res.status(202).json(pending);
      }
      throw error;
    }

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
      message: 'Finalized payroll hash recorded on Hyperledger Fabric.',
      payroll_id: String(payrollId),
      payroll_hash: payrollHash,
      transaction_hash: transactionHash,
      blockchain_status: 'RECORDED',
      ledger_record: ledgerRecord,
      receipt,
    });
  } catch (error) {
    console.error('[blockchain/finalizePayrollAndRecordOnBlockchain]', error);
    return sendSafeError(res, error, 'Payroll blockchain recording could not be completed.');
  }
}

async function verifyPayrollIntegrity(req, res) {
  const { payrollId } = req.params;
  let payroll = null;
  let payrollHash = null;

  try {
    if (!isSystemAdministrator(req)) {
      return res.status(403).json({ error: 'System Administrator access is required for blockchain integrity verification.' });
    }

    payroll = await fetchPayrollRecord(pool, payrollId);
    if (!payroll) {
      await writeSystemAuditLog(pool, req, `PAYROLL_INTEGRITY_SCAN_NOT_FOUND [PAYROLL:${payrollId}]`, 'BLOCKCHAIN_INTEGRITY', null, {
        payroll_id: payrollId,
        result: 'NOT_FOUND',
      });
      await writeBlockchainAuditLog(pool, req, payrollId, 'VERIFY_INTEGRITY', 'NOT_FOUND', null, null, null);
      return res.status(404).json({ error: 'Payroll record not found.' });
    }

    // A submitted payroll has no immutable Fabric entry yet, so comparing it
    // against the ledger would be misleading. It must be approved and anchored first.
    if (payroll.Approval_Status !== 'Finalized') {
      await writeSystemAuditLog(pool, req, `PAYROLL_INTEGRITY_SCAN_NOT_FINALIZED [PAYROLL:${payrollId}]`, 'BLOCKCHAIN_INTEGRITY', payroll.Employee_ID, {
        payroll_id: payrollId,
        approval_status: payroll.Approval_Status,
        result: 'NOT_FINALIZED',
      });
      await writeBlockchainAuditLog(pool, req, payrollId, 'VERIFY_INTEGRITY', 'NOT_FINALIZED', payroll.Transaction_Hash, null, {
        message: 'Verification was requested before payroll finalization.',
      });
      return res.status(409).json({
        error: 'Only finalized and recorded payroll can be verified against the blockchain.',
        status: 'not_finalized',
        payroll_id: String(payrollId),
      });
    }

    payrollHash = computePayrollHash(payroll);
    let fabricResult;
    try {
      fabricResult = await verifyPayrollHashOnFabric(payrollId, payrollHash);
    } catch (error) {
      if (isFabricUnavailable(error)) {
        const recordedAudit = await fetchLatestRecordedPayrollAuditHash(pool, payrollId);
        if (recordedAudit?.Payload_Hash) {
          const isLocalMatch = recordedAudit.Payload_Hash === payrollHash;
          const auditStatus = isLocalMatch ? 'VERIFIED' : 'CRITICAL';
          const localResult = {
            mode: 'LOCAL_RECORDED_AUDIT_HASH',
            blockchain_hash: recordedAudit.Payload_Hash,
            transaction_hash: recordedAudit.Transaction_Hash,
            fabric_error: error.message,
          };
          await writeSystemAuditLog(pool, req, isLocalMatch
            ? `PAYROLL_LOCAL_INTEGRITY_VERIFIED [PAYROLL:${payrollId}]`
            : `CRITICAL_PAYROLL_TAMPERING_DETECTED [PAYROLL:${payrollId}]`,
            isLocalMatch ? 'BLOCKCHAIN_INTEGRITY' : 'BLOCKCHAIN_SECURITY',
            payroll.Employee_ID,
            {
              payroll_id: payrollId,
              computed_hash: payrollHash,
              recorded_hash: recordedAudit.Payload_Hash,
              result: auditStatus,
              fabric_error: error.message,
            });
          await writeBlockchainAuditLog(pool, req, payrollId, 'VERIFY_INTEGRITY', auditStatus, payroll.Transaction_Hash, payrollHash, localResult);

          if (isLocalMatch) {
            return res.json({
              status: 'success',
              message: 'Payroll record integrity verified against the recorded local blockchain audit hash.',
              payroll_id: String(payrollId),
              computed_hash: payrollHash,
              blockchain_hash: recordedAudit.Payload_Hash,
            });
          }

          return res.status(409).json({
            status: 'critical',
            message: 'Tampering detected: off-chain payroll record does not match blockchain ledger.',
            payroll_id: String(payrollId),
            computed_hash: payrollHash,
            blockchain_hash: recordedAudit.Payload_Hash,
          });
        }

        await writeSystemAuditLog(pool, req, `PAYROLL_INTEGRITY_SCAN_PENDING_ANCHOR [PAYROLL:${payrollId}]`, 'BLOCKCHAIN_INTEGRITY', payroll.Employee_ID, {
          payroll_id: payrollId,
          computed_hash: payrollHash,
          fabric_error: error.message,
        });
        await writeBlockchainAuditLog(pool, req, payrollId, 'VERIFY_INTEGRITY', 'PENDING_ANCHOR', payroll.Transaction_Hash, payrollHash, {
          message: FABRIC_OFFLINE_MESSAGE,
          fabric_error: error.message,
          fabric_code: error.code || null,
        });
        return res.status(202).json({
          status: 'pending_anchor',
          message: FABRIC_OFFLINE_MESSAGE,
          payroll_id: String(payrollId),
          computed_hash: payrollHash,
          blockchain_status: payroll.Blockchain_Status,
        });
      }
      throw error;
    }

    const isMatch = Boolean(fabricResult?.match);
    const auditStatus = isMatch ? 'VERIFIED' : 'CRITICAL';
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
        message: 'Payroll record integrity verified.',
        payroll_id: String(payrollId),
        computed_hash: payrollHash,
        blockchain_hash: fabricResult.blockchain_hash,
      });
    }

    return res.status(409).json({
      status: 'critical',
      message: 'Tampering detected: off-chain payroll record does not match blockchain ledger.',
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
    return sendSafeError(res, error, 'Payroll integrity verification could not be completed.');
  }
}

async function getBlockchainAuditTrail(req, res) {
  const { payrollId } = req.params;

  try {
    const [auditLogs] = await pool.execute(
      `SELECT Audit_ID, Payroll_ID, Event_Type, Actor_User_ID, Actor_Role,
              Transaction_Hash, Payload_Hash, Status, IP_Address, Details, Created_At
         FROM BLOCKCHAIN_AUDIT_LOG
        WHERE Payroll_ID = ?
        ORDER BY Created_At DESC, Audit_ID DESC`,
      [payrollId]
    );
    const payroll = await fetchPayrollRecord(pool, payrollId);

    return res.json({
      payroll_id: String(payrollId),
      fabric: getFabricConfigStatus(),
      payroll,
      audit_logs: auditLogs,
    });
  } catch (error) {
    console.error('[blockchain/getBlockchainAuditTrail]', error);
    return res.status(500).json({ error: 'Blockchain audit trail could not be loaded.' });
  }
}

async function createPayrollAdjustment(req, res) {
  const { payrollId } = req.params;
  const adjustmentReference = String(req.body?.adjustmentReference || req.body?.reference || '').trim();
  const adjustmentReason = String(req.body?.reason || '').trim();
  const previousTransactionHash = String(req.body?.previousTransactionHash || '').trim() || null;

  if (!adjustmentReference) {
    return res.status(400).json({ error: 'adjustmentReference is required.' });
  }

  try {
    const payroll = await fetchPayrollRecord(pool, payrollId);
    assertFinalizedPayroll(payroll);

    const adjustmentPayload = {
      ...buildFinalizedPayrollHashPayload(payroll),
      Adjustment_Reference: adjustmentReference,
      Adjustment_Reason: adjustmentReason || null,
      Adjustment_Recorded_By: String(req.user.id),
      Adjustment_Recorded_At: new Date().toISOString(),
    };
    const adjustmentHash = sha256Hex(stableStringify(adjustmentPayload));
    const ledgerRecord = buildPayrollLedgerRecord(payroll, adjustmentHash, 'ADJUSTMENT', previousTransactionHash || payroll.Transaction_Hash || null);

    let receipt;
    try {
      receipt = await submitPayrollAdjustmentRecord(ledgerRecord);
    } catch (error) {
      if (isFabricUnavailable(error)) {
        await writeSystemAuditLog(pool, req, `PAYROLL_ADJUSTMENT_PENDING_ANCHOR [PAYROLL:${payrollId}]`, 'BLOCKCHAIN_PAYROLL', payroll.Employee_ID, {
          payroll_id: payrollId,
          adjustment_reference: adjustmentReference,
          adjustment_hash: adjustmentHash,
          fabric_error: error.message,
        });
        await writeBlockchainAuditLog(pool, req, payrollId, 'ADJUSTMENT_RECORD', 'PENDING_ANCHOR', null, adjustmentHash, {
          message: FABRIC_OFFLINE_MESSAGE,
          adjustment_reference: adjustmentReference,
          fabric_error: error.message,
          fabric_code: error.code || null,
        });
        return res.status(202).json({
          status: 'pending_anchor',
          message: FABRIC_OFFLINE_MESSAGE,
          payroll_id: String(payrollId),
          adjustment_hash: adjustmentHash,
        });
      }
      throw error;
    }

    const txHash = receipt?.transaction_id || receipt?.tx_id || null;
    await writeSystemAuditLog(pool, req, `PAYROLL_ADJUSTMENT_BLOCKCHAIN_RECORDED [PAYROLL:${payrollId}]`, 'BLOCKCHAIN_PAYROLL', payroll.Employee_ID, {
      payroll_id: payrollId,
      adjustment_reference: adjustmentReference,
      adjustment_hash: adjustmentHash,
      receipt,
    });
    await writeBlockchainAuditLog(pool, req, payrollId, 'ADJUSTMENT_RECORD', 'RECORDED', txHash, adjustmentHash, receipt);

    return res.status(201).json({
      status: 'success',
      message: 'Payroll adjustment hash recorded on Hyperledger Fabric.',
      payroll_id: String(payrollId),
      adjustment_hash: adjustmentHash,
      transaction_hash: txHash,
      receipt,
    });
  } catch (error) {
    console.error('[blockchain/createPayrollAdjustment]', error);
    return sendSafeError(res, error, 'Payroll adjustment blockchain recording could not be completed.');
  }
}

async function readPayrollLedgerRecord(req, res) {
  try {
    const record = await queryPayrollRecord(req.params.payrollId);
    return res.json(record);
  } catch (error) {
    if (isFabricUnavailable(error)) {
      return res.status(202).json({ status: 'pending_anchor', message: FABRIC_OFFLINE_MESSAGE });
    }
    console.error('[blockchain/readPayrollLedgerRecord]', error);
    return res.status(500).json({ error: 'Payroll ledger record could not be loaded.' });
  }
}

async function getPayrollLedgerHistory(req, res) {
  try {
    const history = await getPayrollHistory(req.params.payrollId);
    return res.json(history);
  } catch (error) {
    if (isFabricUnavailable(error)) {
      return res.status(202).json({ status: 'pending_anchor', message: FABRIC_OFFLINE_MESSAGE, history: [] });
    }
    console.error('[blockchain/getPayrollLedgerHistory]', error);
    return res.status(500).json({ error: 'Payroll ledger history could not be loaded.' });
  }
}

async function getFinalizedPayrollLedgerRecords(req, res) {
  try {
    if (!roleCanViewFinalized(req.user?.role)) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const [records] = await pool.execute(
      `SELECT pr.Payroll_ID, pr.Employee_ID, pr.Gross_Pay, pr.Total_Statutory_Deductions,
              pr.Net_Pay, pr.Non_Taxable_Allowance, pr.Approval_Status,
              pr.Transaction_Hash, pr.Blockchain_Status, pr.Finalized_At,
              pr.Approved_By, pr.created_at, pr.updated_at,
              latest.Event_Type AS Latest_Event_Type,
              latest.Status AS Latest_Audit_Status,
              latest.Payload_Hash AS Latest_Payload_Hash,
              latest.Created_At AS Latest_Audit_At,
              (
                SELECT COUNT(*)
                  FROM BLOCKCHAIN_AUDIT_LOG critical
                 WHERE critical.Payroll_ID = pr.Payroll_ID
                   AND critical.Status = 'CRITICAL'
              ) AS Critical_Audit_Count
         FROM PAYROLL_RECORD pr
         LEFT JOIN (
           SELECT bal.*
             FROM BLOCKCHAIN_AUDIT_LOG bal
             JOIN (
               SELECT Payroll_ID, MAX(Audit_ID) AS Audit_ID
                 FROM BLOCKCHAIN_AUDIT_LOG
                GROUP BY Payroll_ID
             ) picked ON picked.Audit_ID = bal.Audit_ID
         ) latest ON latest.Payroll_ID = pr.Payroll_ID
        WHERE pr.Approval_Status IN ('Submitted', 'Finalized')
           OR pr.Blockchain_Status IN ('PENDING_APPROVAL','PENDING','RECORDED','PENDING_ANCHOR','FAILED')
        ORDER BY COALESCE(pr.Finalized_At, pr.updated_at, pr.created_at) DESC
        LIMIT 500`
    );

    return res.json({
      fabric: getFabricConfigStatus(),
      records: records.map(row => ({
        ...row,
        local_hash: computePayrollHash(row),
      })),
    });
  } catch (error) {
    console.error('[blockchain/getFinalizedPayrollLedgerRecords]', error);
    return res.status(500).json({ error: 'Finalized payroll blockchain records could not be loaded.' });
  }
}

module.exports = {
  createPayrollAdjustment,
  createPayrollAdjustmentRecord: createPayrollAdjustment,
  finalizePayrollAndRecordOnBlockchain,
  getBlockchainAuditTrail,
  getFinalizedPayrollLedgerRecords,
  getPayrollLedgerHistory,
  readPayrollLedgerRecord,
  verifyPayrollIntegrity,
  normalizeStatus,
};
