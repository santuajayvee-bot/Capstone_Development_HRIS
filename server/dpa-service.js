const pool = require('../config/db');

const DEFAULT_DPA_VERSION = 'LGSV-HR-DPA-2026-07-03';
const DPA_MODULE = 'DATA_PRIVACY';

function getCurrentDpaVersion() {
  return String(process.env.DPA_AGREEMENT_VERSION || DEFAULT_DPA_VERSION).trim() || DEFAULT_DPA_VERSION;
}

function requestIp(req) {
  return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || req.ip
    || 'unknown';
}

function requestUserAgent(req) {
  return req.headers?.['user-agent'] || 'unknown';
}

function safeJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch (_error) {
    return String(value);
  }
}

function dpaAuditDescription(action, result, details = null) {
  const version = details?.agreement_version || getCurrentDpaVersion();
  const actor = details?.user_id ? `user ${details.user_id}` : 'authenticated user';
  return `${action} ${String(result || '').toUpperCase()} for ${version} by ${actor}.`;
}

function isMissingDpaTable(error) {
  return error?.code === 'ER_NO_SUCH_TABLE' || /DATA_PRIVACY_AGREEMENT_ACCEPTANCE/i.test(error?.message || '');
}

async function findCurrentDpaAcceptance(userId, version = getCurrentDpaVersion()) {
  if (!userId) return null;

  try {
    const [rows] = await pool.execute(
      `SELECT Acceptance_ID, User_ID, Employee_ID, Agreement_Version, Accepted_At
         FROM DATA_PRIVACY_AGREEMENT_ACCEPTANCE
        WHERE User_ID = ?
          AND Agreement_Version = ?
        LIMIT 1`,
      [userId, version]
    );
    return rows[0] || null;
  } catch (error) {
    if (isMissingDpaTable(error)) {
      console.warn('[DPA] Acceptance table is missing. Run the DPA migration.');
      return null;
    }
    throw error;
  }
}

async function hasAcceptedCurrentDpa(userId) {
  return Boolean(await findCurrentDpaAcceptance(userId));
}

async function auditDpaEvent(req, action, result, details = null, options = {}) {
  const executor = options.connection || pool;
  const detailsJson = safeJson(details);
  try {
    const [auditResult] = await executor.execute(
      `INSERT INTO system_audit_log
         (user_id, employee_id, target_employee_id, action_performed, module,
          new_value, ip_address, user_agent, timestamp, Action_Type, Description, Created_At)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, NOW())`,
      [
        req.user?.id || null,
        req.user?.employeeId || null,
        req.user?.employeeId || null,
        `${action} [${String(result || 'recorded').toUpperCase()}]`,
        DPA_MODULE,
        detailsJson,
        requestIp(req),
        requestUserAgent(req),
        action.slice(0, 100),
        dpaAuditDescription(action, result, details),
      ]
    );
    return auditResult.insertId || true;
  } catch (error) {
    console.error('[DPA] Audit logging failed:', error.message);
    if (options.required) throw error;
    return false;
  }
}

module.exports = {
  auditDpaEvent,
  findCurrentDpaAcceptance,
  getCurrentDpaVersion,
  hasAcceptedCurrentDpa,
  requestIp,
  requestUserAgent,
};
