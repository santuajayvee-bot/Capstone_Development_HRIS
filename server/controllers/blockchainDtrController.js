const pool = require('../../config/db');
const {
  buildDTRLedgerRecord,
  buildFinalizedDTRHashPayload,
  computeDTRHash,
  normalizeDateOnly,
  sha256Hex,
  stableStringify,
} = require('../utils/dtrHash');
const {
  getFabricConfigStatus,
  getDTRHistory,
  queryDTRRecord,
  submitDTRAdjustmentRecord,
  submitDTRRecord,
  verifyDTRHash: verifyDTRHashOnFabric,
} = require('../services/fabricService');
const { isStrictDateOnly } = require('../utils/dateValidation');

const FABRIC_OFFLINE_MESSAGE = 'Blockchain network is not currently connected. Local DTR audit records are available, but Fabric verification is disabled.';
const FABRIC_CHAINCODE_NOT_READY_MESSAGE = 'Fabric is reachable, but the deployed chaincode is not ready for DTR anchoring yet. The DTR is finalized in MySQL and queued as PENDING_ANCHOR.';
const FABRIC_UNAVAILABLE_MESSAGE = 'Fabric anchoring is temporarily unavailable. The DTR is finalized in MySQL and queued as PENDING_ANCHOR.';

const DTR_GENERATE_ALLOWED_FIELDS = new Set([
  'start_date',
  'end_date',
  'date_range_start',
  'date_range_end',
  'Date_Range_Start',
  'Date_Range_End',
  'remarks',
]);

const DTR_ADJUSTMENT_ALLOWED_FIELDS = new Set([
  'adjustmentReference',
  'adjustment_reference',
  'reference',
  'reason',
  'remarks',
  'previousTransactionHash',
  'previous_transaction_hash',
]);

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

function safeDetails(details) {
  if (details === undefined || details === null) return null;
  return JSON.stringify(details);
}

function isFabricUnavailable(error) {
  return Boolean(error?.fabricUnavailable);
}

function isSystemAdministrator(req) {
  return ['system_admin', 'admin'].includes(req.user?.role);
}

function dtrPendingAnchorMessage(error) {
  if (error?.code === 'FABRIC_DISABLED') return FABRIC_OFFLINE_MESSAGE;
  if (error?.code === 'FABRIC_CONFIG_MISSING' || error?.code === 'FABRIC_CREDENTIAL_FILE_MISSING' || error?.code === 'FABRIC_KEY_DIRECTORY_MISSING') {
    return 'Fabric identity configuration is incomplete. The DTR is finalized in MySQL and queued as PENDING_ANCHOR.';
  }
  if (error?.code === 'FABRIC_GATEWAY_ERROR' && /function that does not exist|chaincode/i.test(error.message || '')) {
    return FABRIC_CHAINCODE_NOT_READY_MESSAGE;
  }
  return FABRIC_UNAVAILABLE_MESSAGE;
}

function sendSafeError(res, error, fallbackMessage) {
  const statusCode = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
  const message = statusCode >= 500 ? fallbackMessage : error.message;
  return res.status(statusCode).json({ error: message });
}

function cleanText(value, max = 500) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[<>]/g, '')
    .trim()
    .slice(0, max);
}

function positiveInteger(value, fieldName) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    const error = new Error(`${fieldName} must be a positive integer.`);
    error.statusCode = 400;
    throw error;
  }
  return number;
}

function assertAllowedFields(body, allowedFields) {
  const unknown = Object.keys(body || {}).filter(field => !allowedFields.has(field));
  if (unknown.length) {
    const error = new Error('Request contains unsupported field(s).');
    error.statusCode = 400;
    error.fields = unknown;
    throw error;
  }
}

function isDate(value) {
  return typeof value === 'string' && isStrictDateOnly(value);
}

