/* ============================================================
   Secure pre-employment onboarding workflow

   Applicants are not official employees until HR approves and
   transfers them to the Employee Directory.
   ============================================================ */

const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const argon2 = require('argon2');
const pool = require('../config/db');
const { encryptAES256, decryptAES256, encryptPII } = require('./crypto');
const { decryptColumnValue, encryptColumnValue } = require('./data-protection');
const { decryptAuditValue, encryptAuditValue } = require('./privacy-protection');
const { requireAuth, requireRole } = require('./middleware');
const { requestJson } = require('./secure-http');
const { optionalDateOnly } = require('./utils/dateValidation');
const {
  PAYROLL_SCHEDULE_LABELS,
  normalizePayrollScheduleValue,
} = require('./utils/payrollSchedule');

const router = express.Router();
const HR_ROLES = ['hr_admin', 'hr_manager', 'admin'];
const HR_FINAL_APPROVAL_ROLES = ['hr_manager'];
const SYSTEM_ADMIN_ROLES = ['system_admin', 'admin'];
const SCREENING_STATUSES = [
  'Pending Screening', 'For Interview', 'For Requirements Checking',
  'Passed Screening', 'Failed Screening', 'Not Required',
];
const employeePiiDb = value => encryptColumnValue(nullable(value));
const TRAINING_STATUSES = [
  'Not Yet Started', 'In Training', 'Completed Training',
  'Failed Training', 'For Final Evaluation', 'Not Required',
];
const DECISIONS = ['Approved', 'Rejected', 'For Re-evaluation', 'On Hold'];
const DOCUMENT_TYPES = [
  'Valid ID', 'Application Form', 'Contract', 'Medical Requirement',
  'Certificate', 'Training Record', 'Other',
];
const GENDERS = ['Male', 'Female', 'Prefer not to say'];
const CIVIL_STATUSES = ['Single', 'Married', 'Separated', 'Widowed'];
const BLOOD_TYPES = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown'];
const EMPLOYMENT_TYPES = ['Full-time', 'Part-time', 'Contractual'];
const SHIFT_SCHEDULES = [
  'Day Shift (8:00 AM - 5:00 PM)',
  'Morning Shift (6:00 AM - 2:00 PM)',
  'Afternoon Shift (2:00 PM - 10:00 PM)',
  'Night Shift (10:00 PM - 6:00 AM)',
  'Rotating Shift',
  'Flexible',
];
const EMPLOYEE_LEVELS = ['Rank and File', 'Supervisor', 'Manager', 'Executive'];
const PAYROLL_SCHEDULES = PAYROLL_SCHEDULE_LABELS;
const DIRECT_ROUTE_KEYWORDS = ['manager', 'supervisor', 'office staff', 'admin staff', 'hr staff', 'hr officer', 'hr manager'];
const ONBOARDING_ROUTE_KEYWORDS = [
  'operator', 'production worker', 'production staff', 'piece-rate worker',
  'piece rate worker', 'factory worker', 'logistics helper', 'machine operator',
];
const ARGON2ID_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 4,
  hashLength: 32,
};

const vaultDirectory = path.join(__dirname, '..', 'secure_uploads', 'onboarding');
if (!fs.existsSync(vaultDirectory)) fs.mkdirSync(vaultDirectory, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, callback) => {
    const allowedMimeTypes = new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'image/jpeg',
      'image/png',
    ]);
    if (!allowedMimeTypes.has(file.mimetype)) {
      return callback(new Error('Only PDF, DOC, DOCX, JPG, and PNG files are allowed.'));
    }
    callback(null, true);
  },
});

router.use(requireAuth);

router.post('/integrity/anchor-pending', requireRole(SYSTEM_ADMIN_ROLES), async (req, res) => {
  try {
    const [entries] = await pool.execute(
      `SELECT * FROM onboarding_integrity_chain
        WHERE anchor_status IN ('PENDING','FAILED')
        ORDER BY chain_id
        LIMIT 100`
    );
    if (!process.env.BLOCKCHAIN_API_URL) {
      return res.status(503).json({ error: 'BLOCKCHAIN_API_URL is not configured. Onboarding integrity entries remain queued locally.' });
    }

    let anchored = 0;
    let failed = 0;
    for (const entry of entries) {
      try {
        const result = await anchorIntegrityEntry(entry);
        await pool.execute(
          `UPDATE onboarding_integrity_chain
              SET anchor_status = 'ANCHORED', blockchain_reference = ?,
                  anchor_error = NULL, anchored_at = NOW()
            WHERE chain_id = ?`,
          [result.reference || null, entry.chain_id]
        );
        anchored += 1;
      } catch (error) {
        await pool.execute(
          `UPDATE onboarding_integrity_chain
              SET anchor_status = 'FAILED', anchor_error = ?
            WHERE chain_id = ?`,
          [cleanText(error.message, 500), entry.chain_id]
        );
        failed += 1;
      }
    }
    await writeModuleAudit(pool, req, 'ONBOARDING INTEGRITY ANCHOR RUN', null, { queued: entries.length, anchored, failed });
    res.json({ message: 'Onboarding integrity anchor run completed.', queued: entries.length, anchored, failed });
  } catch (error) {
    res.status(502).json({ error: error.message });
  }
});

router.use(requireRole(HR_ROLES));

function cleanText(value, maxLength = 255) {
  return String(value ?? '').trim().replace(/[\x00<>]/g, '').slice(0, maxLength);
}

function requiredText(value, field, maxLength = 255) {
  const cleaned = cleanText(value, maxLength);
  if (!cleaned) throw new Error(`${field} is required.`);
  return cleaned;
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${field} must be a positive integer.`);
  return number;
}

function optionalPositiveInteger(value, field) {
  if (value == null || value === '') return null;
  return positiveInteger(value, field);
}

function optionalDate(value, field, options = {}) {
  if (value == null || value === '') return null;
  return optionalDateOnly(value, field, options);
}

function validEmail(value) {
  const email = requiredText(value, 'Email', 150).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('A valid email address is required.');
  return email;
}

function optionalEmail(value, field = 'Email') {
  const email = cleanText(value, 150).toLowerCase();
  if (!email) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${field} must be a valid email address.`);
  return email;
}

function optionalChoice(value, field, choices) {
  const cleaned = cleanText(value, 100);
  if (!cleaned) return '';
  if (!choices.includes(cleaned)) throw new Error(`Invalid ${field}.`);
  return cleaned;
}

function optionalPayrollSchedule(value) {
  const cleaned = cleanText(value, 100);
  if (!cleaned) return '';
  const normalized = normalizePayrollScheduleValue(cleaned);
  if (!normalized) throw new Error('Invalid payroll schedule.');
  return normalized;
}

