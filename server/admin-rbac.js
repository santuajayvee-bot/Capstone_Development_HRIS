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

const express  = require('express');
const router   = express.Router();
const pool     = require('../config/db');
const { requireAuth, requirePermission } = require('./middleware');
const accountController = require('../controllers/accountController');
const { decryptColumnValue, nullableText } = require('./data-protection');
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
async function logAuditEntry(req, { action, module = 'RBAC', targetEmployeeId = null, oldValue = null, newValue = null }) {
  const userId    = req.user?.id || 0;
  const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';

  await pool.execute(
    `INSERT INTO system_audit_log 
       (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [userId, req.user?.employeeId || null, targetEmployeeId, action, module, oldValue, newValue, ipAddress, userAgent]
  );
}

/* ================================================================
   HELPER: extractClientIP — Get real client IP behind proxies
   ================================================================ */
function extractClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || 'unknown';
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
