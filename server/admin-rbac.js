/* ============================================================
   server/admin-rbac.js — Account Registration & RBAC Management
   ============================================================
   Zero Trust Security Model — Level 4 (System Admin) Only
   
   Features:
   1. Strict Level 4 Authorization Middleware
   2. Account Registration / Role Assignment (Use Case 17)
   3. Immutable Audit Logging (ISO/IEC 27001 Non-Repudiation)
   4. Role CRUD for System Administrator
   ============================================================ */

const crypto   = require('crypto');
const express  = require('express');
const router   = express.Router();
const pool     = require('../config/db');
const appPackage = require('../package.json');
const { requireAuth, requirePermission } = require('./middleware');
const accountController = require('../controllers/accountController');
const { decryptColumnValue, encryptColumnValue, nullableText } = require('./data-protection');
const { getFabricConfigStatus } = require('./services/fabricService');
const {
  hashTemporaryPassword,
  validateTemporaryPassword,
} = require('../services/passwordService');

const auditSchemaCache = {
  tables: new Map(),
  columns: new Map(),
};

async function hasColumn(tableName, columnName) {
  const cacheKey = `${tableName}.${columnName}`.toLowerCase();
  if (auditSchemaCache.columns.has(cacheKey)) return auditSchemaCache.columns.get(cacheKey);
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [tableName, columnName]
  );
  const exists = Number(rows[0]?.count || 0) > 0;
  auditSchemaCache.columns.set(cacheKey, exists);
  return exists;
}

async function hasTable(tableName) {
  const cacheKey = String(tableName || '').toLowerCase();
  if (auditSchemaCache.tables.has(cacheKey)) return auditSchemaCache.tables.get(cacheKey);
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName]
  );
  const exists = Number(rows[0]?.count || 0) > 0;
  auditSchemaCache.tables.set(cacheKey, exists);
  return exists;
}

async function columnExpr(tableName, alias, columnName, fallback = 'NULL') {
  return (await hasColumn(tableName, columnName)) ? `${alias}.${columnName}` : fallback;
}

function sqlLiteral(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function auditEventTypeCondition(eventType, fields = {}) {
  const normalized = String(eventType || '').trim().toLowerCase();
  const actionField = fields.action || 'action_performed';
  const moduleField = fields.module || 'module';
  const detailsField = fields.details || 'details';
  if (!normalized) return null;
  if (normalized === 'create') return `LOWER(${actionField}) REGEXP 'create|created|add|added|register|registered|submit|submitted|upload|uploaded|encode|encoded|generate|generated'`;
  if (normalized === 'update') return `LOWER(${actionField}) REGEXP 'update|updated|change|changed|edit|edited|approve|approved|reject|rejected|correct|corrected|verify|verified|activate|activated|deactivate|deactivated|reset|reassign|reassigned'`;
  if (normalized === 'delete') return `LOWER(${actionField}) REGEXP 'delete|deleted|remove|removed|disable|disabled|cancel|cancelled|revoke|revoked'`;
  if (normalized === 'security') return `LOWER(CONCAT_WS(' ', ${moduleField}, ${actionField}, ${detailsField})) REGEXP 'security|denied|blocked|unauthorized|failed|tamper|lock|mfa|password|token|session'`;
  if (normalized === 'auth') return `LOWER(CONCAT_WS(' ', ${moduleField}, ${actionField}, ${detailsField})) REGEXP 'auth|login|logout|mfa|captcha|session|credential|lockout'`;
  return null;
}

async function buildGeneralAuditQueries({ includeLegacy = false } = {}) {
  const queries = [];

  if (await hasTable('system_audit_log')) {
    const logId = await columnExpr(
      'system_audit_log',
      'sal',
      'id',
      await columnExpr('system_audit_log', 'sal', 'log_id', await columnExpr('system_audit_log', 'sal', 'Log_ID', 'NULL'))
    );
    const timestamp = await columnExpr('system_audit_log', 'sal', 'timestamp', await columnExpr('system_audit_log', 'sal', 'Created_At', 'NULL'));
    const module = await columnExpr('system_audit_log', 'sal', 'module', sqlLiteral('SYSTEM'));
    const action = `COALESCE(${[
      await columnExpr('system_audit_log', 'sal', 'action_performed', 'NULL'),
      await columnExpr('system_audit_log', 'sal', 'Action_Type', 'NULL'),
      await columnExpr('system_audit_log', 'sal', 'Description', 'NULL'),
    ].join(', ')})`;
    const actionType = await columnExpr('system_audit_log', 'sal', 'Action_Type', 'NULL');
    const employeeId = await columnExpr('system_audit_log', 'sal', 'employee_id', 'NULL');
    const userId = await columnExpr('system_audit_log', 'sal', 'user_id', 'NULL');
    queries.push(`
      SELECT
        CONCAT('system:', ${logId}) AS id,
        'system_audit_log' AS source_table,
        ${module} AS module,
        ${action} AS action_performed,
        ${actionType} AS action_type,
        ${timestamp} AS timestamp,
        ${userId} AS user_id,
        COALESCE(u.username, actor_user.username) AS admin_username,
        ${employeeId} AS employee_id,
        ${await columnExpr('system_audit_log', 'sal', 'target_employee_id', 'NULL')} AS target_employee_id,
        ${await columnExpr('system_audit_log', 'sal', 'old_value', 'NULL')} AS old_value,
        ${await columnExpr('system_audit_log', 'sal', 'new_value', 'NULL')} AS new_value,
        ${await columnExpr('system_audit_log', 'sal', 'ip_address', 'NULL')} AS ip_address,
        ${await columnExpr('system_audit_log', 'sal', 'user_agent', 'NULL')} AS user_agent,
        NULL AS result,
        NULL AS field_changed,
        NULL AS details
      FROM system_audit_log sal
      LEFT JOIN users u ON u.id = ${userId}
      LEFT JOIN users actor_user ON actor_user.employee_id = ${employeeId}
    `);
  }

  // Fast path for the System Admin default view. `system_audit_log` is the
  // canonical/general audit table and now receives metadata-only write audits
  // from all modules. Legacy module-specific audit tables can be queried by
  // passing include_legacy=1, but they are intentionally excluded by default so
  // one slow historical table cannot freeze the Audit Trail page.
  if (!includeLegacy) return queries;

  if (await hasTable('payroll_audit_trail')) {
    const employeeId = await columnExpr('payroll_audit_trail', 'pat', 'employee_id', 'NULL');
    const payrollRunId = await columnExpr('payroll_audit_trail', 'pat', 'payroll_run_id', 'NULL');
    const salaryCalculationId = await columnExpr('payroll_audit_trail', 'pat', 'salary_calculation_id', 'NULL');
    const result = await columnExpr('payroll_audit_trail', 'pat', 'result', 'NULL');
    queries.push(`
      SELECT
        CONCAT('payroll:', pat.id) AS id,
        'payroll_audit_trail' AS source_table,
        'PAYROLL' AS module,
        pat.action AS action_performed,
        pat.created_at AS timestamp,
        ${await columnExpr('payroll_audit_trail', 'pat', 'user_id', 'NULL')} AS user_id,
        u.username AS admin_username,
        ${employeeId} AS employee_id,
        ${employeeId} AS target_employee_id,
        NULL AS old_value,
        ${await columnExpr('payroll_audit_trail', 'pat', 'metadata', 'NULL')} AS new_value,
        ${await columnExpr('payroll_audit_trail', 'pat', 'ip_address', 'NULL')} AS ip_address,
        NULL AS user_agent,
        ${result} AS result,
        NULL AS field_changed,
        CONCAT_WS(' | ',
          IF(${employeeId} IS NULL, NULL, CONCAT('Employee ID: ', ${employeeId})),
          IF(${payrollRunId} IS NULL, NULL, CONCAT('Payroll Run: ', ${payrollRunId})),
          IF(${salaryCalculationId} IS NULL, NULL, CONCAT('Salary Calc: ', ${salaryCalculationId})),
          IF(${result} IS NULL, NULL, CONCAT('Result: ', ${result}))
        ) AS details
      FROM payroll_audit_trail pat
      LEFT JOIN users u ON u.id = ${await columnExpr('payroll_audit_trail', 'pat', 'user_id', 'NULL')}
    `);
  }

  if (await hasTable('leave_audit_trail')) {
    const oldStatus = await columnExpr('leave_audit_trail', 'lat', 'old_status', 'NULL');
    const newStatus = await columnExpr('leave_audit_trail', 'lat', 'new_status', 'NULL');
    const remarksEncrypted = await columnExpr('leave_audit_trail', 'lat', 'remarks_encrypted', 'NULL');
    const metadataEncrypted = await columnExpr('leave_audit_trail', 'lat', 'metadata_encrypted', 'NULL');
    queries.push(`
      SELECT
        CONCAT('leave:', lat.id) AS id,
        'leave_audit_trail' AS source_table,
        'LEAVE' AS module,
        lat.action AS action_performed,
        lat.created_at AS timestamp,
        ${await columnExpr('leave_audit_trail', 'lat', 'actor_user_id', 'NULL')} AS user_id,
        u.username AS admin_username,
        ${await columnExpr('leave_audit_trail', 'lat', 'employee_id', 'NULL')} AS employee_id,
        ${await columnExpr('leave_audit_trail', 'lat', 'employee_id', 'NULL')} AS target_employee_id,
        ${oldStatus} AS old_value,
        ${newStatus} AS new_value,
        NULL AS ip_address,
        NULL AS user_agent,
        NULL AS result,
        NULL AS field_changed,
        CONCAT_WS(' | ',
          IF(${await columnExpr('leave_audit_trail', 'lat', 'leave_request_id', 'NULL')} IS NULL, NULL, CONCAT('Leave Request: ', ${await columnExpr('leave_audit_trail', 'lat', 'leave_request_id', 'NULL')})),
          IF(${oldStatus} IS NULL AND ${newStatus} IS NULL, NULL, CONCAT('Status: ', COALESCE(${oldStatus}, '-'), ' → ', COALESCE(${newStatus}, '-'))),
          IF(${remarksEncrypted} IS NULL, NULL, 'Remarks protected'),
          IF(${metadataEncrypted} IS NULL, NULL, 'Metadata protected')
        ) AS details
      FROM leave_audit_trail lat
      LEFT JOIN users u ON u.id = ${await columnExpr('leave_audit_trail', 'lat', 'actor_user_id', 'NULL')}
    `);
  }

  if (await hasTable('user_profile_audit_logs')) {
    queries.push(`
      SELECT
        CONCAT('profile:', upal.id) AS id,
        'user_profile_audit_logs' AS source_table,
        'SELF_SERVICE' AS module,
        upal.action AS action_performed,
        upal.created_at AS timestamp,
        upal.user_id AS user_id,
        u.username AS admin_username,
        upal.employee_id AS employee_id,
        upal.employee_id AS target_employee_id,
        NULL AS old_value,
        NULL AS new_value,
        ${await columnExpr('user_profile_audit_logs', 'upal', 'ip_address', 'NULL')} AS ip_address,
        ${await columnExpr('user_profile_audit_logs', 'upal', 'user_agent', 'NULL')} AS user_agent,
        NULL AS result,
        ${await columnExpr('user_profile_audit_logs', 'upal', 'field_changed', 'NULL')} AS field_changed,
        CONCAT_WS(' | ', IF(${await columnExpr('user_profile_audit_logs', 'upal', 'field_changed', 'NULL')} IS NULL, NULL, CONCAT('Field: ', ${await columnExpr('user_profile_audit_logs', 'upal', 'field_changed', 'NULL')})), 'Change details protected') AS details
      FROM user_profile_audit_logs upal
      LEFT JOIN users u ON u.id = upal.user_id
    `);
  }

  if (await hasTable('employee_201_file_access_audit')) {
    queries.push(`
      SELECT
        CONCAT('201:', efa.id) AS id,
        'employee_201_file_access_audit' AS source_table,
        '201_FILE' AS module,
        efa.action AS action_performed,
        efa.accessed_at AS timestamp,
        efa.accessed_by AS user_id,
        u.username AS admin_username,
        efa.employee_id AS employee_id,
        efa.employee_id AS target_employee_id,
        NULL AS old_value,
        NULL AS new_value,
        NULL AS ip_address,
        NULL AS user_agent,
        NULL AS result,
        NULL AS field_changed,
        CONCAT_WS(' | ', IF(efa.resource_type IS NULL, NULL, CONCAT('Resource: ', efa.resource_type)), IF(efa.resource_id IS NULL, NULL, CONCAT('Resource ID: ', efa.resource_id)), IF(efa.details IS NULL, NULL, 'Details available')) AS details
      FROM employee_201_file_access_audit efa
      LEFT JOIN users u ON u.id = efa.accessed_by
    `);
  }

  if (await hasTable('onboarding_applicant_activity')) {
    queries.push(`
      SELECT
        CONCAT('onboarding:', oaa.activity_id) AS id,
        'onboarding_applicant_activity' AS source_table,
        'ONBOARDING' AS module,
        oaa.action AS action_performed,
        oaa.created_at AS timestamp,
        oaa.actor_user_id AS user_id,
        u.username AS admin_username,
        NULL AS employee_id,
        oaa.applicant_id AS target_employee_id,
        NULL AS old_value,
        NULL AS new_value,
        NULL AS ip_address,
        NULL AS user_agent,
        NULL AS result,
        NULL AS field_changed,
        CONCAT_WS(' | ', CONCAT('Applicant ID: ', oaa.applicant_id), IF(${await columnExpr('onboarding_applicant_activity', 'oaa', 'reason_encrypted', 'NULL')} IS NULL, NULL, 'Reason protected'), IF(${await columnExpr('onboarding_applicant_activity', 'oaa', 'new_value_encrypted', 'NULL')} IS NULL, NULL, 'Change details protected')) AS details
      FROM onboarding_applicant_activity oaa
      LEFT JOIN users u ON u.id = oaa.actor_user_id
    `);
  }

  return queries;
}

function redactAuditValue(value) {
  const text = nullableText(value);
  if (!text) return null;
  if (resemblesEncryptedPayload(text)) return '[protected]';
  return text.length > 1000 ? `${text.slice(0, 1000)}…` : text;
}

const AUDIT_ANOMALY_TYPES = new Set([
  'SQL_INJECTION',
  'XSS',
  'BRUTE_FORCE',
  'SESSION_MANIPULATION',
]);

function normalizeAuditText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch (_) {
      return String(value);
    }
  }
  return String(value);
}

function auditAnomalyHaystack(row) {
  return [
    row.module,
    row.action_performed,
    row.action_type,
    row.old_value,
    row.new_value,
    row.details,
    row.ip_address,
    row.user_agent,
  ].map(normalizeAuditText).join(' ').toLowerCase();
}

function auditAnomalyKey(row) {
  return String(row.ip_address || row.admin_username || row.user_id || 'unknown').trim() || 'unknown';
}

function isFailedLoginAudit(row) {
  const text = auditAnomalyHaystack(row);
  return /\blogin_failed\b|failed login|invalid login|invalid credentials/.test(text);
}

function isFailedMfaAudit(row) {
  const text = auditAnomalyHaystack(row);
  return /\bmfa_verification_failed\b|\bmfa_too_many_attempts\b|invalid verification code/.test(text);
}

function auditAnomalyContext(rows) {
  const failedLoginsByKey = new Map();
  const failedMfaByKey = new Map();
  for (const row of rows) {
    const key = auditAnomalyKey(row);
    if (isFailedLoginAudit(row)) failedLoginsByKey.set(key, (failedLoginsByKey.get(key) || 0) + 1);
    if (isFailedMfaAudit(row)) failedMfaByKey.set(key, (failedMfaByKey.get(key) || 0) + 1);
  }
  return { failedLoginsByKey, failedMfaByKey };
}

function classifyAuditAnomaly(row, context) {
  const text = auditAnomalyHaystack(row);
  const key = auditAnomalyKey(row);

  const sqlInjectionPattern = /(\bsql_injection\b|sql injection|\bunion\s+(all\s+)?select\b|\binformation_schema\b|\bor\s+1\s*=\s*1\b|\band\s+1\s*=\s*1\b|'\s*or\s*'1'\s*=\s*'1|--\s|\/\*|\*\/|\bsleep\s*\(|\bbenchmark\s*\(|\bdrop\s+table\b|\binsert\s+into\b|\bselect\s+.+\bfrom\b)/i;
  if (sqlInjectionPattern.test(text)) {
    return {
      anomaly_type: 'SQL_INJECTION',
      anomaly_label: 'SQLi Pattern',
      anomaly_severity: 'High',
      anomaly_reason: 'Audit content contains SQL injection indicators such as UNION SELECT, boolean bypass, SQL comments, or database metadata access.',
    };
  }

  const xssPattern = /(\bxss\b|<\s*script\b|javascript\s*:|onerror\s*=|onload\s*=|<\s*img\b|<\s*svg\b|document\.cookie|localstorage|<\s*iframe\b|eval\s*\()/i;
  if (xssPattern.test(text)) {
    return {
      anomaly_type: 'XSS',
      anomaly_label: 'XSS Pattern',
      anomaly_severity: 'High',
      anomaly_reason: 'Audit content contains script, event-handler, JavaScript URI, or browser storage indicators.',
    };
  }

  const failedLoginCount = context.failedLoginsByKey.get(key) || 0;
  const failedMfaCount = context.failedMfaByKey.get(key) || 0;
  if (
    failedLoginCount >= 5
    || failedMfaCount >= 3
    || /\blogin_blocked_locked_account\b|account locked|account lockout|blocked_auth_rate_limit_exceeded|mfa_too_many_attempts/.test(text)
  ) {
    return {
      anomaly_type: 'BRUTE_FORCE',
      anomaly_label: 'Brute Force',
      anomaly_severity: failedLoginCount >= 5 || /rate_limit|too_many|lockout/.test(text) ? 'Critical' : 'High',
      anomaly_reason: `Repeated failed authentication activity detected for ${key}.`,
    };
  }

  if (
    /invalid_or_tampered_jwt_attempt|expired_jwt_attempt|blocked_client_authority_field_tampering|blocked_inactive_account_token_use|session expired|invalid session|revoked session|token_version|unauthorized request fields/.test(text)
  ) {
    return {
      anomaly_type: 'SESSION_MANIPULATION',
      anomaly_label: 'Session Manipulation',
      anomaly_severity: /tampered|authority_field|inactive_account|revoked/.test(text) ? 'High' : 'Medium',
      anomaly_reason: 'Session/token tampering, expired token reuse, revoked session reuse, or client authority-field manipulation was detected.',
    };
  }

  return null;
}

function enrichAuditAnomalies(rows) {
  const context = auditAnomalyContext(rows);
  return rows.map(row => {
    const anomaly = classifyAuditAnomaly(row, context);
    return {
      ...row,
      anomaly_type: anomaly?.anomaly_type || null,
      anomaly_label: anomaly?.anomaly_label || null,
      anomaly_severity: anomaly?.anomaly_severity || null,
      anomaly_reason: anomaly?.anomaly_reason || null,
    };
  });
}

function filterAuditAnomalies(rows, anomalyType) {
  const normalized = String(anomalyType || '').trim().toUpperCase();
  return rows.filter(row => {
    if (!row.anomaly_type) return false;
    return !normalized || normalized === row.anomaly_type;
  });
}

async function queryCanonicalSystemAuditLog({
  limit,
  offset,
  module,
  search,
  eventType,
} = {}) {
  if (!(await hasTable('system_audit_log'))) return [];

  const logId = await columnExpr(
    'system_audit_log',
    'sal',
    'id',
    await columnExpr('system_audit_log', 'sal', 'log_id', await columnExpr('system_audit_log', 'sal', 'Log_ID', 'NULL'))
  );
  const timestamp = await columnExpr('system_audit_log', 'sal', 'timestamp', await columnExpr('system_audit_log', 'sal', 'Created_At', 'NULL'));
  const moduleExpr = await columnExpr('system_audit_log', 'sal', 'module', sqlLiteral('SYSTEM'));
  const userId = await columnExpr('system_audit_log', 'sal', 'user_id', 'NULL');
  const employeeId = await columnExpr('system_audit_log', 'sal', 'employee_id', await columnExpr('system_audit_log', 'sal', 'Employee_ID', 'NULL'));
  const actionType = await columnExpr('system_audit_log', 'sal', 'Action_Type', 'NULL');
  const actionExpr = `COALESCE(${[
    await columnExpr('system_audit_log', 'sal', 'action_performed', 'NULL'),
    actionType,
    await columnExpr('system_audit_log', 'sal', 'Description', 'NULL'),
  ].join(', ')})`;
  const oldValue = await columnExpr('system_audit_log', 'sal', 'old_value', 'NULL');
  const newValue = await columnExpr('system_audit_log', 'sal', 'new_value', await columnExpr('system_audit_log', 'sal', 'Description', 'NULL'));
  const ipAddress = await columnExpr('system_audit_log', 'sal', 'ip_address', await columnExpr('system_audit_log', 'sal', 'IP_Address', 'NULL'));
  const userAgent = await columnExpr('system_audit_log', 'sal', 'user_agent', await columnExpr('system_audit_log', 'sal', 'User_Agent', 'NULL'));
  const targetEmployeeId = await columnExpr('system_audit_log', 'sal', 'target_employee_id', 'NULL');
  const safeLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const orderExpr = logId === 'NULL' ? timestamp : logId;
  const params = [];

  let query = `
    SELECT
      CONCAT('system:', ${logId}) AS id,
      'system_audit_log' AS source_table,
      ${moduleExpr} AS module,
      ${actionExpr} AS action_performed,
      ${actionType} AS action_type,
      ${timestamp} AS timestamp,
      ${userId} AS user_id,
      COALESCE(u.username, actor_user.username) AS admin_username,
      ${employeeId} AS employee_id,
      ${targetEmployeeId} AS target_employee_id,
      ${oldValue} AS old_value,
      ${newValue} AS new_value,
      ${ipAddress} AS ip_address,
      ${userAgent} AS user_agent,
      CASE
        WHEN UPPER(COALESCE(${actionType}, ${actionExpr}, '')) REGEXP 'SUCCESS|COMPLETED|APPROVED|VERIFIED|RECORDED|CREATED|UPDATED|ACTIVATED|LOGOUT' THEN 'Success'
        WHEN UPPER(COALESCE(${actionType}, ${actionExpr}, '')) REGEXP 'FAILED|DENIED|BLOCKED|LOCKED|EXPIRED|INVALID|UNAUTHORIZED|TAMPER' THEN 'Failed'
        ELSE NULL
      END AS result,
      NULL AS field_changed,
      NULL AS details
    FROM system_audit_log sal
    LEFT JOIN users u ON u.id = ${userId}
    LEFT JOIN users actor_user ON actor_user.employee_id = ${employeeId}
    WHERE ${timestamp} IS NOT NULL
  `;

  if (module) {
    query += ` AND ${moduleExpr} = ?`;
    params.push(module);
  }

  const eventCondition = auditEventTypeCondition(eventType, {
    action: `COALESCE(${actionExpr}, '')`,
    module: `COALESCE(${moduleExpr}, '')`,
    details: `COALESCE(${newValue}, '')`,
  });
  if (eventCondition) query += ` AND (${eventCondition})`;

  if (search) {
    const needle = `%${search}%`;
    query += `
      AND (
        LOWER(COALESCE(${actionExpr}, '')) LIKE ?
        OR LOWER(COALESCE(${moduleExpr}, '')) LIKE ?
        OR LOWER(COALESCE(u.username, '')) LIKE ?
        OR LOWER(COALESCE(${newValue}, '')) LIKE ?
        OR LOWER(COALESCE(${oldValue}, '')) LIKE ?
        OR LOWER('system_audit_log') LIKE ?
      )
    `;
    params.push(needle, needle, needle, needle, needle, needle);
  }

  // Safe interpolation: safeLimit/safeOffset are clamped numeric values.
  query += ` ORDER BY ${orderExpr} DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`;

  const [rows] = await pool.execute(query, params);
  return rows;
}

async function queryGeneralAuditSources({
  limit,
  offset,
  module,
  search,
  eventType,
  includeLegacy = true,
} = {}) {
  const sources = await buildGeneralAuditQueries({ includeLegacy });
  const sourceLimit = Math.min(Math.max(Number(limit || 100) + Number(offset || 0), 250), 1000);
  const eventTypeCondition = auditEventTypeCondition(eventType);

  if (sources.length === 0) return [];

  const sourceResults = await Promise.all(sources.map(async sourceSql => {
    let query = `
      SELECT *
        FROM (${sourceSql}) general_audit
       WHERE timestamp IS NOT NULL
    `;
    const params = [];

    if (module) {
      query += ' AND module = ?';
      params.push(module);
    }

    if (eventTypeCondition) {
      query += ` AND (${eventTypeCondition})`;
    }

    if (search) {
      const needle = `%${search}%`;
      query += `
        AND (
          LOWER(COALESCE(action_performed, '')) LIKE ?
          OR LOWER(COALESCE(module, '')) LIKE ?
          OR LOWER(COALESCE(admin_username, '')) LIKE ?
          OR LOWER(COALESCE(details, '')) LIKE ?
          OR LOWER(COALESCE(source_table, '')) LIKE ?
          OR LOWER(COALESCE(result, '')) LIKE ?
        )
      `;
      params.push(needle, needle, needle, needle, needle, needle);
    }

    // Safe interpolation: sourceLimit is clamped numeric input.
    query += ` ORDER BY timestamp DESC LIMIT ${sourceLimit}`;

    try {
      const [rows] = await pool.execute(query, params);
      return rows;
    } catch (sourceError) {
      console.warn('[RBAC] audit source skipped:', sourceError.message);
      return [];
    }
  }));

  return sourceResults
    .flat()
    .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
    .slice(Number(offset || 0), Number(offset || 0) + Number(limit || 100));
}

function resemblesEncryptedPayload(value) {
  const parts = nullableText(value)?.split(':') || [];
  // AES-GCM values use iv:authTag:ciphertext. This broader check means a
  // malformed value is still treated as protected data and never sent to UI.
  return parts.length === 3 && parts[0].length === 32 && parts[1].length === 32;
}

function decryptEmployeeUserFields(row) {
  if (!row) return row;

  ['first_name', 'last_name'].forEach(field => {
    if (!Object.prototype.hasOwnProperty.call(row, field)) return;

    const storedValue = row[field];
    const appearsEncrypted = resemblesEncryptedPayload(storedValue);
    try {
      const decrypted = decryptColumnValue(storedValue);

      // Do not fall through with a ciphertext-shaped value if it could not
      // be recognised by the normal decryptor.
      row[field] = appearsEncrypted && decrypted === nullableText(storedValue)
        ? null
        : decrypted;
    } catch (error) {
      // Fail closed: an unreadable protected field must never leak its
      // database representation to the browser.
      console.warn(`[RBAC] Unable to decrypt employee ${field} for account-list response:`, error.message);
      row[field] = null;
    }
  });
  return row;
}

// ── Argon2 Configuration (OWASP recommended) ────────────────
/* ================================================================
   MIDDLEWARE: requireLevel4 — Strict System Administrator Guard
   ================================================================
   Extracts role from the active JWT (set by requireAuth).
   If the role is NOT system_admin (Level 4), the request is
   immediately rejected with 403 Forbidden.
   ================================================================ */
function requireLevel4(req, res, next) {
  const userRole = req.user?.role;

  // Accept both 'system_admin' and legacy 'admin' mapped to Level 4
  const LEVEL_4_ROLES = ['system_admin', 'admin'];

  if (!userRole || !LEVEL_4_ROLES.includes(userRole)) {
    // Log the unauthorized attempt
    logAuditEntry(req, {
      action: `UNAUTHORIZED_ACCESS_ATTEMPT: Role '${userRole}' tried to access Level 4 endpoint ${req.method} ${req.originalUrl}`,
      module: 'RBAC_SECURITY',
    }).catch(() => {});

    return res.status(403).json({
      error: 'Access denied.',
      message: 'Only System Administrator (Level 4) can access this resource.',
      required_level: 'Level 4',
      your_role: userRole || 'unknown',
    });
  }

  next();
}

/* ================================================================
   HELPER: logAuditEntry — Immutable Audit Trail (Non-Repudiation)
   ================================================================
   Inserts into system_audit_log with parameterized queries.
   This function is called within every mutation to guarantee
   an unalterable record exists for ISO/IEC 27001 compliance.
   ================================================================ */
async function logAuditEntryWithExecutor(executor, req, { action, module = 'RBAC', targetEmployeeId = null, oldValue = null, newValue = null }) {
  const userId    = req.user?.id || 0;
  const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';

  await executor.execute(
    `INSERT INTO system_audit_log 
       (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [userId, req.user?.employeeId || null, targetEmployeeId, action, module, oldValue, newValue, ipAddress, userAgent]
  );
}

async function logAuditEntry(req, args) {
  return logAuditEntryWithExecutor(pool, req, args);
}

/* ================================================================
   HELPER: extractClientIP — Get real client IP behind proxies
   ================================================================ */
function extractClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
}

const SUPPORT_CATEGORIES = new Set([
  'ACCOUNT',
  'AUTHENTICATION',
  'MFA',
  'PAYROLL_PROCESS',
  'BLOCKCHAIN',
  'BIOMETRIC',
  'REPORTING',
  'SECURITY',
  'SYSTEM',
  'OTHER',
]);

const SUPPORT_PRIORITIES = new Set(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const SUPPORT_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'WAITING_FOR_OWNER', 'RESOLVED', 'CLOSED']);
const BACKUP_TYPES = new Set(['DATABASE', 'FILES', 'CONFIGURATION', 'MODULE_STATE', 'DEPLOYMENT_VERSION', 'FULL_BACKUP', 'FULL_SYSTEM']);
const BACKUP_SET_TYPES = new Set(['DATABASE', 'FILES', 'CONFIGURATION', 'MODULE_STATE', 'DEPLOYMENT_VERSION', 'FULL_BACKUP']);
const BACKUP_TARGETS = new Set(['LOCAL', 'S3', 'RDS_SNAPSHOT', 'MANUAL', 'EXTERNAL']);
const BACKUP_SET_TARGETS = new Set(['LOCAL', 'S3', 'RDS_SNAPSHOT', 'MANUAL']);
const BACKUP_STATUSES = new Set(['REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED', 'VERIFICATION_FAILED', 'VERIFIED']);
const BACKUP_SET_STATUSES = new Set(['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'VERIFIED', 'RESTORED']);
const RESTORE_TYPES = new Set(['DATABASE', 'FILES', 'CONFIGURATION', 'MODULE_STATE', 'FULL_BACKUP']);
const RESTORE_STATUSES = new Set(['PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED']);
const ROLLBACK_STATUSES = new Set(['PENDING', 'APPROVED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED']);
const RESTORABLE_BACKUP_TYPES = new Set(['DATABASE', 'FILES', 'CONFIGURATION', 'MODULE_STATE', 'FULL_BACKUP']);
const RESTORE_JOB_TRANSITIONS = {
  PENDING: new Set(['PENDING', 'IN_PROGRESS', 'FAILED', 'CANCELLED']),
  IN_PROGRESS: new Set(['IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED']),
  COMPLETED: new Set(['COMPLETED']),
  FAILED: new Set(['FAILED']),
  CANCELLED: new Set(['CANCELLED']),
};

const BACKUP_RECOVERY_MODULES = [
  { key: 'authentication', name: 'Authentication / Login', data: true, files: false, config: true, rollback: true },
  { key: 'account_management', name: 'Account Management', data: true, files: false, config: true, rollback: true },
  { key: 'rbac', name: 'Role and Access / RBAC', data: true, files: false, config: true, rollback: true },
  { key: 'employee_201', name: 'Employee Management / 201 File', data: true, files: true, config: true, rollback: true },
  { key: 'attendance', name: 'Attendance Management', data: true, files: false, config: true, rollback: true },
  { key: 'attendance_sync', name: 'Attendance Sync', data: true, files: false, config: true, rollback: true },
  { key: 'leave', name: 'Leave Management', data: true, files: false, config: true, rollback: true },
  { key: 'payroll', name: 'Payroll Management', data: true, files: false, config: true, rollback: true },
  { key: 'payslip', name: 'Payslip Generation', data: true, files: true, config: true, rollback: true },
  { key: 'audit_trail', name: 'Audit Trail', data: true, files: false, config: true, rollback: false },
  { key: 'blockchain', name: 'Blockchain Support', data: true, files: false, config: true, rollback: true },
  { key: 'system_health', name: 'System Health', healthKey: 'backup_restore', data: true, files: false, config: true, rollback: true },
  { key: 'support_center', name: 'Support Center / Incident Management', data: true, files: false, config: true, rollback: true },
  { key: 'backup_restore', name: 'Backup and Restore', data: true, files: false, config: true, rollback: true },
  { key: 'file_storage', name: 'File Upload / Document Storage', healthKey: 'employee_201', data: true, files: true, config: true, rollback: true },
  { key: 'notification_service', name: 'Notification Service', healthKey: 'aws_readiness', data: false, files: false, config: true, rollback: true },
];

function normalizePositiveInteger(value, fieldName = 'id') {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    const error = new Error(`${fieldName} is invalid.`);
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

function cleanText(value, maxLength = 500) {
  const text = String(value || '').trim().replace(/[<>]/g, '');
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeEnum(value, allowedValues, fallback) {
  const normalized = String(value || '').trim().toUpperCase();
  return allowedValues.has(normalized) ? normalized : fallback;
}

function protectedText(value) {
  const text = cleanText(value, 2000);
  return text ? encryptColumnValue(text) : null;
}

function revealProtectedText(value) {
  try {
    return decryptColumnValue(value) || null;
  } catch (error) {
    return '[protected]';
  }
}

function makeReference(prefix) {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${timestamp}-${suffix}`;
}

function normalizeBackupSetType(value, fallback = 'DATABASE') {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'FULL_SYSTEM') return 'FULL_BACKUP';
  return BACKUP_SET_TYPES.has(normalized) ? normalized : fallback;
}

function normalizeBackupStorageProvider(value, fallback = 'MANUAL') {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'EXTERNAL') return 'MANUAL';
  return BACKUP_SET_TARGETS.has(normalized) ? normalized : fallback;
}

function normalizeBackupSetStatus(value, fallback = 'PENDING') {
  const normalized = String(value || '').trim().toUpperCase();
  if (normalized === 'REQUESTED') return 'PENDING';
  if (normalized === 'VERIFICATION_FAILED') return 'FAILED';
  return BACKUP_SET_STATUSES.has(normalized) ? normalized : fallback;
}

function backupSetTypeToLegacy(value) {
  const normalized = normalizeBackupSetType(value, 'DATABASE');
  if (normalized === 'DATABASE' || normalized === 'FILES') return normalized;
  return 'FULL_SYSTEM';
}

function backupProviderToLegacy(value) {
  const normalized = normalizeBackupStorageProvider(value, 'MANUAL');
  return normalized === 'MANUAL' ? 'EXTERNAL' : normalized;
}

function backupStatusToLegacy(value) {
  const normalized = normalizeBackupSetStatus(value, 'PENDING');
  if (normalized === 'PENDING') return 'REQUESTED';
  if (normalized === 'RESTORED') return 'VERIFIED';
  return normalized;
}

function parseModuleList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(item => cleanText(item, 80)).filter(Boolean);
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(item => cleanText(item, 80)).filter(Boolean);
  } catch (_) {}
  return text.split(',').map(item => cleanText(item, 80)).filter(Boolean);
}

