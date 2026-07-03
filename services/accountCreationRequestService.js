const crypto = require('crypto');
const pool = require('../config/db');
const { decryptColumnValue } = require('../server/data-protection');
const { hashTemporaryPassword, validateTemporaryPassword } = require('./passwordService');

const REQUEST_MODULE = 'ACCOUNT_LIFECYCLE';
const REQUEST_STATUSES = new Set(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']);

class AccountCreationRequestError extends Error {
  constructor(message, statusCode = 400, code = 'ACCOUNT_REQUEST_INVALID') {
    super(message);
    this.name = 'AccountCreationRequestError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function positiveId(value, field) {
  const id = Number.parseInt(value, 10);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AccountCreationRequestError(field + ' must be a valid identifier.');
  }
  return id;
}

function cleanText(value, maxLength = 500) {
  return String(value ?? '').trim().replace(/[<>\x00]/g, '').slice(0, maxLength);
}

function clientIp(req) {
  return req?.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req?.ip
    || req?.socket?.remoteAddress
    || null;
}

function validateAllowedFields(body, allowedFields) {
  const unsupported = Object.keys(body || {}).filter(field => !allowedFields.has(field));
  if (unsupported.length) {
    throw new AccountCreationRequestError('Request contains unsupported fields.', 400, 'ACCOUNT_REQUEST_UNSUPPORTED_FIELDS');
  }
}

function normalizeUsername(value, fallback) {
  const username = cleanText(value || fallback, 100).toLowerCase();
  if (!username) throw new AccountCreationRequestError('A username could not be generated for this employee.');
  if (!/^[a-z0-9._-]+$/.test(username)) {
    throw new AccountCreationRequestError('Username may use only lowercase letters, numbers, dots, hyphens, and underscores.');
  }
  return username;
}

function defaultUsername(employee) {
  const code = String(employee.employee_code || employee.id || 'employee')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ('employee-' + (code || employee.id)).slice(0, 100);
}

function generatedPassword() {
  return crypto.randomBytes(18).toString('base64url');
}

function safeEmployeeName(row) {
  try {
    return [decryptColumnValue(row.first_name), decryptColumnValue(row.last_name)]
      .filter(Boolean)
      .join(' ') || null;
  } catch {
    return null;
  }
}

function displayStatus(value) {
  const status = String(value || 'PENDING').toLowerCase();
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function serializeRequest(row) {
  if (!row) return null;
  return {
    request_id: Number(row.request_id),
    employee_id: Number(row.employee_id),
    employee_code: row.employee_code,
    employee_name: safeEmployeeName(row),
    source_applicant_id: row.source_applicant_id ? Number(row.source_applicant_id) : null,
    suggested_username: row.suggested_username,
    default_role: row.default_role_name ? {
      id: Number(row.default_role_id),
      name: row.default_role_name,
      label: row.default_role_label,
      access_level: row.default_role_access_level,
    } : null,
    assigned_role: row.assigned_role_name ? {
      id: Number(row.assigned_role_id),
      name: row.assigned_role_name,
      label: row.assigned_role_label,
      access_level: row.assigned_role_access_level,
    } : null,
    status: row.status,
    account_status: row.account_user_id
      ? (Number(row.account_is_active) ? 'Active' : 'Disabled')
      : displayStatus(row.account_status),
    account_user_id: row.account_user_id ? Number(row.account_user_id) : null,
    requested_by: row.requested_by ? Number(row.requested_by) : null,
    requested_by_username: row.requested_by_username || null,
    approved_by: row.approved_by ? Number(row.approved_by) : null,
    approved_by_username: row.approved_by_username || null,
    review_reason: row.review_reason || null,
    created_at: row.created_at,
    approved_at: row.approved_at,
    rejected_at: row.rejected_at,
  };
}

async function writeAudit(connection, req, action, targetEmployeeId, oldValue = null, newValue = null) {
  await connection.execute(
    'INSERT INTO system_audit_log ' +
      '(user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())',
    [
      req.user.id,
      req.user.employeeId || null,
      targetEmployeeId,
      action,
      REQUEST_MODULE,
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
      clientIp(req),
      cleanText(req?.headers?.['user-agent'], 500) || null,
    ]
  );
}

async function getRegularEmployeeRole(connection) {
  const [rows] = await connection.execute(
    "SELECT id, name, label, access_level FROM roles WHERE name = 'employee' ORDER BY id LIMIT 1"
  );
  if (!rows[0]) {
    throw new AccountCreationRequestError(
      'The Regular Employee role is not configured. Contact the System Administrator.',
      409,
      'REGULAR_EMPLOYEE_ROLE_MISSING'
    );
  }
  return rows[0];
}

async function getRole(connection, roleId) {
  const [rows] = await connection.execute(
    'SELECT id, name, label, access_level FROM roles WHERE id = ? LIMIT 1',
    [roleId]
  );
  if (!rows[0]) throw new AccountCreationRequestError('The selected role no longer exists.', 404, 'ROLE_NOT_FOUND');
  return rows[0];
}

async function assertUsernameAvailable(connection, username) {
  const [rows] = await connection.execute('SELECT id FROM users WHERE username = ? LIMIT 1', [username]);
  if (rows[0]) {
    throw new AccountCreationRequestError('Username is already in use. Choose another username.', 409, 'USERNAME_TAKEN');
  }
}

async function getEmployeeForRequest(connection, employeeId, forUpdate = false) {
  const [rows] = await connection.execute(
    'SELECT e.id, e.employee_code, e.first_name, e.last_name, e.status, e.lifecycle_status, u.id AS existing_user_id ' +
      'FROM employees e LEFT JOIN users u ON u.employee_id = e.id ' +
      'WHERE e.id = ? LIMIT 1 ' + (forUpdate ? 'FOR UPDATE' : ''),
    [employeeId]
  );
  if (!rows[0]) throw new AccountCreationRequestError('Employee record was not found.', 404, 'EMPLOYEE_NOT_FOUND');
  const employee = rows[0];
  if (employee.existing_user_id) {
    throw new AccountCreationRequestError('This employee already has an account.', 409, 'ACCOUNT_ALREADY_EXISTS');
  }
  if (String(employee.status || '').toLowerCase() !== 'active') {
    throw new AccountCreationRequestError('Only active employees can receive an account.', 409, 'EMPLOYEE_NOT_ACTIVE');
  }
  return employee;
}

async function getTransferredApplicant(connection, employeeId, forUpdate = false) {
  try {
    const [rows] = await connection.execute(
      "SELECT applicant_id, workflow_status, approval_status FROM onboarding_applicant " +
        "WHERE converted_employee_id = ? ORDER BY transferred_at DESC, applicant_id DESC LIMIT 1 " + (forUpdate ? 'FOR UPDATE' : ''),
      [employeeId]
    );
    const applicant = rows[0] || null;
    if (applicant && (applicant.workflow_status !== 'Transferred' || applicant.approval_status !== 'Approved')) {
      throw new AccountCreationRequestError(
        'An onboarding employee can receive an account only after final approval and transfer to the Employee Directory.',
        409,
        'ONBOARDING_NOT_APPROVED'
      );
    }
    return applicant;
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') return null;
    throw error;
  }
}

async function requireApprovedTransferredApplicant(connection, employeeId, forUpdate = false) {
  const applicant = await getTransferredApplicant(connection, employeeId, forUpdate);
  if (!applicant) {
    throw new AccountCreationRequestError(
      'Accounts can be created only for applicants approved and transferred to the Employee Directory.',
      409,
      'ONBOARDING_APPROVAL_AND_TRANSFER_REQUIRED'
    );
  }
  return applicant;
}

async function getDirectAccountForEmployee(connection, employeeId) {
  const [rows] = await connection.execute(
    'SELECT e.id AS employee_id, e.employee_code, u.id AS account_user_id, u.username, u.is_active, u.created_at, ' +
      'r.id AS role_id, r.name AS role_name, r.label AS role_label, r.access_level AS role_access_level ' +
      'FROM employees e LEFT JOIN users u ON u.employee_id = e.id ' +
      'LEFT JOIN roles r ON r.id = u.role_id WHERE e.id = ? LIMIT 1',
    [employeeId]
  );
  if (!rows[0]) throw new AccountCreationRequestError('Employee record was not found.', 404, 'EMPLOYEE_NOT_FOUND');
  const row = rows[0];
  return row.account_user_id
    ? {
        employee_id: Number(row.employee_id),
        employee_code: row.employee_code,
        account_user_id: Number(row.account_user_id),
        username: row.username,
        account_status: Number(row.is_active) ? 'Active' : 'Disabled',
        role: {
          id: Number(row.role_id),
          name: row.role_name,
          label: row.role_label,
          access_level: row.role_access_level,
        },
        created_at: row.created_at,
      }
    : null;
}

async function getRequestById(connection, requestId, forUpdate = false) {
  const [rows] = await connection.execute(
    'SELECT acr.*, e.employee_code, e.first_name, e.last_name, requester.username AS requested_by_username, ' +
      'approver.username AS approved_by_username, default_role.name AS default_role_name, ' +
      'default_role.label AS default_role_label, default_role.access_level AS default_role_access_level, ' +
      'assigned_role.name AS assigned_role_name, assigned_role.label AS assigned_role_label, ' +
      'assigned_role.access_level AS assigned_role_access_level, account.is_active AS account_is_active ' +
      'FROM account_creation_requests acr JOIN employees e ON e.id = acr.employee_id ' +
      'LEFT JOIN users requester ON requester.id = acr.requested_by ' +
      'LEFT JOIN users approver ON approver.id = acr.approved_by ' +
      'LEFT JOIN roles default_role ON default_role.id = acr.default_role_id ' +
      'LEFT JOIN roles assigned_role ON assigned_role.id = acr.assigned_role_id ' +
      'LEFT JOIN users account ON account.id = acr.account_user_id ' +
      'WHERE acr.request_id = ? LIMIT 1 ' + (forUpdate ? 'FOR UPDATE' : ''),
    [requestId]
  );
  return rows[0] || null;
}

async function createAccountCreationRequest({ req, employeeId, body }) {
  validateAllowedFields(body, new Set(['suggested_username']));
  const targetEmployeeId = positiveId(employeeId, 'employeeId');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const employee = await getEmployeeForRequest(connection, targetEmployeeId, true);
    const applicant = await requireApprovedTransferredApplicant(connection, targetEmployeeId);
    const regularRole = await getRegularEmployeeRole(connection);
    const username = normalizeUsername(body?.suggested_username, defaultUsername(employee));
    await assertUsernameAvailable(connection, username);

    const [openRows] = await connection.execute(
      "SELECT request_id FROM account_creation_requests WHERE employee_id = ? " +
        "AND status IN ('PENDING', 'APPROVED') ORDER BY request_id DESC LIMIT 1 FOR UPDATE",
      [targetEmployeeId]
    );
    if (openRows[0]) {
      throw new AccountCreationRequestError(
        'An active account creation request already exists for this employee.',
        409,
        'ACCOUNT_REQUEST_ALREADY_EXISTS'
      );
    }

    const [inserted] = await connection.execute(
      'INSERT INTO account_creation_requests ' +
        '(employee_id, source_applicant_id, requested_by, suggested_username, default_role_id, status, account_status) ' +
        "VALUES (?, ?, ?, ?, ?, 'PENDING', 'PENDING')",
      [targetEmployeeId, applicant?.applicant_id || null, req.user.id, username, regularRole.id]
    );
    await writeAudit(
      connection,
      req,
      'ACCOUNT_CREATION_REQUESTED [REQUEST:' + inserted.insertId + ']',
      targetEmployeeId,
      null,
      {
        request_id: inserted.insertId,
        suggested_username: username,
        default_role: regularRole.name,
        source: applicant ? 'ONBOARDING_APPROVED_TRANSFER' : 'EMPLOYEE_DIRECTORY',
      }
    );
    const request = await getRequestById(connection, inserted.insertId);
    await connection.commit();
    return serializeRequest(request);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function getApprovedTransferredEmployeeAccount(employeeId) {
  const targetEmployeeId = positiveId(employeeId, 'employeeId');
  const connection = await pool.getConnection();
  try {
    const applicant = await requireApprovedTransferredApplicant(connection, targetEmployeeId);
    const account = await getDirectAccountForEmployee(connection, targetEmployeeId);
    return {
      employee_id: targetEmployeeId,
      source_applicant_id: Number(applicant.applicant_id),
      account,
    };
  } finally {
    connection.release();
  }
}

async function createApprovedTransferredEmployeeAccount({ req, employeeId, body }) {
  validateAllowedFields(body, new Set(['username', 'temporary_password', 'temporaryPassword']));
  const targetEmployeeId = positiveId(employeeId, 'employeeId');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const employee = await getEmployeeForRequest(connection, targetEmployeeId, true);
    const applicant = await requireApprovedTransferredApplicant(connection, targetEmployeeId, true);
    const regularRole = await getRegularEmployeeRole(connection);
    const username = normalizeUsername(body?.username, defaultUsername(employee));
    await assertUsernameAvailable(connection, username);

    const providedPassword = String(body?.temporary_password || body?.temporaryPassword || '');
    const passwordWasGenerated = !providedPassword;
    const plainTemporaryPassword = passwordWasGenerated ? generatedPassword() : providedPassword;
    const validation = validateTemporaryPassword(plainTemporaryPassword);
    if (!validation.valid) {
      throw new AccountCreationRequestError(validation.errors[0] || 'Temporary password is invalid.');
    }
    const passwordHash = await hashTemporaryPassword(plainTemporaryPassword);

    const [user] = await connection.execute(
      'INSERT INTO users ' +
        '(username, password_hash, role_id, employee_id, is_active, password_changed_at, force_password_change, failed_login_attempts, account_locked_until) ' +
        'VALUES (?, ?, ?, ?, 1, NOW(), 1, 0, NULL)',
      [username, passwordHash, regularRole.id, employee.id]
    );
    await connection.execute(
      'UPDATE employees SET Password_Hash = ?, Password_Changed_At = NULL, Failed_Login_Attempts = 0, ' +
        'Locked_Until = NULL, force_password_change = 1, Employee_ID = COALESCE(Employee_ID, id) WHERE id = ?',
      [passwordHash, employee.id]
    );
    await writeAudit(
      connection,
      req,
      'HR_CREATED_LEVEL_1_ACCOUNT [APPLICANT:' + applicant.applicant_id + ']',
      employee.id,
      null,
      {
        account_user_id: user.insertId,
        username,
        assigned_role: regularRole.name,
        assigned_role_label: regularRole.label,
        source_applicant_id: applicant.applicant_id,
        approval_status: applicant.approval_status,
        workflow_status: applicant.workflow_status,
        force_password_change: true,
        temporary_password_generated: passwordWasGenerated,
      }
    );
    const account = await getDirectAccountForEmployee(connection, employee.id);
    await connection.commit();
    return {
      employee_id: employee.id,
      source_applicant_id: Number(applicant.applicant_id),
      account,
      generatedTemporaryPassword: passwordWasGenerated ? plainTemporaryPassword : null,
    };
  } catch (error) {
    await connection.rollback();
    if (error?.code === 'ER_DUP_ENTRY') {
      throw new AccountCreationRequestError('Username is already in use. Choose another username.', 409, 'USERNAME_TAKEN');
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function getAccountRequestForEmployee(employeeId) {
  const targetEmployeeId = positiveId(employeeId, 'employeeId');
  const [rows] = await pool.execute(
    'SELECT request_id FROM account_creation_requests WHERE employee_id = ? ORDER BY request_id DESC LIMIT 1',
    [targetEmployeeId]
  );
  if (!rows[0]) return null;
  const connection = await pool.getConnection();
  try {
    return serializeRequest(await getRequestById(connection, rows[0].request_id));
  } finally {
    connection.release();
  }
}

async function listAccountCreationRequests({ requestedBy = null, status = null }) {
  const where = [];
  const params = [];
  if (requestedBy) {
    where.push('requested_by = ?');
    params.push(positiveId(requestedBy, 'requestedBy'));
  }
  if (status) {
    const normalizedStatus = cleanText(status, 20).toUpperCase();
    if (!REQUEST_STATUSES.has(normalizedStatus)) throw new AccountCreationRequestError('Invalid request status filter.');
    where.push('status = ?');
    params.push(normalizedStatus);
  }
  const [rows] = await pool.execute(
    'SELECT request_id FROM account_creation_requests ' +
      (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
      "ORDER BY FIELD(status, 'PENDING', 'REJECTED', 'APPROVED', 'CANCELLED'), created_at DESC",
    params
  );
  const connection = await pool.getConnection();
  try {
    const requests = [];
    for (const row of rows) {
      const request = await getRequestById(connection, row.request_id);
      if (request) requests.push(serializeRequest(request));
    }
    return requests;
  } finally {
    connection.release();
  }
}

async function approveAccountCreationRequest({ req, requestId, body }) {
  validateAllowedFields(body, new Set(['username', 'temporary_password', 'temporaryPassword', 'assigned_role_id']));
  const normalizedRequestId = positiveId(requestId, 'requestId');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const request = await getRequestById(connection, normalizedRequestId, true);
    if (!request) throw new AccountCreationRequestError('Account creation request was not found.', 404, 'ACCOUNT_REQUEST_NOT_FOUND');
    if (request.status !== 'PENDING') {
      throw new AccountCreationRequestError('Only pending account requests can be approved.', 409, 'ACCOUNT_REQUEST_NOT_PENDING');
    }

    const employee = await getEmployeeForRequest(connection, Number(request.employee_id), true);
    await requireApprovedTransferredApplicant(connection, employee.id, true);
    const roleId = body?.assigned_role_id == null || body?.assigned_role_id === ''
      ? Number(request.default_role_id)
      : positiveId(body.assigned_role_id, 'assigned_role_id');
    const role = await getRole(connection, roleId);
    const username = normalizeUsername(body?.username, request.suggested_username);
    await assertUsernameAvailable(connection, username);

    const providedPassword = String(body?.temporary_password || body?.temporaryPassword || '');
    const passwordWasGenerated = !providedPassword;
    const plainTemporaryPassword = passwordWasGenerated ? generatedPassword() : providedPassword;
    const validation = validateTemporaryPassword(plainTemporaryPassword);
    if (!validation.valid) {
      throw new AccountCreationRequestError(validation.errors[0] || 'Temporary password is invalid.');
    }
    const passwordHash = await hashTemporaryPassword(plainTemporaryPassword);

    const [user] = await connection.execute(
      'INSERT INTO users ' +
        '(username, password_hash, role_id, employee_id, is_active, password_changed_at, force_password_change, failed_login_attempts, account_locked_until) ' +
        'VALUES (?, ?, ?, ?, 1, NOW(), 1, 0, NULL)',
      [username, passwordHash, role.id, employee.id]
    );
    await connection.execute(
      'UPDATE employees SET Password_Hash = ?, Password_Changed_At = NULL, Failed_Login_Attempts = 0, ' +
        'Locked_Until = NULL, force_password_change = 1, Employee_ID = COALESCE(Employee_ID, id) WHERE id = ?',
      [passwordHash, employee.id]
    );
    await connection.execute(
      "UPDATE account_creation_requests SET status = 'APPROVED', account_status = 'ACTIVE', " +
        'account_user_id = ?, assigned_role_id = ?, approved_by = ?, approved_at = NOW(), review_reason = NULL ' +
        'WHERE request_id = ?',
      [user.insertId, role.id, req.user.id, normalizedRequestId]
    );
    await writeAudit(
      connection,
      req,
      'ACCOUNT_CREATION_APPROVED [REQUEST:' + normalizedRequestId + ']',
      employee.id,
      { status: 'PENDING', default_role_id: request.default_role_id },
      {
        account_user_id: user.insertId,
        username,
        assigned_role_id: role.id,
        assigned_role: role.name,
        account_status: 'Active',
        force_password_change: true,
        temporary_password_generated: passwordWasGenerated,
      }
    );
    const approvedRequest = await getRequestById(connection, normalizedRequestId);
    await connection.commit();
    return {
      request: serializeRequest(approvedRequest),
      generatedTemporaryPassword: passwordWasGenerated ? plainTemporaryPassword : null,
    };
  } catch (error) {
    await connection.rollback();
    if (error?.code === 'ER_DUP_ENTRY') {
      throw new AccountCreationRequestError('Username is already in use. Choose another username.', 409, 'USERNAME_TAKEN');
    }
    throw error;
  } finally {
    connection.release();
  }
}

async function rejectAccountCreationRequest({ req, requestId, body }) {
  validateAllowedFields(body, new Set(['reason']));
  const normalizedRequestId = positiveId(requestId, 'requestId');
  const reason = cleanText(body?.reason, 500);
  if (reason.length < 8) {
    throw new AccountCreationRequestError('A rejection reason of at least 8 characters is required.');
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const request = await getRequestById(connection, normalizedRequestId, true);
    if (!request) throw new AccountCreationRequestError('Account creation request was not found.', 404, 'ACCOUNT_REQUEST_NOT_FOUND');
    if (request.status !== 'PENDING') {
      throw new AccountCreationRequestError('Only pending account requests can be rejected.', 409, 'ACCOUNT_REQUEST_NOT_PENDING');
    }
    await connection.execute(
      "UPDATE account_creation_requests SET status = 'REJECTED', review_reason = ?, rejected_by = ?, rejected_at = NOW() WHERE request_id = ?",
      [reason, req.user.id, normalizedRequestId]
    );
    await writeAudit(
      connection,
      req,
      'ACCOUNT_CREATION_REJECTED [REQUEST:' + normalizedRequestId + ']',
      Number(request.employee_id),
      { status: 'PENDING' },
      { status: 'REJECTED', reason }
    );
    const rejectedRequest = await getRequestById(connection, normalizedRequestId);
    await connection.commit();
    return serializeRequest(rejectedRequest);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  AccountCreationRequestError,
  approveAccountCreationRequest,
  createApprovedTransferredEmployeeAccount,
  createAccountCreationRequest,
  getApprovedTransferredEmployeeAccount,
  getAccountRequestForEmployee,
  listAccountCreationRequests,
  rejectAccountCreationRequest,
};
