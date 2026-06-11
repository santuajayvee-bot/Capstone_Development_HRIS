const crypto = require('crypto');

const HASH_PEPPER = process.env.BLOCKCHAIN_EMPLOYEE_REF_PEPPER || process.env.JWT_SECRET || 'lgsv-hr-payroll-ref';

function normalizeDecimal(value) {
  if (value === null || value === undefined || value === '') return '0.00';
  const number = Number(value);
  if (!Number.isFinite(number)) return '0.00';
  return number.toFixed(2);
}

function normalizeDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return String(value);
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = stableSort(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableSort(value));
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function anonymizeEmployeeId(employeeId) {
  return `EMP_REF_${sha256Hex(`${HASH_PEPPER}:${employeeId}`).slice(0, 24)}`;
}

function buildFinalizedPayrollHashPayload(row) {
  return {
    Payroll_ID: String(row.Payroll_ID),
    Employee_ID: String(row.Employee_ID),
    Gross_Pay: normalizeDecimal(row.Gross_Pay),
    Total_Statutory_Deductions: normalizeDecimal(row.Total_Statutory_Deductions),
    Net_Pay: normalizeDecimal(row.Net_Pay),
    Non_Taxable_Allowance: normalizeDecimal(row.Non_Taxable_Allowance),
    Approval_Status: String(row.Approval_Status || ''),
    Finalized_At: normalizeDateTime(row.Finalized_At),
    Approved_By: row.Approved_By == null ? null : String(row.Approved_By),
  };
}

function computePayrollHash(row) {
  return sha256Hex(stableStringify(buildFinalizedPayrollHashPayload(row)));
}

function buildPayrollLedgerRecord(row, payrollHash, recordType = 'FINALIZED_PAYROLL', previousTransactionHash = null) {
  return {
    Payroll_ID: String(row.Payroll_ID),
    Employee_ID: anonymizeEmployeeId(row.Employee_ID),
    Payroll_Hash: payrollHash,
    Approval_Status: String(row.Approval_Status || ''),
    Approved_By: row.Approved_By == null ? null : String(row.Approved_By),
    Approved_At: normalizeDateTime(row.Finalized_At),
    Recorded_At: new Date().toISOString(),
    Record_Type: recordType,
    Previous_Transaction_Hash: previousTransactionHash || null,
  };
}

module.exports = {
  anonymizeEmployeeId,
  buildFinalizedPayrollHashPayload,
  buildPayrollLedgerRecord,
  computePayrollHash,
  normalizeDateTime,
  normalizeDecimal,
  sha256Hex,
  stableStringify,
};