function cleanModuleSelection(value) {
  const allowed = new Set(BACKUP_RECOVERY_MODULES.map(module => module.key));
  const selected = parseModuleList(value).filter(key => allowed.has(key));
  return selected.length ? Array.from(new Set(selected)) : BACKUP_RECOVERY_MODULES.map(module => module.key);
}

function appVersion() {
  return cleanText(process.env.APP_VERSION || appPackage.version || '1.0.0', 80);
}

function deploymentCommit() {
  return cleanText(
    process.env.APP_COMMIT_SHA ||
    process.env.GIT_COMMIT ||
    process.env.COMMIT_SHA ||
    'local-dev',
    80
  );
}

function deploymentArtifactReference() {
  return cleanText(
    process.env.DEPLOYMENT_ARTIFACT_URI ||
    process.env.AWS_DEPLOYMENT_ARTIFACT ||
    process.env.S3_DEPLOYMENT_ARTIFACT ||
    'manual-deployment-record',
    1000
  );
}

function moduleCurrentVersion(moduleKey) {
  const envKey = `MODULE_${String(moduleKey || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_VERSION`;
  return cleanText(process.env[envKey] || appVersion(), 80);
}

function moduleStableVersion(moduleKey) {
  const envKey = `MODULE_${String(moduleKey || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_STABLE_VERSION`;
  return cleanText(process.env[envKey] || moduleCurrentVersion(moduleKey), 80);
}

function backupSetResponse(row) {
  const storageLocation = revealProtectedText(row.storage_location_encrypted);
  const remarks = revealProtectedText(row.remarks_encrypted);
  return {
    id: row.id,
    backup_set_id: row.id,
    backup_id: row.id,
    backup_reference: row.backup_reference,
    backup_name: row.backup_name,
    backup_type: row.backup_type,
    storage_provider: row.storage_provider,
    storage_target: row.storage_provider,
    storage_location: storageLocation,
    backup_location: storageLocation,
    status: row.status,
    included_modules: parseModuleList(row.included_modules),
    checksum: row.checksum,
    manifest_hash: row.checksum,
    file_size: row.file_size,
    created_by: row.created_by,
    created_by_username: row.created_by_username || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    verified_at: row.verified_at,
    restored_at: row.restored_at,
    remarks,
    notes: remarks,
  };
}

function moduleRecoveryPointResponse(row) {
  return {
    id: row.id,
    module_key: row.module_key,
    module_name: row.module_name,
    current_version: row.current_version,
    stable_version: row.stable_version,
    deployment_commit: row.deployment_commit,
    artifact_location: revealProtectedText(row.artifact_location_encrypted),
    storage_provider: row.storage_provider,
    health_status_at_backup: row.health_status_at_backup,
    backup_set_id: row.backup_set_id,
    backup_reference: row.backup_reference || null,
    rollback_available: Boolean(row.rollback_available),
    created_by: row.created_by,
    created_by_username: row.created_by_username || null,
    created_at: row.created_at,
    remarks: revealProtectedText(row.remarks_encrypted),
  };
}

function restoreJobResponse(row) {
  return {
    id: row.id,
    restore_job_id: row.id,
    backup_set_id: row.backup_set_id,
    backup_reference: row.backup_reference || null,
    restore_type: row.restore_type,
    affected_module: row.affected_module,
    status: row.status,
    requested_by: row.requested_by,
    requested_by_username: row.requested_by_username || null,
    approved_by: row.approved_by,
    approved_by_username: row.approved_by_username || null,
    started_at: row.started_at,
    completed_at: row.completed_at,
    reason: revealProtectedText(row.reason_encrypted),
    result_message: revealProtectedText(row.result_message_encrypted),
    created_at: row.created_at,
  };
}

function rollbackRequestResponse(row) {
  return {
    id: row.id,
    rollback_request_id: row.id,
    affected_module: row.affected_module,
    current_version: row.current_version,
    target_version: row.target_version,
    artifact_location: revealProtectedText(row.artifact_location_encrypted),
    reason: revealProtectedText(row.reason_encrypted),
    status: row.status,
    requested_by: row.requested_by,
    requested_by_username: row.requested_by_username || null,
    approved_by: row.approved_by,
    approved_by_username: row.approved_by_username || null,
    created_at: row.created_at,
    completed_at: row.completed_at,
    result_message: revealProtectedText(row.result_message_encrypted),
  };
}

function isSafeIdentifier(identifier) {
  return /^[A-Za-z0-9_]+$/.test(String(identifier || ''));
}

async function countRows(tableName, whereClause = '', params = []) {
  if (!isSafeIdentifier(tableName) || !(await hasTable(tableName))) return 0;
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count FROM ${tableName} ${whereClause}`,
    params
  );
  return Number(rows[0]?.count || 0);
}

async function getTargetUserForSupport(userId, executor = pool) {
  const normalizedUserId = normalizePositiveInteger(userId, 'user_id');
  const [rows] = await executor.execute(
    `SELECT u.id, u.username, u.employee_id, u.role_id,
            r.name AS role_name, r.label AS role_label, r.access_level,
            e.Employee_ID AS auth_employee_id
       FROM users u
       LEFT JOIN roles r ON r.id = u.role_id
       LEFT JOIN employees e ON e.id = u.employee_id
      WHERE u.id = ?
      LIMIT 1`,
    [normalizedUserId]
  );
  const user = rows[0] || null;
  if (!user) {
    const error = new Error('User account not found.');
    error.statusCode = 404;
    throw error;
  }
  return user;
}

async function revokeSessionsByAuthEmployeeId(executor, employeeId, reason) {
  if (!employeeId || !(await hasTable('USER_SESSION'))) return 0;
  const [result] = await executor.execute(
    `UPDATE USER_SESSION
        SET Revoked_At = NOW(),
            Revocation_Reason = ?
      WHERE Employee_ID = ?
        AND Revoked_At IS NULL`,
    [cleanText(reason, 100) || 'admin_support_action', employeeId]
  );
  return result.affectedRows || 0;
}

function ticketResponse(row) {
  return {
    ticket_id: row.ticket_id,
    ticket_number: row.ticket_number,
    title: row.title,
    category: row.category,
    priority: row.priority,
    status: row.status,
    related_user_id: row.related_user_id,
    related_employee_id: row.related_employee_id,
    description: revealProtectedText(row.description_encrypted),
    resolution_notes: revealProtectedText(row.resolution_encrypted),
    created_by: row.created_by,
    created_by_username: row.created_by_username || null,
    assigned_to: row.assigned_to,
    resolved_by: row.resolved_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
  };
}

function backupResponse(row) {
  return {
    backup_id: row.backup_id,
    backup_reference: row.backup_reference,
    backup_type: row.backup_type,
    storage_target: row.storage_target,
    status: row.status,
    requested_by: row.requested_by,
    requested_by_username: row.requested_by_username || null,
    verified_by: row.verified_by,
    manifest_hash: row.manifest_hash,
    backup_location: revealProtectedText(row.backup_location_encrypted),
    notes: revealProtectedText(row.notes_encrypted),
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
    verified_at: row.verified_at,
  };
}

function sqlLimit(value, fallback = 100, max = 200) {
  const parsed = Math.trunc(Number(value));
  return Math.max(1, Math.min(Number.isFinite(parsed) ? parsed : fallback, max));
}

async function listBackupSets(limit = 100) {
  const safeLimit = sqlLimit(limit);
  if (await hasTable('backup_sets')) {
    const [rows] = await pool.execute(
      `SELECT bs.*, creator.username AS created_by_username
         FROM backup_sets bs
         LEFT JOIN users creator ON creator.id = bs.created_by
        ORDER BY bs.created_at DESC
        LIMIT ${safeLimit}`
    );
    return rows.map(backupSetResponse);
  }

  if (await hasTable('system_backup_log')) {
    const [rows] = await pool.execute(
      `SELECT bl.*, requester.username AS requested_by_username
         FROM system_backup_log bl
         LEFT JOIN users requester ON requester.id = bl.requested_by
        ORDER BY bl.created_at DESC
        LIMIT ${safeLimit}`
    );
    return rows.map(row => {
      const legacy = backupResponse(row);
      return {
        ...legacy,
        id: legacy.backup_id,
        backup_set_id: legacy.backup_id,
        backup_name: legacy.backup_reference,
        backup_type: normalizeBackupSetType(legacy.backup_type),
        storage_provider: normalizeBackupStorageProvider(legacy.storage_target),
        status: normalizeBackupSetStatus(legacy.status),
        included_modules: BACKUP_RECOVERY_MODULES.map(module => module.key),
        checksum: legacy.manifest_hash,
        storage_location: legacy.backup_location,
        remarks: legacy.notes,
      };
    });
  }

  return [];
}

async function listModuleRecoveryPoints(limit = 100) {
  if (!(await hasTable('module_recovery_points'))) return [];
  const safeLimit = sqlLimit(limit);
  const [rows] = await pool.execute(
    `SELECT mrp.*, bs.backup_reference, creator.username AS created_by_username
       FROM module_recovery_points mrp
       LEFT JOIN backup_sets bs ON bs.id = mrp.backup_set_id
       LEFT JOIN users creator ON creator.id = mrp.created_by
      ORDER BY mrp.created_at DESC
      LIMIT ${safeLimit}`
  );
  return rows.map(moduleRecoveryPointResponse);
}

async function listRestoreJobs(limit = 100) {
  if (!(await hasTable('restore_jobs'))) return [];
  const safeLimit = sqlLimit(limit);
  const [rows] = await pool.execute(
    `SELECT rj.*, bs.backup_reference,
            requester.username AS requested_by_username,
            approver.username AS approved_by_username
       FROM restore_jobs rj
       LEFT JOIN backup_sets bs ON bs.id = rj.backup_set_id
       LEFT JOIN users requester ON requester.id = rj.requested_by
       LEFT JOIN users approver ON approver.id = rj.approved_by
      ORDER BY rj.created_at DESC
      LIMIT ${safeLimit}`
  );
  return rows.map(restoreJobResponse);
}

async function listRollbackRequests(limit = 100) {
  if (!(await hasTable('module_rollback_requests'))) return [];
  const safeLimit = sqlLimit(limit);
  const [rows] = await pool.execute(
    `SELECT mrr.*,
            requester.username AS requested_by_username,
            approver.username AS approved_by_username
       FROM module_rollback_requests mrr
       LEFT JOIN users requester ON requester.id = mrr.requested_by
       LEFT JOIN users approver ON approver.id = mrr.approved_by
      ORDER BY mrr.created_at DESC
      LIMIT ${safeLimit}`
  );
  return rows.map(rollbackRequestResponse);
}

async function backupHealthStatusMap() {
  const map = new Map();
  if (!(await hasTable('system_health_checks'))) return map;
  const [rows] = await pool.execute(
    `SELECT module_key, status, last_checked_at
       FROM system_health_checks`
  );
  rows.forEach(row => map.set(row.module_key, {
    status: row.status,
    last_checked_at: row.last_checked_at,
  }));
  return map;
}

function latestBackupForModule(backupSets, moduleKey) {
  return backupSets.find(backup => {
    if (backup.backup_type === 'FULL_BACKUP') return true;
    const modules = parseModuleList(backup.included_modules);
    return modules.includes(moduleKey);
  }) || null;
}

async function buildBackupCoverage() {
  const [backupSets, recoveryPoints, healthMap] = await Promise.all([
    listBackupSets(200),
    listModuleRecoveryPoints(200),
    backupHealthStatusMap(),
  ]);
  const latestRecoveryByModule = new Map();
  recoveryPoints.forEach(point => {
    if (!latestRecoveryByModule.has(point.module_key)) latestRecoveryByModule.set(point.module_key, point);
  });

  return BACKUP_RECOVERY_MODULES.map(module => {
    const health = healthMap.get(module.healthKey || module.key) || null;
    const recoveryPoint = latestRecoveryByModule.get(module.key) || null;
    const latestBackup = latestBackupForModule(backupSets, module.key);
    const currentVersion = recoveryPoint?.current_version || moduleCurrentVersion(module.key);
    const stableVersion = recoveryPoint?.stable_version || moduleStableVersion(module.key);
    return {
      module_key: module.key,
      module_name: module.name,
      data_backup_coverage: module.data ? 'Covered' : 'Not Covered',
      file_backup_coverage: module.files ? 'Covered' : 'Not Applicable',
      config_backup_coverage: module.config ? 'Covered' : 'Not Covered',
      recovery_point_available: Boolean(recoveryPoint),
      current_version: currentVersion,
      stable_version: stableVersion,
      last_known_stable_version: stableVersion,
      last_backup_timestamp: latestBackup?.created_at || null,
      last_backup_type: latestBackup?.backup_type || null,
      last_health_status: health?.status || recoveryPoint?.health_status_at_backup || 'UNKNOWN',
      under_maintenance: (health?.status || recoveryPoint?.health_status_at_backup) === 'MAINTENANCE',
      recovery_point_id: recoveryPoint?.id || null,
      backup_set_id: latestBackup?.backup_set_id || null,
      rollback_available: Boolean(module.rollback && recoveryPoint?.rollback_available),
      recommended_action: health && ['OFFLINE', 'WARNING', 'MAINTENANCE'].includes(health.status)
        ? 'Check latest backup or view recovery point.'
        : 'Keep verified recovery point current.',
    };
  });
}

async function buildBackupOverview() {
  const [backupSets, restoreJobs, recoveryPoints, rollbackRequests, coverage] = await Promise.all([
    listBackupSets(200),
    listRestoreJobs(50),
    listModuleRecoveryPoints(50),
    listRollbackRequests(50),
    buildBackupCoverage(),
  ]);
  const latestByType = {};
  backupSets.forEach(backup => {
    if (!latestByType[backup.backup_type]) latestByType[backup.backup_type] = backup;
  });
  const failedBackups = backupSets.filter(backup => backup.status === 'FAILED').length;
  const warningBackups = backupSets.filter(backup => ['PENDING', 'RUNNING'].includes(backup.status)).length;
  const status = !backupSets.length
    ? 'Warning'
    : failedBackups > 0
      ? 'Failed'
      : warningBackups > 0
        ? 'Warning'
        : 'Healthy';
  const latestRecovery = recoveryPoints[0] || null;
  const latestDeployment = latestByType.DEPLOYMENT_VERSION || recoveryPoints.find(point => point.artifact_location) || null;
  return {
    generated_at: new Date().toISOString(),
    status,
    cards: {
      latest_database_backup: latestByType.DATABASE || null,
      latest_file_backup: latestByType.FILES || null,
      latest_configuration_backup: latestByType.CONFIGURATION || null,
      latest_module_recovery_point: latestRecovery,
      latest_deployment_version: latestDeployment,
      backup_status: status,
      total_backup_sets: backupSets.length,
      failed_backup_jobs: failedBackups,
      last_restore_attempt: restoreJobs[0] || null,
    },
    coverage,
    backup_sets: backupSets.slice(0, 20),
    restore_jobs: restoreJobs,
    rollback_requests: rollbackRequests,
    settings: {
      database_provider: process.env.AWS_RDS_DB_INSTANCE_ID ? 'RDS Snapshot metadata / MySQL dump record' : 'Local MySQL dump record',
      file_provider: process.env.AWS_S3_BUCKET || process.env.S3_BUCKET ? 'S3-ready file backup metadata' : 'Local file backup metadata',
      config_provider: 'Non-secret configuration only',
      deployment_provider: process.env.DEPLOYMENT_ARTIFACT_URI ? 'Deployment artifact reference' : 'Manual deployment artifact reference',
      aws_region_configured: Boolean(process.env.AWS_REGION),
      s3_bucket_configured: Boolean(process.env.AWS_S3_BUCKET || process.env.S3_BUCKET),
      rds_snapshot_configured: Boolean(process.env.AWS_RDS_DB_INSTANCE_ID),
    },
  };
}

async function getAuditHealth() {
  if (!(await hasTable('system_audit_log'))) {
    return { available: false, recent_events: 0, security_events_24h: 0 };
  }

  const timeColumn = await hasColumn('system_audit_log', 'timestamp')
    ? 'timestamp'
    : (await hasColumn('system_audit_log', 'Created_At'))
      ? 'Created_At'
      : null;
  if (!timeColumn) return { available: true, recent_events: 0, security_events_24h: 0 };

  const actionParts = [];
  if (await hasColumn('system_audit_log', 'Action_Type')) actionParts.push('Action_Type');
  if (await hasColumn('system_audit_log', 'action_performed')) actionParts.push('action_performed');
  if (await hasColumn('system_audit_log', 'Description')) actionParts.push('Description');
  const actionExpr = actionParts.length
    ? `LOWER(CONCAT_WS(' ', ${actionParts.join(', ')}))`
    : "''";

  const [rows] = await pool.execute(
    `SELECT
        COUNT(*) AS recent_events,
        COALESCE(SUM(CASE WHEN ${actionExpr} REGEXP 'failed|denied|blocked|locked|invalid|unauthorized|tamper' THEN 1 ELSE 0 END), 0) AS security_events_24h
       FROM system_audit_log
      WHERE ${timeColumn} >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`
  );

  return {
    available: true,
    recent_events: Number(rows[0]?.recent_events || 0),
    security_events_24h: Number(rows[0]?.security_events_24h || 0),
  };
}

async function getBlockchainSupportSnapshot() {
  const fabric = getFabricConfigStatus();
  const snapshot = {
    fabric,
    payroll_records: {
      available: await hasTable('PAYROLL_RECORD'),
      total: 0,
      finalized: 0,
      pending_anchor: 0,
      failed: 0,
    },
    audit: {
      available: await hasTable('BLOCKCHAIN_AUDIT_LOG'),
      critical: 0,
      recent: [],
    },
  };

  if (snapshot.payroll_records.available) {
    const [rows] = await pool.execute(
      `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN Approval_Status IN ('Finalized','FINALIZED','Submitted','SUBMITTED') THEN 1 ELSE 0 END), 0) AS finalized,
          COALESCE(SUM(CASE
            WHEN Approval_Status IN ('Finalized','FINALIZED','Submitted','SUBMITTED')
             AND (Transaction_Hash IS NULL OR Transaction_Hash = '' OR Blockchain_Status IN ('PENDING','PENDING_ANCHOR','PENDING_APPROVAL'))
            THEN 1 ELSE 0 END), 0) AS pending_anchor,
          COALESCE(SUM(CASE WHEN Blockchain_Status IN ('FAILED','ERROR') THEN 1 ELSE 0 END), 0) AS failed
         FROM PAYROLL_RECORD`
    );
    snapshot.payroll_records.total = Number(rows[0]?.total || 0);
    snapshot.payroll_records.finalized = Number(rows[0]?.finalized || 0);
    snapshot.payroll_records.pending_anchor = Number(rows[0]?.pending_anchor || 0);
    snapshot.payroll_records.failed = Number(rows[0]?.failed || 0);
  }

  if (snapshot.audit.available) {
    const [criticalRows] = await pool.execute(
      `SELECT COUNT(*) AS count
         FROM BLOCKCHAIN_AUDIT_LOG critical
        WHERE critical.Status IN ('CRITICAL','FAILED','VERIFICATION_FAILED')
          AND NOT EXISTS (
            SELECT 1
              FROM BLOCKCHAIN_AUDIT_LOG later
             WHERE later.Payroll_ID <=> critical.Payroll_ID
               AND later.Event_Type = critical.Event_Type
               AND later.Status IN ('VERIFIED','RECORDED')
               AND (
                 later.Created_At > critical.Created_At
                 OR (later.Created_At = critical.Created_At AND later.Audit_ID > critical.Audit_ID)
               )
          )`
    );
    const [recentRows] = await pool.execute(
      `SELECT Audit_ID, Payroll_ID, Event_Type, Status, Transaction_Hash, Payload_Hash, Created_At
         FROM BLOCKCHAIN_AUDIT_LOG
        ORDER BY Created_At DESC
        LIMIT 8`
    );
    snapshot.audit.critical = Number(criticalRows[0]?.count || 0);
    snapshot.audit.recent = recentRows;
  }

  return snapshot;
}

async function getLegacySystemHealthSnapshot() {
  const started = Date.now();
  await pool.execute('SELECT 1 AS ok');
  const databaseLatencyMs = Date.now() - started;
  const lockedColumn = await hasColumn('users', 'account_locked_until')
    ? 'account_locked_until'
    : (await hasColumn('users', 'locked_until'))
      ? 'locked_until'
      : null;
  const audit = await getAuditHealth();
  const blockchain = await getBlockchainSupportSnapshot();
  const backupAvailable = await hasTable('system_backup_log');
  const supportAvailable = await hasTable('system_support_ticket');

  let lastBackup = null;
  if (backupAvailable) {
    const [rows] = await pool.execute(
      `SELECT backup_id, backup_reference, backup_type, storage_target, status,
              requested_by, verified_by, manifest_hash, backup_location_encrypted,
              notes_encrypted, created_at, updated_at, completed_at, verified_at
         FROM system_backup_log
        ORDER BY created_at DESC
        LIMIT 1`
    );
    lastBackup = rows[0] ? backupResponse(rows[0]) : null;
  }

  const activeSessions = await countRows(
    'USER_SESSION',
    'WHERE Revoked_At IS NULL AND Expires_At > NOW()'
  );
  const activeUsers = await countRows('users', 'WHERE is_active = 1');
  const inactiveUsers = await countRows('users', 'WHERE is_active = 0');
  const lockedUsers = lockedColumn
    ? await countRows('users', `WHERE ${lockedColumn} IS NOT NULL AND ${lockedColumn} > NOW()`)
    : 0;
  const openTickets = supportAvailable
    ? await countRows('system_support_ticket', "WHERE status IN ('OPEN','IN_PROGRESS','WAITING_FOR_OWNER')")
    : 0;

  const [biometricRows] = await pool.execute(
    (await hasTable('biometric_device'))
      ? `SELECT
           COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS active,
           MAX(last_success_at) AS last_success_at,
           MAX(last_error_at) AS last_error_at
         FROM biometric_device`
      : 'SELECT 0 AS total, 0 AS active, NULL AS last_success_at, NULL AS last_error_at'
  );
  const biometric = biometricRows[0] || {};

  const issueCount = [
    databaseLatencyMs > 1000,
    audit.security_events_24h > 25,
    blockchain.payroll_records.failed > 0,
    blockchain.audit.critical > 0,
    openTickets > 0,
  ].filter(Boolean).length;

  return {
    generated_at: new Date().toISOString(),
    status: issueCount >= 2 ? 'warning' : 'healthy',
    database: {
      connected: true,
      latency_ms: databaseLatencyMs,
    },
    runtime: {
      node_version: process.version,
      uptime_seconds: Math.round(process.uptime()),
      memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
    accounts: {
      active: activeUsers,
      inactive: inactiveUsers,
      locked: lockedUsers,
      active_sessions: activeSessions,
    },
    audit,
    support: {
      available: supportAvailable,
      open_tickets: openTickets,
    },
    backups: {
      available: backupAvailable,
      last_backup: lastBackup,
    },
    biometric: {
      total_devices: Number(biometric.total || 0),
      active_devices: Number(biometric.active || 0),
      last_success_at: biometric.last_success_at || null,
      last_error_at: biometric.last_error_at || null,
    },
    blockchain,
  };
}

const SYSTEM_HEALTH_STATUSES = new Set(['ONLINE', 'WARNING', 'OFFLINE', 'MAINTENANCE']);

function healthResult(status, remarks, extras = {}) {
  const normalizedStatus = SYSTEM_HEALTH_STATUSES.has(String(status || '').toUpperCase())
    ? String(status || '').toUpperCase()
    : 'WARNING';
  return {
    status: normalizedStatus,
    remarks: cleanText(remarks || '', 500),
    dependencies: extras.dependencies || {},
    error_message: extras.error_message ? cleanText(extras.error_message, 500) : null,
  };
}

async function firstExistingTable(candidates) {
  for (const tableName of candidates) {
    if (isSafeIdentifier(tableName) && await hasTable(tableName)) return tableName;
  }
  return null;
}

async function tableDependency(tableName, label = tableName) {
  return {
    label,
    table: tableName || null,
    available: Boolean(tableName),
  };
}

async function countIfTable(tableName, whereClause = '', params = []) {
  if (!tableName) return 0;
  return countRows(tableName, whereClause, params);
}

async function maxDateIfColumn(tableName, columnCandidates) {
  if (!tableName || !isSafeIdentifier(tableName)) return null;
  for (const columnName of columnCandidates) {
    if (!isSafeIdentifier(columnName) || !(await hasColumn(tableName, columnName))) continue;
    const [rows] = await pool.execute(`SELECT MAX(${columnName}) AS latest_at FROM ${tableName}`);
    return rows[0]?.latest_at || null;
  }
  return null;
}

function checkedTimestamp() {
  // Pass a real Date to mysql2 so the pool's configured +08:00 timezone is
  // applied consistently. A UTC-looking string inserted into DATETIME was
  // treated as Philippine local time and made health checks appear 8h old.
  return new Date();
}

function makeSystemHealthRunId() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : `health-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}