function optionalNonNegativeNumber(value, field) {
  if (value == null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${field} must be a valid non-negative number.`);
  return number;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function anchorIntegrityEntry(entry) {
  const baseUrl = String(process.env.BLOCKCHAIN_API_URL || '').replace(/\/+$/, '');
  const headers = process.env.BLOCKCHAIN_API_TOKEN
    ? { Authorization: `Bearer ${process.env.BLOCKCHAIN_API_TOKEN}` }
    : {};
  const response = await requestJson(`${baseUrl}/api/onboarding/anchors`, {
    method: 'POST',
    headers,
    body: {
      module: 'ONBOARDING',
      chain_id: entry.chain_id,
      applicant_id: entry.applicant_id,
      activity_id: entry.activity_id,
      chain_hash: entry.chain_hash,
      previous_hash: entry.previous_hash,
    },
    clientCertPath: process.env.BLOCKCHAIN_MTLS_CERT_PATH,
    clientKeyPath: process.env.BLOCKCHAIN_MTLS_KEY_PATH,
    caPath: process.env.BLOCKCHAIN_CA_PATH,
  });
  return {
    reference: response.data.transaction_id || response.data.reference || response.data.id || null,
  };
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 45);
}

function hydrateApplicantNames(row) {
  if (!row) return row;
  for (const field of ['first_name', 'middle_name', 'last_name', 'suffix']) {
    row[field] = decryptColumnValue(row[`${field}_encrypted`] || row[field]);
    delete row[`${field}_encrypted`];
  }
  return row;
}

function publicApplicant(row) {
  return {
    applicant_id: row.applicant_id,
    applicant_code: row.applicant_code,
    first_name: row.first_name,
    middle_name: row.middle_name,
    last_name: row.last_name,
    suffix: row.suffix,
    hiring_type: row.hiring_type,
    agency_name: row.agency_name,
    deployment_status: row.deployment_status,
    contract_start_date: row.contract_start_date,
    contract_end_date: row.contract_end_date,
    applied_position: row.applied_position,
    department_id: row.department_id,
    department: row.department,
    branch: row.branch,
    expected_wage_type_id: row.expected_wage_type_id,
    expected_wage_type: row.expected_wage_type,
    expected_base_rate: row.expected_base_rate,
    requires_onboarding: !!row.requires_onboarding,
    requires_training: !!row.requires_training,
    workflow_status: row.workflow_status,
    screening_status: row.screening_status,
    training_status: row.training_status,
    approval_status: row.approval_status,
    biometric_prepared: !!row.biometric_reference_hash,
    biometric_device_id: row.biometric_device_id,
    biometric_device_name: row.biometric_device_name,
    converted_employee_id: row.converted_employee_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    approved_at: row.approved_at,
    transferred_at: row.transferred_at,
    document_count: Number(row.document_count || 0),
  };
}

async function writeModuleAudit(connection, req, action, oldValue = null, newValue = null, targetEmployeeId = null) {
  await connection.execute(
    `INSERT INTO system_audit_log
       (user_id, employee_id, target_employee_id, action_performed, module,
        old_value, new_value, ip_address, user_agent)
     VALUES (?, ?, ?, ?, 'ONBOARDING', ?, ?, ?, ?)`,
    [
      req.user.id,
      req.user.employeeId || null,
      targetEmployeeId,
      action,
      null,
      null,
      clientIp(req),
      cleanText(req.headers['user-agent'], 500),
    ]
  );
}

async function writeSystemAudit(connection, req, applicantId, action, oldValue = null, newValue = null) {
  await writeModuleAudit(connection, req, `${action} [APPLICANT:${applicantId}]`, oldValue, newValue);
}

function normalizeJsonValue(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function hashActivity(activityId, applicantId, action, reason, oldValue, newValue, previousHash) {
  return sha256(JSON.stringify({
    activityId: Number(activityId),
    applicantId: Number(applicantId),
    action,
    reason: reason || null,
    oldValue: normalizeJsonValue(oldValue) || null,
    newValue: normalizeJsonValue(newValue) || null,
    previousHash: previousHash || null,
  }));
}

async function appendIntegrityHash(connection, activityId, applicantId, action, reason, oldValue, newValue) {
  const [[lock]] = await connection.execute("SELECT GET_LOCK('onboarding_integrity_chain', 5) AS acquired");
  if (Number(lock?.acquired) !== 1) throw new Error('Onboarding integrity ledger is busy. Please retry.');
  try {
    const [[previous]] = await connection.execute(
      'SELECT chain_hash FROM onboarding_integrity_chain ORDER BY chain_id DESC LIMIT 1'
    );
    const previousHash = previous?.chain_hash || null;
    const chainHash = hashActivity(activityId, applicantId, action, reason, oldValue, newValue, previousHash);
    await connection.execute(
      `INSERT INTO onboarding_integrity_chain
         (activity_id, applicant_id, previous_hash, chain_hash)
       VALUES (?, ?, ?, ?)`,
      [activityId, applicantId, previousHash, chainHash]
    );
  } finally {
    await connection.execute("SELECT RELEASE_LOCK('onboarding_integrity_chain')");
  }
}

async function writeActivity(connection, req, applicantId, action, reason = null, oldValue = null, newValue = null) {
  const [activity] = await connection.execute(
    `INSERT INTO onboarding_applicant_activity
       (applicant_id, actor_user_id, action, reason, old_value, new_value,
        reason_encrypted, old_value_encrypted, new_value_encrypted)
     VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
    [
      applicantId,
      req.user.id,
      action,
      encryptAuditValue(reason),
      encryptAuditValue(oldValue),
      encryptAuditValue(newValue),
    ]
  );
  await appendIntegrityHash(connection, activity.insertId, applicantId, action, reason, oldValue, newValue);
  await writeSystemAudit(connection, req, applicantId, action, oldValue, newValue);
}

async function getApplicant(connection, applicantId, forUpdate = false) {
  const [rows] = await connection.execute(
    `SELECT oa.*, d.name AS department, wt.name AS expected_wage_type,
            bd.device_name AS biometric_device_name,
            (SELECT COUNT(*) FROM onboarding_applicant_document oad WHERE oad.applicant_id = oa.applicant_id) AS document_count
       FROM onboarding_applicant oa
       LEFT JOIN departments d ON d.id = oa.department_id
       LEFT JOIN wage_types wt ON wt.id = oa.expected_wage_type_id
      LEFT JOIN biometric_device bd ON bd.device_id = oa.biometric_device_id
      WHERE oa.applicant_id = ?
        AND oa.deleted_at IS NULL
      ${forUpdate ? 'FOR UPDATE' : ''}`,
    [applicantId]
  );
  return hydrateApplicantNames(rows[0] || null);
}

async function getPositionRoute(connection, position) {
  const [rows] = await connection.execute(
    `SELECT * FROM onboarding_position_route
      WHERE position_name = ? AND is_active = 1
      LIMIT 1`,
    [position]
  );
  if (rows[0]) return rows[0];

  const normalized = String(position || '').trim().toLowerCase();
  if (ONBOARDING_ROUTE_KEYWORDS.some(keyword => normalized.includes(keyword))) {
    return { requires_onboarding: 1, requires_training: 1, source: 'keyword_default' };
  }
  if (DIRECT_ROUTE_KEYWORDS.some(keyword => normalized.includes(keyword))) {
    return { requires_onboarding: 0, requires_training: 0, source: 'keyword_default' };
  }
  return { requires_onboarding: 1, requires_training: 1, source: 'secure_default' };
}

async function generateApplicantCode(connection) {
  const year = new Date().getFullYear();
  const [rows] = await connection.execute(
    'SELECT COUNT(*) AS total FROM onboarding_applicant WHERE YEAR(created_at) = ?',
    [year]
  );
  return `APP-${year}-${String(Number(rows[0].total || 0) + 1).padStart(4, '0')}`;
}

async function generateEmployeeCode(connection) {
  const year = new Date().getFullYear();
  const [rows] = await connection.execute(
    "SELECT COUNT(*) AS total FROM employees WHERE employee_code LIKE ?",
    [`MIC-${year}-%`]
  );
  return `MIC-${year}-${String(Number(rows[0].total || 0) + 1).padStart(4, '0')}`;
}

function decryptApplicantPii(applicant) {
  return JSON.parse(decryptAES256(applicant.pii_encrypted));
}

function isEncryptedDataAuthFailure(error) {
  return /unable to authenticate data|Unsupported state/i.test(error?.message || '');
}

function encryptedDataAuthErrorResponse(res) {
  return res.status(409).json({
    code: 'ENCRYPTED_DATA_AUTH_FAILED',
    error: 'Encrypted applicant data cannot be authenticated with the current server key.',
    details: 'Use the same AES_ENCRYPTION_KEY that encrypted this applicant record, or use the original JWT_SECRET if the record was encrypted before AES_ENCRYPTION_KEY was configured.',
  });
}

function truthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

function normalizeDesiredEmploymentType(value, hiringType) {
  if (hiringType === 'Agency-Hired') return 'Contractual';
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized.includes('part')) return 'Part-time';
  if (normalized.includes('contract')) return 'Contractual';
  return 'Full-time';
}

function normalizeLifecycleApplicantBody(body) {
  return {
    ...body,
    applied_position: body.applied_position || body.position,
    branch: body.branch || body.work_location || 'Marulas Industrial Corporation',
    hiring_type: body.hiring_type || body.hiring_classification || 'Direct Hire',
    expected_wage_type_id: body.expected_wage_type_id || body.wage_type_id,
    expected_base_rate: body.expected_base_rate ?? body.base_rate,
    civil_status: body.civil_status || body.marital_status,
    emergency_contact_number: body.emergency_contact_number || body.emergency_contact_num,
    emergency_contact_secondary_number: body.emergency_contact_secondary_number || body.emergency_contact_secondary_num,
    desired_employment_type: normalizeDesiredEmploymentType(body.desired_employment_type || body.employment_type, body.hiring_type || body.hiring_classification || 'Direct Hire'),
  };
}

