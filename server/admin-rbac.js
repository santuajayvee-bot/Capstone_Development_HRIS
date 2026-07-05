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
const BACKUP_TYPES = new Set(['DATABASE', 'FILES', 'FULL_SYSTEM']);
const BACKUP_TARGETS = new Set(['LOCAL', 'S3', 'RDS_SNAPSHOT', 'EXTERNAL']);
const BACKUP_STATUSES = new Set(['REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED', 'VERIFICATION_FAILED', 'VERIFIED']);

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
         FROM BLOCKCHAIN_AUDIT_LOG
        WHERE Status IN ('CRITICAL','FAILED','VERIFICATION_FAILED')`
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
  return new Date().toISOString();
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

async function checkRbacHealth() {
  const usersTable = await firstExistingTable(['users']);
  const rolesTable = await firstExistingTable(['roles']);
  const permissionsTable = await firstExistingTable(['permissions']);
  const rolePermissionsTable = await firstExistingTable(['role_permissions']);
  const roles = await countIfTable(rolesTable);
  const level4Roles = rolesTable && await hasColumn(rolesTable, 'access_level')
    ? await countIfTable(rolesTable, 'WHERE access_level = 4')
    : await countIfTable(rolesTable, "WHERE name IN ('system_admin','admin')");
  const hasCore = Boolean(usersTable && rolesTable);
  const status = hasCore && level4Roles > 0 ? 'ONLINE' : hasCore ? 'WARNING' : 'OFFLINE';
  return healthResult(
    status,
    status === 'ONLINE'
      ? 'RBAC roles and administrator role mapping are reachable.'
      : 'RBAC core tables are incomplete or no Level 4 role was found.',
    {
      dependencies: {
        users: await tableDependency(usersTable, 'User role assignments'),
        roles: await tableDependency(rolesTable, 'Role hierarchy'),
        permissions: await tableDependency(permissionsTable, 'Permission catalog'),
        role_permissions: await tableDependency(rolePermissionsTable, 'Role permissions'),
        role_count: { label: 'Roles', count: roles },
        level4_roles: { label: 'Level 4 roles', count: level4Roles },
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
  const backupTable = await firstExistingTable(['system_backup_log']);
  let latest = null;
  if (backupTable) {
    const [rows] = await pool.execute(
      `SELECT backup_reference, backup_type, storage_target, status, created_at, completed_at, verified_at
         FROM system_backup_log
        ORDER BY created_at DESC
        LIMIT 1`
    );
    latest = rows[0] || null;
  }
  const status = !backupTable ? 'WARNING' : !latest ? 'WARNING' : ['FAILED', 'VERIFICATION_FAILED'].includes(latest.status) ? 'OFFLINE' : 'ONLINE';
  return healthResult(
    status,
    !backupTable
      ? 'Backup log table is not installed yet.'
      : !latest
        ? 'No backup request has been recorded yet.'
        : ['FAILED', 'VERIFICATION_FAILED'].includes(latest.status)
          ? 'Latest backup failed or failed verification.'
          : 'Latest backup record is available.',
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

const SYSTEM_HEALTH_MODULES = [
  {
    key: 'authentication',
    name: 'Authentication / Login',
    endpoint: '/api/auth/login',
    dependencies: ['users', 'USER_SESSION', 'system_audit_log'],
    recommended_action: 'Review failed login, MFA, and lockout audit events before resetting credentials.',
    check: checkAuthenticationHealth,
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
    endpoint: '/api/leaves',
    dependencies: ['leave_requests', 'leave_balances', 'leave_audit_trail'],
    recommended_action: 'Review pending leave requests and verify balance records before payroll cutoff.',
    check: checkLeaveHealth,
  },
  {
    key: 'payroll',
    name: 'Payroll Computation',
    endpoint: '/api/payroll',
    dependencies: ['PAYROLL_RECORD', 'payroll_runs', 'payroll_policy_settings'],
    recommended_action: 'Review draft payroll runs, policy settings, and payroll audit trail before final approval.',
    check: checkPayrollHealth,
  },
  {
    key: 'payslip',
    name: 'Payslip Generation',
    endpoint: '/api/payslips',
    dependencies: ['payslips', 'PAYROLL_RECORD'],
    recommended_action: 'Verify payslip encryption columns and only release finalized payslips.',
    check: checkPayslipHealth,
  },
  {
    key: 'audit_trail',
    name: 'Audit Trail',
    endpoint: '/api/admin/audit-logs',
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
    key: 'backup_restore',
    name: 'Backup and Restore',
    endpoint: '/api/admin/backups',
    dependencies: ['system_backup_log', 'AWS S3 / RDS snapshot target'],
    recommended_action: 'Confirm the latest backup completed and verification hash is recorded.',
    check: checkBackupHealth,
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

function healthModuleResponse(definition, rowOrResult = {}) {
  const status = normalizeHealthStatus(rowOrResult.status);
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
    recent_logs: Array.isArray(rowOrResult.recent_logs) ? rowOrResult.recent_logs : [],
  };
}

async function runSystemHealthModule(definition) {
  const started = Date.now();
  const timestamp = checkedTimestamp();
  try {
    const check = await definition.check();
    const status = normalizeHealthStatus(check.status);
    return healthModuleResponse(definition, {
      status,
      remarks: check.remarks,
      response_time_ms: Date.now() - started,
      endpoint_checked: definition.endpoint,
      dependencies: check.dependencies || {},
      error_message: check.error_message || null,
      checked_at: timestamp,
      last_success_at: status === 'OFFLINE' ? null : timestamp,
      last_failure_at: status === 'OFFLINE' ? timestamp : null,
    });
  } catch (error) {
    console.error(`[RBAC] system health ${definition.key} check failed:`, error.message);
    return healthModuleResponse(definition, {
      status: 'OFFLINE',
      remarks: safeHealthError(),
      response_time_ms: Date.now() - started,
      endpoint_checked: definition.endpoint,
      dependencies: {},
      error_message: safeHealthError(),
      checked_at: timestamp,
      last_failure_at: timestamp,
    });
  }
}

async function persistSystemHealthModule(moduleResult, checkedByUserId = null) {
  if (!(await hasTable('system_health_checks'))) return;
  const status = normalizeHealthStatus(moduleResult.status);
  const checkedAt = moduleResult.last_checked_at || checkedTimestamp();
  const successAt = status === 'OFFLINE' ? null : checkedAt;
  const failureAt = status === 'OFFLINE' ? checkedAt : null;
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
  const params = [];
  const conditions = [];
  if (moduleColumn) conditions.push(`${moduleColumn} = 'SYSTEM_HEALTH'`);
  if (actionColumn) {
    conditions.push(`${actionColumn} LIKE ?`);
    params.push(`%${moduleKey}%`);
  }
  if (newValueColumn) {
    conditions.push(`${newValueColumn} LIKE ?`);
    params.push(`%${moduleKey}%`);
  }
  const whereClause = conditions.length ? `WHERE ${conditions.join(' OR ')}` : '';
  const [rows] = await pool.execute(
    `SELECT ${actionExpr} AS action_performed,
            ${moduleExpr} AS module,
            ${newValueExpr} AS details,
            ${timestampColumn} AS timestamp
       FROM system_audit_log
      ${whereClause}
      ORDER BY ${timestampColumn} DESC
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