function envValue(candidates) {
  for (const name of candidates) {
    const value = String(process.env[name] || '').trim();
    if (value) return { name, value };
  }
  return { name: null, value: '' };
}

function isTruthyEnv(candidates) {
  const { value } = envValue(candidates);
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function secretHealthStatus(candidates, label, minLength = 32) {
  const { name, value } = envValue(candidates);
  if (!value) {
    return {
      label,
      available: false,
      status: 'Missing',
      source: candidates.join(' or '),
    };
  }
  return {
    label,
    available: true,
    status: value.length >= minLength ? 'Configured' : `Configured but shorter than ${minLength} characters`,
    source: name,
  };
}

function classifyDatabaseHost(host) {
  const normalized = String(host || '').trim().toLowerCase();
  if (!normalized) return 'missing';
  if (['localhost', '127.0.0.1', '::1'].includes(normalized) || normalized.endsWith('.local')) return 'local';
  if (normalized.includes('.rds.amazonaws.com') || normalized.includes('rds.amazonaws.com')) return 'amazon-rds';
  if (normalized.includes('amazonaws.com')) return 'aws-managed';
  return 'custom';
}

function dependencySetting(label, available, status, extras = {}) {
  return {
    label,
    available: Boolean(available),
    status,
    ...extras,
  };
}

async function checkDatabaseHealth() {
  const started = Date.now();
  await pool.execute('SELECT 1 AS ok');
  const latency = Date.now() - started;
  return healthResult(
    latency > 1000 ? 'WARNING' : 'ONLINE',
    latency > 1000 ? 'Database responded slowly.' : 'Database connection is reachable.',
    {
      dependencies: {
        database_connection: { label: 'MySQL / RDS connection', available: true, latency_ms: latency },
      },
    }
  );
}

async function checkAuthenticationHealth() {
  const usersTable = await firstExistingTable(['users']);
  const sessionTable = await firstExistingTable(['USER_SESSION']);
  const auditTable = await firstExistingTable(['system_audit_log']);
  const lockedColumn = usersTable && await hasColumn(usersTable, 'account_locked_until')
    ? 'account_locked_until'
    : usersTable && await hasColumn(usersTable, 'locked_until')
      ? 'locked_until'
      : null;
  const activeUsers = await countIfTable(usersTable, 'WHERE is_active = 1');
  const lockedUsers = lockedColumn ? await countIfTable(usersTable, `WHERE ${lockedColumn} IS NOT NULL AND ${lockedColumn} > NOW()`) : 0;
  const activeSessions = await countIfTable(sessionTable, 'WHERE Revoked_At IS NULL AND Expires_At > NOW()');
  const status = !usersTable ? 'OFFLINE' : lockedUsers > 0 ? 'WARNING' : 'ONLINE';
  const remarks = !usersTable
    ? 'Users table is unavailable.'
    : lockedUsers > 0
      ? `${lockedUsers} account lockout(s) need review.`
      : 'Login, account lockout, and session tables are reachable.';
  return healthResult(status, remarks, {
    dependencies: {
      users: await tableDependency(usersTable, 'User accounts'),
      sessions: await tableDependency(sessionTable, 'JWT/session invalidation'),
      audit: await tableDependency(auditTable, 'Authentication audit trail'),
      active_users: { label: 'Active users', count: activeUsers },
      locked_accounts: { label: 'Locked accounts', count: lockedUsers },
      active_sessions: { label: 'Active sessions', count: activeSessions },
    },
  });
}

async function checkAccountManagementHealth() {
  const usersTable = await firstExistingTable(['users']);
  const employeesTable = await firstExistingTable(['employees']);
  const rolesTable = await firstExistingTable(['roles']);
  const activeUsers = await countIfTable(usersTable, 'WHERE is_active = 1');
  const employees = await countIfTable(employeesTable);
  const status = usersTable && employeesTable && rolesTable ? 'ONLINE' : 'WARNING';
  return healthResult(
    status,
    status === 'ONLINE'
      ? 'Account, employee, and role records are reachable.'
      : 'One or more account-management dependencies are missing.',
    {
      dependencies: {
        users: await tableDependency(usersTable, 'User accounts'),
        employees: await tableDependency(employeesTable, 'Employee directory'),
        roles: await tableDependency(rolesTable, 'Role catalog'),
        active_users: { label: 'Active users', count: activeUsers },
        employees_total: { label: 'Employees', count: employees },
      },
    }
  );
}

async function rbacLevel4RoleCondition(rolesTable, alias = '') {
  if (!rolesTable) return '1 = 0';
  const prefix = alias ? `${alias}.` : '';
  const conditions = [];
  if (await hasColumn(rolesTable, 'access_level')) {
    conditions.push(`LOWER(REPLACE(REPLACE(TRIM(CAST(${prefix}access_level AS CHAR)), ' ', ''), '_', '')) IN ('4','level4','l4')`);
  }
  if (await hasColumn(rolesTable, 'name')) {
    conditions.push(`LOWER(${prefix}name) IN ('system_admin','sys_admin','admin','administrator')`);
  }
  if (await hasColumn(rolesTable, 'label')) {
    conditions.push(`LOWER(CAST(${prefix}label AS CHAR)) IN ('system admin','system administrator','administrator')`);
    conditions.push(`LOWER(CAST(${prefix}label AS CHAR)) LIKE '%system%admin%'`);
  }
  return conditions.length ? conditions.join(' OR ') : '1 = 0';
}

async function countRbacLevel4Roles(rolesTable) {
  if (!rolesTable) return 0;
  const condition = await rbacLevel4RoleCondition(rolesTable);
  return countIfTable(rolesTable, `WHERE ${condition}`);
}

async function countRbacLevel4Users(usersTable, rolesTable) {
  if (!usersTable || !rolesTable || !isSafeIdentifier(usersTable) || !isSafeIdentifier(rolesTable)) return 0;
  const hasRoleId = await hasColumn(usersTable, 'role_id');
  const hasRolePk = await hasColumn(rolesTable, 'id');
  if (!hasRoleId || !hasRolePk) return 0;
  const activeClause = await hasColumn(usersTable, 'is_active') ? 'AND u.is_active = 1' : '';
  const condition = await rbacLevel4RoleCondition(rolesTable, 'r');
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count
       FROM ${usersTable} u
       JOIN ${rolesTable} r ON r.id = u.role_id
      WHERE (${condition})
        ${activeClause}`
  );
  return Number(rows[0]?.count || 0);
}

async function checkRbacHealth() {
  const usersTable = await firstExistingTable(['users']);
  const rolesTable = await firstExistingTable(['roles']);
  const permissionsTable = await firstExistingTable(['permissions']);
  const rolePermissionsTable = await firstExistingTable(['role_permissions']);
  const roles = await countIfTable(rolesTable);
  const level4Roles = await countRbacLevel4Roles(rolesTable);
  const level4Users = await countRbacLevel4Users(usersTable, rolesTable);
  const hasCore = Boolean(usersTable && rolesTable);
  const hasPermissionMapping = Boolean(permissionsTable && rolePermissionsTable);
  const status = !hasCore
    ? 'OFFLINE'
    : level4Roles === 0 || !hasPermissionMapping
      ? 'WARNING'
      : 'ONLINE';
  const remarks = !hasCore
    ? 'RBAC core tables are unavailable.'
    : level4Roles === 0
      ? 'RBAC core tables are reachable, but no Level 4 administrator role was found.'
      : !hasPermissionMapping
        ? 'RBAC roles are reachable, but permission catalog or role-permission mapping is incomplete.'
        : 'RBAC roles, administrator role mapping, and permission tables are reachable.';
  return healthResult(
    status,
    remarks,
    {
      dependencies: {
        users: await tableDependency(usersTable, 'User role assignments'),
        roles: await tableDependency(rolesTable, 'Role hierarchy'),
        permissions: await tableDependency(permissionsTable, 'Permission catalog'),
        role_permissions: await tableDependency(rolePermissionsTable, 'Role permissions'),
        role_count: { label: 'Roles', count: roles },
        level4_roles: { label: 'Level 4 roles', count: level4Roles },
        active_level4_users: { label: 'Active Level 4 users', count: level4Users },
      },
    }
  );
}

async function checkEmployeeHealth() {
  const employeesTable = await firstExistingTable(['employees']);
  const lifecycleTable = await firstExistingTable(['employee_lifecycle_event']);
  const fileAuditTable = await firstExistingTable(['employee_201_file_access_audit']);
  const employees = await countIfTable(employeesTable);
  const latest = await maxDateIfColumn(employeesTable, ['updated_at', 'Updated_At', 'created_at', 'Created_At']);
  const status = !employeesTable ? 'OFFLINE' : employees === 0 ? 'WARNING' : 'ONLINE';
  return healthResult(
    status,
    !employeesTable
      ? 'Employee directory table is unavailable.'
      : employees === 0
        ? 'Employee directory is reachable but has no records.'
        : 'Employee directory and 201-file audit dependencies are reachable.',
    {
      dependencies: {
        employees: await tableDependency(employeesTable, 'Employee directory'),
        lifecycle_events: await tableDependency(lifecycleTable, 'Lifecycle events'),
        file_access_audit: await tableDependency(fileAuditTable, '201-file access audit'),
        employee_count: { label: 'Employees', count: employees },
        latest_employee_update: { label: 'Latest employee update', value: latest },
      },
    }
  );
}

async function checkAttendanceHealth() {
  const attendanceTable = await firstExistingTable(['attendance_log']);
  const summaryTable = await firstExistingTable(['attendance_summary']);
  const adjustmentTable = await firstExistingTable(['attendance_adjustment']);
  const records = await countIfTable(attendanceTable);
  const pending = attendanceTable && await hasColumn(attendanceTable, 'verification_status')
    ? await countIfTable(attendanceTable, "WHERE verification_status IN ('PENDING_VALIDATION','INCOMPLETE','NEEDS_REVIEW')")
    : 0;
  const latest = await maxDateIfColumn(attendanceTable, ['updated_at', 'created_at', 'date']);
  const status = !attendanceTable ? 'OFFLINE' : pending > 0 ? 'WARNING' : 'ONLINE';
  return healthResult(
    status,
    !attendanceTable
      ? 'Attendance log table is unavailable.'
      : pending > 0
        ? `${pending} attendance record(s) need validation.`
        : 'Attendance records and summaries are reachable.',
    {
      dependencies: {
        attendance_log: await tableDependency(attendanceTable, 'Attendance logs'),
        attendance_summary: await tableDependency(summaryTable, 'Attendance summaries'),
        attendance_adjustment: await tableDependency(adjustmentTable, 'Manual correction audit'),
        record_count: { label: 'Attendance records', count: records },
        pending_validation: { label: 'Needs validation', count: pending },
        latest_record: { label: 'Latest attendance record', value: latest },
      },
    }
  );
}

async function checkAttendanceSyncHealth() {
  const deviceTable = await firstExistingTable(['biometric_device']);
  const mappingTable = await firstExistingTable(['biometric_employee_mapping']);
  const syncTable = await firstExistingTable(['biometric_sync_log']);
  const commandTable = await firstExistingTable(['biometric_bridge_command']);
  const totalDevices = await countIfTable(deviceTable);
  const activeDevices = deviceTable && await hasColumn(deviceTable, 'is_active')
    ? await countIfTable(deviceTable, 'WHERE is_active = 1')
    : totalDevices;
  const latestSuccess = await maxDateIfColumn(deviceTable, ['last_success_at', 'updated_at']);
  const latestError = await maxDateIfColumn(deviceTable, ['last_error_at']);
  const failedSyncs = syncTable && await hasColumn(syncTable, 'status')
    ? await countIfTable(syncTable, "WHERE status IN ('FAILED','ERROR')")
    : 0;
  const status = !deviceTable ? 'WARNING' : activeDevices === 0 ? 'WARNING' : failedSyncs > 0 ? 'WARNING' : 'ONLINE';
  return healthResult(
    status,
    !deviceTable
      ? 'Biometric device table is not installed yet.'
      : activeDevices === 0
        ? 'No active biometric device is configured.'
        : failedSyncs > 0
          ? `${failedSyncs} biometric sync error(s) need review.`
          : 'Biometric devices and sync logs are reachable.',
    {
      dependencies: {
        biometric_device: await tableDependency(deviceTable, 'Biometric devices'),
        employee_mapping: await tableDependency(mappingTable, 'Employee-device mapping'),
        sync_log: await tableDependency(syncTable, 'Biometric sync log'),
        bridge_command: await tableDependency(commandTable, 'Bridge commands'),
        devices: { label: 'Active devices', count: activeDevices, total: totalDevices },
        failed_syncs: { label: 'Failed syncs', count: failedSyncs },
        last_success_at: { label: 'Last successful sync', value: latestSuccess },
        last_error_at: { label: 'Last sync error', value: latestError },
      },
    }
  );
}

async function checkLeaveHealth() {
  const leaveTable = await firstExistingTable(['leave_requests']);
  const balanceTable = await firstExistingTable(['leave_balances']);
  const typeTable = await firstExistingTable(['leave_types']);
  const auditTable = await firstExistingTable(['leave_audit_trail']);
  const pending = leaveTable && await hasColumn(leaveTable, 'status')
    ? await countIfTable(leaveTable, "WHERE status IN ('Pending','PENDING')")
    : 0;
  const total = await countIfTable(leaveTable);
  const status = !leaveTable ? 'WARNING' : 'ONLINE';
  return healthResult(
    status,
    !leaveTable
      ? 'Leave request table is not installed yet.'
      : pending > 0
        ? `${pending} leave request(s) are pending review.`
        : 'Leave request, balance, and audit dependencies are reachable.',
    {
      dependencies: {
        leave_requests: await tableDependency(leaveTable, 'Leave requests'),
        leave_balances: await tableDependency(balanceTable, 'Leave balances'),
        leave_types: await tableDependency(typeTable, 'Leave types'),
        leave_audit: await tableDependency(auditTable, 'Leave audit trail'),
        request_count: { label: 'Leave requests', count: total },
        pending_requests: { label: 'Pending requests', count: pending },
      },
    }
  );
}

async function checkPayrollHealth() {
  const payrollRecordTable = await firstExistingTable(['PAYROLL_RECORD']);
  const runsTable = await firstExistingTable(['payroll_runs']);
  const policyTable = await firstExistingTable(['payroll_policy_settings']);
  const auditTable = await firstExistingTable(['payroll_audit_trail']);
  const pendingRuns = runsTable && await hasColumn(runsTable, 'status')
    ? await countIfTable(runsTable, "WHERE status IN ('Draft','Pending','Submitted')")
    : 0;
  const records = await countIfTable(payrollRecordTable);
  const status = payrollRecordTable || runsTable ? 'ONLINE' : 'WARNING';
  return healthResult(
    status,
    status === 'ONLINE'
      ? 'Payroll computation records and policy dependencies are reachable.'
      : 'Payroll tables are not installed yet.',
    {
      dependencies: {
        payroll_record: await tableDependency(payrollRecordTable, 'Final payroll records'),
        payroll_runs: await tableDependency(runsTable, 'Payroll runs'),
        policy_settings: await tableDependency(policyTable, 'Payroll policies'),
        payroll_audit: await tableDependency(auditTable, 'Payroll audit trail'),
        payroll_records: { label: 'Payroll records', count: records },
        pending_runs: { label: 'Draft/submitted runs', count: pendingRuns },
      },
    }
  );
}

async function checkPayslipHealth() {
  const payslipTable = await firstExistingTable(['payslips']);
  const encryptedPayload = payslipTable && await hasColumn(payslipTable, 'payload_encrypted');
  const encryptedStorage = payslipTable && (
    await hasColumn(payslipTable, 'gross_pay_encrypted') ||
    await hasColumn(payslipTable, 'net_pay_encrypted')
  );
  const count = await countIfTable(payslipTable);
  const status = !payslipTable ? 'WARNING' : (encryptedPayload || encryptedStorage) ? 'ONLINE' : 'WARNING';
  return healthResult(
    status,
    !payslipTable
      ? 'Payslip table is not installed yet.'
      : status === 'ONLINE'
        ? 'Payslip storage is reachable and encrypted columns are present.'
        : 'Payslip table is reachable, but encrypted storage columns were not detected.',
    {
      dependencies: {
        payslips: await tableDependency(payslipTable, 'Payslip records'),
        encrypted_payload: { label: 'Encrypted payload column', available: Boolean(encryptedPayload) },
        encrypted_storage: { label: 'Encrypted pay columns', available: Boolean(encryptedStorage) },
        payslip_count: { label: 'Payslips', count },
      },
    }
  );
}

async function checkAuditTrailHealth() {
  const audit = await getAuditHealth();
  const status = !audit.available ? 'OFFLINE' : audit.security_events_24h > 25 ? 'WARNING' : 'ONLINE';
  return healthResult(
    status,
    !audit.available
      ? 'System audit log table is unavailable.'
      : audit.security_events_24h > 25
        ? 'High security-event volume detected in the last 24 hours.'
        : 'Audit log is reachable and recording recent events.',
    {
      dependencies: {
        system_audit_log: await tableDependency(audit.available ? 'system_audit_log' : null, 'System audit log'),
        recent_events: { label: 'Events in 24h', count: audit.recent_events },
        security_events: { label: 'Security events in 24h', count: audit.security_events_24h },
      },
    }
  );
}

async function checkBlockchainHealth() {
  const blockchain = await getBlockchainSupportSnapshot();
  const fabricReady = Boolean(blockchain.fabric?.ready);
  const pending = Number(blockchain.payroll_records?.pending_anchor || 0);
  const failed = Number(blockchain.payroll_records?.failed || 0);
  const critical = Number(blockchain.audit?.critical || 0);
  const status = failed > 0 || critical > 0
    ? 'OFFLINE'
    : !fabricReady || pending > 0
      ? 'WARNING'
      : 'ONLINE';
  return healthResult(
    status,
    status === 'ONLINE'
      ? 'Fabric configuration and payroll integrity records are ready.'
      : failed > 0 || critical > 0
        ? 'Blockchain verification has failed or critical audit records.'
        : pending > 0
          ? `${pending} finalized payroll record(s) still need blockchain anchoring.`
          : 'Fabric configuration is incomplete in this environment.',
    {
      dependencies: {
        fabric_config: { label: 'Hyperledger Fabric config', available: fabricReady },
        payroll_record: await tableDependency(blockchain.payroll_records?.available ? 'PAYROLL_RECORD' : null, 'Payroll records'),
        blockchain_audit: await tableDependency(blockchain.audit?.available ? 'BLOCKCHAIN_AUDIT_LOG' : null, 'Blockchain audit log'),
        pending_anchor: { label: 'Pending anchoring', count: pending },
        failed_records: { label: 'Failed blockchain records', count: failed },
        critical_audit: { label: 'Critical audit records', count: critical },
      },
    }
  );
}

async function checkBackupHealth() {
  const backupTable = await firstExistingTable(['backup_sets', 'system_backup_log']);
  let latest = null;
  if (backupTable) {
    const query = backupTable === 'backup_sets'
      ? `SELECT backup_reference, backup_type, storage_provider AS storage_target, status,
                verification_status, integrity_status, checksum,
                storage_location_encrypted, created_at, restored_at AS completed_at, verified_at
           FROM backup_sets
          ORDER BY created_at DESC
          LIMIT 1`
      : `SELECT backup_reference, backup_type, storage_target, status, created_at, completed_at, verified_at
           FROM system_backup_log
          ORDER BY created_at DESC
          LIMIT 1`;
    const [rows] = await pool.execute(query);
    latest = rows[0] || null;
  }
  const failedStatuses = ['FAILED', 'VERIFICATION_FAILED'];
  const pendingStatuses = ['REQUESTED', 'PENDING', 'RUNNING', 'COMPLETED'];
  const verifiedArtifact = backupTable === 'backup_sets'
    && latest
    && ['VERIFIED', 'RESTORED'].includes(latest.status)
    && latest.verification_status === 'MATCH'
    && latest.integrity_status === 'PASSED'
    && latest.checksum
    && latest.storage_location_encrypted
    && latest.verified_at;
  const status = !backupTable
    ? 'WARNING'
    : !latest
      ? 'WARNING'
      : failedStatuses.includes(latest.status)
        ? 'OFFLINE'
        : pendingStatuses.includes(latest.status)
          ? 'WARNING'
          : backupTable === 'backup_sets' && !verifiedArtifact
            ? 'WARNING'
            : 'ONLINE';
  return healthResult(
    status,
    !backupTable
      ? 'Backup log table is not installed yet.'
      : !latest
        ? 'No backup request has been recorded yet.'
        : failedStatuses.includes(latest.status)
          ? 'Latest backup failed or failed verification.'
          : verifiedArtifact || backupTable !== 'backup_sets'
            ? 'Latest backup artifact passed MFA-protected checksum verification and is available.'
            : 'Latest backup record is not yet MFA-verified and restorable.',
    {
      dependencies: {
        backup_log: await tableDependency(backupTable, 'Backup log'),
        latest_backup: latest ? {
          label: 'Latest backup',
          reference: latest.backup_reference,
          status: latest.status,
          target: latest.storage_target,
          created_at: latest.created_at,
          completed_at: latest.completed_at,
          verified_at: latest.verified_at,
        } : { label: 'Latest backup', available: false },
      },
    }
  );
}

async function checkAwsReadinessHealth() {
  const nodeEnv = envValue(['NODE_ENV']).value || 'development';
  const isProduction = nodeEnv.toLowerCase() === 'production';
  const dbHost = envValue(['DB_HOST']);
  const dbClass = classifyDatabaseHost(dbHost.value);
  const dbSslEnabled = isTruthyEnv(['DB_SSL']);
  const dbCredentialsReady = Boolean(
    envValue(['DB_USER']).value &&
    envValue(['DB_PASSWORD']).value &&
    envValue(['DB_NAME']).value
  );
  const jwtSecret = secretHealthStatus(['JWT_ACCESS_SECRET', 'JWT_SECRET'], 'JWT signing secret');
  const aesKey = secretHealthStatus(['AES_ENCRYPTION_KEY', 'AES_256_SECRET_KEY'], 'AES-256 data encryption key', 64);
  const dedicatedEncryptionKeyReady = Boolean(envValue(['AES_ENCRYPTION_KEY', 'AES_256_SECRET_KEY']).value);
  const encryptionRuntimeReady = dedicatedEncryptionKeyReady || Boolean(envValue(['JWT_SECRET', 'JWT_ACCESS_SECRET']).value);
  const publicUrl = envValue(['PUBLIC_BASE_URL', 'APP_BASE_URL', 'BASE_URL']);
  const publicHttps = publicUrl.value ? publicUrl.value.toLowerCase().startsWith('https://') : false;
  const trustProxy = isTruthyEnv(['TRUST_PROXY', 'APP_TRUST_PROXY', 'EXPRESS_TRUST_PROXY']);
  const secureCookies = isTruthyEnv(['COOKIE_SECURE', 'SECURE_COOKIES', 'SESSION_COOKIE_SECURE']);
  const awsRegion = envValue(['AWS_REGION', 'AWS_DEFAULT_REGION']);
  const s3Bucket = envValue(['AWS_S3_BUCKET', 'S3_BUCKET', 'BACKUP_S3_BUCKET', 'S3_BACKUP_BUCKET']);
  const staticAwsCredentials = Boolean(envValue(['AWS_ACCESS_KEY_ID']).value && envValue(['AWS_SECRET_ACCESS_KEY']).value);
  const iamHint = envValue(['AWS_ROLE_ARN', 'AWS_PROFILE', 'AWS_WEB_IDENTITY_TOKEN_FILE']);
  const uploadRoot = envValue(['SECURE_UPLOAD_ROOT']);
  const issues = [];
  const warnings = [];

  if (!isProduction) warnings.push('NODE_ENV is not production; AWS deployment readiness is partial.');
  if (!dbHost.value) warnings.push('DB_HOST is not set; the app may fall back to localhost.');
  if (isProduction && !dbHost.value) issues.push('DB_HOST must point to Amazon RDS MySQL in production.');
  if (isProduction && dbClass === 'local') issues.push('Production DB_HOST points to a local database address.');
  if (isProduction && dbClass !== 'amazon-rds' && dbClass !== 'aws-managed') warnings.push('DB_HOST does not look like an AWS-managed database endpoint.');
  if (!dbCredentialsReady) {
    const message = 'DB_USER, DB_PASSWORD, and DB_NAME must all be configured.';
    if (isProduction) issues.push(message);
    else warnings.push(message);
  }
  if (!dbSslEnabled) {
    const message = 'DB_SSL is not enabled; RDS traffic should use TLS.';
    if (isProduction) issues.push(message);
    else warnings.push(message);
  }
  if (!jwtSecret.available) {
    const message = 'JWT signing secret is missing.';
    if (isProduction) issues.push(message);
    else warnings.push(message);
  }
  if (!encryptionRuntimeReady) {
    const message = 'Encryption key material is missing for sensitive employee and payroll data.';
    if (isProduction) issues.push(message);
    else warnings.push(message);
  } else if (!dedicatedEncryptionKeyReady) {
    warnings.push('Dedicated AES encryption key is not configured; runtime may fall back to JWT-derived encryption.');
  }
  if (!awsRegion.value) warnings.push('AWS_REGION or AWS_DEFAULT_REGION is not configured.');
  if (!s3Bucket.value) warnings.push('S3 backup bucket is not configured.');
  if (isProduction && publicUrl.value && !publicHttps) issues.push('Public base URL must use HTTPS in production.');
  if (isProduction && !publicUrl.value) warnings.push('PUBLIC_BASE_URL or APP_BASE_URL is not configured.');
  if (isProduction && !trustProxy) warnings.push('Trust proxy is not enabled for EC2, reverse proxy, or load balancer deployment.');
  if (isProduction && !secureCookies) warnings.push('Secure cookie mode is not explicitly enabled.');
  if (!uploadRoot.value) warnings.push('SECURE_UPLOAD_ROOT is not configured; uploads will use the local default path.');

  const status = issues.length ? 'OFFLINE' : warnings.length ? 'WARNING' : 'ONLINE';
  const remarks = status === 'ONLINE'
    ? 'AWS deployment settings appear ready for EC2, RDS MySQL, S3 backup, and secure runtime.'
    : issues.length
      ? `${issues.length} critical AWS readiness issue(s) need admin action.`
      : `${warnings.length} AWS readiness warning(s) need review before production deployment.`;

  return healthResult(status, remarks, {
    error_message: issues.length ? issues.join(' ') : null,
    dependencies: {
      runtime_environment: dependencySetting('NODE_ENV', true, nodeEnv, { mode: isProduction ? 'production' : 'local/dev' }),
      http_port: dependencySetting('HTTP port', true, envValue(['PORT']).value ? 'Configured' : 'Default 3000'),
      database_host: dependencySetting('DB_HOST', Boolean(dbHost.value), dbHost.value ? `${dbClass} endpoint` : 'Missing; localhost fallback', { classification: dbClass }),
      database_credentials: dependencySetting('DB_USER / DB_PASSWORD / DB_NAME', dbCredentialsReady, dbCredentialsReady ? 'Configured' : 'Incomplete'),
      database_tls: dependencySetting('DB_SSL', dbSslEnabled, dbSslEnabled ? 'Enabled' : 'Disabled'),
      jwt_secret: jwtSecret,
      encryption_key: aesKey,
      encryption_runtime: dependencySetting('Encryption runtime', encryptionRuntimeReady, dedicatedEncryptionKeyReady ? 'Dedicated AES key configured' : encryptionRuntimeReady ? 'JWT-derived fallback available' : 'Missing'),
      aws_region: dependencySetting('AWS region', Boolean(awsRegion.value), awsRegion.value ? 'Configured' : 'Missing', { source: awsRegion.name || 'AWS_REGION or AWS_DEFAULT_REGION' }),
      s3_backup_bucket: dependencySetting('S3 backup bucket', Boolean(s3Bucket.value), s3Bucket.value ? 'Configured' : 'Missing', { source: s3Bucket.name || 'AWS_S3_BUCKET or S3_BUCKET' }),
      aws_credential_mode: dependencySetting(
        'AWS credential mode',
        true,
        staticAwsCredentials
          ? 'Static env credentials configured'
          : iamHint.value
            ? 'IAM role/profile hint configured'
            : 'Use EC2 instance profile/IAM role for AWS access',
        { source: staticAwsCredentials ? 'AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY' : iamHint.name || 'EC2 instance profile' }
      ),
      public_https_url: dependencySetting('Public HTTPS URL', publicHttps, publicHttps ? 'HTTPS configured' : publicUrl.value ? 'Not HTTPS' : 'Missing', { source: publicUrl.name || 'PUBLIC_BASE_URL or APP_BASE_URL' }),
      trust_proxy: dependencySetting('Express trust proxy', trustProxy, trustProxy ? 'Enabled' : 'Not enabled'),
      secure_cookies: dependencySetting('Secure cookies', secureCookies, secureCookies ? 'Enabled' : 'Not explicitly enabled'),
      secure_upload_root: dependencySetting('Secure upload root', Boolean(uploadRoot.value), uploadRoot.value ? 'Configured' : 'Default local path'),
    },
  });
}

async function checkDashboardHealth() {
  const employeesTable = await firstExistingTable(['employees']);
  const usersTable = await firstExistingTable(['users']);
  const auditTable = await firstExistingTable(['system_audit_log']);
  const attendanceTable = await firstExistingTable(['attendance_log']);
  const payrollTable = await firstExistingTable(['PAYROLL_RECORD', 'payroll_runs']);
  const leaveTable = await firstExistingTable(['leave_requests']);
  const employeeCount = await countIfTable(employeesTable);
  const userCount = await countIfTable(usersTable);
  const latestAudit = await maxDateIfColumn(auditTable, ['timestamp', 'Created_At', 'created_at']);
  const latestAttendance = await maxDateIfColumn(attendanceTable, ['date', 'attendance_date', 'created_at', 'updated_at']);
  const hasCore = Boolean(employeesTable && usersTable);
  const status = hasCore ? 'ONLINE' : (employeesTable || usersTable ? 'WARNING' : 'OFFLINE');
  return healthResult(
    status,
    status === 'ONLINE'
      ? 'Dashboard data sources are reachable.'
      : status === 'WARNING'
        ? 'Dashboard has partial access to employee or account data.'
        : 'Dashboard core employee and account tables are unavailable.',
    {
      dependencies: {
        employees: await tableDependency(employeesTable, 'Employee directory'),
        users: await tableDependency(usersTable, 'User accounts'),
        audit_log: await tableDependency(auditTable, 'Recent system activity'),
        attendance_log: await tableDependency(attendanceTable, 'Attendance summary source'),
        payroll_source: await tableDependency(payrollTable, 'Payroll summary source'),
        leave_requests: await tableDependency(leaveTable, 'Leave summary source'),
        employee_count: { label: 'Employees', count: employeeCount },
        user_count: { label: 'User accounts', count: userCount },
        latest_audit_event: { label: 'Latest audit event', value: latestAudit },
        latest_attendance_record: { label: 'Latest attendance record', value: latestAttendance },
      },
    }
  );
}

async function checkOrganizationSetupHealth() {
  const departmentsTable = await firstExistingTable(['departments']);
  const positionsTable = await firstExistingTable(['positions']);
  const wageTypesTable = await firstExistingTable(['wage_types']);
  const holidaysTable = await firstExistingTable(['holiday_calendar']);
  const departments = await countIfTable(departmentsTable);
  const positions = await countIfTable(positionsTable);
  const wageTypes = await countIfTable(wageTypesTable);
  const holidays = await countIfTable(holidaysTable);
  const hasCore = Boolean(departmentsTable && positionsTable);
  const status = hasCore ? 'ONLINE' : 'WARNING';
  return healthResult(
    status,
    hasCore
      ? 'Organization setup lookups are reachable.'
      : 'Department or position lookup tables are incomplete.',
    {
      dependencies: {
        departments: await tableDependency(departmentsTable, 'Departments'),
        positions: await tableDependency(positionsTable, 'Positions'),
        wage_types: await tableDependency(wageTypesTable, 'Wage type setup'),
        holiday_calendar: await tableDependency(holidaysTable, 'Holiday calendar'),
        department_count: { label: 'Departments', count: departments },
        position_count: { label: 'Positions', count: positions },
        wage_type_count: { label: 'Wage types', count: wageTypes },
        holiday_count: { label: 'Holidays', count: holidays },
      },
    }
  );
}

async function checkOnboardingHealth() {
  const applicantsTable = await firstExistingTable(['applicants']);
  const activityTable = await firstExistingTable(['onboarding_activity_log']);
  const documentsTable = await firstExistingTable(['onboarding_documents']);
  const chainTable = await firstExistingTable(['onboarding_integrity_chain']);
  const applicants = await countIfTable(applicantsTable);
  const pendingApplicants = applicantsTable && await hasColumn(applicantsTable, 'status')
    ? await countIfTable(applicantsTable, "WHERE LOWER(status) IN ('pending','for review','approved','for onboarding','onboarding')")
    : 0;
  const pendingAnchors = chainTable && await hasColumn(chainTable, 'anchor_status')
    ? await countIfTable(chainTable, "WHERE anchor_status IN ('PENDING','FAILED')")
    : 0;
  const latestActivity = await maxDateIfColumn(activityTable, ['created_at', 'Created_At', 'timestamp']);
  const status = !applicantsTable
    ? 'WARNING'
    : pendingAnchors > 0
      ? 'WARNING'
      : 'ONLINE';
  return healthResult(
    status,
    !applicantsTable
      ? 'Applicant/onboarding table is not installed yet.'
      : pendingAnchors > 0
        ? `${pendingAnchors} onboarding integrity anchor(s) need review.`
        : 'Recruitment and onboarding dependencies are reachable.',
    {
      dependencies: {
        applicants: await tableDependency(applicantsTable, 'Applicant records'),
        onboarding_activity: await tableDependency(activityTable, 'Onboarding activity log'),
        onboarding_documents: await tableDependency(documentsTable, 'Onboarding documents'),
        integrity_chain: await tableDependency(chainTable, 'Onboarding integrity chain'),
        applicant_count: { label: 'Applicants', count: applicants },
        pending_applicants: { label: 'Pending applicants', count: pendingApplicants },
        pending_integrity_anchors: { label: 'Pending/failed integrity anchors', count: pendingAnchors },
        latest_activity: { label: 'Latest onboarding activity', value: latestActivity },
      },
    }
  );
}

async function checkReportsHealth() {
  const employeesTable = await firstExistingTable(['employees']);
  const attendanceTable = await firstExistingTable(['attendance_log']);
  const payrollTable = await firstExistingTable(['PAYROLL_RECORD']);
  const payslipTable = await firstExistingTable(['payslips']);
  const auditTable = await firstExistingTable(['system_audit_log']);
  const employeeCount = await countIfTable(employeesTable);
  const attendanceCount = await countIfTable(attendanceTable);
  const payrollCount = await countIfTable(payrollTable);
  const payslipCount = await countIfTable(payslipTable);
  const hasReportSource = Boolean(employeesTable && (attendanceTable || payrollTable || payslipTable));
  const status = hasReportSource ? 'ONLINE' : 'WARNING';
  return healthResult(
    status,
    hasReportSource
      ? 'Report source tables are reachable.'
      : 'One or more report source tables are missing; reports may be limited.',
    {
      dependencies: {
        employees: await tableDependency(employeesTable, 'Employee report source'),
        attendance_log: await tableDependency(attendanceTable, 'Daily attendance report source'),
        payroll_record: await tableDependency(payrollTable, 'Payroll register report source'),
        payslips: await tableDependency(payslipTable, 'Employee payslip report source'),
        audit_log: await tableDependency(auditTable, 'Report access audit source'),
        employee_count: { label: 'Employees', count: employeeCount },
        attendance_records: { label: 'Attendance records', count: attendanceCount },
        payroll_records: { label: 'Payroll records', count: payrollCount },
        payslip_records: { label: 'Payslips', count: payslipCount },
      },
    }
  );
}

async function checkSelfServiceHealth() {
  const employeesTable = await firstExistingTable(['employees']);
  const usersTable = await firstExistingTable(['users']);
  const requestTable = await firstExistingTable(['user_profile_change_requests']);
  const auditTable = await firstExistingTable(['user_profile_audit_logs']);
  const photoTable = await firstExistingTable(['employee_photos']);
  const pendingRequests = requestTable && await hasColumn(requestTable, 'status')
    ? await countIfTable(requestTable, "WHERE status IN ('Pending','PENDING','Submitted','SUBMITTED')")
    : 0;
  const latestRequest = await maxDateIfColumn(requestTable, ['created_at', 'submitted_at', 'updated_at']);
  const hasCore = Boolean(employeesTable && usersTable);
  const status = hasCore && requestTable && auditTable ? 'ONLINE' : hasCore ? 'WARNING' : 'OFFLINE';
  return healthResult(
    status,
    status === 'ONLINE'
      ? 'Employee self-service profile and request tables are reachable.'
      : status === 'WARNING'
        ? 'Self-service core records are reachable, but request or audit tables are incomplete.'
        : 'Self-service employee/account dependencies are unavailable.',
    {
      dependencies: {
        employees: await tableDependency(employeesTable, 'Employee profile source'),
        users: await tableDependency(usersTable, 'Self-service login accounts'),
        profile_change_requests: await tableDependency(requestTable, 'Profile change requests'),
        profile_audit_logs: await tableDependency(auditTable, 'Self-service audit log'),
        employee_photos: await tableDependency(photoTable, 'Profile photo storage'),
        pending_requests: { label: 'Pending profile requests', count: pendingRequests },
        latest_request: { label: 'Latest profile request', value: latestRequest },
      },
    }
  );
}

async function checkDpaPrivacyHealth() {
  const acceptanceTable = await firstExistingTable(['DATA_PRIVACY_AGREEMENT_ACCEPTANCE']);
  const auditTable = await firstExistingTable(['system_audit_log']);
  const usersTable = await firstExistingTable(['users']);
  const acceptances = await countIfTable(acceptanceTable);
  const latestAcceptance = await maxDateIfColumn(acceptanceTable, ['Accepted_At', 'accepted_at', 'created_at']);
  const status = acceptanceTable && auditTable ? 'ONLINE' : acceptanceTable ? 'WARNING' : 'WARNING';
  return healthResult(
    status,
    acceptanceTable && auditTable
      ? 'Data Privacy Agreement acceptance and audit dependencies are reachable.'
      : 'Data Privacy Agreement acceptance or audit table is missing.',
    {
      dependencies: {
        dpa_acceptance: await tableDependency(acceptanceTable, 'DPA acceptance records'),
        users: await tableDependency(usersTable, 'User acceptance owner'),
        audit_log: await tableDependency(auditTable, 'DPA audit trail'),
        acceptance_count: { label: 'Recorded acceptances', count: acceptances },
        latest_acceptance: { label: 'Latest acceptance', value: latestAcceptance },
        agreement_version: dependencySetting('Agreement version', true, envValue(['DPA_AGREEMENT_VERSION']).value || 'Default LGSV-HR-DPA-2026-07-03'),
      },
    }
  );
}

async function checkSupportCenterHealth() {
  const ticketTable = await firstExistingTable(['system_support_ticket']);
  const usersTable = await firstExistingTable(['users']);
  const auditTable = await firstExistingTable(['system_audit_log']);
  const totalTickets = await countIfTable(ticketTable);
  const openTickets = ticketTable && await hasColumn(ticketTable, 'status')
    ? await countIfTable(ticketTable, "WHERE UPPER(status) IN ('OPEN','IN_PROGRESS','PENDING','ESCALATED')")
    : 0;
  const latestTicket = await maxDateIfColumn(ticketTable, ['updated_at', 'created_at']);
  const status = !ticketTable ? 'WARNING' : openTickets > 0 ? 'WARNING' : 'ONLINE';
  return healthResult(
    status,
    !ticketTable
      ? 'Support ticket table is not installed yet.'
      : openTickets > 0
        ? `${openTickets} support ticket(s) are still open.`
        : 'Support ticket and audit dependencies are reachable.',
    {
      dependencies: {
        support_tickets: await tableDependency(ticketTable, 'Support tickets'),
        users: await tableDependency(usersTable, 'Ticket assignees/requesters'),
        audit_log: await tableDependency(auditTable, 'Support action audit'),
        ticket_count: { label: 'Tickets', count: totalTickets },
        open_tickets: { label: 'Open tickets', count: openTickets },
        latest_ticket_update: { label: 'Latest ticket update', value: latestTicket },
      },
    }
  );
}

async function checkOperationalLogsHealth() {
  const pieceOutputsTable = await firstExistingTable(['piece_rate_outputs', 'payroll_production_outputs']);
  const productionPairsTable = await firstExistingTable(['payroll_production_pairs']);
  const pieceRatesTable = await firstExistingTable(['payroll_piece_rates', 'piece_rates']);
  const deliveryTripsTable = await firstExistingTable(['delivery_trips']);
  const logisticsRatesTable = await firstExistingTable(['logistics_rates', 'payroll_logistics_rates']);
  const pieceOutputs = await countIfTable(pieceOutputsTable);
  const productionPairs = await countIfTable(productionPairsTable);
  const deliveryTrips = await countIfTable(deliveryTripsTable);
  const pendingPieceOutputs = pieceOutputsTable && await hasColumn(pieceOutputsTable, 'status')
    ? await countIfTable(pieceOutputsTable, "WHERE status IN ('Draft','For Validation','Submitted','Pending','Payroll Ready')")
    : 0;
  const pendingTrips = deliveryTripsTable && await hasColumn(deliveryTripsTable, 'status')
    ? await countIfTable(deliveryTripsTable, "WHERE status IN ('Draft','For Validation','Submitted','Pending','Payroll Ready')")
    : 0;
  const hasOperationalTables = Boolean(pieceOutputsTable || productionPairsTable || deliveryTripsTable);
  const hasRateTables = Boolean(pieceRatesTable || logisticsRatesTable);
  const status = hasOperationalTables && hasRateTables ? 'ONLINE' : hasOperationalTables ? 'WARNING' : 'WARNING';
  return healthResult(
    status,
    hasOperationalTables && hasRateTables
      ? 'Production and logistics operational log dependencies are reachable.'
      : hasOperationalTables
        ? 'Operational logs are reachable, but rate configuration tables are incomplete.'
        : 'Production and logistics operational log tables are not installed yet.',
    {
      dependencies: {
        piece_rate_outputs: await tableDependency(pieceOutputsTable, 'Piece-rate output logs'),
        production_pairs: await tableDependency(productionPairsTable, 'Production pair logs'),
        piece_rates: await tableDependency(pieceRatesTable, 'Piece-rate configuration'),
        delivery_trips: await tableDependency(deliveryTripsTable, 'Logistics trip logs'),
        logistics_rates: await tableDependency(logisticsRatesTable, 'Logistics rate configuration'),
        piece_output_count: { label: 'Piece-rate outputs', count: pieceOutputs },
        production_pair_count: { label: 'Production pairs', count: productionPairs },
        delivery_trip_count: { label: 'Delivery trips', count: deliveryTrips },
        pending_piece_outputs: { label: 'Pending piece outputs', count: pendingPieceOutputs },
        pending_delivery_trips: { label: 'Pending delivery trips', count: pendingTrips },
      },
    }
  );
}

async function checkPayrollSettingsHealth() {
  const policyTable = await firstExistingTable(['payroll_policy_settings']);
  const deductionSettingsTable = await firstExistingTable(['payroll_deduction_settings']);
  const deductionBracketsTable = await firstExistingTable(['payroll_deduction_brackets']);
  const sssRowsTable = await firstExistingTable(['sss_table_rows']);
  const sssVersionsTable = await firstExistingTable(['sss_table_versions']);
  const allowanceSettingsTable = await firstExistingTable(['payroll_allowance_settings', 'allowance_settings']);
  const attendanceConfigTable = await firstExistingTable(['payroll_attendance_configurations']);
  const employeeDeductionsTable = await firstExistingTable(['employee_deduction_accounts']);
  const activeDeductionSettings = deductionSettingsTable && await hasColumn(deductionSettingsTable, 'is_active')
    ? await countIfTable(deductionSettingsTable, 'WHERE is_active = 1')
    : await countIfTable(deductionSettingsTable);
  const sssRows = await countIfTable(sssRowsTable);
  const employeeDeductions = await countIfTable(employeeDeductionsTable);
  const hasCoreSettings = Boolean(policyTable || deductionSettingsTable || sssRowsTable);
  const status = hasCoreSettings ? 'ONLINE' : 'WARNING';
  return healthResult(
    status,
    hasCoreSettings
      ? 'Payroll settings and statutory deduction tables are reachable.'
      : 'Payroll settings tables are not installed yet.',
    {
      dependencies: {
        payroll_policy_settings: await tableDependency(policyTable, 'Payroll policy settings'),
        payroll_deduction_settings: await tableDependency(deductionSettingsTable, 'Deduction settings'),
        payroll_deduction_brackets: await tableDependency(deductionBracketsTable, 'Deduction brackets'),
        sss_table_rows: await tableDependency(sssRowsTable, 'SSS table rows'),
        sss_table_versions: await tableDependency(sssVersionsTable, 'SSS import versions'),
        allowance_settings: await tableDependency(allowanceSettingsTable, 'Allowance settings'),
        payroll_attendance_configurations: await tableDependency(attendanceConfigTable, 'Payroll attendance rules'),
        employee_deductions: await tableDependency(employeeDeductionsTable, 'Employee deduction accounts'),
        active_deduction_settings: { label: 'Active deduction settings', count: activeDeductionSettings },
        sss_rows: { label: 'SSS rows', count: sssRows },
        employee_deduction_accounts: { label: 'Employee deduction accounts', count: employeeDeductions },
      },
    }
  );
}

async function checkPayrollApprovalHealth() {
  const runsTable = await firstExistingTable(['payroll_runs']);
  const payrollRecordTable = await firstExistingTable(['PAYROLL_RECORD']);
  const auditTable = await firstExistingTable(['payroll_audit_trail', 'system_audit_log']);
  const blockchainAuditTable = await firstExistingTable(['BLOCKCHAIN_AUDIT_LOG']);
  const pendingRuns = runsTable && await hasColumn(runsTable, 'status')
    ? await countIfTable(runsTable, "WHERE status IN ('Submitted','Pending','Pending Approval','For Approval','Ready for Approval')")
    : 0;
  const hasApprovalStatus = payrollRecordTable && await hasColumn(payrollRecordTable, 'Approval_Status');
  const hasBlockchainStatus = payrollRecordTable && await hasColumn(payrollRecordTable, 'Blockchain_Status');
  const finalizedRecords = hasApprovalStatus
    ? await countIfTable(payrollRecordTable, "WHERE Approval_Status IN ('APPROVED','Approved','FINALIZED','Finalized')")
    : await countIfTable(payrollRecordTable);
  const pendingFinalizedAnchors = hasApprovalStatus && hasBlockchainStatus
    ? await countIfTable(payrollRecordTable, "WHERE Approval_Status IN ('APPROVED','Approved','FINALIZED','Finalized') AND (Blockchain_Status IS NULL OR Blockchain_Status IN ('PENDING','FAILED'))")
    : 0;
  const status = !runsTable && !payrollRecordTable
    ? 'WARNING'
    : pendingRuns > 0 || pendingFinalizedAnchors > 0
      ? 'WARNING'
      : 'ONLINE';
  return healthResult(
    status,
    !runsTable && !payrollRecordTable
      ? 'Payroll approval tables are not installed yet.'
      : pendingFinalizedAnchors > 0
        ? `${pendingFinalizedAnchors} finalized payroll record(s) still need blockchain anchoring.`
        : pendingRuns > 0
          ? `${pendingRuns} payroll run(s) are waiting for approval review.`
          : 'Payroll approval, finalization, and audit dependencies are reachable.',
    {
      dependencies: {
        payroll_runs: await tableDependency(runsTable, 'Payroll run approvals'),
        payroll_record: await tableDependency(payrollRecordTable, 'Final payroll records'),
        payroll_audit: await tableDependency(auditTable, 'Payroll approval audit'),
        blockchain_audit: await tableDependency(blockchainAuditTable, 'Finalization blockchain audit'),
        pending_approvals: { label: 'Pending approvals', count: pendingRuns },
        finalized_records: { label: 'Finalized payroll records', count: finalizedRecords },
        pending_blockchain_anchors: { label: 'Pending blockchain anchors', count: pendingFinalizedAnchors },
      },
    }
  );
}

const SYSTEM_HEALTH_MODULES = [
  {
    key: 'dashboard',
    name: 'Dashboard',
    endpoint: '/api/dashboard',
    dependencies: ['employees', 'users', 'system_audit_log', 'attendance_log', 'PAYROLL_RECORD', 'leave_requests'],
    recommended_action: 'Check employee, user, attendance, payroll, leave, and audit data sources when dashboard cards look stale.',
    check: checkDashboardHealth,
  },
  {
    key: 'authentication',
    name: 'Authentication / Login',
    endpoint: '/api/auth/login',
    dependencies: ['users', 'USER_SESSION', 'system_audit_log'],
    recommended_action: 'Review failed login, MFA, and lockout audit events before resetting credentials.',
    check: checkAuthenticationHealth,
  },
  {
    key: 'dpa_privacy',
    name: 'Data Privacy Agreement',
    endpoint: '/api/dpa/status',
    dependencies: ['DATA_PRIVACY_AGREEMENT_ACCEPTANCE', 'system_audit_log', 'users'],
    recommended_action: 'Verify DPA acceptance records and audit entries before allowing continued system access.',
    check: checkDpaPrivacyHealth,
  },
  {
    key: 'account_management',
    name: 'Account Management',
    endpoint: '/api/admin/users',
    dependencies: ['users', 'employees', 'roles'],
    recommended_action: 'Verify employee-account links and unlock or revoke sessions from Account Management when needed.',
    check: checkAccountManagementHealth,
  },
  {
    key: 'rbac',
    name: 'Role and Access Control',
    endpoint: '/api/admin/roles',
    dependencies: ['roles', 'permissions', 'role_permissions'],
    recommended_action: 'Confirm Level 4 role mapping and keep permission changes audited.',
    check: checkRbacHealth,
  },
  {
    key: 'employee_201',
    name: 'Employee / 201-File Management',
    endpoint: '/api/employees',
    dependencies: ['employees', 'employee_lifecycle_event', 'employee_201_file_access_audit'],
    recommended_action: 'Check employee lifecycle records and 201-file access audit entries for missing links.',
    check: checkEmployeeHealth,
  },
  {
    key: 'organization_setup',
    name: 'Organization Setup',
    endpoint: '/api/employee-setup/lookups',
    dependencies: ['departments', 'positions', 'wage_types', 'holiday_calendar'],
    recommended_action: 'Review department, position, wage type, and holiday setup before HR and payroll processing.',
    check: checkOrganizationSetupHealth,
  },
  {
    key: 'onboarding',
    name: 'Onboarding / Recruitment',
    endpoint: '/api/onboarding/dashboard',
    dependencies: ['applicants', 'onboarding_activity_log', 'onboarding_documents', 'onboarding_integrity_chain'],
    recommended_action: 'Review pending applicants, onboarding documents, and integrity anchors before transferring employees.',
    check: checkOnboardingHealth,
  },
  {
    key: 'attendance',
    name: 'Attendance',
    endpoint: '/api/attendance/all',
    dependencies: ['attendance_log', 'attendance_summary', 'attendance_adjustment'],
    recommended_action: 'Validate pending attendance records and keep corrections audit-logged.',
    check: checkAttendanceHealth,
  },
  {
    key: 'attendance_sync',
    name: 'Attendance Sync',
    endpoint: '/api/biometric/status',
    dependencies: ['biometric_device', 'biometric_employee_mapping', 'biometric_sync_log'],
    recommended_action: 'Check biometric device activity, sync logs, and employee-device mappings.',
    check: checkAttendanceSyncHealth,
  },
  {
    key: 'leave',
    name: 'Leave Management',
    endpoint: '/api/leave',
    dependencies: ['leave_requests', 'leave_balances', 'leave_audit_trail'],
    recommended_action: 'Review pending leave requests and verify balance records before payroll cutoff.',
    check: checkLeaveHealth,
  },
  {
    key: 'operational_logs',
    name: 'Operational Logs',
    endpoint: '/api/payroll/piece-rate-config / /api/payroll/logistics/trips',
    dependencies: ['piece_rate_outputs', 'payroll_production_pairs', 'delivery_trips', 'payroll_piece_rates', 'logistics_rates'],
    recommended_action: 'Review piece-rate output and logistics trip validation before payroll computation.',
    check: checkOperationalLogsHealth,
  },
  {
    key: 'payroll_settings',
    name: 'Payroll Settings',
    endpoint: '/api/payroll/deduction-settings',
    dependencies: ['payroll_policy_settings', 'payroll_deduction_settings', 'sss_table_rows', 'payroll_attendance_configurations'],
    recommended_action: 'Confirm statutory deduction, allowance, attendance, and wage-rate settings before payroll runs.',
    check: checkPayrollSettingsHealth,
  },
  {
    key: 'payroll',
    name: 'Payroll Computation',
    endpoint: '/api/payroll/salary-calculations',
    dependencies: ['PAYROLL_RECORD', 'payroll_runs', 'payroll_policy_settings'],
    recommended_action: 'Review draft payroll runs, policy settings, and payroll audit trail before final approval.',
    check: checkPayrollHealth,
  },
  {
    key: 'payroll_approval',
    name: 'Payroll Approval',
    endpoint: '/api/payroll/runs',
    dependencies: ['payroll_runs', 'PAYROLL_RECORD', 'payroll_audit_trail', 'BLOCKCHAIN_AUDIT_LOG'],
    recommended_action: 'Route approval issues to Payroll Manager and keep finalized payroll locked with blockchain anchoring.',
    check: checkPayrollApprovalHealth,
  },
  {
    key: 'payslip',
    name: 'Payslip Generation',
    endpoint: '/api/payroll/payslips',
    dependencies: ['payslips', 'PAYROLL_RECORD'],
    recommended_action: 'Verify payslip encryption columns and only release finalized payslips.',
    check: checkPayslipHealth,
  },
  {
    key: 'reports',
    name: 'Reports',
    endpoint: '/api/reports/library',
    dependencies: ['employees', 'attendance_log', 'PAYROLL_RECORD', 'payslips', 'system_audit_log'],
    recommended_action: 'Verify report source tables and keep financial exports limited to authorized payroll roles.',
    check: checkReportsHealth,
  },
  {
    key: 'self_service',
    name: 'Employee Self-Service',
    endpoint: '/api/self-service/profile',
    dependencies: ['employees', 'users', 'user_profile_change_requests', 'user_profile_audit_logs', 'employee_photos'],
    recommended_action: 'Review pending profile change requests and keep sensitive field reveals audit-logged.',
    check: checkSelfServiceHealth,
  },
  {
    key: 'audit_trail',
    name: 'Audit Trail',
    endpoint: '/api/admin/audit-log',
    dependencies: ['system_audit_log'],
    recommended_action: 'Investigate unusual failed, denied, blocked, or tamper-related audit events.',
    check: checkAuditTrailHealth,
  },
  {
    key: 'blockchain',
    name: 'Blockchain Support',
    endpoint: '/api/admin/blockchain-support/status',
    dependencies: ['PAYROLL_RECORD', 'BLOCKCHAIN_AUDIT_LOG', 'Hyperledger Fabric env'],
    recommended_action: 'Verify Fabric settings and anchor only finalized payroll integrity records.',
    check: checkBlockchainHealth,
  },
  {
    key: 'support_center',
    name: 'Support Center',
    endpoint: '/api/admin/support-tickets',
    dependencies: ['system_support_ticket', 'users', 'system_audit_log'],
    recommended_action: 'Review open support tickets and document troubleshooting actions without exposing secrets.',
    check: checkSupportCenterHealth,
  },
  {
    key: 'backup_restore',
    name: 'Backup and Restore',
    endpoint: '/api/admin/backups',
    dependencies: ['backup_sets', 'module_recovery_points', 'restore_jobs', 'module_rollback_requests', 'AWS S3 / RDS snapshot target'],
    recommended_action: 'Confirm the latest backup completed, recovery points exist, and rollback requests stay controlled.',
    check: checkBackupHealth,
  },
  {
    key: 'aws_readiness',
    name: 'AWS Deployment Readiness',
    endpoint: 'Environment / EC2-RDS-S3 readiness',
    dependencies: ['NODE_ENV', 'DB_HOST', 'DB_SSL', 'JWT_SECRET', 'AES_ENCRYPTION_KEY', 'AWS_REGION', 'S3 backup bucket'],
    recommended_action: 'Review AWS production env vars, RDS TLS, HTTPS, secure cookies, and S3 backup settings before deployment.',
    check: checkAwsReadinessHealth,
  },
  {
    key: 'database',
    name: 'Database',
    endpoint: 'MySQL SELECT 1',
    dependencies: ['MySQL / Amazon RDS MySQL'],
    recommended_action: 'Check RDS connectivity, credentials, TLS, and slow-query indicators if latency is high.',
    check: checkDatabaseHealth,
  },
];

const SYSTEM_HEALTH_MODULE_MAP = new Map(SYSTEM_HEALTH_MODULES.map(module => [module.key, module]));

const SYSTEM_HEALTH_REMEDIATION = {
  dashboard: {
    affected_area: 'Dashboard cards, cross-module summaries, and recent activity indicators.',
    probable_cause: 'Missing employee/account tables, stale attendance or payroll sources, or unavailable audit log data.',
    admin_action: 'Verify dashboard source tables before treating summary counts as accurate.',
    runbook_steps: [
      'Open Dashboard and identify which summary card is stale or blank.',
      'Check the related module source table in System Health.',
      'Review recent audit events if dashboard activity is not updating.',
    ],
  },
  authentication: {
    affected_area: 'Login, MFA verification, session creation, and account lockout handling.',
    probable_cause: 'Missing user/session audit tables, repeated failed login attempts, stale sessions, or MFA setup issues.',
    admin_action: 'Review failed login and MFA audit entries, unlock only verified accounts, and revoke stale sessions when needed.',
    runbook_steps: [
      'Open Account Management and check locked accounts.',
      'Review Audit Trail for failed login, MFA, and session events.',
      'Reset MFA or password only after identity verification.',
    ],
  },
  dpa_privacy: {
    affected_area: 'Data Privacy Agreement acceptance, forced acceptance flow, and DPA audit trail.',
    probable_cause: 'Missing DPA acceptance migration, stale agreement version, or audit log schema drift.',
    admin_action: 'Confirm users accept the current DPA version and that accept/decline actions are audit-logged.',
    runbook_steps: [
      'Check whether DATA_PRIVACY_AGREEMENT_ACCEPTANCE exists.',
      'Confirm DPA_AGREEMENT_VERSION matches the current company agreement.',
      'Review Audit Trail for DPA accepted or declined events.',
    ],
  },
  account_management: {
    affected_area: 'System Admin account registration, employee-account linking, unlock, session revoke, and MFA reset tools.',
    probable_cause: 'Missing employee-role links, inactive accounts, duplicate account records, or unavailable employee directory data.',
    admin_action: 'Verify account-to-employee mapping and correct only through audited System Admin actions.',
    runbook_steps: [
      'Search the affected username or employee code.',
      'Confirm the assigned role and active status.',
      'Use unlock, revoke sessions, or reset MFA only when the request is verified.',
    ],
  },
  rbac: {
    affected_area: 'Role hierarchy, permission checks, and protected admin/payroll/HR actions.',
    probable_cause: 'Missing Level 4 role, incomplete permission mapping, or role records not matching backend RBAC rules.',
    admin_action: 'Check role definitions before changing permissions, and confirm every role update is audit-logged.',
    runbook_steps: [
      'Open Role and Access Control.',
      'Confirm System Administrator remains Level 4.',
      'Review Audit Trail after any role or permission update.',
    ],
  },
  employee_201: {
    affected_area: 'Employee directory, 201-file access, lifecycle events, and protected employee records.',
    probable_cause: 'Employee table unavailable, no employee records, missing lifecycle audit, or 201-file audit not installed.',
    admin_action: 'Coordinate with HR Admin before changing employee records and verify 201-file access audit entries.',
    runbook_steps: [
      'Check Employee Management for the affected employee.',
      'Confirm lifecycle state and employee status.',
      'Review 201-file access audit before exposing sensitive data.',
    ],
  },
  organization_setup: {
    affected_area: 'Department, position, wage type, and holiday lookup data used by HR and payroll.',
    probable_cause: 'Missing lookup migrations, empty setup tables, or incomplete organization reference data.',
    admin_action: 'Coordinate setup changes with HR and payroll because these values affect employee records and computation rules.',
    runbook_steps: [
      'Open Organization Setup and verify departments and positions.',
      'Confirm wage types match approved payroll policies.',
      'Review holiday calendar entries before payroll cutoff.',
    ],
  },
  onboarding: {
    affected_area: 'Applicant records, onboarding documents, employee transfer flow, and onboarding integrity chain.',
    probable_cause: 'Missing applicant/onboarding tables, pending onboarding records, or failed integrity anchors.',
    admin_action: 'Resolve onboarding data issues before creating locked Regular Employee accounts from approved applicants.',
    runbook_steps: [
      'Open Onboarding and check pending applicants.',
      'Verify required onboarding documents are present.',
      'Review onboarding integrity anchor status before employee transfer.',
    ],
  },
  attendance: {
    affected_area: 'Attendance records, validation, correction flow, payroll-ready summaries, and manual adjustment audit.',
    probable_cause: 'Pending validation records, missing attendance tables, incomplete biometric records, or correction queue buildup.',
    admin_action: 'Ask HR Admin to validate attendance records and avoid direct payroll correction without audit trail.',
    runbook_steps: [
      'Open Attendance records and filter pending or needs review.',
      'Validate or reject records through the attendance workflow.',
      'Confirm any manual correction creates an audit entry.',
    ],
  },
  attendance_sync: {
    affected_area: 'Biometric devices, employee-device mappings, sync logs, and bridge commands.',
    probable_cause: 'No active device, failed sync logs, unmapped biometric IDs, or bridge command queue issues.',
    admin_action: 'Check Attendance Sync device status and mapping before asking payroll to rely on attendance data.',
    runbook_steps: [
      'Open Attendance Sync.',
      'Confirm at least one biometric device is active.',
      'Review sync errors and unmapped employee events.',
    ],
  },
  leave: {
    affected_area: 'Leave requests, balances, leave policy data, and leave audit trail.',
    probable_cause: 'Missing leave tables, pending leave requests near cutoff, or leave balances not initialized.',
    admin_action: 'Ask HR Admin to review pending leave and confirm balances before payroll cutoff.',
    runbook_steps: [
      'Open Leave Management and review pending requests.',
      'Verify leave balances for affected employees.',
      'Check leave audit trail for approvals or rejections.',
    ],
  },
  operational_logs: {
    affected_area: 'Production piece-rate output logs, production pair logs, logistics trip logs, and related rate setup.',
    probable_cause: 'Missing operational log tables, pending validation records, or incomplete piece/logistics rate configuration.',
    admin_action: 'Have Payroll Officer validate physical production and trip logs before payroll computation.',
    runbook_steps: [
      'Open Payroll operational logs and filter Draft, For Validation, or Payroll Ready records.',
      'Check piece-rate and logistics rate setup for active rates.',
      'Confirm encoded logs include who encoded and approved them.',
    ],
  },
  payroll_settings: {
    affected_area: 'Payroll policies, statutory deductions, allowances, attendance rules, and employee deduction accounts.',
    probable_cause: 'Missing payroll settings tables, inactive deduction settings, or outdated SSS table rows.',
    admin_action: 'Verify settings before payroll generation; do not add income tax unless the project scope is changed.',
    runbook_steps: [
      'Open Payroll settings and review active deduction rules.',
      'Confirm SSS, PhilHealth, and Pag-IBIG settings are available.',
      'Check employee-specific deductions before generating payroll.',
    ],
  },
  payroll: {
    affected_area: 'Draft payroll computation, payroll policies, payroll runs, and final payroll record preparation.',
    probable_cause: 'Payroll tables unavailable, draft/submitted runs pending, policy settings missing, or payroll audit trail not reachable.',
    admin_action: 'Do not alter finalized payroll directly; route issues through payroll review, correction, or dispute flow.',
    runbook_steps: [
      'Open Payroll and check draft or submitted runs.',
      'Verify statutory deduction and payroll policy settings.',
      'Escalate final approval issues to Payroll Manager.',
    ],
  },
  payroll_approval: {
    affected_area: 'Payroll Manager approval, final payroll locking, final payroll records, and blockchain anchoring readiness.',
    probable_cause: 'Pending approval runs, finalized records not anchored, or missing payroll approval audit tables.',
    admin_action: 'Route approval decisions to Payroll Manager and keep finalized payroll immutable except through correction flow.',
    runbook_steps: [
      'Open Payroll runs and filter submitted or for approval records.',
      'Confirm Payroll Manager approval authority before finalization.',
      'Verify finalized payroll records are ready for blockchain anchoring.',
    ],
  },
  payslip: {
    affected_area: 'Finalized payslip records, encrypted payslip payloads, and employee payslip access.',
    probable_cause: 'Payslip table missing, encrypted storage columns missing, or payslips not generated from finalized payroll.',
    admin_action: 'Confirm payslips are generated only from finalized payroll and sensitive values remain encrypted.',
    runbook_steps: [
      'Check whether payroll was finalized.',
      'Verify payslip records exist for the payroll period.',
      'Confirm encrypted payslip columns are present before release.',
    ],
  },
  reports: {
    affected_area: 'Attendance reports, payroll register, payslip reports, and official financial summary export controls.',
    probable_cause: 'Missing report source tables, empty payroll/payslip records, or unavailable report access audit data.',
    admin_action: 'Verify source tables and ensure official financial exports remain restricted to Payroll Manager.',
    runbook_steps: [
      'Open Reports and identify the affected report.',
      'Check the related source module in System Health.',
      'Confirm report export permissions match RBAC policy.',
    ],
  },
  self_service: {
    affected_area: 'Employee profile viewing, sensitive field reveal audit, password changes, and profile change requests.',
    probable_cause: 'Missing self-service request tables, pending HR review requests, or unavailable employee/account links.',
    admin_action: 'Review profile changes through HR approval flow and keep sensitive field reveal actions audit-logged.',
    runbook_steps: [
      'Open employee self-service request records.',
      'Review pending profile changes with HR.',
      'Check audit logs for sensitive field reveal or profile updates.',
    ],
  },
  audit_trail: {
    affected_area: 'System-wide audit logging for authentication, RBAC, payroll, HR, attendance, and support actions.',
    probable_cause: 'Audit table unavailable, high failed/blocked activity, or missing audit columns from migration drift.',
    admin_action: 'Investigate spikes in failed, denied, blocked, locked, or tamper-related events before clearing alerts.',
    runbook_steps: [
      'Open Audit Trail and filter Security or Authentication.',
      'Check the actor, target, IP address, and timestamp.',
      'Create or update a support ticket if repeated suspicious events appear.',
    ],
  },
  blockchain: {
    affected_area: 'Finalized payroll integrity anchoring, Fabric configuration, and blockchain audit verification.',
    probable_cause: 'Fabric environment incomplete, pending payroll anchors, failed blockchain status, or critical verification records.',
    admin_action: 'Verify only finalized payroll hashes are anchored and never store employee PII on-chain.',
    runbook_steps: [
      'Open Blockchain Support.',
      'Review pending anchors and failed blockchain records.',
      'Confirm Fabric environment variables and chaincode connectivity.',
    ],
  },
  support_center: {
    affected_area: 'Admin support tickets, troubleshooting history, assignment records, and support action audit.',
    probable_cause: 'Support ticket table missing, unresolved tickets, or support action audit not reachable.',
    admin_action: 'Document troubleshooting actions without putting passwords, AWS keys, tokens, or payroll secrets in ticket notes.',
    runbook_steps: [
      'Open Support Center and filter open tickets.',
      'Review ticket priority, assignment, and latest update.',
      'Escalate security or payroll-impacting tickets with audit references.',
    ],
  },
  backup_restore: {
    affected_area: 'Backup request records, verification hashes, storage target references, and restore readiness.',
    probable_cause: 'No recent backup, latest backup failed, missing manifest hash, or storage target not recorded.',
    admin_action: 'Request or verify a backup before any risky maintenance, migration, or restore operation.',
    runbook_steps: [
      'Open Backup and Restore.',
      'Check latest backup status and verification hash.',
      'Record backup location securely; do not expose secrets in notes.',
    ],
  },
  aws_readiness: {
    affected_area: 'AWS EC2 runtime, Amazon RDS MySQL connectivity, S3 backup configuration, HTTPS, cookies, and secrets management.',
    probable_cause: 'Missing production environment variables, local database fallback, disabled RDS TLS, missing encryption key, or incomplete S3 backup settings.',
    admin_action: 'Fix deployment environment settings before production cutover; never paste AWS keys or database passwords into tickets or screenshots.',
    runbook_steps: [
      'Confirm NODE_ENV=production, PORT, DB_HOST, DB_USER, DB_PASSWORD, and DB_NAME are configured from environment variables.',
      'Enable DB_SSL=true for Amazon RDS MySQL and provide certificate env paths when required.',
      'Configure JWT and AES encryption secrets through environment variables or AWS secret management.',
      'Set HTTPS public URL, secure cookies, trust proxy, AWS region, S3 backup bucket, and secure upload root before deployment.',
    ],
  },
  database: {
    affected_area: 'MySQL or Amazon RDS MySQL connectivity, query latency, and schema availability.',
    probable_cause: 'RDS latency, exhausted connection pool, missing migration, DB restart, or network/security group issue.',
    admin_action: 'Check RDS connectivity and migration status before changing application code.',
    runbook_steps: [
      'Confirm database credentials and network access.',
      'Run pending migrations if schema is missing.',
      'Check slow queries and connection pool usage if latency is high.',
    ],
  },
};

function normalizeHealthStatus(value) {
  const status = String(value || '').toUpperCase();
  return SYSTEM_HEALTH_STATUSES.has(status) ? status : 'WARNING';
}

function parseDependencyStatus(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    return {};
  }
}

function safeHealthError() {
  return 'Read-only diagnostic failed. Review server logs.';
}

function boundedIntegerEnv(name, defaultValue, minValue, maxValue) {
  const parsed = Number.parseInt(String(process.env[name] || ''), 10);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(parsed, minValue), maxValue);
}

function systemHealthModuleTimeoutMs() {
  return boundedIntegerEnv('SYSTEM_HEALTH_MODULE_TIMEOUT_MS', 5000, 1000, 60000);
}

function systemHealthSlowWarningMs() {
  return boundedIntegerEnv('SYSTEM_HEALTH_SLOW_WARNING_MS', 3000, 500, 60000);
}

function systemHealthCheckConcurrency(totalModules = SYSTEM_HEALTH_MODULES.length) {
  const configured = boundedIntegerEnv('SYSTEM_HEALTH_CHECK_CONCURRENCY', 4, 1, 12);
  return Math.min(configured, Math.max(Number(totalModules) || 1, 1));
}

class SystemHealthTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`System Health module check timed out after ${timeoutMs} ms.`);
    this.name = 'SystemHealthTimeoutError';
    this.code = 'SYSTEM_HEALTH_TIMEOUT';
    this.timeoutMs = timeoutMs;
  }
}

function withSystemHealthTimeout(work, timeoutMs) {
  let timeoutId = null;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new SystemHealthTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([
    Promise.resolve().then(work),
    timeout,
  ]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function isSystemHealthTimeout(error) {
  return error?.code === 'SYSTEM_HEALTH_TIMEOUT';
}

async function runWithConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(Number(concurrency) || 1, 1), Math.max(list.length, 1));
  async function runWorker() {
    while (nextIndex < list.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(list[currentIndex], currentIndex);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

function healthModuleResponse(definition, rowOrResult = {}) {
  const status = normalizeHealthStatus(rowOrResult.status);
  const remediation = SYSTEM_HEALTH_REMEDIATION[definition.key] || {};
  return {
    module_key: definition.key,
    module_name: definition.name,
    status,
    remarks: rowOrResult.remarks || 'No health check has been run yet.',
    response_time_ms: rowOrResult.response_time_ms ?? null,
    endpoint_checked: rowOrResult.endpoint_checked || definition.endpoint,
    dependency_status: parseDependencyStatus(rowOrResult.dependency_status || rowOrResult.dependencies),
    dependencies: definition.dependencies,
    error_message: rowOrResult.error_message || null,
    last_checked_at: rowOrResult.last_checked_at || rowOrResult.checked_at || null,
    last_success_at: rowOrResult.last_success_at || null,
    last_failure_at: rowOrResult.last_failure_at || null,
    recommended_action: definition.recommended_action,
    affected_area: remediation.affected_area || null,
    probable_cause: remediation.probable_cause || null,
    admin_action: remediation.admin_action || null,
    runbook_steps: remediation.runbook_steps || [],
    recent_logs: Array.isArray(rowOrResult.recent_logs) ? rowOrResult.recent_logs : [],
  };
}

async function runSystemHealthModule(definition, { timeoutMs = systemHealthModuleTimeoutMs() } = {}) {
  const started = Date.now();
  const timestamp = checkedTimestamp();
  try {
    const check = await withSystemHealthTimeout(() => definition.check(), timeoutMs);
    const responseTimeMs = Date.now() - started;
    const slowWarningMs = systemHealthSlowWarningMs();
    const baseStatus = normalizeHealthStatus(check.status);
    const slowDiagnostic = baseStatus === 'ONLINE' && responseTimeMs > slowWarningMs;
    const status = slowDiagnostic ? 'WARNING' : baseStatus;
    const dependencies = { ...(check.dependencies || {}) };
    if (slowDiagnostic) {
      dependencies.diagnostic_performance = dependencySetting(
        'Health check response time',
        false,
        `Slow response: ${responseTimeMs} ms`,
        { slow_warning_ms: slowWarningMs }
      );
    }
    return healthModuleResponse(definition, {
      status,
      remarks: slowDiagnostic
        ? `Slow diagnostic response (${responseTimeMs} ms). ${check.remarks}`
        : check.remarks,
      response_time_ms: responseTimeMs,
      endpoint_checked: definition.endpoint,
      dependencies,
      error_message: check.error_message || null,
      checked_at: timestamp,
      last_success_at: status === 'OFFLINE' ? null : timestamp,
      last_failure_at: status === 'OFFLINE' ? timestamp : null,
    });
  } catch (error) {
    const timedOut = isSystemHealthTimeout(error);
    const safeMessage = timedOut
      ? `Health check timed out after ${timeoutMs} ms.`
      : safeHealthError();
    console.error(`[RBAC] system health ${definition.key} check failed:`, error.message);
    return healthModuleResponse(definition, {
      status: timedOut ? 'WARNING' : 'OFFLINE',
      remarks: timedOut
        ? `This module did not respond within the configured ${timeoutMs} ms diagnostic timeout.`
        : safeHealthError(),
      response_time_ms: Date.now() - started,
      endpoint_checked: definition.endpoint,
      dependencies: timedOut ? {
        diagnostic_timeout: dependencySetting('Health check timeout', false, `Exceeded ${timeoutMs} ms`, { timeout_ms: timeoutMs }),
      } : {},
      error_message: safeMessage,
      checked_at: timestamp,
      last_success_at: null,
      last_failure_at: timestamp,
    });
  }
}

async function persistSystemHealthModule(moduleResult, checkedByUserId = null) {
  if (!(await hasTable('system_health_checks'))) return;
  const status = normalizeHealthStatus(moduleResult.status);
  const checkedAt = moduleResult.last_checked_at || checkedTimestamp();
  const successAt = Object.prototype.hasOwnProperty.call(moduleResult, 'last_success_at')
    ? moduleResult.last_success_at
    : status === 'OFFLINE' ? null : checkedAt;
  const failureAt = Object.prototype.hasOwnProperty.call(moduleResult, 'last_failure_at')
    ? moduleResult.last_failure_at
    : status === 'OFFLINE' ? checkedAt : null;
  await pool.execute(
    `INSERT INTO system_health_checks
       (module_key, module_name, status, remarks, response_time_ms, endpoint_checked,
        dependency_status, error_message, last_checked_at, last_success_at, last_failure_at, checked_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       module_name = VALUES(module_name),
       status = VALUES(status),
       remarks = VALUES(remarks),
       response_time_ms = VALUES(response_time_ms),
       endpoint_checked = VALUES(endpoint_checked),
       dependency_status = VALUES(dependency_status),
       error_message = VALUES(error_message),
       last_checked_at = VALUES(last_checked_at),
       last_success_at = COALESCE(VALUES(last_success_at), last_success_at),
       last_failure_at = COALESCE(VALUES(last_failure_at), last_failure_at),
       checked_by = VALUES(checked_by),
       updated_at = CURRENT_TIMESTAMP`,
    [
      moduleResult.module_key,
      moduleResult.module_name,
      status,
      cleanText(moduleResult.remarks, 500),
      moduleResult.response_time_ms,
      moduleResult.endpoint_checked,
      JSON.stringify(moduleResult.dependency_status || {}),
      moduleResult.error_message ? cleanText(moduleResult.error_message, 500) : null,
      checkedAt,
      successAt,
      failureAt,
      checkedByUserId || null,
    ]
  );
}

function systemHealthHistoryRows(moduleResults, {
  runId,
  triggerType = 'MANUAL',
  checkedByUserId = null,
} = {}) {
  const safeTrigger = String(triggerType || '').toUpperCase() === 'SCHEDULED' ? 'SCHEDULED' : 'MANUAL';
  return (Array.isArray(moduleResults) ? moduleResults : [moduleResults]).filter(Boolean).map(moduleResult => ({
    history_id: null,
    run_id: runId || makeSystemHealthRunId(),
    module_key: moduleResult.module_key,
    module_name: moduleResult.module_name,
    status: normalizeHealthStatus(moduleResult.status),
    remarks: cleanText(moduleResult.remarks, 500),
    response_time_ms: moduleResult.response_time_ms,
    endpoint_checked: moduleResult.endpoint_checked,
    error_message: moduleResult.error_message ? cleanText(moduleResult.error_message, 500) : null,
    trigger_type: safeTrigger,
    checked_by: checkedByUserId || null,
    checked_at: moduleResult.last_checked_at || checkedTimestamp(),
  }));
}

function mergeSystemHealthHistoryRows(currentRows = [], storedRows = [], limit = 30) {
  const seen = new Set();
  const rows = [...currentRows, ...storedRows].filter(row => {
    if (!row) return false;
    // A run persists exactly one row per module. Keying on checked_at caused
    // the in-memory Date and the MySQL-returned ISO value for the same row to
    // be treated as separate records, consuming the recent-history limit.
    const key = row.run_id && row.module_key
      ? `run:${row.run_id}|module:${row.module_key}`
      : row.history_id
        ? `history:${row.history_id}`
        : `fallback:${row.module_key || ''}|${row.checked_at || ''}|${row.status || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  rows.sort((a, b) => {
    const bTime = new Date(b.checked_at || 0).getTime() || 0;
    const aTime = new Date(a.checked_at || 0).getTime() || 0;
    if (bTime !== aTime) return bTime - aTime;
    return Number(b.history_id || 0) - Number(a.history_id || 0);
  });
  return rows.slice(0, limit);
}

async function persistSystemHealthHistory(moduleResult, {
  runId,
  triggerType = 'MANUAL',
  checkedByUserId = null,
} = {}) {
  if (!(await hasTable('system_health_check_history'))) return;
  const status = normalizeHealthStatus(moduleResult.status);
  const checkedAt = moduleResult.last_checked_at || checkedTimestamp();
  const safeTrigger = String(triggerType || '').toUpperCase() === 'SCHEDULED' ? 'SCHEDULED' : 'MANUAL';
  await pool.execute(
    `INSERT INTO system_health_check_history
       (run_id, module_key, module_name, status, remarks, response_time_ms,
        endpoint_checked, dependency_status, error_message, trigger_type, checked_by, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId || makeSystemHealthRunId(),
      moduleResult.module_key,
      moduleResult.module_name,
      status,
      cleanText(moduleResult.remarks, 500),
      moduleResult.response_time_ms,
      moduleResult.endpoint_checked,
      JSON.stringify(moduleResult.dependency_status || {}),
      moduleResult.error_message ? cleanText(moduleResult.error_message, 500) : null,
      safeTrigger,
      checkedByUserId || null,
      checkedAt,
    ]
  );
}

async function loadStoredSystemHealthModules() {
  if (!(await hasTable('system_health_checks'))) return new Map();
  const [rows] = await pool.execute(
    `SELECT module_key, module_name, status, remarks, response_time_ms, endpoint_checked,
            dependency_status, error_message, last_checked_at, last_success_at, last_failure_at
       FROM system_health_checks`
  );
  return new Map(rows.map(row => [row.module_key, row]));
}

async function recentSystemHealthLogs(moduleKey) {
  if (!(await hasTable('system_audit_log'))) return [];
  const timestampColumn = await hasColumn('system_audit_log', 'timestamp')
    ? 'timestamp'
    : (await hasColumn('system_audit_log', 'Created_At'))
      ? 'Created_At'
      : null;
  if (!timestampColumn) return [];
  const actionColumn = await hasColumn('system_audit_log', 'action_performed')
    ? 'action_performed'
    : (await hasColumn('system_audit_log', 'Action_Type'))
      ? 'Action_Type'
      : null;
  const moduleColumn = await hasColumn('system_audit_log', 'module') ? 'module' : null;
  const newValueColumn = await hasColumn('system_audit_log', 'new_value') ? 'new_value' : null;
  const actionExpr = actionColumn || sqlLiteral('SYSTEM_HEALTH_CHECK');
  const moduleExpr = moduleColumn || sqlLiteral('SYSTEM_HEALTH');
  const newValueExpr = newValueColumn || 'NULL';
  const idColumn = await hasColumn('system_audit_log', 'id')
    ? 'id'
    : (await hasColumn('system_audit_log', 'log_id'))
      ? 'log_id'
      : (await hasColumn('system_audit_log', 'Log_ID'))
        ? 'Log_ID'
        : null;
  const params = [];
  const conditions = [];
  const moduleMatches = [];
  if (moduleColumn) {
    conditions.push(`${moduleColumn} = ?`);
    params.push('SYSTEM_HEALTH');
  }
  if (actionColumn) {
    moduleMatches.push(`${actionColumn} LIKE ?`);
    params.push(`%${moduleKey}%`);
  }
  if (newValueColumn) {
    moduleMatches.push(`${newValueColumn} LIKE ?`);
    params.push(`%${moduleKey}%`);
  }
  if (moduleMatches.length) conditions.push(`(${moduleMatches.join(' OR ')})`);
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const secondaryOrder = idColumn ? `, ${idColumn} DESC` : '';
  const [rows] = await pool.execute(
    `SELECT ${actionExpr} AS action_performed,
            ${moduleExpr} AS module,
            ${newValueExpr} AS details,
            ${timestampColumn} AS timestamp
       FROM system_audit_log
      ${whereClause}
      ORDER BY ${timestampColumn} DESC${secondaryOrder}
      LIMIT 5`,
    params
  );
  return rows.map(row => ({
    action: row.action_performed || 'SYSTEM_HEALTH_CHECK',
    module: row.module || 'SYSTEM_HEALTH',
    details: cleanText(row.details || '', 500),
    timestamp: row.timestamp,
  }));
}

function summarizeSystemHealth(modules) {
  const summary = { total: modules.length, online: 0, warning: 0, offline: 0, maintenance: 0 };
  modules.forEach(module => {
    const key = String(module.status || 'WARNING').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(summary, key)) summary[key] += 1;
  });
  return summary;
}

async function buildSystemHealthModules({
  persist = false,
  checkedByUserId = null,
  moduleKey = null,
  historyRunId = null,
  triggerType = 'MANUAL',
} = {}) {
  const stored = await loadStoredSystemHealthModules();
  const definitions = moduleKey ? [SYSTEM_HEALTH_MODULE_MAP.get(moduleKey)].filter(Boolean) : SYSTEM_HEALTH_MODULES;
  const runId = historyRunId || makeSystemHealthRunId();
  const timeoutMs = systemHealthModuleTimeoutMs();
  const concurrency = moduleKey ? 1 : systemHealthCheckConcurrency(definitions.length);

  return runWithConcurrency(definitions, concurrency, async definition => {
    const result = await runSystemHealthModule(definition, { timeoutMs });
    const storedRow = stored.get(definition.key);
    if (storedRow) {
      result.last_success_at = result.last_success_at || storedRow.last_success_at || null;
      result.last_failure_at = result.last_failure_at || storedRow.last_failure_at || null;
      if (normalizeHealthStatus(storedRow.status) === 'MAINTENANCE') {
        result.status = 'MAINTENANCE';
        result.remarks = storedRow.remarks || 'Module is under controlled maintenance.';
        result.error_message = storedRow.error_message || null;
        result.recommended_action = 'Complete the controlled recovery workflow before returning this module to normal operation. This does not bypass HR or Payroll approval workflows.';
      }
    }
    if (persist) {
      await persistSystemHealthModule(result, checkedByUserId);
      await persistSystemHealthHistory(result, { runId, triggerType, checkedByUserId });
    }
    result.recent_logs = await recentSystemHealthLogs(definition.key);
    return result;
  });
}

async function getSystemHealthSnapshot(options = {}) {
  const legacy = await getLegacySystemHealthSnapshot();
  const modules = await buildSystemHealthModules(options);
  const summary = summarizeSystemHealth(modules);
  const issueCount = summary.offline + summary.warning + summary.maintenance;
  return {
    ...legacy,
    generated_at: new Date().toISOString(),
    status: summary.offline > 0 ? 'offline' : issueCount > 0 ? 'warning' : 'healthy',
    summary,
    modules,
  };
}

async function getSystemHealthHistory({ limit = 40, moduleKey = '' } = {}) {
  if (!(await hasTable('system_health_check_history'))) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 40, 1), 200);
  const params = [];
  let whereClause = '';
  if (moduleKey) {
    whereClause = 'WHERE module_key = ?';
    params.push(moduleKey);
  }
  const [rows] = await pool.execute(
    `SELECT history_id, run_id, module_key, module_name, status, remarks,
            response_time_ms, endpoint_checked, error_message, trigger_type,
            checked_by, checked_at
       FROM system_health_check_history
      ${whereClause}
      ORDER BY checked_at DESC, history_id DESC
      LIMIT ${safeLimit}`,
    params
  );
  return rows;
}

async function logSystemHealthCheck(req, moduleResults, requestedModule = 'all') {
  const results = Array.isArray(moduleResults) ? moduleResults : [moduleResults];
  const summary = summarizeSystemHealth(results);
  const action = requestedModule === 'all'
    ? `RUN_SYSTEM_HEALTH_CHECK: all modules, ${summary.online} online, ${summary.warning} warning, ${summary.offline} offline`
    : `RUN_SYSTEM_HEALTH_CHECK: ${requestedModule} => ${results[0]?.status || 'UNKNOWN'}`;
  const details = JSON.stringify({
    module: requestedModule,
    summary,
    results: results.map(result => ({
      module_key: result.module_key,
      status: result.status,
      response_time_ms: result.response_time_ms,
    })),
  });
  await logAuditEntry(req, {
    action,
    module: 'SYSTEM_HEALTH',
    newValue: details,
  });
  return {
    action,
    module: 'SYSTEM_HEALTH',
    details,
    timestamp: new Date(),
  };
}

function attachSystemHealthAuditLog(moduleResults, auditLog) {
  if (!auditLog) return;
  const results = Array.isArray(moduleResults) ? moduleResults : [moduleResults];
  results.filter(Boolean).forEach(result => {
    const existingLogs = Array.isArray(result.recent_logs) ? result.recent_logs : [];
    result.recent_logs = [auditLog, ...existingLogs].slice(0, 5);
  });
}

/* ================================================================
   HELPER: sanitizeInput — Basic input sanitation
   ================================================================ */
function sanitizeInput(str) {
  if (typeof str !== 'string') return str;
  return str.trim().replace(/[<>]/g, '');
}

function passwordPolicyErrors(password) {
  const result = validateTemporaryPassword(password);
  return result.valid ? [] : result.errors;
}

async function revokeEmployeeSessions(conn, employeeId, reason) {
  await conn.execute(
    `UPDATE USER_SESSION
        SET Revoked_At = NOW(),
            Revocation_Reason = ?
      WHERE Employee_ID = (SELECT Employee_ID FROM employees WHERE id = ? LIMIT 1)
        AND Revoked_At IS NULL`,
    [reason, employeeId]
  );
}

// ── Apply auth + Level 4 guard to ALL routes in this router ──
router.use(requireAuth);
router.use(requireLevel4);
router.use(requirePermission('admin_panel:access'));

router.put('/users/:userId/reset-password', accountController.resetUserPassword);

router.get('/system-health', async (req, res) => {
  try {
    const snapshot = await getSystemHealthSnapshot();
    snapshot.history = await getSystemHealthHistory({ limit: 30 });
    return res.json(snapshot);
  } catch (err) {
    console.error('[RBAC] system-health error:', err.message);
    return res.status(500).json({ error: 'Failed to load system health.' });
  }
});

router.get('/system-health/history', async (req, res) => {
  try {
    const moduleKey = cleanText(req.query.module_key || '', 80).toLowerCase();
    if (moduleKey && !SYSTEM_HEALTH_MODULE_MAP.has(moduleKey)) {
      return res.status(400).json({ error: 'Unknown system health module.' });
    }
    const history = await getSystemHealthHistory({
      limit: req.query.limit,
      moduleKey,
    });
    return res.json({ history });
  } catch (err) {
    console.error('[RBAC] system-health history error:', err.message);
    return res.status(500).json({ error: 'Failed to load system health history.' });
  }
});

router.post('/system-health/check', async (req, res) => {
  try {
    const historyRunId = makeSystemHealthRunId();
    const checkedByUserId = req.user?.id || null;
    const snapshot = await getSystemHealthSnapshot({
      persist: true,
      checkedByUserId,
      historyRunId,
      triggerType: 'MANUAL',
    });
    const currentRunHistory = systemHealthHistoryRows(snapshot.modules, {
      runId: historyRunId,
      triggerType: 'MANUAL',
      checkedByUserId,
    });
    const storedHistory = await getSystemHealthHistory({ limit: 30 });
    const auditLog = await logSystemHealthCheck(req, snapshot.modules, 'all').catch(error => {
      console.error('[RBAC] system-health audit log error:', error.message);
      return null;
    });
    attachSystemHealthAuditLog(snapshot.modules, auditLog);
    return res.json({
      message: 'System health check completed.',
      checked_at: snapshot.generated_at,
      summary: snapshot.summary,
      modules: snapshot.modules,
      history: mergeSystemHealthHistoryRows(currentRunHistory, storedHistory, 30),
    });
  } catch (err) {
    console.error('[RBAC] system-health check error:', err.message);
    return res.status(500).json({ error: 'Failed to run system health check.' });
  }
});

router.post('/system-health/check/:moduleKey', async (req, res) => {
  try {
    const moduleKey = cleanText(req.params.moduleKey, 80).toLowerCase();
    if (!SYSTEM_HEALTH_MODULE_MAP.has(moduleKey)) {
      return res.status(404).json({ error: 'Unknown system health module.' });
    }
    const historyRunId = makeSystemHealthRunId();
    const checkedByUserId = req.user?.id || null;
    const snapshot = await getSystemHealthSnapshot({
      persist: true,
      checkedByUserId,
      moduleKey,
      historyRunId,
      triggerType: 'MANUAL',
    });
    const moduleResult = snapshot.modules[0];
    const currentRunHistory = systemHealthHistoryRows(moduleResult, {
      runId: historyRunId,
      triggerType: 'MANUAL',
      checkedByUserId,
    });
    const storedHistory = await getSystemHealthHistory({ limit: 30 });
    const auditLog = await logSystemHealthCheck(req, moduleResult, moduleKey).catch(error => {
      console.error('[RBAC] system-health module audit log error:', error.message);
      return null;
    });
    attachSystemHealthAuditLog(moduleResult, auditLog);
    return res.json({
      message: 'Module health check completed.',
      checked_at: snapshot.generated_at,
      module: moduleResult,
      summary: snapshot.summary,
      history: mergeSystemHealthHistoryRows(currentRunHistory, storedHistory, 30),
    });
  } catch (err) {
    console.error('[RBAC] system-health module check error:', err.message);
    return res.status(500).json({ error: 'Failed to run module health check.' });
  }
});

router.get('/blockchain-support/status', async (req, res) => {
  try {
    const snapshot = await getBlockchainSupportSnapshot();
    return res.json(snapshot);
  } catch (err) {
    console.error('[RBAC] blockchain-support status error:', err.message);
    return res.status(500).json({ error: 'Failed to load blockchain support status.' });
  }
});

router.patch('/users/:userId/unlock', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const targetUserId = normalizePositiveInteger(req.params.userId, 'user_id');
    await conn.beginTransaction();
    const targetUser = await getTargetUserForSupport(targetUserId, conn);

    await conn.execute(
      `UPDATE users
          SET failed_login_attempts = 0,
              account_locked_until = NULL
        WHERE id = ?`,
      [targetUserId]
    );

    if (targetUser.employee_id) {
      await conn.execute(
        `UPDATE employees
            SET Failed_Login_Attempts = 0,
                Locked_Until = NULL
          WHERE id = ?`,
        [targetUser.employee_id]
      );
    }

    await logAuditEntryWithExecutor(conn, req, {
      action: `ACCOUNT_UNLOCKED: System Administrator cleared lockout for user ${targetUser.username}`,
      module: 'ACCOUNT_SUPPORT',
      targetEmployeeId: targetUser.employee_id || null,
      newValue: JSON.stringify({ target_user_id: targetUserId, failed_login_attempts: 0, account_locked_until: null }),
    });

    await conn.commit();
    return res.json({ message: 'Account lockout cleared.' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[RBAC] account unlock error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to unlock account.' });
  } finally {
    conn.release();
  }
});

router.post('/users/:userId/revoke-sessions', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const targetUserId = normalizePositiveInteger(req.params.userId, 'user_id');
    if (targetUserId === req.user.id) {
      return res.status(403).json({ error: 'You cannot revoke your own active session from this support action.' });
    }

    const reason = cleanText(req.body?.reason || 'system_admin_support_revocation', 100);
    await conn.beginTransaction();
    const targetUser = await getTargetUserForSupport(targetUserId, conn);
    const revokedSessions = await revokeSessionsByAuthEmployeeId(
      conn,
      targetUser.auth_employee_id || targetUser.employee_id,
      reason || 'system_admin_support_revocation'
    );

    await logAuditEntryWithExecutor(conn, req, {
      action: `SESSIONS_REVOKED: System Administrator revoked active sessions for user ${targetUser.username}`,
      module: 'ACCOUNT_SUPPORT',
      targetEmployeeId: targetUser.employee_id || null,
      newValue: JSON.stringify({ target_user_id: targetUserId, revoked_sessions: revokedSessions, reason }),
    });

    await conn.commit();
    return res.json({ message: 'Active sessions revoked.', revoked_sessions: revokedSessions });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[RBAC] revoke sessions error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to revoke sessions.' });
  } finally {
    conn.release();
  }
});

router.patch('/users/:userId/reset-mfa', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const targetUserId = normalizePositiveInteger(req.params.userId, 'user_id');
    if (targetUserId === req.user.id) {
      return res.status(403).json({ error: 'You cannot reset your own MFA enrollment from this support action.' });
    }

    const identityVerified = req.body?.identity_verified === true || req.body?.identityVerified === true;
    const reason = cleanText(req.body?.reason || '', 500);
    if (!identityVerified || reason.length < 8) {
      return res.status(400).json({ error: 'Identity verification confirmation and reason are required before MFA reset.' });
    }

    const hasTotpSecret = await hasColumn('employees', 'MFA_TOTP_Secret_Encrypted');
    const hasTotpHash = await hasColumn('employees', 'MFA_TOTP_Secret_Hash');
    const hasTotpEnrolled = await hasColumn('employees', 'MFA_TOTP_Enrolled_At');
    if (!hasTotpSecret || !hasTotpHash || !hasTotpEnrolled) {
      return res.status(409).json({ error: 'MFA enrollment schema is not ready. Run the MFA migration first.' });
    }

    await conn.beginTransaction();
    const targetUser = await getTargetUserForSupport(targetUserId, conn);
    if (!targetUser.employee_id) {
      await conn.rollback();
      return res.status(400).json({ error: 'MFA reset requires a linked employee record.' });
    }

    await conn.execute(
      `UPDATE employees
          SET MFA_TOTP_Secret_Encrypted = NULL,
              MFA_TOTP_Secret_Hash = NULL,
              MFA_TOTP_Enrolled_At = NULL
        WHERE id = ?`,
      [targetUser.employee_id]
    );

    let supersededChallenges = 0;
    if (await hasTable('MFA_CHALLENGE')) {
      const [challengeResult] = await conn.execute(
        `UPDATE MFA_CHALLENGE
            SET Status = 'SUPERSEDED'
          WHERE Employee_ID = ?
            AND Status = 'PENDING'`,
        [targetUser.auth_employee_id || targetUser.employee_id]
      );
      supersededChallenges = challengeResult.affectedRows || 0;
    }

    const revokedSessions = await revokeSessionsByAuthEmployeeId(
      conn,
      targetUser.auth_employee_id || targetUser.employee_id,
      'admin_mfa_reset'
    );

    await logAuditEntryWithExecutor(conn, req, {
      action: `MFA_RESET: System Administrator reset TOTP enrollment for user ${targetUser.username}`,
      module: 'AUTH_SECURITY',
      targetEmployeeId: targetUser.employee_id,
      newValue: JSON.stringify({
        target_user_id: targetUserId,
        reason,
        identity_verified: true,
        superseded_challenges: supersededChallenges,
        revoked_sessions: revokedSessions,
      }),
    });

    await conn.commit();
    return res.json({
      message: 'MFA enrollment reset. The user must enroll again on next privileged login.',
      superseded_challenges: supersededChallenges,
      revoked_sessions: revokedSessions,
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[RBAC] reset MFA error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to reset MFA.' });
  } finally {
    conn.release();
  }
});

router.get('/support-tickets', async (req, res) => {
  try {
    if (!(await hasTable('system_support_ticket'))) return res.json([]);

    const params = [];
    let where = 'WHERE 1 = 1';
    const status = normalizeEnum(req.query.status, SUPPORT_STATUSES, '');
    const category = normalizeEnum(req.query.category, SUPPORT_CATEGORIES, '');
    if (status) {
      where += ' AND st.status = ?';
      params.push(status);
    }
    if (category) {
      where += ' AND st.category = ?';
      params.push(category);
    }

    const [rows] = await pool.execute(
      `SELECT st.*, creator.username AS created_by_username
         FROM system_support_ticket st
         LEFT JOIN users creator ON creator.id = st.created_by
        ${where}
        ORDER BY
          FIELD(st.priority, 'CRITICAL','HIGH','MEDIUM','LOW'),
          FIELD(st.status, 'OPEN','IN_PROGRESS','WAITING_FOR_OWNER','RESOLVED','CLOSED'),
          st.created_at DESC
        LIMIT 200`,
      params
    );

    return res.json(rows.map(ticketResponse));
  } catch (err) {
    console.error('[RBAC] support tickets list error:', err.message);
    return res.status(500).json({ error: 'Failed to load support tickets.' });
  }
});

router.post('/support-tickets', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (!(await hasTable('system_support_ticket'))) {
      return res.status(409).json({ error: 'Support ticket schema is not ready. Run migrations first.' });
    }

    const title = cleanText(req.body?.title, 160);
    const description = cleanText(req.body?.description, 2000);
    if (title.length < 3 || description.length < 5) {
      return res.status(400).json({ error: 'Ticket title and description are required.' });
    }

    const category = normalizeEnum(req.body?.category, SUPPORT_CATEGORIES, 'SYSTEM');
    const priority = normalizeEnum(req.body?.priority, SUPPORT_PRIORITIES, 'MEDIUM');
    const relatedUserId = req.body?.related_user_id ? normalizePositiveInteger(req.body.related_user_id, 'related_user_id') : null;
    let relatedEmployeeId = null;
    if (relatedUserId) {
      const relatedUser = await getTargetUserForSupport(relatedUserId);
      relatedEmployeeId = relatedUser.employee_id || null;
    }

    await conn.beginTransaction();
    const ticketNumber = makeReference('SYS');
    const [result] = await conn.execute(
      `INSERT INTO system_support_ticket
         (ticket_number, title, category, priority, status, related_user_id,
          related_employee_id, description_encrypted, created_by, assigned_to)
       VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?)`,
      [
        ticketNumber,
        title,
        category,
        priority,
        relatedUserId,
        relatedEmployeeId,
        protectedText(description),
        req.user.id,
        req.user.id,
      ]
    );

    await logAuditEntryWithExecutor(conn, req, {
      action: `SUPPORT_TICKET_CREATED: ${ticketNumber}`,
      module: 'SYSTEM_SUPPORT',
      targetEmployeeId: relatedEmployeeId,
      newValue: JSON.stringify({ ticket_id: result.insertId, ticket_number: ticketNumber, category, priority, related_user_id: relatedUserId }),
    });

    await conn.commit();
    return res.status(201).json({
      message: 'Support ticket created.',
      ticket_id: result.insertId,
      ticket_number: ticketNumber,
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[RBAC] support ticket create error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to create support ticket.' });
  } finally {
    conn.release();
  }
});

router.patch('/support-tickets/:ticketId', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (!(await hasTable('system_support_ticket'))) {
      return res.status(409).json({ error: 'Support ticket schema is not ready. Run migrations first.' });
    }

    const ticketId = normalizePositiveInteger(req.params.ticketId, 'ticket_id');
    const status = req.body?.status ? normalizeEnum(req.body.status, SUPPORT_STATUSES, null) : null;
    const priority = req.body?.priority ? normalizeEnum(req.body.priority, SUPPORT_PRIORITIES, null) : null;
    const resolution = req.body?.resolution_notes !== undefined
      ? cleanText(req.body.resolution_notes, 2000)
      : null;
    if (req.body?.status && !status) return res.status(400).json({ error: 'Invalid ticket status.' });
    if (req.body?.priority && !priority) return res.status(400).json({ error: 'Invalid ticket priority.' });

    const fields = [];
    const values = [];
    if (status) {
      fields.push('status = ?');
      values.push(status);
      if (['RESOLVED', 'CLOSED'].includes(status)) {
        fields.push('resolved_by = ?', 'resolved_at = COALESCE(resolved_at, NOW())');
        values.push(req.user.id);
      }
    }
    if (priority) {
      fields.push('priority = ?');
      values.push(priority);
    }
    if (resolution !== null) {
      fields.push('resolution_encrypted = ?');
      values.push(protectedText(resolution));
    }
    if (!fields.length) return res.status(400).json({ error: 'No ticket updates provided.' });

    await conn.beginTransaction();
    const [existingRows] = await conn.execute(
      'SELECT ticket_id, ticket_number, related_employee_id FROM system_support_ticket WHERE ticket_id = ? FOR UPDATE',
      [ticketId]
    );
    if (!existingRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Support ticket not found.' });
    }

    values.push(ticketId);
    await conn.execute(
      `UPDATE system_support_ticket
          SET ${fields.join(', ')}
        WHERE ticket_id = ?`,
      values
    );

    await logAuditEntryWithExecutor(conn, req, {
      action: `SUPPORT_TICKET_UPDATED: ${existingRows[0].ticket_number}`,
      module: 'SYSTEM_SUPPORT',
      targetEmployeeId: existingRows[0].related_employee_id || null,
      newValue: JSON.stringify({ ticket_id: ticketId, status, priority, resolution_updated: resolution !== null }),
    });

    await conn.commit();
    return res.json({ message: 'Support ticket updated.' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[RBAC] support ticket update error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to update support ticket.' });
  } finally {
    conn.release();
  }
});

router.get('/backups', async (req, res) => {
  try {
    return res.json(await listBackupSets(100));
  } catch (err) {
    console.error('[RBAC] backup list error:', err.message);
    return res.status(500).json({ error: 'Failed to load backup history.' });
  }
});

router.get('/backups/overview', async (req, res) => {
  try {
    return res.json(await buildBackupOverview());
  } catch (err) {
    console.error('[RBAC] backup overview error:', err.message);
    return res.status(500).json({ error: 'Failed to load backup dashboard.' });
  }
});

router.get('/backups/recovery-points', async (req, res) => {
  try {
    return res.json(await listModuleRecoveryPoints(100));
  } catch (err) {
    console.error('[RBAC] recovery point list error:', err.message);
    return res.status(500).json({ error: 'Failed to load module recovery points.' });
  }
});

router.get('/backups/restore-jobs', async (req, res) => {
  try {
    return res.json(await listRestoreJobs(100));
  } catch (err) {
    console.error('[RBAC] restore job list error:', err.message);
    return res.status(500).json({ error: 'Failed to load restore jobs.' });
  }
});

router.get('/backups/rollback-requests', async (req, res) => {
  try {
    return res.json(await listRollbackRequests(100));
  } catch (err) {
    console.error('[RBAC] rollback request list error:', err.message);
    return res.status(500).json({ error: 'Failed to load rollback requests.' });
  }
});

router.post('/backups/request', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const backupSetsAvailable = await hasTable('backup_sets');
    const legacyBackupAvailable = await hasTable('system_backup_log');
    if (!backupSetsAvailable && !legacyBackupAvailable) {
      return res.status(409).json({ error: 'Backup schema is not ready. Run migrations first.' });
    }

    const backupType = normalizeBackupSetType(req.body?.backup_type, 'DATABASE');
    const storageProvider = normalizeBackupStorageProvider(req.body?.storage_provider || req.body?.storage_target, 'MANUAL');
    const includedModules = cleanModuleSelection(req.body?.included_modules);
    const notes = cleanText(req.body?.notes, 2000);
    const reference = makeReference('BKP');
    const backupName = cleanText(req.body?.backup_name, 160) || `${backupType.replace(/_/g, ' ')} ${reference}`;
    const checksum = cleanText(req.body?.checksum || req.body?.manifest_hash, 64).toLowerCase();
    const fileSize = Number.parseInt(req.body?.file_size, 10);
    if (checksum && !/^[a-f0-9]{64}$/.test(checksum)) {
      return res.status(400).json({ error: 'checksum must be a SHA-256 hex digest.' });
    }
    const healthMap = await backupHealthStatusMap();

    await conn.beginTransaction();
    let backupSetId = null;
    if (backupSetsAvailable) {
      const [result] = await conn.execute(
        `INSERT INTO backup_sets
           (backup_reference, backup_name, backup_type, storage_provider, status, included_modules,
            checksum, file_size, created_by, remarks_encrypted)
         VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?)`,
        [
          reference,
          backupName,
          backupType,
          storageProvider,
          JSON.stringify(includedModules),
          checksum || null,
          Number.isSafeInteger(fileSize) && fileSize >= 0 ? fileSize : null,
          req.user.id,
          protectedText(notes),
        ]
      );
      backupSetId = result.insertId;
    }

    if (legacyBackupAvailable) {
      await conn.execute(
        `INSERT INTO system_backup_log
           (backup_reference, backup_type, storage_target, status, requested_by, manifest_hash, notes_encrypted)
         VALUES (?, ?, ?, 'REQUESTED', ?, ?, ?)`,
        [
          reference,
          backupSetTypeToLegacy(backupType),
          backupProviderToLegacy(storageProvider),
          req.user.id,
          checksum || null,
          protectedText(notes),
        ]
      );
    }

    if (
      backupSetId &&
      (await hasTable('module_recovery_points')) &&
      ['MODULE_STATE', 'DEPLOYMENT_VERSION', 'FULL_BACKUP'].includes(backupType)
    ) {
      const selected = new Set(includedModules);
      for (const module of BACKUP_RECOVERY_MODULES.filter(item => selected.has(item.key))) {
        const health = healthMap.get(module.healthKey || module.key);
        await conn.execute(
          `INSERT INTO module_recovery_points
             (module_key, module_name, current_version, stable_version, deployment_commit,
              artifact_location_encrypted, storage_provider, health_status_at_backup,
              backup_set_id, rollback_available, created_by, remarks_encrypted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            module.key,
            module.name,
            moduleCurrentVersion(module.key),
            moduleStableVersion(module.key),
            deploymentCommit(),
            protectedText(deploymentArtifactReference()),
            storageProvider,
            health?.status || 'UNKNOWN',
            backupSetId,
            module.rollback ? 1 : 0,
            req.user.id,
            protectedText(`Recovery point captured from ${reference}. ${notes}`),
          ]
        );
      }
    }

    await logAuditEntryWithExecutor(conn, req, {
      action: `CREATE_BACKUP: ${reference}`,
      module: 'BACKUP_RESTORE',
      newValue: JSON.stringify({
        backup_set_id: backupSetId,
        backup_reference: reference,
        backup_type: backupType,
        storage_provider: storageProvider,
        included_modules: includedModules,
      }),
    });

    await conn.commit();
    return res.status(201).json({
      message: 'Backup request logged for controlled recovery follow-up.',
      backup_set_id: backupSetId,
      backup_id: backupSetId,
      backup_reference: reference,
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[RBAC] backup request error:', err.message);
    return res.status(500).json({ error: 'Failed to log backup request.' });
  } finally {
    conn.release();
  }
});