async function createOnboardingApplicantRecord(connection, req, rawBody, options = {}) {
  const body = normalizeLifecycleApplicantBody(rawBody || {});
  const firstName = requiredText(body.first_name, 'First name', 100);
  const middleName = cleanText(body.middle_name, 100) || null;
  const lastName = requiredText(body.last_name, 'Last name', 100);
  const suffix = cleanText(body.suffix, 20) || null;
  const email = validEmail(body.email);
  const contactNumber = requiredText(body.contact_number, 'Contact number', 50);
  const address = requiredText(body.residential_address, 'Residential address', 500);
  const hiringType = cleanText(body.hiring_type, 20);
  const position = requiredText(body.applied_position, 'Applied position', 120);
  const departmentId = optionalPositiveInteger(body.department_id, 'department_id');
  const branch = requiredText(body.branch, 'Branch', 120);
  const wageTypeId = optionalPositiveInteger(body.expected_wage_type_id, 'expected_wage_type_id');
  const baseRate = optionalNonNegativeNumber(body.expected_base_rate, 'Initial payroll rate');
  if (!['Agency-Hired', 'Direct Hire'].includes(hiringType)) throw new Error('Hiring type must be Agency-Hired or Direct Hire.');

  const agencyName = hiringType === 'Agency-Hired' ? requiredText(body.agency_name, 'Agency name', 180) : null;
  const agencyContactPerson = hiringType === 'Agency-Hired' ? requiredText(body.agency_contact_person, 'Agency contact person', 180) : '';
  const agencyContactNumber = hiringType === 'Agency-Hired' ? requiredText(body.agency_contact_number, 'Agency contact number', 80) : '';
  const deploymentStatus = hiringType === 'Agency-Hired' ? cleanText(body.deployment_status, 40) || 'Pending Deployment' : null;
  const contractStart = hiringType === 'Agency-Hired' ? optionalDate(body.contract_start_date, 'Contract start date') : null;
  const contractEnd = hiringType === 'Agency-Hired' ? optionalDate(body.contract_end_date, 'Contract end date') : null;
  if (hiringType === 'Agency-Hired' && !['Pending Deployment', 'Deployed', 'On Hold', 'Ended'].includes(deploymentStatus)) {
    throw new Error('Invalid agency deployment status.');
  }
  if (contractStart && contractEnd && contractEnd < contractStart) throw new Error('Contract end date cannot be earlier than contract start date.');

  const biometricReference = cleanText(body.biometric_reference, 190);
  const biometricDeviceId = biometricReference ? optionalPositiveInteger(body.biometric_device_id, 'biometric_device_id') : null;
  const desiredEmploymentType = normalizeDesiredEmploymentType(body.desired_employment_type, hiringType);
  const pii = {
    contact_number: contactNumber,
    residential_address: address,
    residential_address_region: cleanText(body.residential_address_region, 120),
    residential_address_province: cleanText(body.residential_address_province, 120),
    residential_address_city_municipality: cleanText(body.residential_address_city_municipality, 120),
    residential_address_barangay: cleanText(body.residential_address_barangay, 180),
    residential_address_street_address: cleanText(body.residential_address_street_address, 255),
    residential_address_full_address: cleanText(body.residential_address_full_address, 500),
    residential_address_place_id: cleanText(body.residential_address_place_id, 190),
    residential_address_lat: cleanText(body.residential_address_lat, 40),
    residential_address_lng: cleanText(body.residential_address_lng, 40),
    current_address: cleanText(body.current_address, 500),
    current_address_region: cleanText(body.current_address_region, 120),
    current_address_province: cleanText(body.current_address_province, 120),
    current_address_city_municipality: cleanText(body.current_address_city_municipality, 120),
    current_address_barangay: cleanText(body.current_address_barangay, 180),
    current_address_street_address: cleanText(body.current_address_street_address, 255),
    current_address_full_address: cleanText(body.current_address_full_address, 500),
    current_address_place_id: cleanText(body.current_address_place_id, 190),
    current_address_lat: cleanText(body.current_address_lat, 40),
    current_address_lng: cleanText(body.current_address_lng, 40),
    current_address_same_as_home: Number(body.current_address_same_as_home) === 1 || truthy(body.current_address_same_as_home),
    mailing_address: cleanText(body.mailing_address, 500),
    mailing_address_region: cleanText(body.mailing_address_region, 120),
    mailing_address_province: cleanText(body.mailing_address_province, 120),
    mailing_address_city_municipality: cleanText(body.mailing_address_city_municipality, 120),
    mailing_address_barangay: cleanText(body.mailing_address_barangay, 180),
    mailing_address_street_address: cleanText(body.mailing_address_street_address, 255),
    mailing_address_full_address: cleanText(body.mailing_address_full_address, 500),
    mailing_address_place_id: cleanText(body.mailing_address_place_id, 190),
    mailing_address_lat: cleanText(body.mailing_address_lat, 40),
    mailing_address_lng: cleanText(body.mailing_address_lng, 40),
    mailing_address_same_as_home: Number(body.mailing_address_same_as_home) === 1 || truthy(body.mailing_address_same_as_home),
    work_email: optionalEmail(body.work_email, 'Work email'),
    nationality: cleanText(body.nationality, 50) || 'Filipino',
    date_of_birth: optionalDate(body.date_of_birth, 'Date of birth', { noFuture: true }),
    place_of_birth: cleanText(body.place_of_birth, 180),
    place_of_birth_lat: cleanText(body.place_of_birth_lat, 40),
    place_of_birth_lng: cleanText(body.place_of_birth_lng, 40),
    gender: optionalChoice(body.gender, 'gender', GENDERS),
    civil_status: optionalChoice(body.civil_status, 'civil status', CIVIL_STATUSES),
    blood_type: optionalChoice(body.blood_type, 'blood type', BLOOD_TYPES),
    religion: cleanText(body.religion, 100),
    emergency_contact_name: cleanText(body.emergency_contact_name, 180),
    emergency_contact_relationship: cleanText(body.emergency_contact_relationship, 80),
    emergency_contact_number: cleanText(body.emergency_contact_number, 50),
    emergency_contact_secondary_number: cleanText(body.emergency_contact_secondary_number, 50),
    emergency_contact_email: optionalEmail(body.emergency_contact_email, 'Emergency contact email'),
    emergency_contact_address: cleanText(body.emergency_contact_address, 500),
    education_school: cleanText(body.education_school, 255),
    education_attainment: cleanText(body.education_attainment, 150),
    education_units: cleanText(body.education_units, 150),
    education_year_graduated: cleanText(body.education_year_graduated, 20),
    education_jhs_school: cleanText(body.education_jhs_school, 255),
    education_jhs_attainment: cleanText(body.education_jhs_attainment, 150),
    education_jhs_from: cleanText(body.education_jhs_from, 20),
    education_jhs_to: cleanText(body.education_jhs_to, 20),
    education_jhs_year_graduated: cleanText(body.education_jhs_year_graduated, 20),
    education_shs_school: cleanText(body.education_shs_school, 255),
    education_shs_attainment: cleanText(body.education_shs_attainment, 150),
    education_shs_from: cleanText(body.education_shs_from, 20),
    education_shs_to: cleanText(body.education_shs_to, 20),
    education_shs_year_graduated: cleanText(body.education_shs_year_graduated, 20),
    education_vocational_school: cleanText(body.education_vocational_school, 255),
    education_vocational_attainment: cleanText(body.education_vocational_attainment, 150),
    education_vocational_units: cleanText(body.education_vocational_units, 150),
    education_vocational_from: cleanText(body.education_vocational_from, 20),
    education_vocational_to: cleanText(body.education_vocational_to, 20),
    education_vocational_year_graduated: cleanText(body.education_vocational_year_graduated, 20),
    education_college_school: cleanText(body.education_college_school, 255),
    education_college_attainment: cleanText(body.education_college_attainment, 150),
    education_college_units: cleanText(body.education_college_units, 150),
    education_college_from: cleanText(body.education_college_from, 20),
    education_college_to: cleanText(body.education_college_to, 20),
    education_college_year_graduated: cleanText(body.education_college_year_graduated, 20),
    desired_employment_type: desiredEmploymentType,
    supervisor: cleanText(body.supervisor, 180),
    shift_schedule: optionalChoice(body.shift_schedule, 'shift schedule', SHIFT_SCHEDULES),
    employee_level: optionalChoice(body.employee_level, 'employee level', EMPLOYEE_LEVELS),
    payroll_schedule: optionalPayrollSchedule(body.payroll_schedule),
    allowances: optionalNonNegativeNumber(body.allowances, 'Allowances'),
    employment_history: cleanText(body.employment_history, 1000),
    salary_grade: cleanText(body.salary_grade, 100),
    sss_number: cleanText(body.sss_number, 30),
    philhealth_number: cleanText(body.philhealth_number, 30),
    pagibig_number: cleanText(body.pagibig_number, 30),
    tin: cleanText(body.tin, 30),
    tax_status: cleanText(body.tax_status, 100),
    bank_name: cleanText(body.bank_name, 120),
    bank_account: cleanText(body.bank_account, 80),
    agency_contact_person: agencyContactPerson,
    agency_contact_number: agencyContactNumber,
  };

  const route = await getPositionRoute(connection, position);
  const manualOnboardingRequired = truthy(body.requires_onboarding) || truthy(body.force_onboarding);
  const applicantCode = await generateApplicantCode(connection);
  const intendedEmployeeCode = cleanText(options.intendedEmployeeCode || body.intended_employee_code || body.employee_code, 20) || null;
  const sourceModule = cleanText(options.sourceModule || body.source_module || 'ONBOARDING', 60) || 'ONBOARDING';
  const requiresOnboarding = manualOnboardingRequired || Number(route.requires_onboarding) ? 1 : 0;
  const requiresTraining = requiresOnboarding && (truthy(body.requires_training) || (!manualOnboardingRequired && Number(route.requires_training))) ? 1 : 0;
  const requestedInitialStatus = cleanText(body.initial_workflow_status || body.workflow_status, 40);
  const allowedInitialStatuses = new Set(['Under Screening', 'For Approval', 'On Hold']);
  const workflowStatus = allowedInitialStatuses.has(requestedInitialStatus)
    ? requestedInitialStatus
    : requiresOnboarding ? 'Under Screening' : 'For Approval';
  const screeningStatus = requiresOnboarding ? 'Pending Screening' : 'Not Required';
  const trainingStatus = requiresTraining ? 'Not Yet Started' : 'Not Required';
  const lifecycleNote = cleanText(body.lifecycle_note, 500);

  const [result] = await connection.execute(
    `INSERT INTO onboarding_applicant
       (applicant_code, intended_employee_code, source_module, first_name, middle_name, last_name, suffix,
        first_name_encrypted, middle_name_encrypted, last_name_encrypted, suffix_encrypted, email_hash,
        email_encrypted, pii_encrypted, hiring_type, agency_name, deployment_status,
        contract_start_date, contract_end_date, applied_position, department_id, branch,
        expected_wage_type_id, expected_base_rate, requires_onboarding, requires_training,
        workflow_status, screening_status, training_status, biometric_device_id,
        biometric_reference_hash, biometric_reference_encrypted, created_by, updated_by)
     VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      applicantCode, intendedEmployeeCode, sourceModule,
      encryptColumnValue(firstName), encryptColumnValue(middleName), encryptColumnValue(lastName), encryptColumnValue(suffix),
      sha256(email), encryptAES256(email),
      encryptAES256(JSON.stringify(pii)), hiringType, agencyName, deploymentStatus,
      contractStart, contractEnd, position, departmentId, branch, wageTypeId, baseRate,
      requiresOnboarding, requiresTraining, workflowStatus, screeningStatus, trainingStatus,
      biometricDeviceId, biometricReference ? sha256(biometricReference) : null,
      biometricReference ? encryptAES256(biometricReference) : null, req.user.id, req.user.id,
    ]
  );
  await writeActivity(connection, req, result.insertId, 'APPLICANT_CREATED', null, null, {
    applicant_code: applicantCode,
    intended_employee_code: intendedEmployeeCode,
    source_module: sourceModule,
    hiring_type: hiringType,
    applied_position: position,
    workflow_status: workflowStatus,
    route_source: route.source || 'position_route',
    lifecycle_action: cleanText(body.lifecycle_action, 40),
    lifecycle_note: lifecycleNote || null,
  });

  return {
    message: sourceModule === 'EMPLOYEE_MANAGEMENT'
      ? 'Employee Management record routed to onboarding.'
      : 'Applicant onboarding record created.',
    applicant_id: result.insertId,
    applicant_code: applicantCode,
    intended_employee_code: intendedEmployeeCode,
    workflow_status: workflowStatus,
    screening_status: screeningStatus,
    training_status: trainingStatus,
    requires_onboarding: requiresOnboarding,
    requires_training: requiresTraining,
  };
}

router.get('/lookups', async (_req, res) => {
  try {
    const [departments] = await pool.execute('SELECT id, name FROM departments ORDER BY name');
    const [wageTypes] = await pool.execute('SELECT id, name FROM wage_types ORDER BY id');
    const [devices] = await pool.execute('SELECT device_id, device_name FROM biometric_device WHERE is_active = 1 ORDER BY device_name');
    res.json({
      departments,
      wage_types: wageTypes,
      biometric_devices: devices,
      document_types: DOCUMENT_TYPES,
      genders: GENDERS,
      civil_statuses: CIVIL_STATUSES,
      blood_types: BLOOD_TYPES,
      employment_types: EMPLOYMENT_TYPES,
      shift_schedules: SHIFT_SCHEDULES,
      employee_levels: EMPLOYEE_LEVELS,
      payroll_schedules: PAYROLL_SCHEDULES,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load onboarding lookups.' });
  }
});

router.get('/dashboard', async (_req, res) => {
  try {
    const [[stats]] = await pool.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(workflow_status NOT IN ('Transferred','Rejected')) AS active,
        SUM(hiring_type = 'Agency-Hired') AS agency_hired,
        SUM(hiring_type = 'Direct Hire') AS direct_hire,
        SUM(screening_status IN ('Pending Screening','For Interview','For Requirements Checking')) AS screening,
        SUM(training_status IN ('Not Yet Started','In Training','For Final Evaluation')) AS training,
        SUM(approval_status = 'Approved' AND workflow_status <> 'Transferred') AS ready_for_transfer,
        SUM(workflow_status = 'Transferred') AS transferred
      FROM onboarding_applicant
      WHERE deleted_at IS NULL
    `);
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load onboarding dashboard.' });
  }
});