async function buildSystemHealthModules({ persist = false, checkedByUserId = null, moduleKey = null } = {}) {
  const stored = await loadStoredSystemHealthModules();
  const definitions = moduleKey ? [SYSTEM_HEALTH_MODULE_MAP.get(moduleKey)].filter(Boolean) : SYSTEM_HEALTH_MODULES;
  const modules = [];

  for (const definition of definitions) {
    const result = await runSystemHealthModule(definition);
    const storedRow = stored.get(definition.key);
    if (storedRow) {
      result.last_success_at = result.last_success_at || storedRow.last_success_at || null;
      result.last_failure_at = result.last_failure_at || storedRow.last_failure_at || null;
    }
    if (persist) await persistSystemHealthModule(result, checkedByUserId);
    result.recent_logs = await recentSystemHealthLogs(definition.key);
    modules.push(result);
  }

  return modules;
}

async function getSystemHealthSnapshot(options = {}) {
  const legacy = await getLegacySystemHealthSnapshot();
  const modules = await buildSystemHealthModules(options);
  const summary = summarizeSystemHealth(modules);
  const issueCount = summary.offline + summary.warning;
  return {
    ...legacy,
    generated_at: new Date().toISOString(),
    status: summary.offline > 0 ? 'offline' : issueCount > 0 ? 'warning' : 'healthy',
    summary,
    modules,
  };
}