router.post('/backups/:backupId/restore', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (!(await hasTable('backup_sets')) || !(await hasTable('restore_jobs'))) {
      return res.status(409).json({ error: 'Restore job schema is not ready. Run migrations first.' });
    }
    if (String(req.body?.confirmation_phrase || '').trim() !== 'RESTORE') {
      return res.status(400).json({ error: 'Type RESTORE to confirm this recovery request.' });
    }

    const backupId = normalizePositiveInteger(req.params.backupId, 'backup_set_id');
    const restoreType = normalizeEnum(req.body?.restore_type, RESTORE_TYPES, null);
    if (!restoreType) return res.status(400).json({ error: 'Restore type is invalid for this backup.' });
    const affectedModule = cleanText(req.body?.affected_module, 80) || null;
    const reason = cleanText(req.body?.reason, 2000);
    const placeUnderMaintenance = Boolean(req.body?.place_under_maintenance);

    await conn.beginTransaction();
    const [backupRows] = await conn.execute(
      'SELECT id, backup_reference, backup_type, status FROM backup_sets WHERE id = ? FOR UPDATE',
      [backupId]
    );
    if (!backupRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Backup set not found.' });
    }
    const backup = backupRows[0];
    if (!RESTORABLE_BACKUP_TYPES.has(backup.backup_type)) {
      await conn.rollback();
      return res.status(409).json({ error: 'Deployment version backups use rollback requests, not restore jobs.' });
    }
    if (backup.backup_type !== 'FULL_BACKUP' && restoreType !== backup.backup_type) {
      await conn.rollback();
      return res.status(400).json({ error: 'Restore type must match the selected backup type unless it is a full backup.' });
    }
    if (!['COMPLETED', 'VERIFIED', 'RESTORED'].includes(backup.status)) {
      await conn.rollback();
      return res.status(409).json({ error: 'Only completed or verified backups can be queued for restore.' });
    }

    const [jobResult] = await conn.execute(
      `INSERT INTO restore_jobs
         (backup_set_id, restore_type, affected_module, status, requested_by, reason_encrypted, result_message_encrypted)
       VALUES (?, ?, ?, 'PENDING', ?, ?, ?)`,
      [
        backupId,
        restoreType,
        affectedModule,
        req.user.id,
        protectedText(reason),
        protectedText('Restore request queued. Run dry-run validation before applying recovery. This does not bypass HR or Payroll business approvals.'),
      ]
    );

    if (placeUnderMaintenance && affectedModule && (await hasTable('system_health_checks'))) {
      const module = BACKUP_RECOVERY_MODULES.find(item => item.key === affectedModule);
      const healthKey = module?.healthKey || affectedModule;
      const healthDefinition = SYSTEM_HEALTH_MODULE_MAP.get(healthKey);
      await conn.execute(
        `INSERT INTO system_health_checks
           (module_key, module_name, status, remarks, endpoint_checked, checked_by, last_checked_at)
         VALUES (?, ?, 'MAINTENANCE', ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
           status = 'MAINTENANCE',
           remarks = VALUES(remarks),
           checked_by = VALUES(checked_by),
           last_checked_at = NOW(),
           updated_at = NOW()`,
        [
          healthKey,
          healthDefinition?.name || module?.name || affectedModule,
          `Placed under maintenance for restore job ${jobResult.insertId}.`,
          '/api/admin/backups',
          req.user.id,
        ]
      );
    }

    await logAuditEntryWithExecutor(conn, req, {
      action: `RESTORE_BACKUP: ${backup.backup_reference}`,
      module: 'BACKUP_RESTORE',
      newValue: JSON.stringify({
        restore_job_id: jobResult.insertId,
        backup_set_id: backupId,
        restore_type: restoreType,
        affected_module: affectedModule,
        place_under_maintenance: placeUnderMaintenance,
        result: 'PENDING',
      }),
    });

    await conn.commit();
    return res.status(201).json({
      message: 'Restore request queued for controlled validation.',
      restore_job_id: jobResult.insertId,
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[RBAC] restore request error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to queue restore request.' });
  } finally {
    conn.release();
  }
});