router.get('/positions', async (_req, res) => {
  try {
    const [rows] = await pool.execute(`
      SELECT opr.*, d.name AS department
        FROM onboarding_position_route opr
        LEFT JOIN departments d ON d.id = opr.department_id
       WHERE opr.is_active = 1
       ORDER BY opr.position_name
    `);
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load position routing rules.' });
  }
});

router.post('/positions', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const positionName = requiredText(req.body.position_name, 'Position name', 120);
    const departmentId = optionalPositiveInteger(req.body.department_id, 'department_id');
    const requiresOnboarding = req.body.requires_onboarding === false || req.body.requires_onboarding === 0 ? 0 : 1;
    const requiresTraining = requiresOnboarding && !(req.body.requires_training === false || req.body.requires_training === 0) ? 1 : 0;
    await connection.beginTransaction();
    const [existing] = await connection.execute(
      'SELECT * FROM onboarding_position_route WHERE position_name = ? LIMIT 1',
      [positionName]
    );
    await connection.execute(
      `INSERT INTO onboarding_position_route
         (position_name, department_id, requires_onboarding, requires_training, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         department_id = VALUES(department_id),
         requires_onboarding = VALUES(requires_onboarding),
         requires_training = VALUES(requires_training),
         is_active = 1,
         updated_by = VALUES(updated_by)`,
      [positionName, departmentId, requiresOnboarding, requiresTraining, req.user.id, req.user.id]
    );
    await writeModuleAudit(connection, req, `POSITION_ROUTE_SAVED [POSITION:${positionName}]`, existing[0] || null, {
      position_name: positionName,
      department_id: departmentId,
      requires_onboarding: requiresOnboarding,
      requires_training: requiresTraining,
    });
    await connection.commit();
    res.json({ message: 'Position routing rule saved.' });
  } catch (error) {
    await connection.rollback();
    res.status(400).json({ error: error.message });
  } finally {
    connection.release();
  }
});

router.put('/positions/:positionRouteId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const positionRouteId = positiveInteger(req.params.positionRouteId, 'positionRouteId');
    const positionName = requiredText(req.body.position_name, 'Position name', 120);
    const departmentId = optionalPositiveInteger(req.body.department_id, 'department_id');
    const requiresOnboarding = req.body.requires_onboarding === false || req.body.requires_onboarding === 0 ? 0 : 1;
    const requiresTraining = requiresOnboarding && !(req.body.requires_training === false || req.body.requires_training === 0) ? 1 : 0;

    await connection.beginTransaction();
    const [existingRows] = await connection.execute(
      'SELECT * FROM onboarding_position_route WHERE position_route_id = ? FOR UPDATE',
      [positionRouteId]
    );
    const existing = existingRows[0];
    if (!existing) {
      await connection.rollback();
      return res.status(404).json({ error: 'Position routing rule not found.' });
    }

    const [duplicateRows] = await connection.execute(
      'SELECT position_route_id FROM onboarding_position_route WHERE position_name = ? AND position_route_id <> ? LIMIT 1',
      [positionName, positionRouteId]
    );
    if (duplicateRows.length) {
      await connection.rollback();
      return res.status(409).json({ error: 'A routing rule already exists for that position.' });
    }

    await connection.execute(
      `UPDATE onboarding_position_route
          SET position_name = ?, department_id = ?, requires_onboarding = ?,
              requires_training = ?, is_active = 1, updated_by = ?
        WHERE position_route_id = ?`,
      [positionName, departmentId, requiresOnboarding, requiresTraining, req.user.id, positionRouteId]
    );
    await writeModuleAudit(connection, req, `POSITION_ROUTE_UPDATED [ROUTE:${positionRouteId}]`, existing, {
      position_name: positionName,
      department_id: departmentId,
      requires_onboarding: requiresOnboarding,
      requires_training: requiresTraining,
      is_active: 1,
    });
    await connection.commit();
    return res.json({ message: 'Position routing rule updated.' });
  } catch (error) {
    await connection.rollback();
    return res.status(400).json({ error: error.message });
  } finally {
    connection.release();
  }
});