async function logSystemHealthCheck(req, moduleResults, requestedModule = 'all') {
  const results = Array.isArray(moduleResults) ? moduleResults : [moduleResults];
  const summary = summarizeSystemHealth(results);
  const action = requestedModule === 'all'
    ? `RUN_SYSTEM_HEALTH_CHECK: all modules, ${summary.online} online, ${summary.warning} warning, ${summary.offline} offline`
    : `RUN_SYSTEM_HEALTH_CHECK: ${requestedModule} => ${results[0]?.status || 'UNKNOWN'}`;
  await logAuditEntry(req, {
    action,
    module: 'SYSTEM_HEALTH',
    newValue: JSON.stringify({
      module: requestedModule,
      summary,
      results: results.map(result => ({
        module_key: result.module_key,
        status: result.status,
        response_time_ms: result.response_time_ms,
      })),
    }),
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
    return res.json(snapshot);
  } catch (err) {
    console.error('[RBAC] system-health error:', err.message);
    return res.status(500).json({ error: 'Failed to load system health.' });
  }
});

router.post('/system-health/check', async (req, res) => {
  try {
    const snapshot = await getSystemHealthSnapshot({
      persist: true,
      checkedByUserId: req.user?.id || null,
    });
    await logSystemHealthCheck(req, snapshot.modules, 'all').catch(error => {
      console.error('[RBAC] system-health audit log error:', error.message);
    });
    return res.json({
      message: 'System health check completed.',
      checked_at: snapshot.generated_at,
      summary: snapshot.summary,
      modules: snapshot.modules,
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
    const snapshot = await getSystemHealthSnapshot({
      persist: true,
      checkedByUserId: req.user?.id || null,
      moduleKey,
    });
    const moduleResult = snapshot.modules[0];
    await logSystemHealthCheck(req, moduleResult, moduleKey).catch(error => {
      console.error('[RBAC] system-health module audit log error:', error.message);
    });
    return res.json({
      message: 'Module health check completed.',
      checked_at: snapshot.generated_at,
      module: moduleResult,
      summary: snapshot.summary,
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
    if (!(await hasTable('system_backup_log'))) return res.json([]);
    const [rows] = await pool.execute(
      `SELECT bl.*, requester.username AS requested_by_username
         FROM system_backup_log bl
         LEFT JOIN users requester ON requester.id = bl.requested_by
        ORDER BY bl.created_at DESC
        LIMIT 100`
    );
    return res.json(rows.map(backupResponse));
  } catch (err) {
    console.error('[RBAC] backup list error:', err.message);
    return res.status(500).json({ error: 'Failed to load backup history.' });
  }
});

router.post('/backups/request', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (!(await hasTable('system_backup_log'))) {
      return res.status(409).json({ error: 'Backup log schema is not ready. Run migrations first.' });
    }

    const backupType = normalizeEnum(req.body?.backup_type, BACKUP_TYPES, 'DATABASE');
    const storageTarget = normalizeEnum(req.body?.storage_target, BACKUP_TARGETS, 'EXTERNAL');
    const notes = cleanText(req.body?.notes, 2000);
    const reference = makeReference('BKP');

    await conn.beginTransaction();
    const [result] = await conn.execute(
      `INSERT INTO system_backup_log
         (backup_reference, backup_type, storage_target, status, requested_by, notes_encrypted)
       VALUES (?, ?, ?, 'REQUESTED', ?, ?)`,
      [reference, backupType, storageTarget, req.user.id, protectedText(notes)]
    );

    await logAuditEntryWithExecutor(conn, req, {
      action: `BACKUP_REQUESTED: ${reference}`,
      module: 'BACKUP_RESTORE',
      newValue: JSON.stringify({ backup_id: result.insertId, backup_reference: reference, backup_type: backupType, storage_target: storageTarget }),
    });

    await conn.commit();
    return res.status(201).json({
      message: 'Backup request logged for system administrator follow-up.',
      backup_id: result.insertId,
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

router.patch('/backups/:backupId', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    if (!(await hasTable('system_backup_log'))) {
      return res.status(409).json({ error: 'Backup log schema is not ready. Run migrations first.' });
    }

    const backupId = normalizePositiveInteger(req.params.backupId, 'backup_id');
    const status = req.body?.status ? normalizeEnum(req.body.status, BACKUP_STATUSES, null) : null;
    const manifestHash = cleanText(req.body?.manifest_hash, 64).toLowerCase();
    const backupLocation = req.body?.backup_location !== undefined ? cleanText(req.body.backup_location, 1000) : null;
    const notes = req.body?.notes !== undefined ? cleanText(req.body.notes, 2000) : null;
    if (req.body?.status && !status) return res.status(400).json({ error: 'Invalid backup status.' });
    if (manifestHash && !/^[a-f0-9]{64}$/.test(manifestHash)) {
      return res.status(400).json({ error: 'manifest_hash must be a SHA-256 hex digest.' });
    }

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
    if (!fields.length) return res.status(400).json({ error: 'No backup updates provided.' });

    await conn.beginTransaction();
    const [existingRows] = await conn.execute(
      'SELECT backup_id, backup_reference FROM system_backup_log WHERE backup_id = ? FOR UPDATE',
      [backupId]
    );
    if (!existingRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'Backup record not found.' });
    }

    values.push(backupId);
    await conn.execute(
      `UPDATE system_backup_log
          SET ${fields.join(', ')}
        WHERE backup_id = ?`,
      values
    );

    await logAuditEntryWithExecutor(conn, req, {
      action: `BACKUP_RECORD_UPDATED: ${existingRows[0].backup_reference}`,
      module: 'BACKUP_RESTORE',
      newValue: JSON.stringify({ backup_id: backupId, status, manifest_hash_recorded: Boolean(manifestHash), location_updated: backupLocation !== null }),
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
    return res.json(rows.map(decryptEmployeeUserFields));
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
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const module = String(req.query.module || '').trim();
    const search = String(req.query.search || '').trim().toLowerCase();
    const eventType = req.query.event_type || req.query.action_type;
    const includeLegacy = req.query.include_legacy === '1';
    if (!includeLegacy) {
      const rows = await queryCanonicalSystemAuditLog({ limit, offset, module, search, eventType });
      if (rows.length === 0) {
        const fallbackRows = await queryGeneralAuditSources({ limit, offset, module, search, eventType, includeLegacy: true });
        return res.json(fallbackRows.map(row => ({
          ...row,
          old_value: redactAuditValue(row.old_value),
          new_value: redactAuditValue(row.new_value),
        })));
      }
      return res.json(rows.map(row => ({
        ...row,
        old_value: redactAuditValue(row.old_value),
        new_value: redactAuditValue(row.new_value),
      })));
    }

    const rows = await queryGeneralAuditSources({ limit, offset, module, search, eventType, includeLegacy });

    return res.json(rows.map(row => ({
      ...row,
      old_value: redactAuditValue(row.old_value),
      new_value: redactAuditValue(row.new_value),
    })));
  } catch (err) {
    console.error('❌ [RBAC] audit-log error:', err.message);
    return res.status(500).json({ error: 'Failed to fetch audit log.' });
  }
});

module.exports = router;