router.patch('/backups/restore-jobs/:jobId', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (!(await hasTable('restore_jobs'))) {
      return res.status(409).json({ error: 'Restore job schema is not ready. Run migrations first.' });
    }

    const jobId = normalizePositiveInteger(req.params.jobId, 'restore_job_id');
    const status = normalizeEnum(req.body?.status, RESTORE_STATUSES, null);
    const resultMessage = cleanText(req.body?.result_message, 2000);
    if (!status) return res.status(400).json({ error: 'Restore job status is invalid.' });
    if (resultMessage.length < 3) return res.status(400).json({ error: 'Result message is required for restore job updates.' });

    await conn.beginTransaction();
    const [existingRows] = await conn.execute(
      `SELECT rj.id, rj.status, rj.restore_type, rj.affected_module,
              bs.backup_reference, bs.id AS backup_set_id
         FROM restore_jobs rj
         LEFT JOIN backup_sets bs ON bs.id = rj.backup_set_id
        WHERE rj.id = ?
        FOR UPDATE`,
      [jobId]
    );
    if (!existingRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Restore job not found.' });
    }

    const existing = existingRows[0];
    const allowedTransitions = RESTORE_JOB_TRANSITIONS[existing.status] || new Set();
    if (!allowedTransitions.has(status)) {
      await conn.rollback();
      return res.status(409).json({ error: `Restore job cannot move from ${existing.status} to ${status}.` });
    }

    const fields = ['status = ?', 'result_message_encrypted = ?'];
    const values = [status, protectedText(resultMessage)];
    if (status === 'IN_PROGRESS') {
      fields.push('approved_by = COALESCE(approved_by, ?)', 'started_at = COALESCE(started_at, NOW())');
      values.push(req.user.id);
    }
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) {
      fields.push('completed_at = COALESCE(completed_at, NOW())');
    }

    values.push(jobId);
    await conn.execute(
      `UPDATE restore_jobs
          SET ${fields.join(', ')}
        WHERE id = ?`,
      values
    );

    await logAuditEntryWithExecutor(conn, req, {
      action: `RESTORE_JOB_UPDATED: ${existing.backup_reference || `JOB-${jobId}`}`,
      module: 'BACKUP_RESTORE',
      newValue: JSON.stringify({
        restore_job_id: jobId,
        backup_set_id: existing.backup_set_id,
        previous_status: existing.status,
        status,
        restore_type: existing.restore_type,
        affected_module: existing.affected_module,
        result: resultMessage,
      }),
    });

    await conn.commit();
    return res.json({ message: 'Restore job updated.' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[RBAC] restore job update error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to update restore job.' });
  } finally {
    conn.release();
  }
});