// Soft-delete preserves historical routing decisions and the audit trail while
// keeping the route out of all future onboarding decisions and dropdowns.
router.delete('/positions/:positionRouteId', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const positionRouteId = positiveInteger(req.params.positionRouteId, 'positionRouteId');
    await connection.beginTransaction();
    const [existingRows] = await connection.execute(
      'SELECT * FROM onboarding_position_route WHERE position_route_id = ? FOR UPDATE',
      [positionRouteId]
    );
    const existing = existingRows[0];
    if (!existing) {
      await connection.rollback();
      return res.status(404).json({ error: 'Position routing rule not found.' });
    }

    await connection.execute(
      'UPDATE onboarding_position_route SET is_active = 0, updated_by = ? WHERE position_route_id = ?',
      [req.user.id, positionRouteId]
    );
    await writeModuleAudit(connection, req, `POSITION_ROUTE_DEACTIVATED [ROUTE:${positionRouteId}]`, existing, {
      ...existing,
      is_active: 0,
    });
    await connection.commit();
    return res.json({ message: 'Position routing rule deleted.' });
  } catch (error) {
    await connection.rollback();
    return res.status(400).json({ error: error.message });
  } finally {
    connection.release();
  }
});

router.get('/applicants', async (req, res) => {
  try {
    const search = cleanText(req.query.search, 80);
    const values = [];
    const conditions = ['oa.deleted_at IS NULL'];
    if (req.query.workflow_status) {
      conditions.push('oa.workflow_status = ?');
      values.push(cleanText(req.query.workflow_status, 40));
    }
    const [rows] = await pool.execute(
      `SELECT oa.*, d.name AS department, wt.name AS expected_wage_type,
              bd.device_name AS biometric_device_name,
              (SELECT COUNT(*) FROM onboarding_applicant_document oad WHERE oad.applicant_id = oa.applicant_id) AS document_count
         FROM onboarding_applicant oa
         LEFT JOIN departments d ON d.id = oa.department_id
         LEFT JOIN wage_types wt ON wt.id = oa.expected_wage_type_id
         LEFT JOIN biometric_device bd ON bd.device_id = oa.biometric_device_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY oa.updated_at DESC, oa.applicant_id DESC
        LIMIT 500`,
      values
    );
    let applicants = rows.map(hydrateApplicantNames);
    if (search) {
      const needle = search.toLowerCase();
      applicants = applicants.filter(row => [
        row.applicant_code,
        row.first_name,
        row.middle_name,
        row.last_name,
        row.applied_position,
      ].some(value => String(value || '').toLowerCase().includes(needle)));
    }
    res.json(applicants.map(publicApplicant));
  } catch (error) {
    res.status(500).json({ error: 'Failed to load onboarding applicants.' });
  }
});

router.get('/applicants/:applicantId', async (req, res) => {
  try {
    const applicantId = positiveInteger(req.params.applicantId, 'applicantId');
    const applicant = await getApplicant(pool, applicantId);
    if (!applicant) return res.status(404).json({ error: 'Applicant not found.' });
    return res.json({
      ...publicApplicant(applicant),
      sensitive_details_available: !!(applicant.email_encrypted || applicant.pii_encrypted),
      sensitive_fields_masked: true,
    });
    /* istanbul ignore next -- legacy payload retained below only for migration rollback compatibility */
    const pii = decryptApplicantPii(applicant);
    res.json({
      ...publicApplicant(applicant),
      email: decryptAES256(applicant.email_encrypted),
      contact_number: pii.contact_number || '',
      residential_address: pii.residential_address || '',
      residential_address_region: pii.residential_address_region || '',
      residential_address_province: pii.residential_address_province || '',
      residential_address_city_municipality: pii.residential_address_city_municipality || '',
      residential_address_barangay: pii.residential_address_barangay || '',
      residential_address_street_address: pii.residential_address_street_address || '',
      residential_address_full_address: pii.residential_address_full_address || '',
      residential_address_place_id: pii.residential_address_place_id || '',
      residential_address_lat: pii.residential_address_lat || '',
      residential_address_lng: pii.residential_address_lng || '',
      current_address: pii.current_address || '',
      current_address_region: pii.current_address_region || '',
      current_address_province: pii.current_address_province || '',
      current_address_city_municipality: pii.current_address_city_municipality || '',
      current_address_barangay: pii.current_address_barangay || '',
      current_address_street_address: pii.current_address_street_address || '',
      current_address_full_address: pii.current_address_full_address || '',
      current_address_place_id: pii.current_address_place_id || '',
      current_address_lat: pii.current_address_lat || '',
      current_address_lng: pii.current_address_lng || '',
      current_address_same_as_home: !!pii.current_address_same_as_home,
      mailing_address: pii.mailing_address || '',
      mailing_address_region: pii.mailing_address_region || '',
      mailing_address_province: pii.mailing_address_province || '',
      mailing_address_city_municipality: pii.mailing_address_city_municipality || '',
      mailing_address_barangay: pii.mailing_address_barangay || '',
      mailing_address_street_address: pii.mailing_address_street_address || '',
      mailing_address_full_address: pii.mailing_address_full_address || '',
      mailing_address_place_id: pii.mailing_address_place_id || '',
      mailing_address_lat: pii.mailing_address_lat || '',
      mailing_address_lng: pii.mailing_address_lng || '',
      mailing_address_same_as_home: !!pii.mailing_address_same_as_home,
      work_email: pii.work_email || '',
      nationality: pii.nationality || '',
      date_of_birth: pii.date_of_birth || '',
      place_of_birth: pii.place_of_birth || '',
      gender: pii.gender || '',
      civil_status: pii.civil_status || '',
      blood_type: pii.blood_type || '',
      religion: pii.religion || '',
      emergency_contact_name: pii.emergency_contact_name || '',
      emergency_contact_relationship: pii.emergency_contact_relationship || '',
      emergency_contact_number: pii.emergency_contact_number || '',
      emergency_contact_secondary_number: pii.emergency_contact_secondary_number || '',
      emergency_contact_email: pii.emergency_contact_email || '',
      emergency_contact_address: pii.emergency_contact_address || '',
      desired_employment_type: pii.desired_employment_type || '',
      supervisor: pii.supervisor || '',
      shift_schedule: pii.shift_schedule || '',
      employee_level: pii.employee_level || '',
      payroll_schedule: normalizePayrollScheduleValue(pii.payroll_schedule) || pii.payroll_schedule || '',
      allowances: pii.allowances ?? null,
      sss_number: pii.sss_number || '',
      philhealth_number: pii.philhealth_number || '',
      pagibig_number: pii.pagibig_number || '',
      tin: pii.tin || '',
      bank_name: pii.bank_name || '',
      bank_account: pii.bank_account || '',
      agency_contact_person: pii.agency_contact_person || '',
      agency_contact_number: pii.agency_contact_number || '',
      biometric_reference: applicant.biometric_reference_encrypted ? decryptAES256(applicant.biometric_reference_encrypted) : '',
    });
  } catch (error) {
    if (isEncryptedDataAuthFailure(error)) {
      return encryptedDataAuthErrorResponse(res);
    }
    res.status(400).json({ error: error.message });
  }
});

router.post('/applicants/:applicantId/reveal-sensitive', async (req, res) => {
  try {
    const applicantId = positiveInteger(req.params.applicantId, 'applicantId');
    const applicant = await getApplicant(pool, applicantId);
    if (!applicant) return res.status(404).json({ error: 'Applicant not found.' });
    const pii = decryptApplicantPii(applicant);
    await writeModuleAudit(pool, req, `APPLICANT_SENSITIVE_DETAILS_REVEALED [APPLICANT:${applicantId}]`);
    return res.json({
      email: decryptAES256(applicant.email_encrypted),
      ...pii,
      biometric_reference: applicant.biometric_reference_encrypted
        ? decryptAES256(applicant.biometric_reference_encrypted)
        : '',
    });
  } catch (error) {
    if (isEncryptedDataAuthFailure(error)) return encryptedDataAuthErrorResponse(res);
    return res.status(400).json({ error: error.message || 'Failed to reveal applicant details.' });
  }
});

