const {
  anonymizeEmployeeId,
  normalizeDateTime,
  normalizeDecimal,
  sha256Hex,
  stableStringify,
} = require('./payrollHash');

function normalizeDateOnly(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const match = value.match(/^\d{4}-\d{2}-\d{2}/);
    if (match) return match[0];
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return String(value);
}

function normalizeInteger(value) {
  if (value === null || value === undefined || value === '') return '0';
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Math.trunc(number));
}

function buildFinalizedDTRHashPayload(row) {
  return {
    DTR_ID: String(row.DTR_ID),
    Employee_Reference: anonymizeEmployeeId(row.Employee_ID),
    Date_Range_Start: normalizeDateOnly(row.Date_Range_Start),
    Date_Range_End: normalizeDateOnly(row.Date_Range_End),
    Total_Work_Hours: normalizeDecimal(row.Total_Work_Hours),
    Total_Late_Minutes: normalizeInteger(row.Total_Late_Minutes),
    Total_Undertime_Minutes: normalizeInteger(row.Total_Undertime_Minutes),
    Total_Overtime_Hours: normalizeDecimal(row.Total_Overtime_Hours),
    Attendance_Status: String(row.Attendance_Status || ''),
    Generated_By: row.Generated_By == null ? null : String(row.Generated_By),
    Verified_By: row.Verified_By == null ? null : String(row.Verified_By),
    Finalized_At: normalizeDateTime(row.Finalized_At),
  };
}

function computeDTRHash(row) {
  return sha256Hex(stableStringify(buildFinalizedDTRHashPayload(row)));
}

function buildDTRLedgerRecord(row, dtrHash, recordType = 'FINALIZED_DTR', previousTransactionHash = null, extra = {}) {
  return {
    DTR_ID: String(row.DTR_ID),
    Employee_Reference: anonymizeEmployeeId(row.Employee_ID),
    DTR_Hash: dtrHash,
    Date_Range_Start: normalizeDateOnly(row.Date_Range_Start),
    Date_Range_End: normalizeDateOnly(row.Date_Range_End),
    Attendance_Status: String(row.Attendance_Status || ''),
    Generated_By: row.Generated_By == null ? null : String(row.Generated_By),
    Verified_By: row.Verified_By == null ? null : String(row.Verified_By),
    Finalized_At: normalizeDateTime(row.Finalized_At),
    Recorded_At: new Date().toISOString(),
    Record_Type: recordType,
    Previous_Transaction_Hash: previousTransactionHash || null,
    ...extra,
  };
}

module.exports = {
  buildDTRLedgerRecord,
  buildFinalizedDTRHashPayload,
  computeDTRHash,
  normalizeDateOnly,
  normalizeInteger,
  sha256Hex,
  stableStringify,
};