router.post('/backups/rollback-requests', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (!(await hasTable('module_rollback_requests'))) {
      return res.status(409).json({ error: 'Rollback request schema is not ready. Run migrations first.' });
    }

    const affectedModule = cleanText(req.body?.affected_module, 80);
    const module = BACKUP_RECOVERY_MODULES.find(item => item.key === affectedModule);
    if (!module) return res.status(400).json({ error: 'Affected module is invalid.' });

    let latestRecovery = null;
    if (await hasTable('module_recovery_points')) {
      const [rows] = await pool.execute(
        `SELECT current_version, stable_version, artifact_location_encrypted, rollback_available
           FROM module_recovery_points
          WHERE module_key = ?
          ORDER BY created_at DESC
          LIMIT 1`,
        [affectedModule]
      );
      latestRecovery = rows[0] || null;
    }

    const currentVersion = cleanText(req.body?.current_version, 80) || latestRecovery?.current_version || moduleCurrentVersion(affectedModule);
    const targetVersion = cleanText(req.body?.target_version, 80) || latestRecovery?.stable_version || moduleStableVersion(affectedModule);
    const artifactLocation = cleanText(req.body?.artifact_location, 1000)
      || revealProtectedText(latestRecovery?.artifact_location_encrypted)
      || deploymentArtifactReference();
    const reason = cleanText(req.body?.reason, 2000);
    if (!reason) return res.status(400).json({ error: 'Rollback reason is required.' });
    if (!module.rollback) return res.status(409).json({ error: 'Rollback is not supported for this module.' });

    await conn.beginTransaction();
    const [result] = await conn.execute(
      `INSERT INTO module_rollback_requests
         (affected_module, current_version, target_version, artifact_location_encrypted, reason_encrypted, status, requested_by)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?)`,
      [
        affectedModule,
        currentVersion,
        targetVersion,
        protectedText(artifactLocation),
        protectedText(reason),
        req.user.id,
      ]
    );

    await logAuditEntryWithExecutor(conn, req, {
      action: `REQUEST_MODULE_ROLLBACK: ${affectedModule}`,
      module: 'BACKUP_RESTORE',
      newValue: JSON.stringify({
        rollback_request_id: result.insertId,
        affected_module: affectedModule,
        current_version: currentVersion,
        target_version: targetVersion,
        result: 'PENDING',
      }),
    });

    await conn.commit();
    return res.status(201).json({
      message: 'Rollback request logged for controlled approval.',
      rollback_request_id: result.insertId,
    });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[RBAC] rollback request error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to request rollback.' });
  } finally {
    conn.release();
  }
});