router.delete('/applicants/:applicantId', async (req, res) => {
  const connection = await pool.getConnection();
  let documentPaths = [];
  try {
    const applicantId = positiveInteger(req.params.applicantId, 'applicantId');
    const confirmation = cleanText(req.body.confirmation, 20).toLowerCase();
    if (confirmation !== 'delete') {
      throw new Error('Type delete to remove this applicant.');
    }
    const deletionReason = 'Deletion confirmed by HR user.';
    await connection.beginTransaction();
    const applicant = await getApplicant(connection, applicantId, true);
    if (!applicant) {
      await connection.rollback();
      return res.status(404).json({ error: 'Applicant not found or already removed from onboarding.' });
    }
    if (applicant.converted_employee_id || applicant.workflow_status === 'Transferred') {
      throw new Error('Transferred hires cannot be deleted from onboarding. Manage the official employee record instead.');
    }
    const [documents] = await connection.execute(
      'SELECT encrypted_file_path FROM onboarding_applicant_document WHERE applicant_id = ?',
      [applicantId]
    );
    documentPaths = documents.map(document => document.encrypted_file_path);
    await writeActivity(connection, req, applicantId, 'APPLICANT_ARCHIVED', deletionReason, {
      workflow_status: applicant.workflow_status,
      document_count: Number(applicant.document_count || 0),
    }, {
      removed_from_active_onboarding: true,
    });
    await connection.execute(
      `UPDATE onboarding_applicant
          SET deleted_at = NOW(), deleted_by = ?, deletion_reason = ?, updated_by = ?
        WHERE applicant_id = ?`,
      [req.user.id, deletionReason, req.user.id, applicantId]
    );
    await connection.execute(
      'DELETE FROM onboarding_applicant_document WHERE applicant_id = ?',
      [applicantId]
    );
    await connection.commit();

    const cleanup = await Promise.allSettled(documentPaths.map(filePath => fs.promises.unlink(filePath)));
    const cleanupPending = cleanup.filter(result => result.status === 'rejected' && result.reason?.code !== 'ENOENT').length;
    if (cleanupPending) console.warn(`Onboarding vault cleanup pending for applicant ${applicantId}: ${cleanupPending} file(s).`);
    res.json({
      message: 'Applicant removed from active onboarding with an audit trail.',
      vault_files_removed: documentPaths.length - cleanupPending,
      vault_cleanup_pending: cleanupPending,
    });
  } catch (error) {
    await connection.rollback();
    res.status(400).json({ error: error.message });
  } finally {
    connection.release();
  }
});

router.post('/applicants', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await createOnboardingApplicantRecord(connection, req, req.body);
    await connection.commit();
    res.status(201).json(result);
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Applicant code already exists. Please retry.' });
    res.status(400).json({ error: error.message });
  } finally {
    connection.release();
  }
});

router.patch('/applicants/:applicantId/progress', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const applicantId = positiveInteger(req.params.applicantId, 'applicantId');
    const reason = cleanText(req.body.reason, 500) || null;
    await connection.beginTransaction();
    const applicant = await getApplicant(connection, applicantId, true);
    if (!applicant) {
      await connection.rollback();
      return res.status(404).json({ error: 'Applicant not found.' });
    }
    if (['Approved', 'Rejected', 'Transferred'].includes(applicant.workflow_status)) {
      throw new Error('Completed applicants cannot be moved back into screening or training.');
    }

    const screeningStatus = req.body.screening_status ? cleanText(req.body.screening_status, 60) : applicant.screening_status;
    const trainingStatus = req.body.training_status ? cleanText(req.body.training_status, 60) : applicant.training_status;
    if (!SCREENING_STATUSES.includes(screeningStatus)) throw new Error('Invalid screening status.');
    if (!TRAINING_STATUSES.includes(trainingStatus)) throw new Error('Invalid training status.');
    if (!applicant.requires_onboarding && screeningStatus !== 'Not Required') throw new Error('Screening is not required for this position.');
    if (!applicant.requires_training && trainingStatus !== 'Not Required') throw new Error('Training is not required for this position.');
    if (applicant.requires_training && screeningStatus !== 'Passed Screening' && trainingStatus !== 'Not Yet Started') {
      throw new Error('Training cannot start until screening is passed.');
    }

    const workflowStatus = screeningStatus === 'Failed Screening' || trainingStatus === 'Failed Training'
      ? 'For Re-evaluation'
      : trainingStatus === 'In Training' || trainingStatus === 'For Final Evaluation'
        ? 'Training'
        : applicant.requires_training && trainingStatus !== 'Completed Training'
          ? 'Under Screening'
          : 'For Approval';
    const oldValue = { workflow_status: applicant.workflow_status, screening_status: applicant.screening_status, training_status: applicant.training_status };
    const newValue = { workflow_status: workflowStatus, screening_status: screeningStatus, training_status: trainingStatus };
    await connection.execute(
      `UPDATE onboarding_applicant
          SET workflow_status = ?, screening_status = ?, training_status = ?, updated_by = ?
        WHERE applicant_id = ?`,
      [workflowStatus, screeningStatus, trainingStatus, req.user.id, applicantId]
    );
    await writeActivity(connection, req, applicantId, 'PROGRESS_UPDATED', reason, oldValue, newValue);
    await connection.commit();
    res.json({ message: 'Screening and training progress updated.', ...newValue });
  } catch (error) {
    await connection.rollback();
    res.status(400).json({ error: error.message });
  } finally {
    connection.release();
  }
});

function nullable(value) {
  return value === undefined || value === null || value === '' ? null : value;
}

async function createInitialEmployeePasswordHash() {
  const temporaryPassword = process.env.DEFAULT_EMPLOYEE_TEMP_PASSWORD
    || crypto.randomBytes(32).toString('base64url');
  return argon2.hash(temporaryPassword, ARGON2ID_OPTIONS);
}