function dateRangeFromBody(body = {}) {
  const start = cleanText(body.date_range_start || body.start_date || body.Date_Range_Start, 10);
  const end = cleanText(body.date_range_end || body.end_date || body.Date_Range_End, 10);
  if (!isDate(start) || !isDate(end)) {
    const error = new Error('date_range_start/start_date and date_range_end/end_date must use YYYY-MM-DD format.');
    error.statusCode = 400;
    throw error;
  }
  if (end < start) {
    const error = new Error('DTR end date cannot be earlier than start date.');
    error.statusCode = 400;
    throw error;
  }

  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const days = Math.floor((endMs - startMs) / 86400000) + 1;
  if (days > 366) {
    const error = new Error('DTR date range cannot exceed 366 days.');
    error.statusCode = 400;
    throw error;
  }

  return { start, end };
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

async function writeDTRBlockchainAuditLog(executor, req, dtrId, eventType, status, txHash = null, payloadHash = null, details = null) {
  await executor.execute(
    `INSERT INTO DTR_BLOCKCHAIN_AUDIT_LOG
       (DTR_ID, Event_Type, Actor_User_ID, Actor_Role, Transaction_Hash,
        Payload_Hash, Status, IP_Address, Details, Created_At)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      dtrId,
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

async function fetchDTRRecord(executor, dtrId, forUpdate = false) {
  const [rows] = await executor.execute(
    `SELECT DTR_ID, Employee_ID,
            DATE_FORMAT(Date_Range_Start, '%Y-%m-%d') AS Date_Range_Start,
            DATE_FORMAT(Date_Range_End, '%Y-%m-%d') AS Date_Range_End,
            Total_Work_Hours, Total_Late_Minutes, Total_Undertime_Minutes,
            Total_Overtime_Hours, Attendance_Status, Generated_By, Verified_By,
            Finalized_At, DTR_Hash, Transaction_Hash, Blockchain_Status,
            Source_Summary_Count, Audit_Summary, Remarks, created_at, updated_at
       FROM DTR_RECORD
      WHERE DTR_ID = ?
      LIMIT 1
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [dtrId]
  );
  return rows[0] || null;
}

function assertFinalizedDTR(row) {
  if (!row) {
    const error = new Error('DTR record not found.');
    error.statusCode = 404;
    throw error;
  }
  if (!row.Finalized_At) {
    const error = new Error('Only finalized DTR records can be recorded on-chain.');
    error.statusCode = 409;
    throw error;
  }
}

function publicDTRStatus(row) {
  if (!row) return null;
  return {
    dtr_id: String(row.DTR_ID),
    employee_id: String(row.Employee_ID),
    date_range_start: normalizeDateOnly(row.Date_Range_Start),
    date_range_end: normalizeDateOnly(row.Date_Range_End),
    attendance_status: row.Attendance_Status,
    blockchain_status: row.Blockchain_Status,
    finalized_at: row.Finalized_At,
    source_summary_count: row.Source_Summary_Count,
  };
}

function privilegedDTRPayload(row) {
  if (!row) return null;
  return {
    ...row,
    local_hash: computeDTRHash(row),
  };
}

async function fetchEmployee(executor, employeeId) {
  const [rows] = await executor.execute(
    `SELECT id, employee_code, status
       FROM employees
      WHERE id = ?
      LIMIT 1`,
    [employeeId]
  );
  return rows[0] || null;
}

async function fetchAttendanceAggregate(executor, employeeId, start, end) {
  const [[aggregate], [statusRows]] = await Promise.all([
    executor.execute(
      `SELECT COUNT(*) AS summary_count,
              COALESCE(SUM(regular_minutes), 0) AS total_regular_minutes,
              COALESCE(SUM(overtime_minutes), 0) AS total_overtime_minutes,
              COALESCE(SUM(late_minutes), 0) AS total_late_minutes,
              COALESCE(SUM(undertime_minutes), 0) AS total_undertime_minutes,
              COALESCE(SUM(CASE WHEN payroll_eligible = 1 THEN 1 ELSE 0 END), 0) AS payroll_ready_count,
              COALESCE(SUM(CASE WHEN verification_status IN ('PAYROLL_READY','VALIDATED','CORRECTED_BY_HR') THEN 1 ELSE 0 END), 0) AS verified_count
         FROM attendance_summary
        WHERE employee_id = ?
          AND attendance_date BETWEEN ? AND ?`,
      [employeeId, start, end]
    ),
    executor.execute(
      `SELECT attendance_status, verification_status, payroll_eligible, COUNT(*) AS count
         FROM attendance_summary
        WHERE employee_id = ?
          AND attendance_date BETWEEN ? AND ?
        GROUP BY attendance_status, verification_status, payroll_eligible
        ORDER BY attendance_status, verification_status, payroll_eligible`,
      [employeeId, start, end]
    ),
  ]);

  const row = aggregate[0] || {};
  const count = Number(row.summary_count || 0);
  if (!count) {
    const error = new Error('No attendance summaries found for the selected employee and date range.');
    error.statusCode = 409;
    throw error;
  }

  const payrollReadyCount = Number(row.payroll_ready_count || 0);
  const verifiedCount = Number(row.verified_count || 0);
  const attendanceStatus = payrollReadyCount === count
    ? 'VERIFIED'
    : verifiedCount === count
      ? 'FINALIZED_WITH_EXCEPTIONS'
      : 'FINALIZED_WITH_EXCEPTIONS';

  const summary = {
    summary_count: count,
    payroll_ready_count: payrollReadyCount,
    verified_count: verifiedCount,
    status_counts: statusRows.map(item => ({
      attendance_status: item.attendance_status,
      verification_status: item.verification_status,
      payroll_eligible: Number(item.payroll_eligible || 0),
      count: Number(item.count || 0),
    })),
  };

  return {
    totalWorkHours: (Number(row.total_regular_minutes || 0) / 60).toFixed(2),
    totalOvertimeHours: (Number(row.total_overtime_minutes || 0) / 60).toFixed(2),
    totalLateMinutes: Math.trunc(Number(row.total_late_minutes || 0)),
    totalUndertimeMinutes: Math.trunc(Number(row.total_undertime_minutes || 0)),
    attendanceStatus,
    sourceSummaryCount: count,
    auditSummary: summary,
  };
}

async function markDTRPendingAnchor(req, dtr, dtrHash, eventType, fabricError, responseMessage = null) {
  const pendingMessage = responseMessage || dtrPendingAnchorMessage(fabricError);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE DTR_RECORD
          SET DTR_Hash = ?,
              Blockchain_Status = 'PENDING_ANCHOR',
              updated_at = NOW()
        WHERE DTR_ID = ?`,
      [dtrHash, dtr.DTR_ID]
    );
    await writeSystemAuditLog(connection, req, `DTR_BLOCKCHAIN_PENDING_ANCHOR [DTR:${dtr.DTR_ID}]`, 'BLOCKCHAIN_DTR', dtr.Employee_ID, {
      dtr_id: dtr.DTR_ID,
      dtr_hash: dtrHash,
      fabric_error: fabricError?.message || pendingMessage,
      fabric_code: fabricError?.code || null,
    });
    await writeDTRBlockchainAuditLog(connection, req, dtr.DTR_ID, eventType, 'PENDING_ANCHOR', null, dtrHash, {
      message: pendingMessage,
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
    message: pendingMessage,
    dtr_id: String(dtr.DTR_ID),
    dtr_hash: dtrHash,
    blockchain_status: 'PENDING_ANCHOR',
  };
}

async function anchorDTRRecord(req, dtr, eventType = 'FINALIZE_RECORD') {
  assertFinalizedDTR(dtr);
  if (dtr.Blockchain_Status === 'RECORDED' && dtr.Transaction_Hash) {
    const error = new Error('DTR record has already been recorded on the blockchain.');
    error.statusCode = 409;
    throw error;
  }

  const dtrHash = computeDTRHash(dtr);
  if (dtr.DTR_Hash && dtr.DTR_Hash !== dtrHash) {
    const error = new Error('Critical tampering alert: off-chain DTR fields no longer match the saved DTR hash.');
    error.statusCode = 409;
    error.critical = true;
    throw error;
  }

  const ledgerRecord = buildDTRLedgerRecord(dtr, dtrHash);
  let receipt;
  try {
    receipt = await submitDTRRecord(ledgerRecord);
  } catch (error) {
    if (isFabricUnavailable(error)) {
      return markDTRPendingAnchor(req, dtr, dtrHash, eventType, error);
    }
    throw error;
  }

  const transactionHash = receipt?.transaction_id || receipt?.tx_id || receipt?.receipt || dtrHash;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `UPDATE DTR_RECORD
          SET DTR_Hash = ?,
              Transaction_Hash = ?,
              Blockchain_Status = 'RECORDED',
              updated_at = NOW()
        WHERE DTR_ID = ?`,
      [dtrHash, transactionHash, dtr.DTR_ID]
    );
    await writeSystemAuditLog(connection, req, `DTR_BLOCKCHAIN_RECORDED [DTR:${dtr.DTR_ID}]`, 'BLOCKCHAIN_DTR', dtr.Employee_ID, {
      dtr_id: dtr.DTR_ID,
      transaction_hash: transactionHash,
      dtr_hash: dtrHash,
    });
    await writeDTRBlockchainAuditLog(connection, req, dtr.DTR_ID, eventType, 'RECORDED', transactionHash, dtrHash, receipt);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return {
    status: 'success',
    message: 'Finalized DTR hash recorded on Hyperledger Fabric.',
    dtr_id: String(dtr.DTR_ID),
    dtr_hash: dtrHash,
    transaction_hash: transactionHash,
    blockchain_status: 'RECORDED',
    ledger_record: ledgerRecord,
    receipt,
  };
}

async function generateFinalizedDTR(req, employeeId, start, end, remarks) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const employee = await fetchEmployee(connection, employeeId);
    if (!employee) {
      const error = new Error('Employee not found.');
      error.statusCode = 404;
      throw error;
    }

    const [existing] = await connection.execute(
      `SELECT DTR_ID, Blockchain_Status
         FROM DTR_RECORD
        WHERE Employee_ID = ?
          AND Date_Range_Start = ?
          AND Date_Range_End = ?
        ORDER BY DTR_ID DESC
        LIMIT 1
        FOR UPDATE`,
      [employeeId, start, end]
    );
    if (existing.length) {
      const error = new Error('A finalized DTR already exists for this employee and date range. Create an adjustment record instead of regenerating it.');
      error.statusCode = 409;
      error.existingDtrId = existing[0].DTR_ID;
      throw error;
    }

    const aggregate = await fetchAttendanceAggregate(connection, employeeId, start, end);
    const [result] = await connection.execute(
      `INSERT INTO DTR_RECORD
         (Employee_ID, Date_Range_Start, Date_Range_End, Total_Work_Hours,
          Total_Late_Minutes, Total_Undertime_Minutes, Total_Overtime_Hours,
          Attendance_Status, Generated_By, Verified_By, Finalized_At,
          Blockchain_Status, Source_Summary_Count, Audit_Summary, Remarks)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'PENDING', ?, ?, ?)`,
      [
        employeeId,
        start,
        end,
        aggregate.totalWorkHours,
        aggregate.totalLateMinutes,
        aggregate.totalUndertimeMinutes,
        aggregate.totalOvertimeHours,
        aggregate.attendanceStatus,
        req.user?.id || null,
        req.user?.id || null,
        aggregate.sourceSummaryCount,
        JSON.stringify(aggregate.auditSummary),
        remarks || null,
      ]
    );

    const dtr = await fetchDTRRecord(connection, result.insertId, true);
    const dtrHash = computeDTRHash(dtr);
    await connection.execute(
      `UPDATE DTR_RECORD
          SET DTR_Hash = ?
        WHERE DTR_ID = ?`,
      [dtrHash, dtr.DTR_ID]
    );
    dtr.DTR_Hash = dtrHash;

    await writeSystemAuditLog(connection, req, `DTR_GENERATED_AND_FINALIZED [DTR:${dtr.DTR_ID}]`, 'BLOCKCHAIN_DTR', employeeId, {
      dtr_id: dtr.DTR_ID,
      employee_id: employeeId,
      date_range_start: start,
      date_range_end: end,
      attendance_status: aggregate.attendanceStatus,
      source_summary_count: aggregate.sourceSummaryCount,
      dtr_hash: dtrHash,
    });
    await writeDTRBlockchainAuditLog(connection, req, dtr.DTR_ID, 'GENERATE_FINALIZE', 'FINALIZED', null, dtrHash, {
      employee_reference: buildDTRLedgerRecord(dtr, dtrHash).Employee_Reference,
      date_range_start: start,
      date_range_end: end,
      attendance_status: aggregate.attendanceStatus,
      source_summary_count: aggregate.sourceSummaryCount,
    });

    await connection.commit();
    return dtr;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function generateAndAnchorDTR(req, res) {
  try {
    assertAllowedFields(req.body || {}, DTR_GENERATE_ALLOWED_FIELDS);
    const employeeId = positiveInteger(req.params.employeeId, 'employeeId');
    const { start, end } = dateRangeFromBody(req.body || {});
    const remarks = cleanText(req.body?.remarks, 500) || null;

    const dtr = await generateFinalizedDTR(req, employeeId, start, end, remarks);
    const result = await anchorDTRRecord(req, dtr, 'FINALIZE_RECORD');
    const statusCode = result.status === 'pending_anchor' ? 202 : 201;
    return res.status(statusCode).json(result);
  } catch (error) {
    if (error.fields) {
      return res.status(error.statusCode || 400).json({ error: error.message, fields: error.fields });
    }
    if (error.existingDtrId) {
      return res.status(error.statusCode || 409).json({ error: error.message, existing_dtr_id: String(error.existingDtrId) });
    }
    console.error('[blockchain/generateAndAnchorDTR]', error);
    return sendSafeError(res, error, 'DTR generation and blockchain anchoring could not be completed.');
  }
}

async function recordDTROnBlockchain(req, res) {
  try {
    const dtrId = positiveInteger(req.params.dtrId, 'dtrId');
    const dtr = await fetchDTRRecord(pool, dtrId);
    const result = await anchorDTRRecord(req, dtr, 'ANCHOR_RECORD');
    const statusCode = result.status === 'pending_anchor' ? 202 : 200;
    return res.status(statusCode).json(result);
  } catch (error) {
    console.error('[blockchain/recordDTROnBlockchain]', error);
    return sendSafeError(res, error, 'DTR blockchain recording could not be completed.');
  }
}

async function verifyDTRIntegrity(req, res) {
  const dtrId = req.params.dtrId;
  let dtr = null;
  let dtrHash = null;

  try {
    if (!isSystemAdministrator(req)) {
      return res.status(403).json({ error: 'System Administrator access is required for blockchain integrity verification.' });
    }

    dtr = await fetchDTRRecord(pool, positiveInteger(dtrId, 'dtrId'));
    if (!dtr) {
      await writeDTRBlockchainAuditLog(pool, req, Number(dtrId) || 0, 'VERIFY_INTEGRITY', 'NOT_FOUND', null, null, null).catch(() => {});
      return res.status(404).json({ error: 'DTR record not found.' });
    }

    assertFinalizedDTR(dtr);
    dtrHash = computeDTRHash(dtr);

    if (dtr.DTR_Hash && dtr.DTR_Hash !== dtrHash) {
      await writeSystemAuditLog(pool, req, `CRITICAL_DTR_LOCAL_TAMPERING_DETECTED [DTR:${dtr.DTR_ID}]`, 'BLOCKCHAIN_SECURITY', dtr.Employee_ID, {
        dtr_id: dtr.DTR_ID,
        saved_hash: dtr.DTR_Hash,
        computed_hash: dtrHash,
      });
      await writeDTRBlockchainAuditLog(pool, req, dtr.DTR_ID, 'VERIFY_INTEGRITY', 'CRITICAL', dtr.Transaction_Hash, dtrHash, {
        message: 'Saved DTR hash does not match current off-chain DTR fields.',
        saved_hash: dtr.DTR_Hash,
      });
      return res.status(409).json({
        status: 'critical',
        message: 'Critical tampering alert: off-chain DTR fields do not match the saved DTR hash.',
        dtr_id: String(dtr.DTR_ID),
        computed_hash: dtrHash,
        saved_hash: dtr.DTR_Hash,
      });
    }

    if (dtr.Blockchain_Status !== 'RECORDED' || !dtr.Transaction_Hash) {
      await writeDTRBlockchainAuditLog(pool, req, dtr.DTR_ID, 'VERIFY_INTEGRITY', 'PENDING_ANCHOR', dtr.Transaction_Hash, dtrHash, {
        message: 'DTR has not been anchored to Fabric yet.',
      });
      return res.status(202).json({
        status: 'pending_anchor',
        message: 'DTR has not been anchored to Fabric yet.',
        dtr_id: String(dtr.DTR_ID),
        computed_hash: dtrHash,
        blockchain_status: dtr.Blockchain_Status,
      });
    }

    let fabricResult;
    try {
      fabricResult = await verifyDTRHashOnFabric(dtr.DTR_ID, dtrHash);
    } catch (error) {
      if (isFabricUnavailable(error)) {
        await writeSystemAuditLog(pool, req, `DTR_INTEGRITY_SCAN_PENDING_ANCHOR [DTR:${dtr.DTR_ID}]`, 'BLOCKCHAIN_INTEGRITY', dtr.Employee_ID, {
          dtr_id: dtr.DTR_ID,
          computed_hash: dtrHash,
          fabric_error: error.message,
        });
        await writeDTRBlockchainAuditLog(pool, req, dtr.DTR_ID, 'VERIFY_INTEGRITY', 'PENDING_ANCHOR', dtr.Transaction_Hash, dtrHash, {
          message: FABRIC_OFFLINE_MESSAGE,
          fabric_error: error.message,
          fabric_code: error.code || null,
        });
        return res.status(202).json({
          status: 'pending_anchor',
          message: FABRIC_OFFLINE_MESSAGE,
          dtr_id: String(dtr.DTR_ID),
          computed_hash: dtrHash,
          blockchain_status: dtr.Blockchain_Status,
        });
      }
      throw error;
    }

    const isMatch = Boolean(fabricResult?.match);
    const auditStatus = isMatch ? 'VERIFIED' : 'CRITICAL';
    await writeSystemAuditLog(pool, req, isMatch
      ? `DTR_INTEGRITY_VERIFIED [DTR:${dtr.DTR_ID}]`
      : `CRITICAL_DTR_TAMPERING_DETECTED [DTR:${dtr.DTR_ID}]`,
      isMatch ? 'BLOCKCHAIN_INTEGRITY' : 'BLOCKCHAIN_SECURITY',
      dtr.Employee_ID,
      {
        dtr_id: dtr.DTR_ID,
        computed_hash: dtrHash,
        blockchain_hash: fabricResult?.blockchain_hash || null,
        result: auditStatus,
      });
    await writeDTRBlockchainAuditLog(pool, req, dtr.DTR_ID, 'VERIFY_INTEGRITY', auditStatus, dtr.Transaction_Hash, dtrHash, fabricResult);

    if (isMatch) {
      return res.json({
        status: 'success',
        message: 'DTR integrity verified.',
        dtr_id: String(dtr.DTR_ID),
        computed_hash: dtrHash,
        blockchain_hash: fabricResult.blockchain_hash,
      });
    }

    return res.status(409).json({
      status: 'critical',
      message: 'Critical tampering alert: off-chain DTR record does not match blockchain ledger.',
      dtr_id: String(dtr.DTR_ID),
      computed_hash: dtrHash,
      blockchain_hash: fabricResult?.blockchain_hash || null,
    });
  } catch (error) {
    console.error('[blockchain/verifyDTRIntegrity]', error);
    if (dtr) {
      await writeSystemAuditLog(pool, req, `DTR_INTEGRITY_SCAN_FAILED [DTR:${dtr.DTR_ID}]`, 'BLOCKCHAIN_INTEGRITY', dtr.Employee_ID, {
        dtr_id: dtr.DTR_ID,
        computed_hash: dtrHash,
        error: error.message,
      }).catch(() => {});
      await writeDTRBlockchainAuditLog(pool, req, dtr.DTR_ID, 'VERIFY_INTEGRITY', 'FAILED', dtr.Transaction_Hash, dtrHash, { error: error.message }).catch(() => {});
    }
    return sendSafeError(res, error, 'DTR integrity verification could not be completed.');
  }
}

function canViewPrivilegedDTR(req) {
  return ['hr_admin', 'hr_manager', 'payroll_officer', 'payroll_manager', 'system_admin', 'admin'].includes(req.user?.role);
}

async function getDTRAuditTrail(req, res) {
  try {
    const dtrId = positiveInteger(req.params.dtrId, 'dtrId');
    const dtr = await fetchDTRRecord(pool, dtrId);
    if (!dtr) return res.status(404).json({ error: 'DTR record not found.' });

    if (req.user?.role === 'employee') {
      if (Number(req.user.employeeId) !== Number(dtr.Employee_ID)) {
        return res.status(403).json({ error: 'Employees can only view their own DTR status.' });
      }
      return res.json({
        dtr_id: String(dtrId),
        dtr: publicDTRStatus(dtr),
      });
    }

    if (!canViewPrivilegedDTR(req)) return res.status(403).json({ error: 'Access denied.' });

    const [auditLogs] = await pool.execute(
      `SELECT Audit_ID, DTR_ID, Event_Type, Actor_User_ID, Actor_Role,
              Transaction_Hash, Payload_Hash, Status, IP_Address, Details, Created_At
         FROM DTR_BLOCKCHAIN_AUDIT_LOG
        WHERE DTR_ID = ?
        ORDER BY Created_At DESC, Audit_ID DESC`,
      [dtrId]
    );
    const [adjustments] = await pool.execute(
      `SELECT Adjustment_ID, DTR_ID, Adjustment_Reference, Reason,
              Previous_DTR_Hash, Adjustment_Hash, Transaction_Hash,
              Blockchain_Status, Created_By, Created_At, Details
         FROM DTR_ADJUSTMENT_RECORD
        WHERE DTR_ID = ?
        ORDER BY Created_At DESC, Adjustment_ID DESC`,
      [dtrId]
    );

    return res.json({
      dtr_id: String(dtrId),
      fabric: getFabricConfigStatus(),
      dtr: privilegedDTRPayload(dtr),
      audit_logs: auditLogs,
      adjustments,
    });
  } catch (error) {
    console.error('[blockchain/getDTRAuditTrail]', error);
    return sendSafeError(res, error, 'DTR audit trail could not be loaded.');
  }
}

async function getFinalizedDTRLedgerRecords(req, res) {
  try {
    if (!canViewPrivilegedDTR(req) && req.user?.role !== 'employee') {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const params = [];
    let employeeFilter = '';
    if (req.user?.role === 'employee') {
      employeeFilter = 'WHERE dr.Employee_ID = ?';
      params.push(req.user.employeeId || req.user.Employee_ID || 0);
    }

    const [records] = await pool.execute(
      `SELECT dr.DTR_ID, dr.Employee_ID, e.employee_code AS Employee_Code,
              DATE_FORMAT(dr.Date_Range_Start, '%Y-%m-%d') AS Date_Range_Start,
              DATE_FORMAT(dr.Date_Range_End, '%Y-%m-%d') AS Date_Range_End,
              dr.Total_Work_Hours, dr.Total_Late_Minutes, dr.Total_Undertime_Minutes,
              dr.Total_Overtime_Hours, dr.Attendance_Status, dr.Generated_By,
              dr.Verified_By, dr.Finalized_At, dr.DTR_Hash, dr.Transaction_Hash,
              dr.Blockchain_Status, dr.Source_Summary_Count, dr.Remarks,
              dr.created_at, dr.updated_at,
              latest.Event_Type AS Latest_Event_Type,
              latest.Status AS Latest_Audit_Status,
              latest.Payload_Hash AS Latest_Payload_Hash,
              latest.Created_At AS Latest_Audit_At
         FROM DTR_RECORD dr
         LEFT JOIN employees e ON e.id = dr.Employee_ID
         LEFT JOIN (
           SELECT dlog.*
             FROM DTR_BLOCKCHAIN_AUDIT_LOG dlog
             JOIN (
               SELECT DTR_ID, MAX(Audit_ID) AS Audit_ID
                 FROM DTR_BLOCKCHAIN_AUDIT_LOG
                GROUP BY DTR_ID
             ) picked ON picked.Audit_ID = dlog.Audit_ID
         ) latest ON latest.DTR_ID = dr.DTR_ID
        ${employeeFilter}
        ORDER BY COALESCE(dr.Finalized_At, dr.updated_at, dr.created_at) DESC
        LIMIT 500`,
      params
    );

    return res.json({
      fabric: getFabricConfigStatus(),
      records: records.map(row => ({
        ...row,
        Employee_Ref: row.Employee_Code || `EMPLOYEE-${row.Employee_ID}`,
        local_hash: computeDTRHash(row),
      })),
    });
  } catch (error) {
    console.error('[blockchain/getFinalizedDTRLedgerRecords]', error);
    return res.status(500).json({ error: 'Finalized DTR blockchain records could not be loaded.' });
  }
}

async function createDTRAdjustment(req, res) {
  try {
    assertAllowedFields(req.body || {}, DTR_ADJUSTMENT_ALLOWED_FIELDS);
    const dtrId = positiveInteger(req.params.dtrId, 'dtrId');
    const adjustmentReference = cleanText(req.body?.adjustmentReference || req.body?.adjustment_reference || req.body?.reference, 120);
    const adjustmentReason = cleanText(req.body?.reason || req.body?.remarks, 500);
    const previousTransactionHash = cleanText(req.body?.previousTransactionHash || req.body?.previous_transaction_hash, 255) || null;

    if (!adjustmentReference) return res.status(400).json({ error: 'adjustmentReference is required.' });
    if (adjustmentReason.length < 8) return res.status(400).json({ error: 'A DTR adjustment reason of at least 8 characters is required.' });

    const dtr = await fetchDTRRecord(pool, dtrId);
    assertFinalizedDTR(dtr);
    if (dtr.Blockchain_Status !== 'RECORDED' || !dtr.Transaction_Hash) {
      return res.status(409).json({ error: 'Original DTR must be recorded on-chain before an adjustment can be anchored.' });
    }

    const adjustmentPayload = {
      ...buildFinalizedDTRHashPayload(dtr),
      Adjustment_Reference: adjustmentReference,
      Adjustment_Reason: adjustmentReason,
      Adjustment_Recorded_By: String(req.user.id),
      Adjustment_Recorded_At: new Date().toISOString(),
    };
    const adjustmentHash = sha256Hex(stableStringify(adjustmentPayload));
    const ledgerRecord = buildDTRLedgerRecord(dtr, adjustmentHash, 'ADJUSTMENT', previousTransactionHash || dtr.Transaction_Hash || null, {
      Adjustment_Reference: adjustmentReference,
    });

    let receipt;
    let blockchainStatus = 'RECORDED';
    let txHash = null;
    try {
      receipt = await submitDTRAdjustmentRecord(ledgerRecord);
      txHash = receipt?.transaction_id || receipt?.tx_id || null;
    } catch (error) {
      if (!isFabricUnavailable(error)) throw error;
      blockchainStatus = 'PENDING_ANCHOR';
      receipt = {
        message: FABRIC_OFFLINE_MESSAGE,
        fabric_error: error.message,
        fabric_code: error.code || null,
      };
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        `INSERT INTO DTR_ADJUSTMENT_RECORD
           (DTR_ID, Adjustment_Reference, Reason, Previous_DTR_Hash,
            Adjustment_Hash, Transaction_Hash, Blockchain_Status, Created_By, Details)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          dtrId,
          adjustmentReference,
          adjustmentReason,
          dtr.DTR_Hash || null,
          adjustmentHash,
          txHash,
          blockchainStatus,
          req.user?.id || null,
          JSON.stringify({ previous_transaction_hash: ledgerRecord.Previous_Transaction_Hash }),
        ]
      );
      await writeSystemAuditLog(connection, req, `DTR_ADJUSTMENT_${blockchainStatus} [DTR:${dtrId}]`, 'BLOCKCHAIN_DTR', dtr.Employee_ID, {
        dtr_id: dtrId,
        adjustment_reference: adjustmentReference,
        adjustment_hash: adjustmentHash,
        blockchain_status: blockchainStatus,
      });
      await writeDTRBlockchainAuditLog(connection, req, dtrId, 'ADJUSTMENT_RECORD', blockchainStatus, txHash, adjustmentHash, receipt);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const statusCode = blockchainStatus === 'PENDING_ANCHOR' ? 202 : 201;
    return res.status(statusCode).json({
      status: blockchainStatus === 'PENDING_ANCHOR' ? 'pending_anchor' : 'success',
      message: blockchainStatus === 'PENDING_ANCHOR'
        ? FABRIC_OFFLINE_MESSAGE
        : 'DTR adjustment hash recorded on Hyperledger Fabric.',
      dtr_id: String(dtrId),
      adjustment_hash: adjustmentHash,
      transaction_hash: txHash,
      receipt,
    });
  } catch (error) {
    if (error.fields) {
      return res.status(error.statusCode || 400).json({ error: error.message, fields: error.fields });
    }
    console.error('[blockchain/createDTRAdjustment]', error);
    return sendSafeError(res, error, 'DTR adjustment blockchain recording could not be completed.');
  }
}