router.patch('/backups/rollback-requests/:requestId', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (!(await hasTable('module_rollback_requests'))) {
      return res.status(409).json({ error: 'Rollback request schema is not ready. Run migrations first.' });
    }
    const requestId = normalizePositiveInteger(req.params.requestId, 'rollback_request_id');
    const status = normalizeEnum(req.body?.status, ROLLBACK_STATUSES, null);
    const resultMessage = req.body?.result_message !== undefined ? cleanText(req.body.result_message, 2000) : null;
    if (!status && resultMessage === null) return res.status(400).json({ error: 'No rollback update provided.' });

    const fields = [];
    const values = [];
    if (status) {
      fields.push('status = ?');
      values.push(status);
      if (status === 'APPROVED') {
        fields.push('approved_by = ?');
        values.push(req.user.id);
      }
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(status)) fields.push('completed_at = NOW()');
    }
    if (resultMessage !== null) {
      fields.push('result_message_encrypted = ?');
      values.push(protectedText(resultMessage));
    }

    await conn.beginTransaction();
    const [existingRows] = await conn.execute(
      'SELECT id, affected_module FROM module_rollback_requests WHERE id = ? FOR UPDATE',
      [requestId]
    );
    if (!existingRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Rollback request not found.' });
    }

    values.push(requestId);
    await conn.execute(
      `UPDATE module_rollback_requests
          SET ${fields.join(', ')}
        WHERE id = ?`,
      values
    );

    const actionName = status === 'APPROVED'
      ? 'APPROVE_MODULE_ROLLBACK'
      : status === 'COMPLETED'
        ? 'COMPLETE_MODULE_ROLLBACK'
        : status === 'FAILED'
          ? 'FAIL_MODULE_ROLLBACK'
          : 'REQUEST_MODULE_ROLLBACK';
    await logAuditEntryWithExecutor(conn, req, {
      action: `${actionName}: ${existingRows[0].affected_module}`,
      module: 'BACKUP_RESTORE',
      newValue: JSON.stringify({ rollback_request_id: requestId, status, result_updated: resultMessage !== null }),
    });

    await conn.commit();
    return res.json({ message: 'Rollback request updated.' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[RBAC] rollback update error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to update rollback request.' });
  } finally {
    conn.release();
  }
});