async function transferApprovedApplicant(connection, req, applicant, reason, employeeCodeOverride = '') {
  if (applicant.approval_status !== 'Approved' || applicant.workflow_status !== 'Approved') {
    throw new Error('Only approved applicants can be transferred.');
  }
  if (applicant.converted_employee_id) throw new Error('Applicant has already been transferred.');

  const employeeCode = cleanText(employeeCodeOverride, 20)
    || cleanText(applicant.intended_employee_code, 20)
    || await generateEmployeeCode(connection);
  const email = decryptAES256(applicant.email_encrypted);
  const pii = decryptApplicantPii(applicant);
  const employeePii = encryptPII({
    ...pii,
    hiring_type: applicant.hiring_type || 'Direct Hire',
    agency_name: applicant.agency_name || '',
    deployment_status: applicant.deployment_status || '',
    contract_start_date: applicant.contract_start_date || '',
    contract_end_date: applicant.contract_end_date || '',
  });
  const employmentType = applicant.hiring_type === 'Agency-Hired'
    ? 'Contractual'
    : EMPLOYMENT_TYPES.includes(pii.desired_employment_type) ? pii.desired_employment_type : 'Full-time';
  const initialPasswordHash = await createInitialEmployeePasswordHash();

  const [employee] = await connection.execute(
    `INSERT INTO employees
       (employee_code, first_name, middle_name, last_name, suffix, email, contact_number,
        work_email, mailing_address, nationality, marital_status, date_of_birth, place_of_birth,
        gender, blood_type, religion, residential_address, current_address,
        emergency_contact_name, emergency_contact_num, emergency_contact_relationship,
        emergency_contact_secondary_num, emergency_contact_email, emergency_contact_address,
        education_school, education_attainment, education_units, education_year_graduated,
        education_jhs_school, education_jhs_attainment, education_jhs_from, education_jhs_to, education_jhs_year_graduated,
        education_shs_school, education_shs_attainment, education_shs_from, education_shs_to, education_shs_year_graduated,
        education_vocational_school, education_vocational_attainment, education_vocational_units, education_vocational_from, education_vocational_to, education_vocational_year_graduated,
        education_college_school, education_college_attainment, education_college_units, education_college_from, education_college_to, education_college_year_graduated,
        department_id, position, employment_type, date_hired, end_of_contract, supervisor,
        work_location, shift_schedule, employee_level, employment_history, status,
        Password_Hash, Password_Changed_At,
        salary_grade, allowances, payroll_schedule, sss_number, philhealth_number,
        pagibig_number, tin, tax_status, bank_name, bank_account,
        residential_address_lat, residential_address_lng, current_address_lat, current_address_lng,
        current_address_same_as_home, mailing_address_lat, mailing_address_lng, mailing_address_same_as_home,
        wage_type_id, encrypted_pii, hiring_type, agency_name, agency_contact_person,
        agency_contact_number, deployment_status, contract_start_date, contract_end_date, lifecycle_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURDATE(), ?, ?, ?, ?, ?, ?, 'Active', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active')`,
    [
      employeeCode, employeePiiDb(applicant.first_name), employeePiiDb(applicant.middle_name), employeePiiDb(applicant.last_name), employeePiiDb(applicant.suffix), employeePiiDb(email), employeePiiDb(pii.contact_number),
      employeePiiDb(pii.work_email), employeePiiDb(pii.mailing_address), employeePiiDb(nullable(pii.nationality) || 'Filipino'), employeePiiDb(pii.civil_status), employeePiiDb(pii.date_of_birth), employeePiiDb(pii.place_of_birth),
      employeePiiDb(pii.gender), employeePiiDb(pii.blood_type), employeePiiDb(pii.religion), employeePiiDb(pii.residential_address), employeePiiDb(pii.current_address),
      employeePiiDb(pii.emergency_contact_name), employeePiiDb(pii.emergency_contact_number), employeePiiDb(pii.emergency_contact_relationship),
      employeePiiDb(pii.emergency_contact_secondary_number), employeePiiDb(pii.emergency_contact_email), employeePiiDb(pii.emergency_contact_address),
      employeePiiDb(pii.education_school), employeePiiDb(pii.education_attainment), employeePiiDb(pii.education_units), employeePiiDb(pii.education_year_graduated),
      employeePiiDb(pii.education_jhs_school), employeePiiDb(pii.education_jhs_attainment), employeePiiDb(pii.education_jhs_from), employeePiiDb(pii.education_jhs_to), employeePiiDb(pii.education_jhs_year_graduated),
      employeePiiDb(pii.education_shs_school), employeePiiDb(pii.education_shs_attainment), employeePiiDb(pii.education_shs_from), employeePiiDb(pii.education_shs_to), employeePiiDb(pii.education_shs_year_graduated),
      employeePiiDb(pii.education_vocational_school), employeePiiDb(pii.education_vocational_attainment), employeePiiDb(pii.education_vocational_units), employeePiiDb(pii.education_vocational_from), employeePiiDb(pii.education_vocational_to), employeePiiDb(pii.education_vocational_year_graduated),
      employeePiiDb(pii.education_college_school), employeePiiDb(pii.education_college_attainment), employeePiiDb(pii.education_college_units), employeePiiDb(pii.education_college_from), employeePiiDb(pii.education_college_to), employeePiiDb(pii.education_college_year_graduated),
      applicant.department_id, applicant.applied_position, employmentType, applicant.contract_end_date || null, nullable(pii.supervisor),
      applicant.branch, nullable(pii.shift_schedule), nullable(pii.employee_level), nullable(pii.employment_history),
      initialPasswordHash,
      nullable(pii.salary_grade), pii.allowances == null ? null : pii.allowances, normalizePayrollScheduleValue(pii.payroll_schedule), employeePiiDb(pii.sss_number), employeePiiDb(pii.philhealth_number),
      employeePiiDb(pii.pagibig_number), employeePiiDb(pii.tin), employeePiiDb(pii.tax_status), employeePiiDb(pii.bank_name), employeePiiDb(pii.bank_account),
      nullable(pii.residential_address_lat), nullable(pii.residential_address_lng), nullable(pii.current_address_lat), nullable(pii.current_address_lng),
      pii.current_address_same_as_home ? 1 : 0, nullable(pii.mailing_address_lat), nullable(pii.mailing_address_lng), pii.mailing_address_same_as_home ? 1 : 0,
      applicant.expected_wage_type_id, employeePii, applicant.hiring_type || 'Direct Hire', applicant.agency_name || null, employeePiiDb(pii.agency_contact_person),
      employeePiiDb(pii.agency_contact_number), applicant.deployment_status || null, applicant.contract_start_date || null, applicant.contract_end_date || null,
    ]
  );
  const employeeId = employee.insertId;

  await connection.execute(
    `UPDATE employees
        SET residential_address_region = ?, residential_address_province = ?,
            residential_address_city_municipality = ?, residential_address_barangay = ?,
            residential_address_street_address = ?, residential_address_full_address = ?,
            residential_address_place_id = ?,
            current_address_region = ?, current_address_province = ?,
            current_address_city_municipality = ?, current_address_barangay = ?,
            current_address_street_address = ?, current_address_full_address = ?,
            current_address_place_id = ?,
            mailing_address_region = ?, mailing_address_province = ?,
            mailing_address_city_municipality = ?, mailing_address_barangay = ?,
            mailing_address_street_address = ?, mailing_address_full_address = ?,
            mailing_address_place_id = ?
      WHERE id = ?`,
    [
      nullable(pii.residential_address_region), nullable(pii.residential_address_province),
      nullable(pii.residential_address_city_municipality), nullable(pii.residential_address_barangay),
      nullable(pii.residential_address_street_address), nullable(pii.residential_address_full_address),
      nullable(pii.residential_address_place_id),
      nullable(pii.current_address_region), nullable(pii.current_address_province),
      nullable(pii.current_address_city_municipality), nullable(pii.current_address_barangay),
      nullable(pii.current_address_street_address), nullable(pii.current_address_full_address),
      nullable(pii.current_address_place_id),
      nullable(pii.mailing_address_region), nullable(pii.mailing_address_province),
      nullable(pii.mailing_address_city_municipality), nullable(pii.mailing_address_barangay),
      nullable(pii.mailing_address_street_address), nullable(pii.mailing_address_full_address),
      nullable(pii.mailing_address_place_id),
      employeeId,
    ]
  );

  if (applicant.expected_wage_type_id && applicant.expected_base_rate != null) {
    await connection.execute(
      `INSERT INTO employee_wage_rates
         (employee_id, wage_type_id, rate, effective_date)
       VALUES (?, ?, ?, CURDATE())`,
      [employeeId, applicant.expected_wage_type_id, applicant.expected_base_rate]
    );
  }

  if (applicant.biometric_device_id && applicant.biometric_reference_hash && applicant.biometric_reference_encrypted) {
    await connection.execute(
      `INSERT INTO biometric_employee_mapping
         (device_id, employee_id, biometric_user_hash, biometric_user_id_encrypted,
          is_active, created_by, updated_by)
       VALUES (?, ?, ?, ?, 1, ?, ?)
       ON DUPLICATE KEY UPDATE
         employee_id = VALUES(employee_id),
         biometric_user_id_encrypted = VALUES(biometric_user_id_encrypted),
         is_active = 1,
         updated_by = VALUES(updated_by)`,
      [
        applicant.biometric_device_id, employeeId, applicant.biometric_reference_hash,
        applicant.biometric_reference_encrypted, req.user.id, req.user.id,
      ]
    );
  }

  await connection.execute(
    `UPDATE onboarding_applicant_document
        SET transferred_employee_id = ?
      WHERE applicant_id = ?`,
    [employeeId, applicant.applicant_id]
  );
  await connection.execute(
    `UPDATE onboarding_applicant
        SET workflow_status = 'Transferred', converted_employee_id = ?,
            transferred_by = ?, transferred_at = NOW(), updated_by = ?
      WHERE applicant_id = ?`,
    [employeeId, req.user.id, req.user.id, applicant.applicant_id]
  );
  await writeActivity(connection, req, applicant.applicant_id, 'TRANSFERRED_TO_EMPLOYEE_DIRECTORY', reason, null, {
    employee_id: employeeId,
    employee_code: employeeCode,
    source_module: applicant.source_module || 'ONBOARDING',
  });
  return { employee_id: employeeId, employee_code: employeeCode };
}

router.patch('/applicants/:applicantId/decision', requireRole(HR_FINAL_APPROVAL_ROLES), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const applicantId = positiveInteger(req.params.applicantId, 'applicantId');
    const reason = cleanText(req.body.reason, 500) || null;
    const decision = cleanText(req.body.approval_status, 40);
    if (!DECISIONS.includes(decision)) throw new Error('Invalid approval decision.');
    await connection.beginTransaction();
    const applicant = await getApplicant(connection, applicantId, true);
    if (!applicant) {
      await connection.rollback();
      return res.status(404).json({ error: 'Applicant not found.' });
    }
    if (applicant.workflow_status === 'Transferred') throw new Error('Transferred applicants cannot be changed.');
    if (decision === 'Approved') {
      if (applicant.requires_onboarding && applicant.screening_status !== 'Passed Screening') throw new Error('Applicant must pass screening before approval.');
      if (applicant.requires_training && applicant.training_status !== 'Completed Training') throw new Error('Applicant must complete training before approval.');
    }
    const workflowStatus = decision;
    const oldValue = { workflow_status: applicant.workflow_status, approval_status: applicant.approval_status };
    const newValue = { workflow_status: workflowStatus, approval_status: decision };
    await connection.execute(
      `UPDATE onboarding_applicant
          SET workflow_status = ?, approval_status = ?, approved_by = ?,
              approved_at = NOW(), updated_by = ?
        WHERE applicant_id = ?`,
      [workflowStatus, decision, req.user.id, req.user.id, applicantId]
    );
    await writeActivity(connection, req, applicantId, `DECISION_${decision.toUpperCase().replace(/ /g, '_')}`, reason, oldValue, newValue);
    let transferResult = null;
    if (decision === 'Approved') {
      transferResult = await transferApprovedApplicant(connection, req, {
        ...applicant,
        workflow_status: 'Approved',
        approval_status: 'Approved',
      }, reason, req.body.employee_code);
    }
    await connection.commit();
    res.json({
      message: transferResult
        ? `Applicant approved and transferred to Employee Directory as ${transferResult.employee_code}.`
        : `Applicant marked ${decision}.`,
      ...newValue,
      ...(transferResult ? { workflow_status: 'Transferred', routed_to: 'Employee Directory', ...transferResult } : {}),
    });
  } catch (error) {
    await connection.rollback();
    res.status(400).json({ error: error.message });
  } finally {
    connection.release();
  }
});