async function readDTRLedgerRecord(req, res) {
  try {
    const record = await queryDTRRecord(req.params.dtrId);
    return res.json(record);
  } catch (error) {
    if (isFabricUnavailable(error)) {
      return res.status(202).json({ status: 'pending_anchor', message: FABRIC_OFFLINE_MESSAGE });
    }
    console.error('[blockchain/readDTRLedgerRecord]', error);
    return res.status(500).json({ error: 'DTR ledger record could not be loaded.' });
  }
}

async function getDTRLedgerHistory(req, res) {
  try {
    const history = await getDTRHistory(req.params.dtrId);
    return res.json(history);
  } catch (error) {
    if (isFabricUnavailable(error)) {
      return res.status(202).json({ status: 'pending_anchor', message: FABRIC_OFFLINE_MESSAGE, history: [] });
    }
    console.error('[blockchain/getDTRLedgerHistory]', error);
    return res.status(500).json({ error: 'DTR ledger history could not be loaded.' });
  }
}

module.exports = {
  createDTRAdjustment,
  generateAndAnchorDTR,
  getDTRAuditTrail,
  getFinalizedDTRLedgerRecords,
  getDTRLedgerHistory,
  readDTRLedgerRecord,
  recordDTROnBlockchain,
  verifyDTRIntegrity,
};