router.patch('/backups/:backupId', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const backupSetsAvailable = await hasTable('backup_sets');
    const legacyBackupAvailable = await hasTable('system_backup_log');
    if (!backupSetsAvailable && !legacyBackupAvailable) {
      return res.status(409).json({ error: 'Backup schema is not ready. Run migrations first.' });
    }

    const backupId = normalizePositiveInteger(req.params.backupId, 'backup_id');
    const status = req.body?.status
      ? (backupSetsAvailable ? normalizeBackupSetStatus(req.body.status, null) : normalizeEnum(req.body.status, BACKUP_STATUSES, null))
      : null;
    const manifestHash = cleanText(req.body?.checksum || req.body?.manifest_hash, 64).toLowerCase();
    const backupLocation = req.body?.storage_location !== undefined
      ? cleanText(req.body.storage_location, 1000)
      : (req.body?.backup_location !== undefined ? cleanText(req.body.backup_location, 1000) : null);
    const notes = req.body?.notes !== undefined ? cleanText(req.body.notes, 2000) : null;
    if (req.body?.status && !status) return res.status(400).json({ error: 'Invalid backup status.' });
    if (manifestHash && !/^[a-f0-9]{64}$/.test(manifestHash)) {
      return res.status(400).json({ error: 'manifest_hash must be a SHA-256 hex digest.' });
    }

    await conn.beginTransaction();
    let backupReference = null;
    if (backupSetsAvailable) {
      const fields = [];
      const values = [];
      if (status) {
        fields.push('status = ?');
        values.push(status);
        if (status === 'VERIFIED') fields.push('verified_at = NOW()');
        if (status === 'RESTORED') fields.push('restored_at = NOW()');
      }
      if (manifestHash) {
        fields.push('checksum = ?');
        values.push(manifestHash);
      }
      if (backupLocation !== null) {
        fields.push('storage_location_encrypted = ?');
        values.push(protectedText(backupLocation));
      }
      if (notes !== null) {
        fields.push('remarks_encrypted = ?');
        values.push(protectedText(notes));
      }
      if (!fields.length) {
        await conn.rollback();
        return res.status(400).json({ error: 'No backup updates provided.' });
      }

      const [existingRows] = await conn.execute(
        'SELECT id, backup_reference FROM backup_sets WHERE id = ? FOR UPDATE',
        [backupId]
      );
      if (!existingRows.length) {
        await conn.rollback();
        return res.status(404).json({ error: 'Backup set not found.' });
      }
      backupReference = existingRows[0].backup_reference;
      values.push(backupId);
      await conn.execute(
        `UPDATE backup_sets
            SET ${fields.join(', ')}
          WHERE id = ?`,
        values
      );

      if (legacyBackupAvailable) {
        const legacyFields = [];
        const legacyValues = [];
        if (status) {
          legacyFields.push('status = ?');
          legacyValues.push(backupStatusToLegacy(status));
          if (['COMPLETED', 'VERIFIED', 'RESTORED'].includes(status)) legacyFields.push('completed_at = COALESCE(completed_at, NOW())');
          if (status === 'VERIFIED') {
            legacyFields.push('verified_by = ?', 'verified_at = NOW()');
            legacyValues.push(req.user.id);
          }
        }
        if (manifestHash) {
          legacyFields.push('manifest_hash = ?');
          legacyValues.push(manifestHash);
        }
        if (backupLocation !== null) {
          legacyFields.push('backup_location_encrypted = ?');
          legacyValues.push(protectedText(backupLocation));
        }
        if (notes !== null) {
          legacyFields.push('notes_encrypted = ?');
          legacyValues.push(protectedText(notes));
        }
        if (legacyFields.length) {
          legacyValues.push(backupReference);
          await conn.execute(
            `UPDATE system_backup_log
                SET ${legacyFields.join(', ')}
              WHERE backup_reference = ?`,
            legacyValues
          );
        }
      }
    } else {
      const fields = [];
      const values = [];
      if (status) {
        fields.push('status = ?');
        values.push(status);
        if (['COMPLETED', 'VERIFIED'].includes(status)) fields.push('completed_at = COALESCE(completed_at, NOW())');
        if (status === 'VERIFIED') {
          fields.push('verified_by = ?', 'verified_at = NOW()');
          values.push(req.user.id);
        }
      }
      if (manifestHash) {
        fields.push('manifest_hash = ?');
        values.push(manifestHash);
      }
      if (backupLocation !== null) {
        fields.push('backup_location_encrypted = ?');
        values.push(protectedText(backupLocation));
      }
      if (notes !== null) {
        fields.push('notes_encrypted = ?');
        values.push(protectedText(notes));
      }
      if (!fields.length) {
        await conn.rollback();
        return res.status(400).json({ error: 'No backup updates provided.' });
      }

      const [existingRows] = await conn.execute(
        'SELECT backup_id, backup_reference FROM system_backup_log WHERE backup_id = ? FOR UPDATE',
        [backupId]
      );
      if (!existingRows.length) {
        await conn.rollback();
        return res.status(404).json({ error: 'Backup record not found.' });
      }
      backupReference = existingRows[0].backup_reference;
      values.push(backupId);
      await conn.execute(
        `UPDATE system_backup_log
            SET ${fields.join(', ')}
          WHERE backup_id = ?`,
        values
      );
    }

    await logAuditEntryWithExecutor(conn, req, {
      action: `${status === 'VERIFIED' ? 'VERIFY_BACKUP' : 'CHANGE_BACKUP_SETTINGS'}: ${backupReference}`,
      module: 'BACKUP_RESTORE',
      newValue: JSON.stringify({
        backup_set_id: backupId,
        status,
        checksum_recorded: Boolean(manifestHash),
        location_updated: backupLocation !== null,
      }),
    });

    await conn.commit();
    return res.json({ message: 'Backup record updated.' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    console.error('[RBAC] backup update error:', err.message);
    return res.status(err.statusCode || 500).json({ error: err.statusCode ? err.message : 'Failed to update backup record.' });
  } finally {
    conn.release();
  }
});

/* ================================================================
   POST /api/admin/register-role
   ================================================================
   Account Registration & Role Assignment (Use Case 17)
   
   Creates or updates a user account and assigns a role.
   - Hashes password with Argon2id
   - Logs immutable audit entry
   
   Body: {
     employee_id:      (required) target employee's numeric ID
     username:         (required) login username
     password:         (required) default password
     role_id:          (required) role to assign
   }
   ================================================================ */
router.post('/register-role', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const { employee_id, username, password, role_id } = req.body;

    // ── Input Validation ─────────────────────────────────────
    if (!employee_id || !username || !password || !role_id) {
      return res.status(400).json({
        error: 'Missing required fields.',
        required: ['employee_id', 'username', 'password', 'role_id'],
      });
    }

    const passwordErrors = passwordPolicyErrors(password);
    if (passwordErrors.length) {
      return res.status(400).json({
        error: 'Temporary password is invalid.',
        requirements: passwordErrors,
      });
    }

    const cleanUsername = sanitizeInput(username).toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(cleanUsername)) {
      return res.status(400).json({
        error: 'Username may only contain lowercase letters, numbers, dots, hyphens, and underscores.',
      });
    }

    // ── Verify employee exists ───────────────────────────────
    const [empRows] = await conn.execute(
      'SELECT id, first_name, last_name, employee_code FROM employees WHERE id = ?',
      [employee_id]
    );
    if (empRows.length === 0) {
      return res.status(404).json({ error: 'Employee not found.' });
    }
    const employee = empRows[0];

    // ── Verify role exists ───────────────────────────────────
    const [roleRows] = await conn.execute(
      'SELECT id, name, label, access_level FROM roles WHERE id = ?',
      [role_id]
    );
    if (roleRows.length === 0) {
      return res.status(404).json({ error: 'Role not found.' });
    }
    const assignedRole = roleRows[0];

    // ── Hash password with Argon2id ──────────────────────────
    // Administrator-created passwords are temporary. They are stored only as
    // Argon2id hashes and force the employee to choose a new password.
    const passwordHash = await hashTemporaryPassword(password);

    // ── Begin Transaction ────────────────────────────────────
    await conn.beginTransaction();

    // Check if user account already exists for this employee
    const [existingUser] = await conn.execute(
      'SELECT id, role_id FROM users WHERE employee_id = ? FOR UPDATE',
      [employee_id]
    );

    let userId;
    let actionPerformed;
    let oldValue = null;

    if (existingUser.length > 0) {
      // ── UPDATE existing account ────────────────────────────
      const oldRoleId = existingUser[0].role_id;
      userId = existingUser[0].id;

      // Fetch old role name for audit
      const [oldRoleRows] = await conn.execute('SELECT name, label FROM roles WHERE id = ?', [oldRoleId]);
      oldValue = JSON.stringify({
        role_id: oldRoleId,
        role_name: oldRoleRows[0]?.name || 'unknown',
        role_label: oldRoleRows[0]?.label || 'unknown',
      });

      await conn.execute(
        `UPDATE users
            SET username = ?,
                password_hash = ?,
                role_id = ?,
                password_changed_at = NOW(),
                force_password_change = 1,
                failed_login_attempts = 0,
                account_locked_until = NULL
          WHERE id = ?`,
        [cleanUsername, passwordHash, role_id, userId]
      );
      await revokeEmployeeSessions(conn, employee_id, 'admin_password_reset');

      actionPerformed = `ROLE_UPDATED: Employee ${employee.employee_code} (${employee.first_name} ${employee.last_name}) role changed from ${oldRoleRows[0]?.label || oldRoleId} to ${assignedRole.label}`;

    } else {
      // ── INSERT new account ─────────────────────────────────
      const [insertResult] = await conn.execute(
        `INSERT INTO users
           (username, password_hash, role_id, employee_id, is_active,
            password_changed_at, force_password_change, failed_login_attempts, account_locked_until)
         VALUES (?, ?, ?, ?, 1, NOW(), 1, 0, NULL)`,
        [cleanUsername, passwordHash, role_id, employee_id]
      );
      userId = insertResult.insertId;

      actionPerformed = `ACCOUNT_CREATED: New account '${cleanUsername}' for Employee ${employee.employee_code} (${employee.first_name} ${employee.last_name}) with role ${assignedRole.label} (${assignedRole.access_level})`;
    }

    await conn.execute(
      `UPDATE employees
          SET Password_Hash = ?,
              Password_Changed_At = NULL,
              Failed_Login_Attempts = 0,
              Locked_Until = NULL,
              force_password_change = 1
        WHERE id = ?`,
      [passwordHash, employee_id]
    );

    // ── Immutable Audit Log Entry (Non-Repudiation) ──────────
    const newValue = JSON.stringify({
      user_id: userId,
      username: cleanUsername,
      role_id: role_id,
      role_name: assignedRole.name,
      role_label: assignedRole.label,
      access_level: assignedRole.access_level,
      force_password_change: true,
    });

    const adminIP = extractClientIP(req);
    const adminUA = req.headers['user-agent'] || 'unknown';

    await conn.execute(
      `INSERT INTO system_audit_log 
         (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp)
       VALUES (?, ?, ?, ?, 'RBAC', ?, ?, ?, ?, NOW())`,
      [req.user.id, req.user.employeeId || null, employee_id, actionPerformed, oldValue, newValue, adminIP, adminUA]
    );

    // ── Commit Transaction ───────────────────────────────────
    await conn.commit();

    console.log(`✅ [RBAC] ${actionPerformed} — by Admin ID: ${req.user.id} from IP: ${adminIP}`);

    return res.status(existingUser.length > 0 ? 200 : 201).json({
      message: existingUser.length > 0 ? 'Account updated and role reassigned.' : 'Account registered with role assigned.',
      data: {
        user_id: userId,
        username: cleanUsername,
        employee_id: employee_id,
        employee_name: `${employee.first_name} ${employee.last_name}`,
        role: {
          id: assignedRole.id,
          name: assignedRole.name,
          label: assignedRole.label,
          access_level: assignedRole.access_level,
        },
      },
    });

  } catch (err) {
    await conn.rollback();

    // Handle duplicate username
    if (err.code === 'ER_DUP_ENTRY' && err.message.includes('username')) {
      return res.status(409).json({ error: 'Username already exists. Choose a different username.' });
    }

    console.error('❌ [RBAC] register-role error:', err.message);
    return res.status(500).json({ error: 'Failed to register account.' });
  } finally {
    conn.release();
  }
});

/* ================================================================
   PUT /api/admin/update-role/:userId
   ================================================================
   Update an existing user's role assignment only.
   Body: { role_id }
   ================================================================ */
router.put('/update-role/:userId', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const targetUserId = parseInt(req.params.userId, 10);
    const { role_id } = req.body;

    if (!role_id) {
      return res.status(400).json({ error: 'role_id is required.' });
    }

    // Prevent self-demotion
    if (targetUserId === req.user.id) {
      await logAuditEntry(req, {
        action: `DENIED_ROLE_CHANGE_ATTEMPT: User '${req.user.username || req.user.id}' attempted to change their own role`,
        module: 'RBAC_SECURITY',
        targetEmployeeId: req.user.employeeId || null,
        newValue: JSON.stringify({ target_user_id: targetUserId, requested_role_id: role_id, result: 'denied' }),
      }).catch(() => {});
      return res.status(403).json({ error: 'You cannot change your own role.' });
    }

    // Verify user exists
    const [userRows] = await conn.execute(
      `SELECT u.id, u.username, u.role_id, u.employee_id, r.name AS old_role_name, r.label AS old_role_label
       FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?`,
      [targetUserId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const targetUser = userRows[0];

    // Verify new role exists
    const [roleRows] = await conn.execute(
      'SELECT id, name, label, access_level FROM roles WHERE id = ?',
      [role_id]
    );
    if (roleRows.length === 0) {
      await logAuditEntry(req, {
        action: `DENIED_ROLE_CHANGE_ATTEMPT: Invalid role '${role_id}' requested for user ID ${targetUserId}`,
        module: 'RBAC_SECURITY',
        targetEmployeeId: targetUser.employee_id || null,
        newValue: JSON.stringify({ target_user_id: targetUserId, requested_role_id: role_id, result: 'denied' }),
      }).catch(() => {});
      return res.status(404).json({ error: 'Role not found.' });
    }
    const newRole = roleRows[0];

    await conn.beginTransaction();

    await conn.execute('UPDATE users SET role_id = ? WHERE id = ?', [role_id, targetUserId]);

    // Audit log
    const oldValue = JSON.stringify({ role_id: targetUser.role_id, role_name: targetUser.old_role_name });
    const newValue = JSON.stringify({ role_id: newRole.id, role_name: newRole.name, access_level: newRole.access_level });
    const action = `ROLE_REASSIGNED: User '${targetUser.username}' (ID: ${targetUserId}) changed from ${targetUser.old_role_label} to ${newRole.label}`;

    await conn.execute(
      `INSERT INTO system_audit_log 
         (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp)
       VALUES (?, ?, ?, ?, 'RBAC', ?, ?, ?, ?, NOW())`,
      [req.user.id, req.user.employeeId || null, targetUser.employee_id, action, oldValue, newValue, extractClientIP(req), req.headers['user-agent'] || 'unknown']
    );

    await conn.commit();

    console.log(`✅ [RBAC] ${action} — by Admin ID: ${req.user.id}`);

    return res.json({
      message: 'Role updated successfully.',
      data: { user_id: targetUserId, username: targetUser.username, new_role: newRole },
    });

  } catch (err) {
    await conn.rollback();
    console.error('❌ [RBAC] update-role error:', err.message);
    return res.status(500).json({ error: 'Failed to update role.' });
  } finally {
    conn.release();
  }
});

/* ================================================================
   PUT /api/admin/users/:userId/credentials
   ================================================================
   Update a user's username and password.
   Body: { username, password }
   ================================================================ */
router.put('/users/:userId/credentials', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const targetUserId = parseInt(req.params.userId, 10);
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Both username and password are required.' });
    }

    const passwordErrors = passwordPolicyErrors(password);
    if (passwordErrors.length) {
      return res.status(400).json({
        error: 'Temporary password is invalid.',
        requirements: passwordErrors,
      });
    }

    const cleanUsername = sanitizeInput(username).toLowerCase();
    if (!/^[a-z0-9._-]+$/.test(cleanUsername)) {
      return res.status(400).json({
        error: 'Username may only contain lowercase letters, numbers, dots, hyphens, and underscores.',
      });
    }

    // Verify user exists
    const [userRows] = await conn.execute(
      'SELECT id, username, employee_id FROM users WHERE id = ?',
      [targetUserId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }
    const targetUser = userRows[0];

    const passwordHash = await hashTemporaryPassword(password);

    await conn.beginTransaction();

    await conn.execute(
      `UPDATE users
          SET username = ?,
              password_hash = ?,
              password_changed_at = NOW(),
              force_password_change = 1,
              failed_login_attempts = 0,
              account_locked_until = NULL
        WHERE id = ?`,
      [cleanUsername, passwordHash, targetUserId]
    );
    await conn.execute(
      `UPDATE employees
          SET Password_Hash = ?,
              Password_Changed_At = NULL,
              Failed_Login_Attempts = 0,
              Locked_Until = NULL,
              force_password_change = 1
        WHERE id = ?`,
      [passwordHash, targetUser.employee_id]
    );
    await revokeEmployeeSessions(conn, targetUser.employee_id, 'admin_password_reset');

    // Audit log
    const oldValue = JSON.stringify({ username: targetUser.username });
    const newValue = JSON.stringify({ username: cleanUsername, password_changed: true, force_password_change: true });
    const action = `CREDENTIALS_UPDATED: Credentials updated for user ID ${targetUserId} (${targetUser.username} -> ${cleanUsername})`;

    await conn.execute(
      `INSERT INTO system_audit_log 
         (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp)
       VALUES (?, ?, ?, ?, 'RBAC', ?, ?, ?, ?, NOW())`,
      [req.user.id, req.user.employeeId || null, targetUser.employee_id, action, oldValue, newValue, extractClientIP(req), req.headers['user-agent'] || 'unknown']
    );

    await conn.commit();
    console.log(`✅ [RBAC] ${action} — by Admin ID: ${req.user.id}`);

    return res.json({ message: 'Credentials updated successfully.' });

  } catch (err) {
    await conn.rollback();
    
    if (err.code === 'ER_DUP_ENTRY' && err.message.includes('username')) {
      return res.status(409).json({ error: 'Username already exists. Choose a different username.' });
    }

    console.error('❌ [RBAC] update credentials error:', err.message);
    return res.status(500).json({ error: 'Failed to update credentials.' });
  } finally {
    conn.release();
  }
});

/* ================================================================
   GET /api/admin/roles — List all roles with access levels
   ================================================================ */
router.get('/roles', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, name, label, access_level, created_at FROM roles ORDER BY id'
    );
    return res.json(rows);
  } catch (err) {
    console.error('❌ [RBAC] list roles error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch roles.' });
  }
});

/* ================================================================
   GET /api/admin/users — List all user accounts with roles
   ================================================================ */
router.get('/users', async (req, res) => {
  try {
    const includeStats = req.query.include_stats === '1';
    const hasFailedAttempts = await hasColumn('users', 'failed_login_attempts');
    const hasAccountLockedUntil = await hasColumn('users', 'account_locked_until');
    const hasLoginAttempts = await hasColumn('users', 'login_attempts');
    const hasLockedUntil = await hasColumn('users', 'locked_until');
    const attemptsExpr = hasFailedAttempts
      ? 'u.failed_login_attempts'
      : hasLoginAttempts
        ? 'u.login_attempts'
        : '0';
    const lockedUntilExpr = hasAccountLockedUntil
      ? 'u.account_locked_until'
      : hasLockedUntil
        ? 'u.locked_until'
        : 'NULL';

    const [rows] = await pool.execute(
      `SELECT u.id, u.username, u.role_id, u.employee_id, u.is_active, u.last_login,
              u.password_changed_at, u.force_password_change, u.created_at,
              COALESCE(${attemptsExpr}, 0) AS failed_login_attempts,
              ${lockedUntilExpr} AS account_locked_until,
              CASE
                WHEN ${lockedUntilExpr} IS NOT NULL AND ${lockedUntilExpr} > NOW() THEN 1
                ELSE 0
              END AS is_locked,
              GREATEST(TIMESTAMPDIFF(SECOND, NOW(), ${lockedUntilExpr}), 0) AS lock_seconds_remaining,
              r.name AS role_name, r.label AS role_label, r.access_level,
              e.first_name, e.last_name, e.employee_code
       FROM users u
       JOIN roles r ON r.id = u.role_id
       LEFT JOIN employees e ON e.id = u.employee_id
       ORDER BY u.id`
    );
    const users = rows.map(decryptEmployeeUserFields);
    if (!includeStats) return res.json(users);

    const [unlinkedRows] = await pool.execute(
      `SELECT COUNT(*) AS count
         FROM employees e
        WHERE NOT EXISTS (
          SELECT 1
            FROM users account_user
           WHERE account_user.employee_id = e.id
        )`
    );
    return res.json({
      users,
      stats: {
        total: users.length,
        active: users.filter(user => Number(user.is_active || 0) === 1).length,
        inactive: users.filter(user => Number(user.is_active || 0) !== 1).length,
        locked: users.filter(user => Number(user.is_locked || 0) === 1).length,
        unlinked_employees: Number(unlinkedRows[0]?.count || 0),
      },
    });
  } catch (err) {
    console.error('❌ [RBAC] list users error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch users.' });
  }
});

/* ================================================================
   PATCH /api/admin/users/:userId/deactivate — Deactivate account
   ================================================================ */
router.patch('/users/:userId/deactivate', async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId, 10);

    if (targetUserId === req.user.id) {
      return res.status(403).json({ error: 'You cannot deactivate your own account.' });
    }

    const [result] = await pool.execute(
      'UPDATE users SET is_active = 0 WHERE id = ?',
      [targetUserId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    await logAuditEntry(req, {
      action: `ACCOUNT_DEACTIVATED: User ID ${targetUserId} deactivated by Admin`,
      targetEmployeeId: null,
    });

    return res.json({ message: 'Account deactivated.' });
  } catch (err) {
    console.error('❌ [RBAC] deactivate error:', err.message);
    return res.status(500).json({ error: 'Failed to deactivate account.' });
  }
});

/* ================================================================
   PATCH /api/admin/users/:userId/activate — Reactivate account
   ================================================================ */
router.patch('/users/:userId/activate', async (req, res) => {
  try {
    const targetUserId = parseInt(req.params.userId, 10);

    const [result] = await pool.execute(
      'UPDATE users SET is_active = 1 WHERE id = ?',
      [targetUserId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found.' });
    }

    await logAuditEntry(req, {
      action: `ACCOUNT_ACTIVATED: User ID ${targetUserId} reactivated by Admin`,
      targetEmployeeId: null,
    });

    return res.json({ message: 'Account activated.' });
  } catch (err) {
    console.error('❌ [RBAC] activate error:', err.message);
    return res.status(500).json({ error: 'Failed to activate account.' });
  }
});

/* ================================================================
   GET /api/admin/audit-log — System-wide audit trail
   ================================================================ */
router.get('/audit-log', async (req, res) => {
  try {
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const module = String(req.query.module || '').trim();
    const search = String(req.query.search || '').trim().toLowerCase();
    const eventType = req.query.event_type || req.query.action_type;
    const anomalyType = String(req.query.anomaly_type || '').trim().toUpperCase();
    const anomalyOnly = String(eventType || '').trim().toLowerCase() === 'anomaly'
      || req.query.anomaly_only === '1'
      || Boolean(anomalyType);
    const includeLegacy = req.query.include_legacy === '1';
    const queryLimit = anomalyOnly ? Math.min(Math.max(limit * 4, 100), 500) : limit;
    const queryOffset = anomalyOnly ? 0 : offset;
    const queryEventType = anomalyOnly ? null : eventType;
    if (!includeLegacy) {
      const rows = await queryCanonicalSystemAuditLog({ limit: queryLimit, offset: queryOffset, module, search, eventType: queryEventType });
      const enrichedRows = enrichAuditAnomalies(rows);
      const visibleRows = anomalyOnly
        ? filterAuditAnomalies(enrichedRows, anomalyType).slice(offset, offset + limit)
        : enrichedRows;
      return res.json(visibleRows.map(row => ({
        ...row,
        old_value: redactAuditValue(row.old_value),
        new_value: redactAuditValue(row.new_value),
      })));
    }

    const rows = await queryGeneralAuditSources({ limit: queryLimit, offset: queryOffset, module, search, eventType: queryEventType, includeLegacy });
    const enrichedRows = enrichAuditAnomalies(rows);
    const visibleRows = anomalyOnly
      ? filterAuditAnomalies(enrichedRows, anomalyType).slice(offset, offset + limit)
      : enrichedRows;

    return res.json(visibleRows.map(row => ({
      ...row,
      old_value: redactAuditValue(row.old_value),
      new_value: redactAuditValue(row.new_value),
    })));
  } catch (err) {
    console.error('❌ [RBAC] audit-log error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch audit log.' });
  }
});

let systemHealthSchedulerTimer = null;
let systemHealthSchedulerRunning = false;

function systemHealthAutoCheckEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.SYSTEM_HEALTH_AUTO_CHECK_ENABLED || '').trim().toLowerCase());
}

function systemHealthIntervalMs() {
  const minutes = Number.parseInt(process.env.SYSTEM_HEALTH_INTERVAL_MINUTES || '10', 10);
  const safeMinutes = Number.isFinite(minutes) ? Math.min(Math.max(minutes, 1), 1440) : 10;
  return safeMinutes * 60 * 1000;
}

async function runScheduledSystemHealthCheck() {
  if (systemHealthSchedulerRunning) return;
  systemHealthSchedulerRunning = true;
  try {
    const snapshot = await getSystemHealthSnapshot({
      persist: true,
      checkedByUserId: null,
      historyRunId: makeSystemHealthRunId(),
      triggerType: 'SCHEDULED',
    });
    const summary = snapshot.summary || summarizeSystemHealth(snapshot.modules || []);
    console.log(
      `[RBAC] scheduled system health check: ${summary.online || 0} online, ${summary.warning || 0} warning, ${summary.offline || 0} offline`
    );
  } catch (error) {
    console.error('[RBAC] scheduled system health check failed:', error.message);
  } finally {
    systemHealthSchedulerRunning = false;
  }
}

function startSystemHealthScheduler() {
  if (!systemHealthAutoCheckEnabled() || systemHealthSchedulerTimer) return;
  const intervalMs = systemHealthIntervalMs();
  systemHealthSchedulerTimer = setInterval(runScheduledSystemHealthCheck, intervalMs);
  if (typeof systemHealthSchedulerTimer.unref === 'function') systemHealthSchedulerTimer.unref();
  console.log(`[RBAC] System Health auto-check enabled every ${Math.round(intervalMs / 60000)} minute(s).`);
}

startSystemHealthScheduler();

module.exports = router;