router.post('/applicants/:applicantId/transfer', requireRole(HR_FINAL_APPROVAL_ROLES), async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const applicantId = positiveInteger(req.params.applicantId, 'applicantId');
    const reason = cleanText(req.body.reason, 500) || null;
    await connection.beginTransaction();
    const applicant = await getApplicant(connection, applicantId, true);
    if (!applicant) {
      await connection.rollback();
      return res.status(404).json({ error: 'Applicant not found.' });
    }
    const transferResult = await transferApprovedApplicant(connection, req, applicant, reason, req.body.employee_code);
    await connection.commit();
    res.status(201).json({ message: 'Approved applicant transferred to Employee Directory.', ...transferResult });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Employee code or email already exists in the Employee Directory.' });
    res.status(400).json({ error: error.message });
  } finally {
    connection.release();
  }
});

router.get('/applicants/:applicantId/documents', async (req, res) => {
  try {
    const applicantId = positiveInteger(req.params.applicantId, 'applicantId');
    const [rows] = await pool.execute(
      `SELECT document_id, applicant_id, transferred_employee_id, document_type,
              original_file_name, mime_type, file_size_bytes, verification_status,
              rejection_reason, uploaded_at, verified_at
         FROM onboarding_applicant_document
        WHERE applicant_id = ?
        ORDER BY uploaded_at DESC`,
      [applicantId]
    );
    res.json(rows);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/applicants/:applicantId/documents', (req, res, next) => {
  upload.single('file')(req, res, error => {
    if (!error) return next();
    res.status(400).json({ error: error.message || 'Document upload failed.' });
  });
}, async (req, res) => {
  const connection = await pool.getConnection();
  let filePath;
  try {
    const applicantId = positiveInteger(req.params.applicantId, 'applicantId');
    if (!req.file) return res.status(400).json({ error: 'A document file is required.' });
    const documentType = cleanText(req.body.document_type, 80);
    if (!DOCUMENT_TYPES.includes(documentType)) return res.status(400).json({ error: 'Invalid document type.' });
    const applicant = await getApplicant(connection, applicantId);
    if (!applicant) return res.status(404).json({ error: 'Applicant not found.' });

    const fileName = `${Date.now()}-${crypto.randomBytes(10).toString('hex')}.enc`;
    filePath = path.join(vaultDirectory, fileName);
    await fs.promises.writeFile(filePath, encryptAES256(req.file.buffer.toString('base64')), 'utf8');
    await connection.beginTransaction();
    const [result] = await connection.execute(
      `INSERT INTO onboarding_applicant_document
         (applicant_id, document_type, original_file_name, encrypted_file_path,
          mime_type, file_size_bytes, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [applicantId, documentType, cleanText(req.file.originalname, 255), filePath, req.file.mimetype, req.file.size, req.user.id]
    );
    await writeActivity(connection, req, applicantId, 'DOCUMENT_UPLOADED', null, null, { document_id: result.insertId, document_type: documentType });
    await connection.commit();
    res.status(201).json({ message: 'Document encrypted and stored in the onboarding vault.', document_id: result.insertId });
  } catch (error) {
    await connection.rollback();
    if (filePath) await fs.promises.unlink(filePath).catch(() => {});
    res.status(400).json({ error: error.message });
  } finally {
    connection.release();
  }
});

router.get('/applicants/:applicantId/documents/:documentId/download', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const applicantId = positiveInteger(req.params.applicantId, 'applicantId');
    const documentId = positiveInteger(req.params.documentId, 'documentId');
    const [rows] = await connection.execute(
      `SELECT * FROM onboarding_applicant_document
        WHERE document_id = ? AND applicant_id = ?`,
      [documentId, applicantId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Document not found.' });
    const document = rows[0];
    const encrypted = await fs.promises.readFile(document.encrypted_file_path, 'utf8');
    const buffer = Buffer.from(decryptAES256(encrypted), 'base64');
    await connection.beginTransaction();
    await writeActivity(connection, req, applicantId, 'DOCUMENT_DOWNLOADED', null, null, { document_id: documentId });
    await connection.commit();
    res.setHeader('Content-Type', document.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${document.original_file_name.replace(/["\r\n]/g, '')}"`);
    res.send(buffer);
  } catch (error) {
    await connection.rollback();
    res.status(400).json({ error: error.message });
  } finally {
    connection.release();
  }
});

router.patch('/applicants/:applicantId/documents/:documentId/verify', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const applicantId = positiveInteger(req.params.applicantId, 'applicantId');
    const documentId = positiveInteger(req.params.documentId, 'documentId');
    const status = cleanText(req.body.verification_status, 20);
    const reason = cleanText(req.body.reason, 500) || null;
    if (!['Verified', 'Rejected'].includes(status)) return res.status(400).json({ error: 'Document status must be Verified or Rejected.' });
    await connection.beginTransaction();
    const [result] = await connection.execute(
      `UPDATE onboarding_applicant_document
          SET verification_status = ?, rejection_reason = ?, verified_by = ?, verified_at = NOW()
        WHERE document_id = ? AND applicant_id = ?`,
      [status, reason, req.user.id, documentId, applicantId]
    );
    if (!result.affectedRows) {
      await connection.rollback();
      return res.status(404).json({ error: 'Document not found.' });
    }
    await writeActivity(connection, req, applicantId, `DOCUMENT_${status.toUpperCase()}`, reason, null, { document_id: documentId });
    await connection.commit();
    res.json({ message: `Document marked ${status}.` });
  } catch (error) {
    await connection.rollback();
    res.status(400).json({ error: error.message });
  } finally {
    connection.release();
  }
});

router.get('/applicants/:applicantId/integrity', async (req, res) => {
  try {
    const applicantId = positiveInteger(req.params.applicantId, 'applicantId');
    const [rows] = await pool.execute(
      `SELECT oic.*, oaa.action, oaa.reason_encrypted, oaa.old_value_encrypted, oaa.new_value_encrypted
         FROM onboarding_integrity_chain oic
         JOIN onboarding_applicant_activity oaa ON oaa.activity_id = oic.activity_id
        ORDER BY oic.chain_id`
    );
    let chainValid = true;
    let previousHash = null;
    for (const row of rows) {
      const expectedHash = hashActivity(
        row.activity_id,
        row.applicant_id,
        row.action,
        decryptAuditValue(row.reason_encrypted),
        decryptAuditValue(row.old_value_encrypted),
        decryptAuditValue(row.new_value_encrypted),
        previousHash
      );
      if (row.previous_hash !== previousHash || row.chain_hash !== expectedHash) chainValid = false;
      previousHash = row.chain_hash;
    }
    const records = rows
      .filter(row => Number(row.applicant_id) === applicantId)
      .map(row => ({
        chain_id: row.chain_id,
        activity_id: row.activity_id,
        chain_hash: row.chain_hash,
        anchor_status: row.anchor_status,
        blockchain_reference: row.blockchain_reference,
        created_at: row.created_at,
      }));
    res.json({
      chain_valid: chainValid,
      records,
      pending_anchor_count: records.filter(row => row.anchor_status === 'PENDING').length,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.get('/applicants/:applicantId/audit', async (req, res) => {
  try {
    const applicantId = positiveInteger(req.params.applicantId, 'applicantId');
    const [rows] = await pool.execute(
      `SELECT oaa.*, u.username AS actor, oic.chain_hash, oic.anchor_status
         FROM onboarding_applicant_activity oaa
         JOIN users u ON u.id = oaa.actor_user_id
         LEFT JOIN onboarding_integrity_chain oic ON oic.activity_id = oaa.activity_id
        WHERE oaa.applicant_id = ?
        ORDER BY oaa.created_at DESC, oaa.activity_id DESC`,
      [applicantId]
    );
    res.json(rows.map(row => ({
      activity_id: row.activity_id,
      applicant_id: row.applicant_id,
      action: row.action,
      actor: row.actor,
      chain_hash: row.chain_hash,
      anchor_status: row.anchor_status,
      created_at: row.created_at,
      reason_available: !!(row.reason_encrypted || row.reason),
      change_details_available: !!(row.old_value_encrypted || row.new_value_encrypted || row.old_value || row.new_value),
    })));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.createOnboardingApplicantRecord = createOnboardingApplicantRecord;
router.getPositionRoute = getPositionRoute;

module.exports = router;
