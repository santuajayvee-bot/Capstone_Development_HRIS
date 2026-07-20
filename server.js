/* ============================================================
   server.js — LGSV_HR System — Express + JWT + MySQL
   ============================================================ */

require('dotenv').config();
const express    = require('express');
const https      = require('https');
const os         = require('os');
const path       = require('path');
const multer     = require('multer');
const fs         = require('fs');
const http       = require('http');
const nodeCrypto = require('crypto');

const { me }                                 = require('./server/auth');
const { hasPermission, requireAuth, requireRole, ROLES } = require('./server/middleware');
const authRoutes                             = require('./routes/authRoutes');
const accountRoutes                          = require('./routes/accountRoutes');
const payrollRoutes                          = require('./server/payroll');
const fileManagementRoutes                   = require('./server/201-file-management');
const attendanceRoutes                       = require('./server/attendance');
const biometricRoutes                        = require('./server/biometric');
const holidayRoutes                          = require('./server/holidays');
const blockchainPayrollRoutes                = require('./server/routes/blockchain-payroll');
const blockchainDtrRoutes                    = require('./server/routes/blockchain-dtr');
const onboardingRoutes                       = require('./server/onboarding');
const adminRbacRoutes                        = require('./server/admin-rbac');
const backupRecoveryRoutes                   = require('./server/backup-recovery');
const accountCreationRequestRoutes           = require('./server/account-creation-requests');
const employeeDashboardRoutes                = require('./server/employee-dashboard');
const performanceManagementRoutes            = require('./server/performance-management');
const { encryptPII }                         = require('./server/crypto');
const { decryptColumnValue, decryptPII, encryptColumnValue, encryptPII: encryptPiiJson, hashNullable, isEncryptedValue } = require('./server/data-protection');
const dashboardRoutes                        = require('./server/dashboard');
const reportsRoutes                          = require('./server/reports');
const selfServiceRoutes                      = require('./server/self-service');
const dpaRoutes                              = require('./server/dpa').router;
const trustedDeviceRoutes                   = require('./server/trusted-devices');
const { clientErrorResponse }                = require('./server/error-response');
const { validateRequestBody }                = require('./validators/inputValidation');
const { hashTemporaryPassword, verifyPassword } = require('./services/passwordService');
const { attachSocketDeviceDetection }        = require('./services/socketDeviceDetectionService');
const { encryptedCommunicationMiddleware }   = require('./server/middleware/encryptedCommunication');
const { encryptAuditValue, maskSensitiveValue, preventStorageCiphertextResponses } = require('./server/privacy-protection');
const { deleteEncryptedFile, readEncryptedBuffer, storeEncryptedBuffer, VAULT_ROOT } = require('./server/encrypted-file-vault');
const {
  inclusiveDays,
  strictDateOnly,
  yearFromDateOnly,
}                                             = require('./server/utils/dateValidation');
const {
  PAYROLL_SCHEDULE_LABELS,
  normalizePayrollScheduleValue,
}                                             = require('./server/utils/payrollSchedule');
const {
  auditSecurityEvent,
  auditSuspiciousRequestPatterns,
  createRateLimiter,
  multerFileFilter,
  randomSafeFilename,
  rejectForbiddenFields,
  requireSameOriginForBrowserWrites,
  secureUploadedFile,
  validateUploadedBuffer,
}                                             = require('./server/security-controls');
const { createAttendanceRouteRateLimiter }    = require('./server/attendance-rate-limits');
const { createPayrollRouteRateLimiter }       = require('./server/payroll-rate-limits');
const { createHealthHandlers }                 = require('./server/health-endpoints');

const app  = express();
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Requested-With,X-Session-Binding');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
});

function rateLimitPrincipal(req) {
  const authHeader = String(req.headers?.authorization || '').trim();
  if (authHeader) {
    return `auth:${nodeCrypto.createHash('sha256').update(authHeader).digest('hex').slice(0, 24)}`;
  }
  return `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
}

const API_READ_RATE_LIMIT = createRateLimiter({
  windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.API_READ_RATE_LIMIT_MAX || process.env.API_RATE_LIMIT_MAX || 1200),
  keyGenerator: req => `read:${rateLimitPrincipal(req)}`,
  auditAction: 'blocked_api_read_rate_limit_exceeded',
});
const API_WRITE_RATE_LIMIT = createRateLimiter({
  windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.API_WRITE_RATE_LIMIT_MAX || process.env.API_RATE_LIMIT_MAX || 300),
  keyGenerator: req => `write:${rateLimitPrincipal(req)}`,
  auditAction: 'blocked_api_write_rate_limit_exceeded',
});
const AUTH_RATE_LIMIT = createRateLimiter({
  windowMs: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS || 15 * 60_000),
  max: Number(process.env.AUTH_RATE_LIMIT_MAX || 20),
  keyGenerator: req => `${req.ip || req.socket?.remoteAddress || 'unknown'}:${String(req.body?.username || req.body?.email || '').toLowerCase()}`,
  auditAction: 'blocked_auth_rate_limit_exceeded',
});
const DEVICE_APPROVAL_POLL_RATE_LIMIT = createRateLimiter({
  windowMs: Number(process.env.DEVICE_APPROVAL_POLL_RATE_LIMIT_WINDOW_MS || 15 * 60_000),
  max: Number(process.env.DEVICE_APPROVAL_POLL_RATE_LIMIT_MAX || 360),
  keyGenerator: req => [
    req.ip || req.socket?.remoteAddress || 'unknown',
    String(req.body?.username || req.body?.email || '').toLowerCase(),
    String(req.body?.approvalRequestId || 'unknown'),
  ].join(':'),
  auditAction: 'blocked_device_approval_poll_rate_limit_exceeded',
});
const ATTENDANCE_ROUTE_RATE_LIMIT = createAttendanceRouteRateLimiter();
const PERFORMANCE_ROUTE_RATE_LIMIT = createRateLimiter({
  windowMs: Number(process.env.PERFORMANCE_RATE_LIMIT_WINDOW_MS || 60_000),
  max: Number(process.env.PERFORMANCE_RATE_LIMIT_MAX || 120),
  keyGenerator: req => `performance:${rateLimitPrincipal(req)}`,
  auditAction: 'blocked_performance_rate_limit_exceeded',
  module: 'PERFORMANCE_SECURITY',
});
const PAYROLL_ROUTE_RATE_LIMIT = createPayrollRouteRateLimiter();
function apiRateLimit(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return API_READ_RATE_LIMIT(req, res, next);
  }
  return API_WRITE_RATE_LIMIT(req, res, next);
}
const EMPLOYEE_ID_ADMIN_ROLES = ROLES.staff_management;
const EMPLOYEE_PARAMETER_TAMPER_GUARD = rejectForbiddenFields(new Set([
  'role',
  'role_id',
  'access_level',
  'is_admin',
  'admin',
  'admin_flag',
  'is_super_admin',
  'user_type',
  'permissions',
  'account_status',
  'employee_status',
  'token_version',
  'password',
  'password_hash',
  'mfa_secret',
  'refresh_token',
  'salary',
  'hourly_rate',
  'daily_rate',
  'gross_pay',
  'net_pay',
  'total_deductions',
  'payroll_status',
]), {
  action: 'blocked_employee_parameter_tampering_attempt',
  module: 'EMPLOYEE_SECURITY',
  targetTable: 'employees',
});
const ADDRESS_DATASET_PATH = path.join(__dirname, 'data', 'philippine_provinces_cities_municipalities_and_barangays.json');
const ADDRESS_DATASET_UNAVAILABLE = 'Philippine address dataset unavailable. Please contact the administrator.';
const EMPLOYEE_TEXT_PATTERN = /^[A-Za-zÀ-ÖØ-öø-ÿÑñ\s'.-]+$/;
const EMPLOYEE_ADDRESS_PATTERN = /^[A-Za-z0-9À-ÖØ-öø-ÿÑñ\s,.'#()&+:/-]+$/;
const EMPLOYEE_SAFE_TEXT_PATTERN = /^[A-Za-z0-9À-ÖØ-öø-ÿÑñ\s,.'#()&+:/-]+$/;
const EMPLOYEE_FORBIDDEN_PATTERN = /(<|>|<\/|script|javascript:|onerror\s*=|onload\s*=|\b(select|insert|update|delete|drop|alter|union|exec|truncate)\b|--|;)/i;
const EMPLOYEE_ENUMS = {
  gender: new Set(['Male', 'Female', 'Prefer not to say']),
  nationality: new Set(['Filipino', 'American', 'Other']),
  marital_status: new Set(['Single', 'Married', 'Separated', 'Widowed']),
  blood_type: new Set(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown']),
  employment_type: new Set(['Full-time', 'Part-time', 'Contractual', 'Regular']),
  hiring_type: new Set(['Direct Hire', 'Agency-Hired']),
  deployment_status: new Set(['Pending Deployment', 'Deployed', 'On Hold', 'Ended']),
  employee_level: new Set(['Rank and File', 'Supervisor', 'Manager', 'Executive']),
  status: new Set(['Active', 'Inactive', 'Resigned', 'Terminated', 'End of Contract', 'Suspended', 'Retired', 'Offboarded', 'Rehired']),
  payroll_schedule: new Set(PAYROLL_SCHEDULE_LABELS),
  tax_status: new Set(['Single', 'Married', 'Head of Family', 'Exempt']),
};
const EMPLOYEE_PAYROLL_PROTECTED_FIELDS = new Set([
  'wage_type', 'wage_type_id', 'base_rate', 'wage_effective_date', 'sewingRates', 'allowances', 'allowance',
  'payroll_schedule', 'salary_grade', 'sss_number', 'philhealth_number',
  'pagibig_number', 'tin', 'tax_status', 'bank_name', 'bank_account'
]);
const EMPLOYEE_WAGE_CONFIG_FIELDS = new Set(['wage_type', 'wage_type_id', 'base_rate', 'wage_effective_date', 'sewingRates']);
const EMPLOYEE_GOVERNMENT_ID_FIELDS = new Set(['sss_number', 'philhealth_number', 'pagibig_number', 'tin']);
const EMPLOYEE_PAYROLL_ONLY_FIELDS = new Set(['allowances', 'allowance', 'payroll_schedule', 'salary_grade', 'tax_status', 'bank_name', 'bank_account']);
const EMPLOYEE_BANK_ACCOUNT_FORMATS = [
  { label: 'BPI', aliases: ['bpi', 'bank of the philippine islands'], lengths: [10] },
  { label: 'BDO Unibank', aliases: ['bdo', 'bdo unibank'], lengths: [12] },
  { label: 'Metrobank', aliases: ['metrobank', 'metropolitan bank and trust company'], lengths: [13] },
  { label: 'Security Bank', aliases: ['security bank'], lengths: [13] },
  { label: 'PNB', aliases: ['pnb', 'philippine national bank'], lengths: [12] },
  { label: 'LandBank', aliases: ['landbank', 'land bank', 'land bank of the philippines'], lengths: [10, 16] },
  { label: 'RCBC', aliases: ['rcbc', 'rizal commercial banking corporation'], lengths: [10, 16] },
];
const EMPLOYEE_HR_PROTECTED_FIELDS = new Set([
  'department_id', 'position', 'employment_type', 'hiring_type', 'deployment_status',
  'date_hired', 'end_of_contract', 'employee_level', 'status', 'employment_status', 'supervisor',
  'work_location', 'shift_schedule', 'agency_name', 'agency_contact_person',
  'agency_contact_number', 'contract_start_date', 'contract_end_date',
  'separation_date', 'separation_reason', 'offboarding_remarks'
]);
const EMPLOYEE_UPDATE_ALLOWED_FIELDS = new Set([
  'employee_id_mode', 'employee_code',
  'first_name', 'middle_name', 'last_name', 'suffix',
  'email', 'contact_number', 'work_email',
  'nationality', 'marital_status', 'date_of_birth', 'place_of_birth', 'gender', 'blood_type', 'religion',
  'residential_address', 'current_address', 'mailing_address',
  'residential_address_lat', 'residential_address_lng', 'current_address_lat', 'current_address_lng', 'mailing_address_lat', 'mailing_address_lng',
  'current_address_same_as_home', 'mailing_address_same_as_home',
  'residential_address_region', 'residential_address_province', 'residential_address_city_municipality', 'residential_address_barangay',
  'residential_address_street_address', 'residential_address_full_address', 'residential_address_place_id',
  'current_address_region', 'current_address_province', 'current_address_city_municipality', 'current_address_barangay',
  'current_address_street_address', 'current_address_full_address', 'current_address_place_id',
  'mailing_address_region', 'mailing_address_province', 'mailing_address_city_municipality', 'mailing_address_barangay',
  'mailing_address_street_address', 'mailing_address_full_address', 'mailing_address_place_id',
  'emergency_contact_name', 'emergency_contact_num', 'emergency_contact_number',
  'emergency_contact_relationship', 'emergency_contact_secondary_num', 'emergency_contact_email', 'emergency_contact_address',
  'education_school', 'education_attainment', 'education_units', 'education_year_graduated',
  'education_jhs_school', 'education_jhs_attainment', 'education_jhs_from', 'education_jhs_to', 'education_jhs_year_graduated',
  'education_shs_school', 'education_shs_attainment', 'education_shs_from', 'education_shs_to', 'education_shs_year_graduated',
  'education_vocational_school', 'education_vocational_attainment', 'education_vocational_units',
  'education_vocational_from', 'education_vocational_to', 'education_vocational_year_graduated',
  'education_college_school', 'education_college_attainment', 'education_college_units',
  'education_college_from', 'education_college_to', 'education_college_year_graduated',
  'department_id', 'position', 'employment_type', 'hiring_type',
  'agency_name', 'agency_contact_person', 'agency_contact_number', 'deployment_status',
  'contract_start_date', 'contract_end_date', 'date_hired', 'end_of_contract',
  'supervisor', 'work_location', 'shift_schedule', 'employee_level', 'employment_history',
  'status', 'employment_status', 'separation_date', 'separation_reason', 'offboarding_remarks',
  'lifecycle_action', 'lifecycle_note', 'requires_onboarding', 'requires_training',
  'wage_type', 'wage_type_id', 'base_rate', 'wage_effective_date', 'sewingRates',
  'salary_grade', 'allowances', 'allowance', 'payroll_schedule',
  'sss_number', 'philhealth_number', 'pagibig_number', 'tin', 'tax_status', 'bank_name', 'bank_account'
]);
const EMPLOYEE_CREATE_ALLOWED_FIELDS = new Set(EMPLOYEE_UPDATE_ALLOWED_FIELDS);
const EMPLOYEE_UPDATE_DEFAULT_FIELDS = [...EMPLOYEE_UPDATE_ALLOWED_FIELDS].filter(field => ![
  'employee_id_mode',
  'lifecycle_action',
  'lifecycle_note',
  'requires_onboarding',
  'requires_training',
  'sewingRates',
  'allowance',
].includes(field));
const FAMILY_PII_FIELDS = [
  'relationship_type', 'extension_name', 'first_name', 'middle_name', 'last_name',
  'date_of_birth', 'telephone_number', 'business_address', 'occupation', 'employer_name', 'deceased'
];
const WORK_EXPERIENCE_PII_FIELDS = [
  'company_name', 'position_title', 'employment_type', 'date_from', 'date_to',
  'supervisor_name', 'company_address', 'reason_for_leaving'
];
const CERTIFICATION_PII_FIELDS = [
  'certification_name', 'issuing_organization', 'issue_date', 'expiry_date'
];
const TRAINING_PII_FIELDS = [
  'training_name', 'provider', 'date_from', 'date_to', 'training_hours', 'remarks'
];
const EMPLOYEE_FAMILY_ALLOWED_FIELDS = new Set(FAMILY_PII_FIELDS);
const EMPLOYEE_WORK_EXPERIENCE_ALLOWED_FIELDS = new Set(WORK_EXPERIENCE_PII_FIELDS);
const EMPLOYEE_CERTIFICATION_ALLOWED_FIELDS = new Set(CERTIFICATION_PII_FIELDS);
const EMPLOYEE_TRAINING_ALLOWED_FIELDS = new Set(TRAINING_PII_FIELDS);
const EMPLOYEE_SKILL_ALLOWED_FIELDS = new Set(['skill_name', 'proficiency', 'remarks']);
const EMPLOYEE_DOCUMENT_ALLOWED_FIELDS = new Set(['docType', 'document_type']);
const EMPLOYEE_STATUS_ALLOWED_FIELDS = new Set(['status', 'employment_status', 'separation_date', 'separation_reason', 'offboarding_remarks']);
const EMPLOYEE_OFFBOARD_ALLOWED_FIELDS = new Set([
  'offboarding_type', 'effective_date', 'last_working_day', 'reason', 'clearance_status', 'final_pay_status', 'account_action', 'remarks',
  'clearance_items',
  'company_property_status', 'turnover_status', 'exit_interview_status', 'attendance_leave_clearance',
  'payroll_clearance_status', 'payroll_checked_by', 'final_pay_approved_by', 'final_pay_release_date',
  'it_access_status', 'permissions_revoked', 'sessions_invalidated', 'biometric_access_removed', 'it_processed_by', 'it_processed_at',
  'offboarding_status', 'processed_by', 'completed_by', 'completed_at'
]);
const EMPLOYEE_REONBOARD_ALLOWED_FIELDS = new Set(['rehire_date', 'new_position', 'department_id', 'department', 'work_location', 'employment_type', 'hiring_type', 'new_supervisor', 'employee_level', 'payroll_setup_status', 'assigned_system_role', 'force_password_reset', 'remarks']);
const FORM_DRAFT_ALLOWED_FIELDS = new Set(['module_name', 'form_name', 'record_id', 'status', 'expiry_days', 'draft_data']);
const FORM_DRAFT_STATUS_ALLOWED_FIELDS = new Set(['module_name', 'form_name', 'record_id', 'status']);
const EMPLOYEE_ID_CONFIG_ALLOWED_FIELDS = new Set(['prefix', 'starting_number', 'number_padding', 'current_sequence', 'auto_generate_enabled']);
const DEPARTMENT_SETUP_ALLOWED_FIELDS = new Set(['name']);
const POSITION_SETUP_ALLOWED_FIELDS = new Set(['department_id', 'name']);
const LEAVE_TYPE_ALLOWED_FIELDS = new Set([
  'id', 'name', 'code', 'category', 'description', 'max_allowed_days', 'is_paid',
  'is_active', 'requires_attachment', 'allow_unpaid_extension', 'max_extension_days',
  'female_only', 'male_only', 'married_only', 'solo_parent_required',
  'medical_certificate_required', 'legal_document_required', 'minimum_service_months',
]);
const LEAVE_BALANCE_ALLOWED_FIELDS = new Set(['employee_id', 'leave_type_id', 'leave_type', 'year', 'total_days', 'balance', 'used_days', 'used']);
const LEAVE_REQUEST_ALLOWED_FIELDS = new Set(['type', 'leave_type_id', 'date_from', 'date_to', 'days', 'reason', 'employee_id', 'filing_source', 'remarks']);
const LEAVE_STATUS_ALLOWED_FIELDS = new Set(['status', 'remarks', 'review_note', 'reason']);
const LEAVE_STEP_UP_ALLOWED_FIELDS = new Set(['currentPassword', 'current_password', 'password_confirmation']);
const GENERAL_REQUEST_ALLOWED_FIELDS = new Set(['type', 'request_type', 'purpose', 'details', 'reason', 'remarks']);
const GENERAL_REQUEST_STATUS_ALLOWED_FIELDS = new Set(['status', 'remarks']);
const PAYROLL_RUN_ALLOWED_FIELDS = new Set(['period_start', 'period_end']);
const PAYROLL_RUN_APPROVE_ALLOWED_FIELDS = new Set(['remarks']);
const EMPLOYEE_STRICT_PII_COLUMNS = [
  'first_name', 'middle_name', 'last_name', 'suffix',
  'email', 'contact_number', 'work_email', 'mailing_address',
  'nationality', 'marital_status', 'date_of_birth', 'place_of_birth', 'gender', 'blood_type', 'religion',
  'residential_address', 'current_address',
  'residential_address_region', 'residential_address_province', 'residential_address_city_municipality',
  'residential_address_barangay', 'residential_address_street_address', 'residential_address_full_address', 'residential_address_place_id',
  'current_address_region', 'current_address_province', 'current_address_city_municipality',
  'current_address_barangay', 'current_address_street_address', 'current_address_full_address', 'current_address_place_id',
  'mailing_address_region', 'mailing_address_province', 'mailing_address_city_municipality',
  'mailing_address_barangay', 'mailing_address_street_address', 'mailing_address_full_address', 'mailing_address_place_id',
  'emergency_contact_name', 'emergency_contact_num', 'emergency_contact_relationship',
  'emergency_contact_secondary_num', 'emergency_contact_email', 'emergency_contact_address',
  'education_school', 'education_attainment', 'education_units', 'education_year_graduated',
  'education_jhs_school', 'education_jhs_attainment', 'education_jhs_from', 'education_jhs_to', 'education_jhs_year_graduated',
  'education_shs_school', 'education_shs_attainment', 'education_shs_from', 'education_shs_to', 'education_shs_year_graduated',
  'education_vocational_school', 'education_vocational_attainment', 'education_vocational_units',
  'education_vocational_from', 'education_vocational_to', 'education_vocational_year_graduated',
  'education_college_school', 'education_college_attainment', 'education_college_units',
  'education_college_from', 'education_college_to', 'education_college_year_graduated',
  'sss_number', 'philhealth_number', 'pagibig_number', 'tin', 'tax_status', 'bank_name', 'bank_account',
  'agency_contact_person', 'agency_contact_number', 'separation_reason', 'offboarding_remarks'
];
const EMPLOYEE_STATUS_OPTIONS = ['Active', 'Inactive', 'Resigned', 'Terminated', 'End of Contract', 'Suspended', 'Retired', 'Offboarded', 'Rehired'];
const NON_ACTIVE_EMPLOYEE_STATUSES = new Set(EMPLOYEE_STATUS_OPTIONS.filter(status => status !== 'Active'));
const ACCOUNT_DEACTIVATION_STATUSES = new Set(['Inactive', 'Resigned', 'Terminated', 'End of Contract', 'Retired', 'Offboarded']);
const EMPLOYEE_REONBOARDABLE_STATUSES = new Set(['Resigned', 'Terminated', 'End of Contract', 'Retired', 'Offboarded']);
const EMPLOYEE_OFFBOARDING_TYPES = new Map([
  ['Resignation', 'Resigned'],
  ['Termination', 'Terminated'],
  ['End of Contract', 'End of Contract'],
  ['Retirement', 'Retired'],
  ['AWOL', 'Offboarded'],
  ['Redundancy', 'Offboarded'],
]);
const EMPLOYEE_CLEARANCE_STATUSES = new Set(['Pending', 'Cleared', 'Not Cleared']);
const EMPLOYEE_COMPANY_PROPERTY_STATUSES = new Set(['Pending', 'Partially Returned', 'Completed', 'Not Applicable']);
const EMPLOYEE_TURNOVER_STATUSES = new Set(['Pending', 'Completed', 'Not Required']);
const EMPLOYEE_EXIT_INTERVIEW_STATUSES = new Set(['Pending', 'Completed', 'Not Required']);
const EMPLOYEE_ATTENDANCE_LEAVE_CLEARANCES = new Set(['Pending', 'Checked', 'With Issue']);
const EMPLOYEE_PAYROLL_CLEARANCE_STATUSES = new Set(['Pending', 'Checked', 'Cleared', 'With Issue']);
const EMPLOYEE_FINAL_PAY_STATUSES = new Set(['Pending', 'For Processing', 'For Approval', 'Approved', 'Processed', 'Released', 'With Issue']);
const EMPLOYEE_IT_ACCESS_STATUSES = new Set(['Pending', 'Disabled', 'Revoked']);
const EMPLOYEE_OFFBOARDING_PROCESS_STATUSES = new Set([
  'Pending', 'In Progress', 'For Offboarding', 'Clearance Pending', 'Payroll Review',
  'Final Approval', 'Approved', 'Completed', 'Offboarded', 'Inactive', 'Cancelled'
]);
const EMPLOYEE_OFFBOARDING_FINAL_STATUSES = new Set(['Offboarded', 'Inactive', 'Completed']);
const EMPLOYEE_OFFBOARDING_CLEARANCE_ITEM_STATUSES = new Set(['Pending', 'Cleared', 'Not Applicable']);
const EMPLOYEE_OFFBOARDING_CHECKLIST_ITEMS = [
  ['company_id_returned', 'Company ID returned'],
  ['uniform_ppe_returned', 'Uniform/PPE returned'],
  ['tools_equipment_returned', 'Tools/equipment returned'],
  ['documents_submitted', 'Documents submitted'],
  ['pending_attendance_checked', 'Pending attendance checked'],
  ['pending_payroll_final_pay_checked', 'Pending payroll/final pay checked'],
  ['account_access_reviewed', 'Account access reviewed'],
  ['final_hr_approval', 'Final HR approval'],
];
const EMPLOYEE_OFFBOARDING_CHECKLIST_KEYS = new Set(EMPLOYEE_OFFBOARDING_CHECKLIST_ITEMS.map(([key]) => key));
const EMPLOYEE_OFFBOARDING_DOCUMENT_TYPES = new Map([
  ['Separation_Notice', 'Separation notice / resignation letter'],
  ['Offboarding_Clearance', 'Clearance / accountability form'],
  ['Property_Return', 'Company property return proof'],
  ['Attendance_Timesheet', 'Final attendance / timesheet support'],
  ['Final_Pay_Computation', 'Final pay computation support'],
  ['Exit_Interview', 'Exit interview form'],
  ['Final_Pay_Acknowledgement', 'Final pay acknowledgement / quitclaim if used'],
  ['Other', 'Other supporting document'],
]);
const EMPLOYEE_OFFBOARDING_DOCUMENT_TYPE_VALUES = [...EMPLOYEE_OFFBOARDING_DOCUMENT_TYPES.keys()];
const EMPLOYEE_DOCUMENT_TYPE_ENUM_VALUES = [
  'Resume',
  'Government_ID',
  'NBI_Clearance',
  'Contract',
  'Other',
  ...EMPLOYEE_OFFBOARDING_DOCUMENT_TYPE_VALUES.filter(value => value !== 'Other'),
];
const EMPLOYEE_OFFBOARDING_DOCUMENT_ALLOWED_FIELDS = new Set(['docType', 'document_type']);
const EMPLOYEE_ACCOUNT_ACTIONS = new Set(['Disable Immediately', 'Disable on Effective Date']);
const EMPLOYEE_PAYROLL_SETUP_STATUSES = new Set(['Pending', 'Ready']);
const EMPLOYEE_LIFECYCLE_PENDING_STATUSES = new Set(['Pending']);
let philippineAddressCache = null;
let philippineAddressError = null;

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

function normalizeLookupKey(value) {
  return String(value || '').trim().toUpperCase();
}

function loadPhilippineAddressDataset() {
  try {
    const raw = fs.readFileSync(ADDRESS_DATASET_PATH, 'utf8');
    const data = JSON.parse(raw);
    const regions = Object.entries(data).map(([code, region]) => ({
      code,
      name: region.region_name,
      provinceList: region.province_list || {}
    })).filter(region => region.name);

    philippineAddressCache = {
      regions: regions.sort((a, b) => a.name.localeCompare(b.name)),
      regionByName: new Map(regions.map(region => [normalizeLookupKey(region.name), region])),
      provinceByName: new Map()
    };

    regions.forEach(region => {
      Object.entries(region.provinceList).forEach(([provinceName, province]) => {
        philippineAddressCache.provinceByName.set(normalizeLookupKey(provinceName), {
          name: provinceName,
          region: region.name,
          municipalityList: province.municipality_list || {}
        });
      });
    });
    console.log(`Loaded Philippine address dataset: ${regions.length} regions`);
  } catch (error) {
    philippineAddressCache = null;
    philippineAddressError = error;
    console.error(`${ADDRESS_DATASET_UNAVAILABLE} ${error.message}`);
  }
}

loadPhilippineAddressDataset();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    cb(null, randomSafeFilename(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: multerFileFilter
});

const sensitiveUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: multerFileFilter,
});

function uploadSingle(fieldName) {
  return (req, res, next) => {
    upload.single(fieldName)(req, res, (err) => {
      if (!err) return secureUploadedFile(req, res, next);

      const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large. Maximum size is 5MB.'
        : err.message || 'File upload failed.';

      auditSecurityEvent(req, {
        action: 'blocked_file_upload_tampering_attempt',
        module: 'FILE_UPLOAD_SECURITY',
        targetTable: 'documents',
        newValue: { message, path: req.originalUrl },
        result: 'blocked',
      }).catch(() => {});
      return res.status(400).json({ error: message });
    });
  };
}

function uploadSensitiveSingle(fieldName) {
  return (req, res, next) => {
    sensitiveUpload.single(fieldName)(req, res, err => {
      if (!err) {
        const validation = validateUploadedBuffer(req.file);
        if (validation.ok) return next();
        return res.status(400).json({ error: validation.error });
      }
      const message = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large. Maximum size is 5MB.'
        : err.message || 'File upload failed.';
      return res.status(400).json({ error: message });
    });
  };
}

function discardUploadedFile(file) {
  if (file?.path && fs.existsSync(file.path)) fs.unlinkSync(file.path);
}

function normalizeWageTypeInput(value) {
  const name = String(value || '').trim();
  if (/piece/i.test(name)) return 'Per-Piece';
  if (/trip|logistics/i.test(name)) return 'Per-Trip';
  if (/hour/i.test(name)) return 'Hourly';
  if (/day|daily/i.test(name)) return 'Daily';
  if (/base|salary/i.test(name)) return 'Base Salary';
  return name;
}

async function resolveWageTypeId(pool, wageType) {
  const normalized = normalizeWageTypeInput(wageType);
  const [rows] = await pool.execute(
    'SELECT id FROM wage_types WHERE LOWER(name) = LOWER(?) LIMIT 1',
    [normalized]
  );
  return rows[0]?.id || null;
}

function decryptRowPii(row, payloadColumn, fields) {
  if (!row) return row;
  if (!row[payloadColumn]) return row;
  try {
    const pii = decryptPII(row[payloadColumn]);
    fields.forEach(field => {
      if (Object.prototype.hasOwnProperty.call(pii, field)) row[field] = pii[field];
    });
  } catch (error) {
    console.error(`Failed to decrypt ${payloadColumn}:`, error.message);
  }
  delete row[payloadColumn];
  return row;
}

function encryptSelectedFields(source, fields) {
  const pii = {};
  fields.forEach(field => {
    pii[field] = source[field] === undefined || source[field] === '' ? null : source[field];
  });
  return encryptPiiJson(pii);
}

function decryptEmployeeStrictPii(row) {
  if (!row) return row;
  for (const field of EMPLOYEE_STRICT_PII_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      row[field] = safeDecryptEmployeeColumnValue(row, field);
    }
  }
  return row;
}

const EMPLOYEE_PII_DECRYPT_WARNING_LIMIT = 20;
const employeePiiDecryptWarningKeys = new Set();
let employeePiiDecryptWarningsSuppressed = false;
const EMPLOYEE_DIRECTORY_PII_COLUMNS = [
  'first_name',
  'middle_name',
  'last_name',
  'suffix',
  'email',
  'contact_number',
];

function logEmployeePiiDecryptFailure(row, field, error) {
  const warningKey = `${row?.id || 'unknown'}:${field}`;
  if (employeePiiDecryptWarningKeys.size < EMPLOYEE_PII_DECRYPT_WARNING_LIMIT && !employeePiiDecryptWarningKeys.has(warningKey)) {
    employeePiiDecryptWarningKeys.add(warningKey);
    console.warn('Employee PII decrypt failed; returning null for field.', {
      employee_id: row?.id || null,
      employee_code: row?.employee_code || null,
      field,
      reason: error.message,
    });
  } else if (!employeePiiDecryptWarningsSuppressed && employeePiiDecryptWarningKeys.size >= EMPLOYEE_PII_DECRYPT_WARNING_LIMIT) {
    employeePiiDecryptWarningsSuppressed = true;
    console.warn('Additional employee PII decrypt warnings suppressed to keep API responses responsive.');
  }
}

function safeDecryptEmployeeDirectoryColumnValue(row, field, budget) {
  const value = row?.[field];
  if (!isEncryptedValue(value)) return value ?? null;
  if (budget && budget.failures >= budget.limit) return null;

  try {
    return decryptColumnValue(value);
  } catch (error) {
    if (budget) budget.failures += 1;
    logEmployeePiiDecryptFailure(row, field, error);
    return null;
  }
}

function decryptEmployeeDirectoryPii(row, budget) {
  if (!row) return row;
  for (const field of EMPLOYEE_DIRECTORY_PII_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      row[field] = safeDecryptEmployeeDirectoryColumnValue(row, field, budget);
    }
  }
  return row;
}

function safeDecryptEmployeeColumnValue(row, field) {
  try {
    return decryptColumnValue(row?.[field]);
  } catch (error) {
    logEmployeePiiDecryptFailure(row, field, error);
    return null;
  }
}

function encryptEmployeeStrictPiiPayload(payload) {
  for (const field of EMPLOYEE_STRICT_PII_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(payload, field)) {
      payload[field] = encryptColumnValue(payload[field]);
    }
  }
  return payload;
}

function dbNullable(value) {
  return value === undefined ? null : value;
}

function employeeDbValue(field, value) {
  const safeValue = value === undefined ? null : value;
  return EMPLOYEE_STRICT_PII_COLUMNS.includes(field) ? encryptColumnValue(safeValue) : safeValue;
}

const AUDITED_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function auditModuleFromPath(pathname = '') {
  const pathOnly = String(pathname || '').split('?')[0].toLowerCase();
  if (pathOnly.startsWith('/api/admin') || pathOnly.startsWith('/api/account-requests')) return 'ACCOUNT_LIFECYCLE';
  if (pathOnly.startsWith('/api/account') || pathOnly.startsWith('/api/auth')) return 'AUTH';
  if (pathOnly.startsWith('/api/payroll')) return 'PAYROLL';
  if (pathOnly.startsWith('/api/attendance') || pathOnly.startsWith('/api/biometric')) return 'ATTENDANCE';
  if (pathOnly.startsWith('/api/leave')) return 'LEAVE';
  if (pathOnly.startsWith('/api/employees') || pathOnly.startsWith('/api/employee-setup')) return 'EMPLOYEE';
  if (pathOnly.startsWith('/api/201-files')) return '201_FILE';
  if (pathOnly.startsWith('/api/onboarding')) return 'ONBOARDING';
  if (pathOnly.startsWith('/api/reports')) return 'REPORTS';
  if (pathOnly.startsWith('/api/blockchain')) return 'BLOCKCHAIN';
  if (pathOnly.startsWith('/api/self-service') || pathOnly.startsWith('/api/hr/profile-change-requests')) return 'SELF_SERVICE';
  if (pathOnly.startsWith('/api/employee')) return 'SELF_SERVICE';
  if (pathOnly.startsWith('/api/requests')) return 'SELF_SERVICE';
  return 'SYSTEM';
}

function auditVerbFromMethod(method) {
  if (method === 'POST') return 'CREATE';
  if (method === 'PUT' || method === 'PATCH') return 'UPDATE';
  if (method === 'DELETE') return 'DELETE';
  return 'WRITE';
}

function auditPathMatches(path, pattern) {
  return pattern.test(String(path || '').toLowerCase());
}

function auditStatusLabel(req, fallback = 'status updated') {
  const status = String(req.body?.status || req.body?.approval_status || req.body?.final_pay_status || req.body?.payroll_clearance_status || '')
    .trim();
  return status ? `${fallback}: ${status}` : fallback;
}

function auditActionFromRequest(req, pathOnly, verb) {
  const method = String(req.method || '').toUpperCase();
  const path = String(pathOnly || '').toLowerCase();
  const employeeRecord = /^\/api\/employees\/\d+$/;
  const employeeDocument = /^\/api\/employees\/\d+\/documents(?:\/\d+)?$/;
  const employeeNested = /^\/api\/employees\/\d+\/(family|work-experiences|certifications|trainings|skills)(?:\/\d+)?$/;
  const payrollRecord = /^\/api\/payroll\/salary-calculations\/\d+/;

  if (path === '/api/admin/register-role' && method === 'POST') return 'User account created';
  if (/^\/api\/admin\/update-role\/\d+$/.test(path) && method === 'PUT') return 'User role updated';
  if (/^\/api\/admin\/users\/\d+\/reset-password$/.test(path)) return 'User password reset';
  if (/^\/api\/admin\/users\/\d+\/credentials$/.test(path)) return 'User credentials updated';
  if (/^\/api\/admin\/users\/\d+\/unlock$/.test(path)) return 'User account unlocked';
  if (/^\/api\/admin\/users\/\d+\/reset-mfa$/.test(path)) return 'User MFA reset';
  if (/^\/api\/admin\/users\/\d+\/revoke-sessions$/.test(path)) return 'User sessions revoked';
  if (/^\/api\/admin\/users\/\d+\/deactivate$/.test(path)) return 'User account deactivated';
  if (/^\/api\/admin\/users\/\d+\/activate$/.test(path)) return 'User account reactivated';
  if (path.startsWith('/api/admin/system-health/check')) return 'System health check run';
  if (path === '/api/admin/support-tickets' && method === 'POST') return 'Support ticket created';
  if (/^\/api\/admin\/support-tickets\/\d+$/.test(path) && method === 'PATCH') return auditStatusLabel(req, 'Support ticket status updated');
  if (path === '/api/admin/backups/request') return 'Backup request created';
  if (/^\/api\/admin\/backups\/\d+$/.test(path) && method === 'PATCH') return auditStatusLabel(req, 'Backup request status updated');

  if (path === '/api/form-drafts' && method === 'POST') return 'Form draft saved';
  if (path === '/api/form-drafts/status' && method === 'PATCH') return 'Form draft status updated';
  if (path === '/api/employees/id-config' && method === 'PUT') return 'Employee ID format updated';
  if (path === '/api/employees' && method === 'POST') return 'Employee record created';
  if (auditPathMatches(path, employeeRecord) && method === 'PUT') return 'Employee profile updated';
  if (auditPathMatches(path, employeeRecord) && method === 'DELETE') return 'Employee record deletion requested';
  if (/^\/api\/employees\/\d+\/status$/.test(path)) return auditStatusLabel(req, 'Employee status updated');
  if (/^\/api\/employees\/\d+\/reveal-sensitive$/.test(path)) return 'Employee sensitive fields revealed';
  if (/^\/api\/employees\/\d+\/offboard$/.test(path)) return 'Employee offboarding requested';
  if (/^\/api\/employees\/\d+\/reonboard$/.test(path)) return 'Employee re-onboarding requested';
  if (/^\/api\/employees\/offboarding\/\d+$/.test(path)) return auditStatusLabel(req, 'Employee offboarding case updated');
  if (/^\/api\/employees\/offboarding\/\d+\/documents$/.test(path)) return 'Offboarding document uploaded';
  if (auditPathMatches(path, employeeDocument) && method === 'POST') return 'Employee document uploaded';
  if (auditPathMatches(path, employeeDocument) && method === 'DELETE') return 'Employee document deleted';
  if (/^\/api\/employees\/\d+\/photo$/.test(path) && method === 'POST') return 'Employee profile photo uploaded';
  if (/^\/api\/employees\/\d+\/photo$/.test(path) && method === 'DELETE') return 'Employee profile photo removed';
  if (auditPathMatches(path, employeeNested)) {
    const section = path.match(/^\/api\/employees\/\d+\/([^/]+)/)?.[1] || 'profile record';
    const label = section.replaceAll('-', ' ');
    if (method === 'POST') return `Employee ${label} added`;
    if (method === 'DELETE') return `Employee ${label} deleted`;
  }
  if (path === '/api/employee-setup/departments' && method === 'POST') return 'Department created';
  if (/^\/api\/employee-setup\/departments\/\d+$/.test(path) && method === 'PUT') return 'Department updated';
  if (/^\/api\/employee-setup\/departments\/\d+$/.test(path) && method === 'DELETE') return 'Department deleted';
  if (path === '/api/employee-setup/positions' && method === 'POST') return 'Position created';
  if (/^\/api\/employee-setup\/positions\/\d+$/.test(path) && method === 'PUT') return 'Position updated';
  if (/^\/api\/employee-setup\/positions\/\d+$/.test(path) && method === 'DELETE') return 'Position deleted';

  if (path === '/api/attendance/manual') return 'Manual attendance encoded';
  if (/^\/api\/attendance\/\d+\/override$/.test(path)) return 'Attendance time record corrected';
  if (/^\/api\/attendance\/\d+\/verify$/.test(path)) return auditStatusLabel(req, 'Attendance verification updated');
  if (/^\/api\/attendance\/\d+\/overtime$/.test(path)) return 'Attendance overtime encoded';
  if (/^\/api\/attendance\/\d+\/overtime-review$/.test(path)) return auditStatusLabel(req, 'Overtime review decision recorded');
  if (path === '/api/attendance/policies') return 'Attendance policy updated';
  if (path === '/api/attendance/biometric/devices' && method === 'POST') return 'Biometric device registered';
  if (/^\/api\/attendance\/biometric\/devices\/\d+$/.test(path) && method === 'PUT') return 'Biometric device updated';
  if (path === '/api/attendance/biometric/mappings' && method === 'POST') return 'Biometric employee mapping created';
  if (/^\/api\/attendance\/biometric\/mappings\/\d+$/.test(path) && method === 'DELETE') return 'Biometric employee mapping deleted';
  if (/^\/api\/attendance\/biometric\/sync\/\d+$/.test(path)) return 'Biometric attendance sync started';
  if (path === '/api/attendance/integrity/anchor-pending') return 'Pending attendance hashes anchored';
  if (/^\/api\/attendance\/geofence\/\d+$/.test(path)) return 'Attendance geofence updated';
  if (path === '/api/biometric/attendance') return 'Biometric attendance event recorded';
  if (path === '/api/biometric/bridge-commands') return 'Biometric bridge command queued';

  if (path === '/api/leave' && method === 'POST') {
    return req.body?.filing_source === 'Manual' ? 'Manual leave encoded' : 'Leave filed';
  }
  if (/^\/api\/leave\/\d+\/status$/.test(path) && method === 'PATCH') {
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (status === 'approved') return 'Leave approved';
    if (status === 'rejected' || status === 'denied') return 'Leave rejected';
    if (status === 'cancelled') return 'Leave cancelled';
    return 'Leave status updated';
  }
  if (path === '/api/leave/balances' && method === 'PUT') return 'Leave balance adjusted';
  if (path === '/api/leave/types' && method === 'POST') return req.body?.id ? 'Leave type updated' : 'Leave type created';
  if (/^\/api\/leave\/\d+\/reveal-sensitive$/.test(path)) return 'Leave details revealed';
  if (/^\/api\/leave\/\d+\/attachment$/.test(path)) return 'Leave attachment downloaded';
  if (path === '/api/requests' && method === 'POST') return 'Employee request submitted';
  if (/^\/api\/requests\/\d+\/status$/.test(path)) return auditStatusLabel(req, 'Employee request status updated');

  if (path === '/api/payroll/runs' && method === 'POST') return 'Payroll run created';
  if (/^\/api\/payroll\/runs\/\d+\/approve$/.test(path)) return 'Payroll run approved';
  if (path === '/api/payroll/salary-calculation') return 'Draft salary calculation created';
  if (path === '/api/payroll/generate/preview') return 'Payroll generation previewed';
  if (path === '/api/payroll/generate') return 'Payroll generated';
  if (auditPathMatches(path, payrollRecord) && path.endsWith('/recalculate')) return 'Salary calculation recalculated';
  if (/^\/api\/payroll\/salary-calculations\/\d+\/status$/.test(path)) return auditStatusLabel(req, 'Salary calculation status updated');
  if (path === '/api/payroll/convert-calculations-to-payslips') return 'Payslips generated from salary calculations';
  if (/^\/api\/payroll\/payslips\/encryption\/backfill$/.test(path)) return 'Payslip encryption backfill started';
  if (path.includes('/government-contributions/reveal')) return 'Government contribution details revealed';
  if (path.includes('/reveal-remarks')) return 'Payroll remarks revealed';
  if (path === '/api/payroll/transactions/production') return 'Production payroll log encoded';
  if (path === '/api/payroll/transactions/logistics') return 'Logistics trip payroll log encoded';
  if (path === '/api/payroll/production-output') return 'Production output encoded';
  if (path === '/api/payroll/production-pairs') return 'Production pair rule saved';
  if (/^\/api\/payroll\/piece-rate-outputs(?:\/\d+)?$/.test(path)) return method === 'PATCH' ? 'Piece-rate output updated' : method === 'DELETE' ? 'Piece-rate output deleted' : 'Piece-rate output encoded';
  if (/^\/api\/payroll\/piece-rate-outputs\/\d+\/submit$/.test(path)) return 'Piece-rate output submitted for review';
  if (/^\/api\/payroll\/piece-rate-outputs\/\d+\/approve$/.test(path)) return 'Piece-rate output approved';
  if (/^\/api\/payroll\/piece-rate-outputs\/\d+\/reject$/.test(path)) return 'Piece-rate output rejected';
  if (/^\/api\/payroll\/logistics\/trips(?:\/\d+)?$/.test(path)) return method === 'PUT' ? 'Logistics trip log updated' : method === 'DELETE' ? 'Logistics trip log deleted' : 'Logistics trip log encoded';
  if (/^\/api\/payroll\/logistics\/trips\/\d+\/submit$/.test(path)) return 'Logistics trip log submitted for review';
  if (/^\/api\/payroll\/logistics\/trips\/\d+\/approve$/.test(path)) return 'Logistics trip log approved';
  if (/^\/api\/payroll\/logistics\/trips\/\d+\/reject$/.test(path)) return 'Logistics trip log rejected';
  if (path.includes('/deduction-settings')) return method === 'DELETE' ? 'Deduction setting deleted' : 'Deduction setting saved';
  if (path.includes('/sss-tables')) return path.endsWith('/preview') ? 'SSS table import previewed' : path.endsWith('/activate') ? 'SSS table activated' : 'SSS table imported';
  if (path.includes('/allowance-settings')) return 'Allowance setting saved';
  if (path.includes('/employee-deductions')) return auditStatusLabel(req, 'Employee deduction status updated');
  if (path.includes('/employee-cash-advances')) return 'Employee cash advance saved';
  if (path.includes('/employee-loans')) return 'Employee loan saved';
  if (path.includes('/policy-settings')) return 'Payroll policy setting saved';
  if (path.includes('/attendance-configurations')) return method === 'DELETE' ? 'Payroll attendance configuration deleted' : 'Payroll attendance configuration saved';
  if (/^\/api\/payroll\/employees\/\d+\/wage-config$/.test(path)) return 'Employee wage configuration saved';
  if (path.includes('/logistics/') || path.includes('/piece-') || path.includes('/sew-types') || path.includes('/size-ranges') || path.includes('/production-share')) {
    return method === 'DELETE' ? 'Payroll configuration deleted' : 'Payroll configuration saved';
  }
  if (path.endsWith('/generate') && path.includes('/api/payroll/')) return 'Payroll report generated';
  if (/^\/api\/payroll\/offboarding-clearance\/\d+$/.test(path)) return auditStatusLabel(req, 'Payroll offboarding clearance updated');
  if (/^\/api\/payroll\/final-pay-approval\/\d+$/.test(path)) return auditStatusLabel(req, 'Final pay approval updated');

  if (path === '/api/onboarding/integrity/anchor-pending') return 'Pending onboarding hashes anchored';
  if (path === '/api/onboarding/positions') return 'Onboarding position created';
  if (/^\/api\/onboarding\/positions\/[^/]+$/.test(path)) return method === 'DELETE' ? 'Onboarding position deleted' : 'Onboarding position updated';
  if (path === '/api/onboarding/applicants') return 'Applicant record created';
  if (/^\/api\/onboarding\/applicants\/\d+\/progress$/.test(path)) return auditStatusLabel(req, 'Applicant progress updated');
  if (/^\/api\/onboarding\/applicants\/\d+\/decision$/.test(path)) return auditStatusLabel(req, 'Applicant hiring decision recorded');
  if (/^\/api\/onboarding\/applicants\/\d+\/transfer$/.test(path)) return 'Applicant transferred to employee directory';
  if (/^\/api\/onboarding\/applicants\/\d+\/reveal-sensitive$/.test(path)) return 'Applicant sensitive details revealed';
  if (/^\/api\/onboarding\/applicants\/\d+$/.test(path) && method === 'DELETE') return 'Applicant removed from active onboarding';
  if (/^\/api\/onboarding\/applicants\/\d+\/documents$/.test(path)) return 'Applicant document uploaded';
  if (/^\/api\/onboarding\/applicants\/\d+\/documents\/\d+\/verify$/.test(path)) return 'Applicant document verification updated';

  if (path === '/api/self-service/profile') return 'Employee self-service profile updated';
  if (path === '/api/self-service/password') return 'Employee password changed';
  if (path === '/api/self-service/profile-picture') return 'Employee profile picture changed';
  if (/^\/api\/self-service\/restricted-fields\/[^/]+\/reveal$/.test(path)) return 'Self-service restricted field revealed';
  if (path === '/api/self-service/change-requests') return 'Profile change request submitted';
  if (/^\/api\/self-service\/change-requests\/\d+\/reveal$/.test(path)) return 'Profile change request details revealed';
  if (/^\/api\/hr\/profile-change-requests\/\d+\/approve$/.test(path)) return 'Profile change request approved';
  if (/^\/api\/hr\/profile-change-requests\/\d+\/reject$/.test(path)) return 'Profile change request rejected';

  if (path.startsWith('/api/reports')) return 'Report generated or exported';
  if (/^\/api\/blockchain\/payroll\/finalize\/\d+$/.test(path)) return 'Final payroll recorded on blockchain';
  if (/^\/api\/blockchain\/payroll\/adjustment\/\d+$/.test(path)) return 'Payroll blockchain adjustment recorded';
  if (/^\/api\/blockchain\/dtr\/generate\/\d+$/.test(path)) return 'DTR blockchain hash generated';
  if (/^\/api\/blockchain\/dtr\/anchor\/\d+$/.test(path)) return 'DTR record anchored on blockchain';
  if (/^\/api\/blockchain\/dtr\/adjustment\/\d+$/.test(path)) return 'DTR blockchain adjustment recorded';

  return `${verb}_API: ${method} ${pathOnly}`;
}

function firstNumericPathId(pathname = '') {
  const match = String(pathname || '').match(/\/(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : null;
}

function generalWriteAuditMiddleware(req, res, next) {
  if (!AUDITED_WRITE_METHODS.has(req.method)) return next();
  if (!String(req.originalUrl || '').startsWith('/api/')) return next();

  // Auth endpoints have dedicated logging and may contain credentials/MFA flow.
  if (String(req.originalUrl || '').startsWith('/api/auth/')) return next();

  res.on('finish', () => {
    const userId = req.user?.id;
    if (!userId) return;
    const statusCode = Number(res.statusCode || 0);
    if (statusCode >= 500) return;

    const pathOnly = String(req.originalUrl || '').split('?')[0];
    const module = auditModuleFromPath(pathOnly);
    const verb = auditVerbFromMethod(req.method);
    const result = statusCode >= 200 && statusCode < 400 ? 'success' : 'failed';

    auditSecurityEvent(req, {
      action: auditActionFromRequest(req, pathOnly, verb),
      module,
      targetTable: pathOnly,
      targetRecord: firstNumericPathId(pathOnly),
      newValue: {
        method: req.method,
        path: pathOnly,
        statusCode,
      },
      result,
    }).catch(() => {});
  });

  return next();
}

app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buffer) => {
    req.rawBody = Buffer.from(buffer);
  }
}));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(encryptedCommunicationMiddleware);
app.use(preventStorageCiphertextResponses);
app.use('/api', requireSameOriginForBrowserWrites);
app.use('/api', auditSuspiciousRequestPatterns);
// Enforce shared input rules before any API route receives a write request.
// This is the final authority; browser validation is only a usability layer.
app.use(validateRequestBody);
app.use('/api/auth/device-approval/status', DEVICE_APPROVAL_POLL_RATE_LIMIT);
app.use([
  '/api/auth/login',
  '/api/auth/mfa/verify',
  '/api/auth/mfa/resend',
  '/api/auth/lockout-status',
  '/api/auth/client-security-event',
], AUTH_RATE_LIMIT);
app.use(['/api/attendance', '/api/biometric'], ATTENDANCE_ROUTE_RATE_LIMIT);
app.use(['/api/payroll', '/api/blockchain/payroll'], PAYROLL_ROUTE_RATE_LIMIT);
app.use('/api/performance', PERFORMANCE_ROUTE_RATE_LIMIT);
app.use('/api', apiRateLimit);
app.use('/api', generalWriteAuditMiddleware);
app.use((req, res, next) => {
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (req.originalUrl.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://www.google.com https://www.gstatic.com; script-src-attr 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; frame-src https://www.google.com https://recaptcha.google.com; connect-src 'self' https://www.google.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
  );
  next();
});
app.use('/uploads', (_req, res) => res.status(404).send('Not found'));

const SPA_ROUTE_PATHS = new Set([
  '/dashboard',
  '/employees',
  '/attendance',
  '/leave',
  '/payroll',
  '/salary-calculation',
  '/reports',
  '/settings',
  '/security',
  '/security-center',
  '/organization-setup',
  '/register',
  '/employee-profile',
  '/requests',
  '/onboarding',
  '/blockchain',
  '/system-admin',
  '/my-profile',
  '/payslips',
]);

const SPA_ROUTE_HANDLERS = [
  ...SPA_ROUTE_PATHS,
  ...[...SPA_ROUTE_PATHS].map(routePath => `${routePath}/`),
];

app.get(SPA_ROUTE_HANDLERS, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public'), {
  redirect: false,
  setHeaders(res, filePath) {
    if (/\.(?:html|js|css)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

app.get('/attendance/station', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'attendance-station.html'));
});

const healthHandlers = createHealthHandlers({
  poolProvider: () => require('./config/db'),
  encryptColumnValue,
  isEncryptedValue,
});

// Public load-balancer probes. They remain minimal; protected Level 4 System
// Health contains all dependency details and remediation guidance.
app.get('/health/live', healthHandlers.live);
app.get('/health/ready', healthHandlers.ready);

// Retained for backward compatibility with existing local deployment checks.
app.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.type('text/plain').send('Server is running');
});

// ── PUBLIC ───────────────────────────────────────────────────
app.use('/api/auth', authRoutes);

// ── PROTECTED ────────────────────────────────────────────────
app.get('/api/auth/me', requireAuth, me);
app.use('/api/dpa', dpaRoutes);
app.use('/api/trusted-devices', trustedDeviceRoutes);
app.use('/api/account', accountRoutes);

function requirePhilippineAddressCache(res) {
  if (philippineAddressCache) return true;
  console.error('Philippine address dataset load error:', philippineAddressError?.message || 'unknown');
  res.status(503).json({ error: ADDRESS_DATASET_UNAVAILABLE });
  return false;
}

function addressOption(value) {
  return { value, label: value };
}

function localPhilippineAddressSuggestions(query, limit = 8) {
  if (!philippineAddressCache) return [];
  const needle = normalizeLookupKey(query);
  const suggestions = [];

  const pushSuggestion = (fullAddress, details) => {
    if (!fullAddress || suggestions.some(item => normalizeLookupKey(item.full_address) === normalizeLookupKey(fullAddress))) return;
    suggestions.push({
      full_address: fullAddress,
      latitude: null,
      longitude: null,
      place_id: '',
      provider: 'philippine_dataset',
      ...details
    });
  };

  for (const region of philippineAddressCache.regions) {
    if (normalizeLookupKey(region.name).includes(needle)) {
      pushSuggestion(`${region.name}, Philippines`, {
        region: region.name
      });
    }

    for (const [provinceName, province] of Object.entries(region.provinceList)) {
      if (normalizeLookupKey(provinceName).includes(needle)) {
        pushSuggestion(`${provinceName}, ${region.name}, Philippines`, {
          region: region.name,
          province: provinceName
        });
      }

      for (const [cityName, city] of Object.entries(province.municipality_list || {})) {
        if (normalizeLookupKey(cityName).includes(needle)) {
          pushSuggestion(`${cityName}, ${provinceName}, ${region.name}, Philippines`, {
            region: region.name,
            province: provinceName,
            city_municipality: cityName
          });
        }

        for (const barangayName of city.barangay_list || []) {
          if (normalizeLookupKey(barangayName).includes(needle)) {
            pushSuggestion(`${barangayName}, ${cityName}, ${provinceName}, ${region.name}, Philippines`, {
              region: region.name,
              province: provinceName,
              city_municipality: cityName,
              barangay: barangayName
            });
          }
          if (suggestions.length >= limit) return suggestions;
        }
        if (suggestions.length >= limit) return suggestions;
      }
      if (suggestions.length >= limit) return suggestions;
    }
  }

  return suggestions;
}

app.get('/api/address/regions', requireAuth, requireRole(ROLES.any), (_req, res) => {
  if (!requirePhilippineAddressCache(res)) return;
  res.json(philippineAddressCache.regions.map(region => ({
    value: region.name,
    label: region.name,
    code: region.code
  })));
});

app.get('/api/address/provinces/:region', requireAuth, requireRole(ROLES.any), (req, res) => {
  if (!requirePhilippineAddressCache(res)) return;
  const region = philippineAddressCache.regionByName.get(normalizeLookupKey(req.params.region));
  if (!region) return res.json([]);
  res.json(Object.keys(region.provinceList).sort((a, b) => a.localeCompare(b)).map(addressOption));
});

app.get('/api/address/cities/:province', requireAuth, requireRole(ROLES.any), (req, res) => {
  if (!requirePhilippineAddressCache(res)) return;
  const province = philippineAddressCache.provinceByName.get(normalizeLookupKey(req.params.province));
  if (!province) return res.json([]);
  res.json(Object.keys(province.municipalityList).sort((a, b) => a.localeCompare(b)).map(addressOption));
});

app.get('/api/address/barangays/:city', requireAuth, requireRole(ROLES.any), (req, res) => {
  if (!requirePhilippineAddressCache(res)) return;
  const cityKey = normalizeLookupKey(req.params.city);
  for (const province of philippineAddressCache.provinceByName.values()) {
    const cityEntry = Object.entries(province.municipalityList)
      .find(([cityName]) => normalizeLookupKey(cityName) === cityKey);
    if (cityEntry) {
      const barangays = cityEntry[1]?.barangay_list || [];
      return res.json([...barangays].sort((a, b) => a.localeCompare(b)).map(addressOption));
    }
  }
  res.json([]);
});

app.get('/api/address/search', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 3) return res.json([]);

    const localSuggestions = localPhilippineAddressSuggestions(query);
    const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
    if (apiKey) {
      const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
      url.searchParams.set('input', query);
      url.searchParams.set('key', apiKey);
      url.searchParams.set('components', 'country:ph');
      url.searchParams.set('types', 'geocode');

      const response = await fetch(url);
      const data = await response.json();
      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        return res.status(502).json({ error: data.error_message || `Places autocomplete failed: ${data.status}` });
      }

      const suggestions = (data.predictions || []).slice(0, 6).map(item => ({
        full_address: item.description,
        latitude: null,
        longitude: null,
        place_id: item.place_id,
        provider: 'google_places'
      })).filter(item => item.full_address && item.place_id);

      return res.json([...suggestions, ...localSuggestions].slice(0, 8));
    }

    res.json(localSuggestions);
  } catch (err) {
    console.error('Address search error:', err.message);
    res.status(500).json({ error: 'Failed to search address.' });
  }
});

app.get('/api/address/details', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const placeId = String(req.query.place_id || '').trim();
    if (!placeId) return res.status(400).json({ error: 'place_id is required.' });

    const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Google Places API key is not configured.' });
    }

    const url = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    url.searchParams.set('place_id', placeId);
    url.searchParams.set('fields', 'formatted_address,geometry,place_id,address_components');
    url.searchParams.set('key', apiKey);

    const response = await fetch(url);
    const data = await response.json();
    if (data.status !== 'OK') {
      return res.status(502).json({ error: data.error_message || `Place details failed: ${data.status}` });
    }

    const result = data.result || {};
    const components = result.address_components || [];
    const component = (...types) => {
      const match = components.find(item => types.some(type => item.types?.includes(type)));
      return match?.long_name || '';
    };
    res.json({
      full_address: result.formatted_address,
      latitude: result.geometry?.location?.lat,
      longitude: result.geometry?.location?.lng,
      place_id: result.place_id || placeId,
      street_address: [component('street_number'), component('route')].filter(Boolean).join(' ') || result.formatted_address,
      barangay: component('sublocality_level_1', 'sublocality_level_2', 'neighborhood'),
      city_municipality: component('locality', 'administrative_area_level_3', 'postal_town'),
      province: component('administrative_area_level_2'),
      region: component('administrative_area_level_1'),
      provider: 'google_places'
    });
  } catch (err) {
    console.error('Address details error:', err.message);
    res.status(500).json({ error: 'Failed to fetch address details.' });
  }
});

app.get('/api/form-drafts', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    await pool.execute(
      `UPDATE form_drafts
       SET status = 'Expired'
       WHERE status = 'Active' AND expires_at IS NOT NULL AND expires_at < NOW()`
    );

    const moduleName = String(req.query.module_name || '').trim();
    const formName = String(req.query.form_name || '').trim();
    const recordId = req.query.record_id === undefined || req.query.record_id === ''
      ? '__new__'
      : String(req.query.record_id);

    if (!moduleName || !formName) {
      return res.status(400).json({ error: 'module_name and form_name are required.' });
    }

    const [rows] = await pool.execute(
      `SELECT id, user_id, module_name, form_name, NULLIF(record_id, '__new__') AS record_id,
              draft_data_json, status, last_saved_at, expires_at, created_at, updated_at
       FROM form_drafts
       WHERE user_id = ? AND module_name = ? AND form_name = ? AND record_id = ? AND status = 'Active'
       LIMIT 1`,
      [req.user.id, moduleName, formName, recordId]
    );

    res.json(rows[0] || null);
  } catch (err) {
    console.error('Form draft fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch form draft.' });
  }
});

app.post('/api/form-drafts', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    if (await rejectUnsupportedRouteFields(req, res, FORM_DRAFT_ALLOWED_FIELDS, { module: 'FORM_DRAFT_SECURITY' })) return;
    const moduleName = String(req.body.module_name || '').trim();
    const formName = String(req.body.form_name || '').trim();
    const recordId = req.body.record_id === undefined || req.body.record_id === null || req.body.record_id === ''
      ? '__new__'
      : String(req.body.record_id);
    const status = ['Active', 'Submitted', 'Discarded'].includes(req.body.status) ? req.body.status : 'Active';
    const expiryDays = Math.max(parseInt(req.body.expiry_days || process.env.FORM_DRAFT_EXPIRY_DAYS || '14', 10) || 14, 1);
    const draftData = req.body.draft_data || {};

    if (!moduleName || !formName) {
      return res.status(400).json({ error: 'module_name and form_name are required.' });
    }

    await pool.execute(
      `INSERT INTO form_drafts
         (user_id, module_name, form_name, record_id, draft_data_json, status, last_saved_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))
       ON DUPLICATE KEY UPDATE
         draft_data_json = VALUES(draft_data_json),
         status = VALUES(status),
         last_saved_at = NOW(),
         expires_at = VALUES(expires_at)`,
      [req.user.id, moduleName, formName, recordId, JSON.stringify(draftData), status, expiryDays]
    );

    res.json({ message: 'Draft saved.', last_saved_at: new Date().toISOString() });
  } catch (err) {
    console.error('Form draft save error:', err.message);
    res.status(500).json({ error: 'Failed to save form draft.' });
  }
});

app.patch('/api/form-drafts/status', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    if (await rejectUnsupportedRouteFields(req, res, FORM_DRAFT_STATUS_ALLOWED_FIELDS, { module: 'FORM_DRAFT_SECURITY' })) return;
    const moduleName = String(req.body.module_name || '').trim();
    const formName = String(req.body.form_name || '').trim();
    const recordId = req.body.record_id === undefined || req.body.record_id === null || req.body.record_id === ''
      ? '__new__'
      : String(req.body.record_id);
    const status = ['Submitted', 'Discarded', 'Expired'].includes(req.body.status) ? req.body.status : 'Discarded';

    if (!moduleName || !formName) {
      return res.status(400).json({ error: 'module_name and form_name are required.' });
    }

    await pool.execute(
      `UPDATE form_drafts
       SET status = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ? AND module_name = ? AND form_name = ? AND record_id = ?`,
      [status, req.user.id, moduleName, formName, recordId]
    );

    res.json({ message: 'Draft status updated.' });
  } catch (err) {
    console.error('Form draft status error:', err.message);
    res.status(500).json({ error: 'Failed to update form draft.' });
  }
});

// Payroll Routes (wages, transactions, payroll generation)
app.use('/api/payroll', payrollRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/reports', reportsRoutes);

// 201-File Management (Auth required, role-based per endpoint)
app.use('/api/201-files', requireAuth, fileManagementRoutes);

// Attendance Module (biometric attendance, records, manual correction, audit)
app.use('/api/attendance', attendanceRoutes);
app.use('/api/holidays', holidayRoutes);

// Local biometric bridge endpoint for ZKTeco ZK9500 attendance scans
app.use('/api/biometric', biometricRoutes);

// Permissioned blockchain payroll audit layer
app.use('/api/blockchain/payroll', blockchainPayrollRoutes);
app.use('/api/blockchain/dtr', blockchainDtrRoutes);

// Onboarding Module (pre-employment lifecycle, secure document vault, transfer)
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/account-requests', accountCreationRequestRoutes);

// Admin RBAC Module — Account Registration & Role Management (Level 4 only)
// Mount hardened recovery handlers before the legacy admin router.
app.use('/api/admin/backups', backupRecoveryRoutes);
app.use('/api/admin', adminRbacRoutes);

// Employee Actor Module — Employee-only dashboard, 201-file, payslips
app.use('/api/employee', employeeDashboardRoutes);

// Performance Management (HR-managed appraisals and employee self-service)
app.use('/api/performance', performanceManagementRoutes);

function normalizeAddressPayload(body) {
  const sameCurrent = boolValue(body.current_address_same_as_home);
  const sameMailing = boolValue(body.mailing_address_same_as_home);
  const structured = section => ({
    region: String(body[`${section}_region`] || '').trim(),
    province: String(body[`${section}_province`] || '').trim(),
    city_municipality: String(body[`${section}_city_municipality`] || '').trim(),
    barangay: String(body[`${section}_barangay`] || '').trim(),
    street_address: String(body[`${section}_street_address`] || '').trim(),
    full_address: String(body[`${section}_full_address`] || '').trim(),
    place_id: String(body[`${section}_place_id`] || '').trim()
  });
  const home = {
    address: String(body.residential_address || '').trim(),
    lat: body.residential_address_lat,
    lng: body.residential_address_lng,
    ...structured('residential_address')
  };
  const current = sameCurrent
    ? { ...home }
    : { address: String(body.current_address || '').trim(), lat: body.current_address_lat, lng: body.current_address_lng, ...structured('current_address') };
  const mailing = sameMailing
    ? { ...home }
    : { address: String(body.mailing_address || '').trim(), lat: body.mailing_address_lat, lng: body.mailing_address_lng, ...structured('mailing_address') };

  return { home, current, mailing, sameCurrent, sameMailing };
}

async function ensurePhilippineAddressColumns(pool) {
  const columns = [
    ['residential_address_region', 'VARCHAR(120) NULL'],
    ['residential_address_province', 'VARCHAR(120) NULL'],
    ['residential_address_city_municipality', 'VARCHAR(160) NULL'],
    ['residential_address_barangay', 'VARCHAR(160) NULL'],
    ['residential_address_street_address', 'VARCHAR(255) NULL'],
    ['residential_address_full_address', 'TEXT NULL'],
    ['residential_address_place_id', 'VARCHAR(255) NULL'],
    ['current_address_region', 'VARCHAR(120) NULL'],
    ['current_address_province', 'VARCHAR(120) NULL'],
    ['current_address_city_municipality', 'VARCHAR(160) NULL'],
    ['current_address_barangay', 'VARCHAR(160) NULL'],
    ['current_address_street_address', 'VARCHAR(255) NULL'],
    ['current_address_full_address', 'TEXT NULL'],
    ['current_address_place_id', 'VARCHAR(255) NULL'],
    ['mailing_address_region', 'VARCHAR(120) NULL'],
    ['mailing_address_province', 'VARCHAR(120) NULL'],
    ['mailing_address_city_municipality', 'VARCHAR(160) NULL'],
    ['mailing_address_barangay', 'VARCHAR(160) NULL'],
    ['mailing_address_street_address', 'VARCHAR(255) NULL'],
    ['mailing_address_full_address', 'TEXT NULL'],
    ['mailing_address_place_id', 'VARCHAR(255) NULL']
  ];

  for (const [column, definition] of columns) {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) AS count
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'employees'
          AND COLUMN_NAME = ?`,
      [column]
    );
    if (!Number(rows[0]?.count || 0)) {
      await pool.execute(`ALTER TABLE employees ADD COLUMN ${column} ${definition}`);
    }
  }
}

let philippineAddressColumnsReadyPromise = null;
function ensurePhilippineAddressColumnsOnce(pool) {
  if (!philippineAddressColumnsReadyPromise) {
    philippineAddressColumnsReadyPromise = ensurePhilippineAddressColumns(pool)
      .catch(error => {
        philippineAddressColumnsReadyPromise = null;
        throw error;
      });
  }
  return philippineAddressColumnsReadyPromise;
}

function validateEmployeeAddresses(body) {
  const addresses = normalizeAddressPayload(body);
  const errors = [];

  if (!addresses.home.address) errors.push('Home Address is required.');
  if (!addresses.sameCurrent && !addresses.current.address) errors.push('Current Address is required unless Same as Home Address is checked.');
  if (!addresses.sameMailing && !addresses.mailing.address) errors.push('Mailing Address is required unless Same as Home Address is checked.');

  return { errors, addresses };
}

function employeeHasRole(req, roles) {
  return roles.includes(req.user?.role);
}

const EMPLOYEE_INTEGRITY_FIELDS = [
  'employee_code',
  'first_name',
  'middle_name',
  'last_name',
  'suffix',
  'email',
  'contact_number',
  'department_id',
  'position',
  'employment_type',
  'status',
  'hiring_type',
  'deployment_status',
  'supervisor',
  'work_location',
  'shift_schedule',
  'sss_number',
  'philhealth_number',
  'pagibig_number',
  'tin',
  'tax_status',
  'bank_name',
  'bank_account',
];

let employeeIntegritySchemaReadyPromise = null;

function employeeIntegrityValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function employeeIntegrityPayload(row) {
  return [
    'employee:v2',
    ...EMPLOYEE_INTEGRITY_FIELDS.map(field => employeeIntegrityValue(row?.[field])),
  ].join('|');
}

function computeEmployeeIntegrityHash(row) {
  return nodeCrypto.createHash('sha256').update(employeeIntegrityPayload(row), 'utf8').digest('hex');
}

function employeeIntegrityStatus(row) {
  const storedHash = String(row?.integrity_hash || '').trim().toLowerCase();
  if (!storedHash) return { status: 'UNSEALED', hash: null };
  const expectedHash = computeEmployeeIntegrityHash(row);
  return {
    status: storedHash === expectedHash ? 'VALID' : 'TAMPERED',
    hash: storedHash,
  };
}

async function ensureEmployeeIntegritySchema(pool) {
  if (!employeeIntegritySchemaReadyPromise) {
    employeeIntegritySchemaReadyPromise = (async () => {
      if (!(await employeeColumnExists(pool, 'integrity_hash'))) {
        await pool.execute('ALTER TABLE employees ADD COLUMN integrity_hash CHAR(64) NULL');
      }
      await pool.execute(
        `UPDATE employees
            SET integrity_hash = SHA2(CONCAT_WS('|',
                'employee:v2',
                COALESCE(employee_code, ''),
                COALESCE(first_name, ''),
                COALESCE(middle_name, ''),
                COALESCE(last_name, ''),
                COALESCE(suffix, ''),
                COALESCE(email, ''),
                COALESCE(contact_number, ''),
                COALESCE(CAST(department_id AS CHAR), ''),
                COALESCE(position, ''),
                COALESCE(employment_type, ''),
                COALESCE(status, ''),
                COALESCE(hiring_type, ''),
                COALESCE(deployment_status, ''),
                COALESCE(supervisor, ''),
                COALESCE(work_location, ''),
                COALESCE(shift_schedule, ''),
                COALESCE(sss_number, ''),
                COALESCE(philhealth_number, ''),
                COALESCE(pagibig_number, ''),
                COALESCE(tin, ''),
                COALESCE(tax_status, ''),
                COALESCE(bank_name, ''),
                COALESCE(bank_account, '')
              ), 256)
          WHERE integrity_hash IS NULL`
      );
    })().catch(error => {
      employeeIntegritySchemaReadyPromise = null;
      throw error;
    });
  }
  return employeeIntegritySchemaReadyPromise;
}

async function sealEmployeeIntegrity(executor, employeeId) {
  const [rows] = await executor.execute(
    `SELECT id, integrity_hash, employee_code, first_name, middle_name, last_name, suffix,
            email, contact_number, department_id, position, employment_type, status,
            hiring_type, deployment_status, supervisor, work_location, shift_schedule,
            sss_number, philhealth_number, pagibig_number, tin, tax_status, bank_name, bank_account
       FROM employees
      WHERE id = ?
      LIMIT 1`,
    [employeeId]
  );
  if (!rows.length) return null;
  const integrityHash = computeEmployeeIntegrityHash(rows[0]);
  await executor.execute('UPDATE employees SET integrity_hash = ? WHERE id = ?', [integrityHash, employeeId]);
  return integrityHash;
}

function employeeReferencePayload(employee, options = {}) {
  const includePayrollFields = Boolean(options.includePayrollFields);
  return {
    id: employee.id,
    employee_code: employee.employee_code,
    first_name: employee.first_name,
    middle_name: employee.middle_name || null,
    last_name: employee.last_name,
    suffix: employee.suffix || null,
    status: employee.status,
    employment_status: employee.employment_status || employee.status,
    department_id: employee.department_id || null,
    department: employee.department || null,
    position: employee.position || null,
    current_system_role: employee.current_system_role || null,
    integrity_status: employee.integrity_status || null,
    integrity_hash: employee.integrity_hash || null,
    ...(includePayrollFields ? {
      employment_type: employee.employment_type || null,
      wage_type_id: employee.wage_type_id || null,
      wage_type: employee.wage_type || null,
      basic_salary: employee.basic_salary ?? null,
      wage_effective_date: employee.wage_effective_date || null,
    } : {}),
  };
}

function employeeDirectoryPayload(employee, options = {}) {
  const revealSensitive = Boolean(options.revealSensitive);
  return {
    ...employeeReferencePayload(employee, options),
    email: revealSensitive ? (employee.email || null) : (employee.email ? maskSensitiveValue(employee.email, 3) : null),
    contact_number: revealSensitive ? (employee.contact_number || null) : (employee.contact_number ? maskSensitiveValue(employee.contact_number, 4) : null),
    supervisor: employee.supervisor || null,
    hiring_type: employee.hiring_type || null,
    deployment_status: employee.deployment_status || null,
    pending_offboarding_request_id: employee.pending_offboarding_request_id || null,
    pending_offboarding_status: employee.pending_offboarding_status || null,
    pending_reonboarding_request_id: employee.pending_reonboarding_request_id || null,
  };
}

const EMPLOYEE_PROFILE_MASKED_FIELDS = new Set([
  'sss_number',
  'philhealth_number',
  'pagibig_number',
  'tin',
  'bank_account',
]);

function decryptEmployeeGps(row) {
  for (const field of ['residential_address_lat', 'residential_address_lng', 'current_address_lat', 'current_address_lng', 'mailing_address_lat', 'mailing_address_lng']) {
    const encryptedField = `${field}_encrypted`;
    if (row?.[encryptedField]) row[field] = decryptColumnValue(row[encryptedField]);
    delete row?.[encryptedField];
  }
  return row;
}

function maskEmployeeDetail(row) {
  const safe = { ...row, sensitive_fields_masked: true };
  for (const field of EMPLOYEE_PROFILE_MASKED_FIELDS) {
    const value = safe[field];
    if (value === null || value === undefined || value === '') continue;
    safe[field] = maskSensitiveValue(value, 4);
  }
  return safe;
}

function visibleEmployeeDetail(row) {
  return {
    ...row,
    payroll_schedule: normalizePayrollScheduleValue(row?.payroll_schedule) || row?.payroll_schedule || null,
    sensitive_fields_masked: false,
  };
}

function normalizeBlank(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  // Philippine address lookups can contain typographic dashes and apostrophes.
  // Normalize them before allow-list validation, while still rejecting unsafe input.
  const text = String(value)
    .normalize('NFKC')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .replace(/\u00A0/g, ' ')
    .trim();
  return text === '' ? null : text;
}

const EMPLOYEE_FIELD_LABELS = {
  contact_number: 'Contact No',
  emergency_contact_num: 'Primary Phone Number',
  emergency_contact_number: 'Emergency Contact Number',
  emergency_contact_secondary_num: 'Secondary Phone Number',
  agency_contact_number: 'Agency Contact Number',
  sss_number: 'SSS',
  tin: 'TIN',
  philhealth_number: 'PhilHealth',
  pagibig_number: 'Pag-IBIG',
  bank_account: 'Bank Account Number',
  clearance_items: 'Clearance Checklist',
  base_rate: 'Basic Salary',
  allowances: 'Allowances',
  allowance: 'Allowance',
  supervisor: 'Immediate Supervisor',
  new_supervisor: 'New Supervisor'
};

function rejectEmployeeInput(field, reason = null) {
  const label = EMPLOYEE_FIELD_LABELS[field] || String(field || 'field').replace(/_/g, ' ');
  const error = new Error(reason ? `${label}: ${reason}` : `Invalid input for ${label}.`);
  error.status = 400;
  error.field = field;
  error.reason = reason;
  return error;
}

function normalizeEmploymentStatus(value) {
  const status = normalizeBlank(value) || 'Active';
  if (!EMPLOYEE_ENUMS.status.has(status)) throw rejectEmployeeInput('status');
  return status;
}

function isNonActiveEmploymentStatus(status) {
  return NON_ACTIVE_EMPLOYEE_STATUSES.has(normalizeEmploymentStatus(status));
}

async function deactivateLinkedUserAccounts(pool, employeeId, status, req) {
  if (!ACCOUNT_DEACTIVATION_STATUSES.has(status) || !employeeId) return 0;
  const [result] = await pool.execute(
    `UPDATE users
        SET is_active = 0,
            account_status = CASE
              WHEN ? IN ('Resigned','Terminated','End of Contract','Retired','Offboarded') THEN 'Offboarded'
              ELSE 'Disabled'
            END,
            token_version = COALESCE(token_version, 0) + 1
      WHERE employee_id = ?
        AND (is_active <> 0 OR COALESCE(account_status, 'Active') NOT IN ('Disabled','Offboarded'))`,
    [status, employeeId]
  );
  await pool.execute(
    `UPDATE USER_SESSION
        SET Revoked_At = NOW(),
            Revocation_Reason = 'employee_offboarded'
      WHERE Employee_ID = ?
        AND Revoked_At IS NULL`,
    [employeeId]
  ).catch(() => {});
  if (result.affectedRows > 0) {
    await writeEmployeeLifecycleAudit(pool, req, 'LINKED_USER_ACCOUNT_DEACTIVATED', employeeId, null, {
      status,
      affected_user_accounts: result.affectedRows,
    });
  }
  return result.affectedRows || 0;
}

async function reactivateLinkedUserAccounts(pool, employeeId, req) {
  if (!employeeId) return 0;
  const [result] = await pool.execute(
    `UPDATE users
        SET is_active = 1,
            account_status = 'Active',
            force_password_change = 1,
            password_changed_at = NOW(),
            token_version = COALESCE(token_version, 0) + 1
      WHERE employee_id = ?`,
    [employeeId]
  );
  if (result.affectedRows > 0) {
    await writeEmployeeLifecycleAudit(pool, req, 'LINKED_USER_ACCOUNT_REACTIVATED', employeeId, null, {
      affected_user_accounts: result.affectedRows,
    });
  }
  return result.affectedRows || 0;
}

function canCreateOffboarding(req) {
  return employeeHasRole(req, ROLES.staff_management);
}

function canCreateReonboarding(req) {
  return employeeHasRole(req, ROLES.staff_management);
}

function canUpdateItOffboarding(req) {
  return employeeHasRole(req, ['it_staff', ...ROLES.admin_any])
    || hasPermission(req, 'employee:offboard:it');
}

async function rejectLifecycleUnauthorized(req, res, action, targetEmployeeId) {
  await auditSecurityEvent(req, {
    action,
    module: 'EMPLOYEE_LIFECYCLE_SECURITY',
    targetTable: 'employees',
    targetRecord: targetEmployeeId || req.params?.id || null,
    newValue: { path: req.originalUrl, role: req.user?.role || null },
    result: 'blocked',
  }).catch(() => {});
  return res.status(403).json({ error: 'Access denied.' });
}

function requireBodyValue(body, field) {
  const value = normalizeBlank(body[field]);
  if (value == null) throw rejectEmployeeInput(field, 'This field is required.');
  body[field] = value;
  return value;
}

function validateLifecycleChoice(body, field, allowed) {
  const value = requireBodyValue(body, field);
  validateNoDangerousText(field, value);
  if (!allowed.has(value)) throw rejectEmployeeInput(field);
  return value;
}

function normalizeOffboardingStatusForStorage(status) {
  if (status === 'Pending' || status === 'In Progress') return 'For Offboarding';
  if (status === 'Approved') return 'Final Approval';
  if (status === 'Completed') return 'Offboarded';
  return status;
}

function isTerminalOffboardingStatus(status) {
  return ['Offboarded', 'Inactive', 'Completed'].includes(String(status || ''));
}

function employeeStatusFromOffboardingFinalStatus(status, separationType = 'Offboarded') {
  if (status === 'Inactive') return 'Inactive';
  if (status === 'Completed') return separationType || 'Offboarded';
  return 'Offboarded';
}

function isAllowedOffboardingTransition(currentStatus, requestedStatus) {
  const current = normalizeOffboardingStatusForStorage(currentStatus);
  const requested = normalizeOffboardingStatusForStorage(requestedStatus);
  if (!requested || current === requested) return true;
  const allowed = {
    'For Offboarding': new Set(['Clearance Pending', 'Cancelled']),
    'Clearance Pending': new Set(['Payroll Review', 'Cancelled']),
    'Payroll Review': new Set(['Final Approval']),
    'Final Approval': new Set(['Offboarded', 'Inactive']),
    Pending: new Set(['For Offboarding', 'Clearance Pending', 'Cancelled']),
    'In Progress': new Set(['For Offboarding', 'Clearance Pending', 'Payroll Review', 'Cancelled']),
    Approved: new Set(['Final Approval', 'Offboarded', 'Inactive']),
  };
  return Boolean(allowed[current]?.has(requested));
}

function normalizeClearanceStatusFromItems(items = []) {
  if (!items.length) return 'Pending';
  const statuses = items.map(item => item.status);
  if (statuses.some(status => status === 'Pending')) return 'Pending';
  return 'Cleared';
}

function areOffboardingChecklistItemsComplete(items = []) {
  return items.length > 0 && items.every(item => ['Cleared', 'Not Applicable'].includes(item.status));
}

function validateOffboardingClearanceItems(input) {
  if (input === undefined || input === null || input === '') return [];
  let items;
  try {
    items = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (_error) {
    throw rejectEmployeeInput('clearance_items', 'Checklist format is invalid.');
  }
  if (!Array.isArray(items)) throw rejectEmployeeInput('clearance_items', 'Checklist must be an array.');
  return items.map(item => {
    const itemKey = normalizeBlank(item?.item_key || item?.key);
    if (!EMPLOYEE_OFFBOARDING_CHECKLIST_KEYS.has(itemKey)) throw rejectEmployeeInput('clearance_items', 'Unknown checklist item.');
    const status = normalizeBlank(item?.status) || 'Pending';
    if (!EMPLOYEE_OFFBOARDING_CLEARANCE_ITEM_STATUSES.has(status)) throw rejectEmployeeInput('clearance_items', 'Invalid checklist status.');
    const remarksBody = { remarks: item?.remarks || null };
    validateEmployeeTextField(remarksBody, 'remarks', { max: 500, pattern: EMPLOYEE_SAFE_TEXT_PATTERN });
    const [, defaultLabel] = EMPLOYEE_OFFBOARDING_CHECKLIST_ITEMS.find(([key]) => key === itemKey);
    return {
      item_key: itemKey,
      item_label: defaultLabel,
      status,
      remarks: remarksBody.remarks || null,
    };
  });
}

async function seedOffboardingChecklistItems(executor, caseId) {
  for (const [itemKey, itemLabel] of EMPLOYEE_OFFBOARDING_CHECKLIST_ITEMS) {
    await executor.execute(
      `INSERT INTO employee_offboarding_clearance_item
         (offboarding_case_id, item_key, item_label)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE item_label = VALUES(item_label)`,
      [caseId, itemKey, itemLabel]
    );
  }
}

async function upsertOffboardingChecklistItems(executor, req, caseId, items) {
  if (!items?.length) return;
  for (const item of items) {
    const checkedBy = item.status === 'Pending' ? null : req.user.id || null;
    await executor.execute(
      `INSERT INTO employee_offboarding_clearance_item
         (offboarding_case_id, item_key, item_label, status, checked_by, checked_at, remarks)
       VALUES (?, ?, ?, ?, ?, CASE WHEN ? = 'Pending' THEN NULL ELSE NOW() END, ?)
       ON DUPLICATE KEY UPDATE
         item_label = VALUES(item_label),
         status = VALUES(status),
         checked_by = CASE WHEN VALUES(status) = 'Pending' THEN NULL ELSE VALUES(checked_by) END,
         checked_at = CASE WHEN VALUES(status) = 'Pending' THEN NULL ELSE NOW() END,
         remarks = VALUES(remarks)`,
      [caseId, item.item_key, item.item_label, item.status, checkedBy, item.status, item.remarks]
    );
  }
}

async function loadOffboardingChecklistItems(executor, caseId) {
  await seedOffboardingChecklistItems(executor, caseId);
  const [items] = await executor.execute(
    `SELECT ci.clearance_item_id, ci.offboarding_case_id, ci.item_key, ci.item_label,
            ci.status, ci.checked_by, ci.checked_at, ci.remarks,
            u.username AS checked_by_username
       FROM employee_offboarding_clearance_item ci
       LEFT JOIN users u ON u.id = ci.checked_by
      WHERE ci.offboarding_case_id = ?
      ORDER BY FIELD(ci.item_key,
        'company_id_returned',
        'uniform_ppe_returned',
        'tools_equipment_returned',
        'documents_submitted',
        'pending_attendance_checked',
        'pending_payroll_final_pay_checked',
        'account_access_reviewed',
        'final_hr_approval'
      ), ci.clearance_item_id`,
    [caseId]
  );
  return items;
}

function sqlEnumList(values) {
  return values.map(value => `'${String(value).replace(/'/g, "''")}'`).join(',');
}

function normalizeOffboardingDocumentType(value) {
  const requested = normalizeBlank(value);
  if (!requested) return 'Other';
  return EMPLOYEE_OFFBOARDING_DOCUMENT_TYPES.has(requested) ? requested : 'Other';
}

function offboardingDocumentLabel(documentType) {
  return EMPLOYEE_OFFBOARDING_DOCUMENT_TYPES.get(documentType) || documentType || 'Supporting document';
}

async function ensureOffboardingDocumentSchema(pool) {
  const [tables] = await pool.execute("SHOW TABLES LIKE 'documents'");
  if (!tables.length) return;
  await pool.execute(
    `ALTER TABLE documents MODIFY COLUMN document_type ENUM(${sqlEnumList(EMPLOYEE_DOCUMENT_TYPE_ENUM_VALUES)}) NOT NULL`
  ).catch(() => {});

  const columns = [
    ['offboarding_case_id', 'BIGINT NULL AFTER employee_id'],
    ['document_stage', "ENUM('Employee Profile','Offboarding') NOT NULL DEFAULT 'Employee Profile' AFTER document_type"],
    ['uploaded_by', 'INT NULL AFTER uploaded_date'],
    ['file_name_encrypted', 'TEXT NULL AFTER file_name'],
    ['encrypted_file_path', 'VARCHAR(500) NULL AFTER file_path'],
    ['file_mime_type', 'VARCHAR(120) NULL'],
    ['file_size_bytes', 'BIGINT NULL'],
  ];
  for (const [name, definition] of columns) {
    const [existing] = await pool.execute(`SHOW COLUMNS FROM documents LIKE '${name}'`);
    if (!existing.length) await pool.execute(`ALTER TABLE documents ADD COLUMN ${name} ${definition}`);
  }
  await pool.execute('ALTER TABLE documents MODIFY COLUMN file_name VARCHAR(255) NULL').catch(() => {});
  await pool.execute('ALTER TABLE documents MODIFY COLUMN file_path VARCHAR(500) NULL').catch(() => {});
}

async function loadOffboardingDocuments(executor, caseId) {
  const [documents] = await executor.execute(
    `SELECT id, offboarding_case_id, document_type, document_stage, file_name, file_name_encrypted,
            encrypted_file_path, uploaded_date, uploaded_by
       FROM documents
      WHERE offboarding_case_id = ?
        AND document_stage = 'Offboarding'
      ORDER BY uploaded_date DESC, id DESC`,
    [caseId]
  );
  return documents.map(document => ({
    id: document.id,
    offboarding_case_id: document.offboarding_case_id,
    document_type: document.document_type,
    document_stage: document.document_stage,
    file_name: decryptColumnValue(document.file_name_encrypted || document.file_name) || 'Document',
    uploaded_date: document.uploaded_date,
    uploaded_by: document.uploaded_by,
    document_label: offboardingDocumentLabel(document.document_type),
  }));
}

function employeeDisplayName(row) {
  return [row?.first_name, row?.middle_name, row?.last_name].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function validateNoDangerousText(field, value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (EMPLOYEE_FORBIDDEN_PATTERN.test(text) || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(text)) {
    throw rejectEmployeeInput(field);
  }
  return text;
}

function validateEmployeeTextField(body, field, { max = 120, pattern = EMPLOYEE_TEXT_PATTERN, allowEmpty = true } = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  const value = normalizeBlank(body[field]);
  if (value == null) {
    if (!allowEmpty) throw rejectEmployeeInput(field);
    body[field] = null;
    return;
  }
  const text = validateNoDangerousText(field, value);
  if (text.length > max || !pattern.test(text)) throw rejectEmployeeInput(field);
  body[field] = text.replace(/\s+/g, ' ');
}

function validateEmployeeNameLikeField(body, field, options = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  validateEmployeeTextField(body, field, options);
  const value = body[field];
  if (value == null) return;
  if (!/[A-Za-zÀ-ÖØ-öø-ÿÑñ]/.test(String(value))) {
    throw rejectEmployeeInput(field, 'Enter a valid name or title, not numbers only.');
  }
}

function validateEmployeeEmailField(body, field, { required = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) {
    if (required) throw rejectEmployeeInput(field);
    return;
  }
  const value = normalizeBlank(body[field]);
  if (value == null) {
    if (required) throw rejectEmployeeInput(field);
    body[field] = null;
    return;
  }
  const email = validateNoDangerousText(field, value).toLowerCase();
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]{2,}$/.test(email)) throw rejectEmployeeInput(field);
  body[field] = email;
}

function validateEmployeePhoneField(body, field, { required = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) {
    if (required) throw rejectEmployeeInput(field);
    return;
  }
  const value = normalizeBlank(body[field]);
  if (value == null) {
    if (required) throw rejectEmployeeInput(field);
    body[field] = null;
    return;
  }
  const phone = validateNoDangerousText(field, value).replace(/[\s()-]/g, '');
  if (!/^(09\d{9}|\+639\d{9})$/.test(phone)) throw rejectEmployeeInput(field);
  body[field] = phone;
}

function validateEmployeeDateField(body, field, { required = false, noFuture = false } = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) {
    if (required) throw rejectEmployeeInput(field);
    return;
  }
  const value = normalizeBlank(body[field]);
  if (value == null) {
    if (required) throw rejectEmployeeInput(field);
    body[field] = null;
    return;
  }
  try {
    body[field] = strictDateOnly(value, field, { noFuture });
  } catch (_) {
    throw rejectEmployeeInput(field);
  }
}

function validateEmployeeYearField(body, field) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  const value = normalizeBlank(body[field]);
  if (value == null) {
    body[field] = null;
    return;
  }
  if (!/^\d{4}$/.test(value)) throw rejectEmployeeInput(field);
  const year = Number(value);
  const currentYear = new Date().getFullYear() + 1;
  if (year < 1900 || year > currentYear) throw rejectEmployeeInput(field);
  body[field] = String(year);
}

function validateEmployeeEnumField(body, field, allowed = EMPLOYEE_ENUMS[field]) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  const value = normalizeBlank(body[field]);
  if (value == null) {
    body[field] = null;
    return;
  }
  validateNoDangerousText(field, value);
  if (!allowed || !allowed.has(value)) throw rejectEmployeeInput(field);
  body[field] = value;
}

function normalizePayrollSchedule(value) {
  const normalized = normalizePayrollScheduleValue(value);
  if (normalized) return normalized;
  throw rejectEmployeeInput('payroll_schedule');
}

function validateEmployeeMoneyField(body, field, { max = 1000000 } = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  const value = normalizeBlank(body[field]);
  if (value == null) {
    body[field] = null;
    return;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) throw rejectEmployeeInput(field);
  body[field] = number.toFixed(2);
}

function validateGovernmentIdField(body, field, pattern) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  const value = normalizeBlank(body[field]);
  if (value == null) {
    body[field] = null;
    return;
  }
  const text = validateNoDangerousText(field, value);
  const digits = text.replace(/\D/g, '');
  if (!/^[\d\s-]+$/.test(text)) throw rejectEmployeeInput(field, 'This field must contain numbers only.');
  if (!pattern.test(digits)) throw rejectEmployeeInput(field, 'Please enter the required number of digits.');
  body[field] = digits;
}

function normalizeEmployeeBankName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function resolveEmployeeBankAccountFormat(bankName) {
  const normalized = normalizeEmployeeBankName(bankName);
  if (!normalized) return null;
  return EMPLOYEE_BANK_ACCOUNT_FORMATS.find(rule =>
    rule.aliases.some(alias => {
      const normalizedAlias = normalizeEmployeeBankName(alias);
      return normalized === normalizedAlias || normalized.includes(normalizedAlias);
    })
  ) || null;
}

function describeAllowedDigitLengths(lengths) {
  return lengths.map(length => `${length} digits`).join(' or ');
}

function validateBankAccountField(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'bank_account')) return;
  const value = normalizeBlank(body.bank_account);
  if (value == null) {
    body.bank_account = null;
    return;
  }

  const text = validateNoDangerousText('bank_account', value);
  const digits = text.replace(/\D/g, '');
  if (!/^\d+$/.test(text)) throw rejectEmployeeInput('bank_account', 'This field must contain numbers only.');

  const bankFormat = resolveEmployeeBankAccountFormat(body.bank_name);
  if (bankFormat && !bankFormat.lengths.includes(digits.length)) {
    throw rejectEmployeeInput(
      'bank_account',
      `${bankFormat.label} account numbers must contain ${describeAllowedDigitLengths(bankFormat.lengths)}.`
    );
  }

  if (!bankFormat && (digits.length < 6 || digits.length > 20)) {
    throw rejectEmployeeInput('bank_account', 'For unconfigured banks, enter a numeric account number from 6 to 20 digits.');
  }

  body.bank_account = digits;
}

function validateLatLngField(body, field, min, max) {
  if (!Object.prototype.hasOwnProperty.call(body, field)) return;
  const value = normalizeBlank(body[field]);
  if (value == null) {
    body[field] = null;
    return;
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw rejectEmployeeInput(field);
  body[field] = String(number);
}

function validateDateOrder(body, startField, endField) {
  if (!body[startField] || !body[endField]) return;
  if (String(body[endField]) < String(body[startField])) throw rejectEmployeeInput(endField);
}

async function auditEmployeeSensitiveField(req, field, targetEmployeeId, oldValue, newValue, result) {
  await auditSecurityEvent(req, {
    action: result === 'blocked' ? 'employee_sensitive_field_tampering_blocked' : 'employee_sensitive_field_updated',
    module: 'EMPLOYEE_SECURITY',
    targetTable: 'employees',
    targetRecord: targetEmployeeId || req.params?.id || null,
    oldValue: { field, present: oldValue !== undefined && oldValue !== null },
    newValue: { field, present: newValue !== undefined && newValue !== null, path: req.originalUrl },
    result,
  });
}

async function rejectEmployeeFieldTampering(req, res, field, oldValue = null, newValue = null) {
  await auditEmployeeSensitiveField(req, field, req.params?.id || req.body?.id || null, oldValue, newValue, 'blocked');
  return res.status(403).json({ error: 'You are not allowed to modify this field.', field });
}

async function rejectEmployeeUnknownFields(req, res, fields) {
  await auditSecurityEvent(req, {
    action: 'blocked_employee_unknown_fields',
    module: 'EMPLOYEE_SECURITY',
    targetTable: 'employees',
    targetRecord: req.params?.id || null,
    newValue: { fields, path: req.originalUrl },
    result: 'blocked',
  });
  return res.status(400).json({
    error: 'Request contains unsupported employee field(s).',
    fields,
  });
}

async function rejectEmployeeUnsupportedSubresourceFields(req, res, allowedFields, resource) {
  const unknownFields = Object.keys(req.body || {}).filter(field => !allowedFields.has(field));
  if (!unknownFields.length) return false;
  await auditSecurityEvent(req, {
    action: 'blocked_employee_subresource_unknown_fields',
    module: 'EMPLOYEE_SECURITY',
    targetTable: 'employees',
    targetRecord: req.params?.id || null,
    newValue: { resource, fields: unknownFields, path: req.originalUrl },
    result: 'blocked',
  });
  res.status(400).json({ error: 'Request contains unsupported field(s).', fields: unknownFields });
  return true;
}

async function rejectUnsupportedRouteFields(req, res, allowedFields, { module = 'API_FIELD_VALIDATION', action = 'blocked_unsupported_route_fields' } = {}) {
  const unknownFields = Object.keys(req.body || {}).filter(field => !allowedFields.has(field));
  if (!unknownFields.length) return false;
  await auditSecurityEvent(req, {
    action,
    module,
    targetTable: req.originalUrl || null,
    targetRecord: req.params?.id || req.body?.id || null,
    newValue: { fields: unknownFields, path: req.originalUrl },
    result: 'blocked',
  });
  res.status(400).json({ error: 'Request contains unsupported field(s).', fields: unknownFields });
  return true;
}

function validateEmployeeSubresourceBody(body, fields, { dateFields = [], numericFields = [] } = {}) {
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    if (dateFields.includes(field)) {
      validateEmployeeDateField(body, field);
      continue;
    }
    if (numericFields.includes(field)) {
      const value = normalizeBlank(body[field]);
      if (value == null) {
        body[field] = null;
        continue;
      }
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0 || number > 10000) throw rejectEmployeeInput(field);
      body[field] = String(number);
      continue;
    }
    const value = normalizeBlank(body[field]);
    body[field] = value == null ? null : validateNoDangerousText(field, value).replace(/\s+/g, ' ');
  }
}

async function ensureEmployeeRouteAccess(pool, req, res, { param = 'id', action = 'blocked_employee_idor_attempt' } = {}) {
  const rawId = req.params?.[param];
  let employeeId = Number.parseInt(rawId, 10);
  if (!Number.isInteger(employeeId) || employeeId <= 0) {
    const [rows] = await pool.execute('SELECT id FROM employees WHERE employee_code = ? LIMIT 1', [rawId]);
    employeeId = rows[0]?.id || null;
  }
  if (!employeeId) {
    res.status(404).json({ error: 'Employee not found.' });
    return null;
  }
  if (!canAccessEmployeeRecord(req, employeeId, { allowPermission: false })) {
    await rejectEmployeeIdor(req, res, employeeId, action);
    return null;
  }
  return employeeId;
}

function canAccessEmployeeRecord(req, targetEmployeeId, { allowPayroll = false, allowPermission = true } = {}) {
  const employeeId = Number(targetEmployeeId);
  if (!Number.isFinite(employeeId) || employeeId <= 0) return false;
  if (Number(req.user?.employeeId) === employeeId) return true;
  if (ROLES.staff_management.includes(req.user?.role)) return true;
  if (allowPayroll && ROLES.payroll_any.includes(req.user?.role)) return true;
  return allowPermission
    && !ROLES.admin_any.includes(req.user?.role)
    && hasPermission(req, 'employee:read')
    && req.user?.role !== 'employee';
}

async function rejectEmployeeIdor(req, res, targetEmployeeId, action = 'blocked_employee_idor_attempt') {
  await auditSecurityEvent(req, {
    action,
    module: 'IDOR_SECURITY',
    targetTable: 'employees',
    targetRecord: targetEmployeeId || req.params?.id || null,
    newValue: {
      method: req.method,
      path: req.originalUrl,
      requested_employee_id: targetEmployeeId || null,
    },
    result: 'blocked',
  });
  return res.status(403).json({ error: 'Access denied.' });
}

function applyEmployeeUpdateDefaults(body, existingEmployee) {
  if (!existingEmployee) return;
  for (const field of EMPLOYEE_UPDATE_DEFAULT_FIELDS) {
    if (
      !Object.prototype.hasOwnProperty.call(body, field) &&
      Object.prototype.hasOwnProperty.call(existingEmployee, field)
    ) {
      body[field] = EMPLOYEE_STRICT_PII_COLUMNS.includes(field)
        ? safeDecryptEmployeeColumnValue(existingEmployee, field)
        : existingEmployee[field];
    }
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'employment_status') && existingEmployee.status !== undefined) {
    body.employment_status = existingEmployee.status;
  }
}

function hasMeaningfulSubmittedValue(value) {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return String(value).trim() !== '';
}

function comparableEmployeeValue(value) {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function employeeFieldUnchanged(existing, field, submittedValue) {
  if (!existing) return false;
  const existingField = field === 'allowance' ? 'allowances' : field;
  if (!Object.prototype.hasOwnProperty.call(existing, existingField)) return false;
  const currentValue = EMPLOYEE_STRICT_PII_COLUMNS.includes(existingField)
    ? safeDecryptEmployeeColumnValue(existing, existingField)
    : existing[existingField];
  const current = comparableEmployeeValue(currentValue);
  const submitted = comparableEmployeeValue(submittedValue);
  if (['allowances', 'allowance', 'base_rate'].includes(field) && current !== '' && submitted !== '') {
    return Number(current) === Number(submitted);
  }
  return current === submitted;
}

function stripUnauthorizedEmployeeField(body, field) {
  delete body[field];
  if (field === 'allowance') delete body.allowances;
  if (field === 'allowances') delete body.allowance;
}

async function validateDepartmentId(pool, body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'department_id')) return;
  const value = normalizeBlank(body.department_id);
  if (value == null) {
    body.department_id = null;
    return;
  }
  const departmentId = Number(value);
  if (!Number.isInteger(departmentId) || departmentId <= 0) throw rejectEmployeeInput('department_id');
  const [rows] = await pool.execute('SELECT id FROM departments WHERE id = ? AND is_active = 1 LIMIT 1', [departmentId]);
  if (!rows.length) throw rejectEmployeeInput('department_id');
  body.department_id = departmentId;
}

async function validateWageType(pool, body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'wage_type')) return;
  const value = normalizeBlank(body.wage_type);
  if (value == null) {
    body.wage_type = null;
    return;
  }
  const normalized = normalizeWageTypeInput(value);
  const [rows] = await pool.execute('SELECT id, name FROM wage_types WHERE LOWER(name) = LOWER(?) LIMIT 1', [normalized]);
  if (!rows.length) throw rejectEmployeeInput('wage_type');
  body.wage_type = rows[0].name;
}

async function validateEmployeeRequestBody(req, res, pool, { mode = 'update' } = {}) {
  const body = req.body || {};
  if (Object.prototype.hasOwnProperty.call(body, 'employment_status') && !Object.prototype.hasOwnProperty.call(body, 'status')) {
    body.status = body.employment_status;
  }
  const allowedFields = mode === 'create' ? EMPLOYEE_CREATE_ALLOWED_FIELDS : EMPLOYEE_UPDATE_ALLOWED_FIELDS;
  const unknownFields = Object.keys(body).filter(field => !allowedFields.has(field));
  if (unknownFields.length) {
    return rejectEmployeeUnknownFields(req, res, unknownFields);
  }

  const isHrOrAdmin = employeeHasRole(req, [...ROLES.hr_manager, ...ROLES.admin_any]);
  const isPayrollOrAdmin = employeeHasRole(req, [...ROLES.payroll_any, ...ROLES.admin_any]);
  // HR owns employee onboarding and compensation setup. This permission is
  // limited to employee master-data fields; payroll generation, approval,
  // finalization, and report export remain protected by payroll-only routes.
  const canManagePayrollSetup = isPayrollOrAdmin || isHrOrAdmin;
  let existingForUpdate = null;
  if (mode === 'update') {
    const [existingRows] = await pool.execute('SELECT * FROM employees WHERE id = ? OR employee_code = ? LIMIT 1', [req.params.id, req.params.id]);
    existingForUpdate = existingRows[0] || null;
  }

  for (const field of Object.keys(body)) {
    if (EMPLOYEE_HR_PROTECTED_FIELDS.has(field) && !isHrOrAdmin) {
      return rejectEmployeeFieldTampering(req, res, field, null, body[field]);
    }
    if (EMPLOYEE_WAGE_CONFIG_FIELDS.has(field) && !canManagePayrollSetup) {
      if (!hasMeaningfulSubmittedValue(body[field]) || mode === 'update') {
        stripUnauthorizedEmployeeField(body, field);
        continue;
      }
      return rejectEmployeeFieldTampering(req, res, field, null, body[field]);
    }
    if (EMPLOYEE_GOVERNMENT_ID_FIELDS.has(field) && !isPayrollOrAdmin && !isHrOrAdmin) {
      return rejectEmployeeFieldTampering(req, res, field, null, body[field]);
    }
    if (EMPLOYEE_PAYROLL_ONLY_FIELDS.has(field) && !canManagePayrollSetup) {
      if (!hasMeaningfulSubmittedValue(body[field]) || employeeFieldUnchanged(existingForUpdate, field, body[field])) {
        stripUnauthorizedEmployeeField(body, field);
        continue;
      }
      return rejectEmployeeFieldTampering(req, res, field, null, body[field]);
    }
  }

  if (mode === 'update') {
    const existing = existingForUpdate;
    if (existing) {
      for (const field of [...EMPLOYEE_PAYROLL_PROTECTED_FIELDS, ...EMPLOYEE_HR_PROTECTED_FIELDS]) {
        if (Object.prototype.hasOwnProperty.call(body, field)) {
          const oldValue = existing[field] ?? (field === 'allowance' ? existing.allowances : null);
          if (String(oldValue ?? '') !== String(body[field] ?? '')) {
            await auditEmployeeSensitiveField(req, field, existing.id, oldValue, body[field], 'allowed');
          }
        }
      }
    }
  }

  try {
    [
      'first_name', 'middle_name', 'last_name', 'suffix', 'nationality', 'marital_status',
      'place_of_birth', 'religion',
      'emergency_contact_name', 'emergency_contact_relationship',
      'education_school', 'education_attainment', 'education_jhs_school',
      'education_jhs_attainment', 'education_shs_school', 'education_shs_attainment',
      'education_vocational_school', 'education_vocational_attainment',
      'education_college_school', 'education_college_attainment', 'agency_contact_person',
      'separation_reason'
    ].forEach(field => validateEmployeeTextField(body, field, { max: field.includes('school') ? 180 : 120 }));
    validateEmployeeNameLikeField(body, 'supervisor', { max: 120 });

    validateEmployeeTextField(body, 'offboarding_remarks', { max: 500, pattern: EMPLOYEE_SAFE_TEXT_PATTERN });

    ['position', 'shift_schedule', 'salary_grade', 'bank_name', 'agency_name'].forEach(field => {
      validateEmployeeTextField(body, field, { max: 160, pattern: EMPLOYEE_SAFE_TEXT_PATTERN });
    });

    // Work locations use the same normal punctuation and numbering as addresses.
    validateEmployeeTextField(body, 'work_location', { max: 160, pattern: EMPLOYEE_ADDRESS_PATTERN });

    [
      'residential_address', 'current_address', 'mailing_address', 'emergency_contact_address',
      'residential_address_full_address', 'current_address_full_address', 'mailing_address_full_address',
      'residential_address_street_address', 'current_address_street_address', 'mailing_address_street_address'
    ].forEach(field => validateEmployeeTextField(body, field, { max: 500, pattern: EMPLOYEE_ADDRESS_PATTERN }));

    [
      'residential_address_region', 'residential_address_province', 'residential_address_city_municipality',
      'residential_address_barangay', 'current_address_region', 'current_address_province',
      'current_address_city_municipality', 'current_address_barangay', 'mailing_address_region',
      'mailing_address_province', 'mailing_address_city_municipality', 'mailing_address_barangay'
    ].forEach(field => validateEmployeeTextField(body, field, { max: 160, pattern: EMPLOYEE_SAFE_TEXT_PATTERN }));

    validateEmployeeEmailField(body, 'email', { required: true });
    validateEmployeeEmailField(body, 'work_email');
    validateEmployeeEmailField(body, 'emergency_contact_email');
    validateEmployeePhoneField(body, 'contact_number');
    validateEmployeePhoneField(body, 'emergency_contact_num');
    validateEmployeePhoneField(body, 'emergency_contact_number');
    validateEmployeePhoneField(body, 'emergency_contact_secondary_num');
    validateEmployeePhoneField(body, 'agency_contact_number');

    ['gender', 'nationality', 'marital_status', 'blood_type', 'employment_type', 'hiring_type', 'deployment_status', 'employee_level', 'status', 'tax_status']
      .forEach(field => validateEmployeeEnumField(body, field));

    ['date_of_birth', 'date_hired', 'end_of_contract', 'contract_start_date', 'contract_end_date', 'separation_date', 'wage_effective_date'].forEach(field => {
      validateEmployeeDateField(body, field, { noFuture: field === 'date_of_birth' });
    });
    validateDateOrder(body, 'date_hired', 'end_of_contract');
    validateDateOrder(body, 'contract_start_date', 'contract_end_date');

    [
      'education_year_graduated', 'education_jhs_from', 'education_jhs_to', 'education_jhs_year_graduated',
      'education_shs_from', 'education_shs_to', 'education_shs_year_graduated',
      'education_vocational_from', 'education_vocational_to', 'education_vocational_year_graduated',
      'education_college_from', 'education_college_to', 'education_college_year_graduated'
    ].forEach(field => validateEmployeeYearField(body, field));
    validateDateOrder(body, 'education_jhs_from', 'education_jhs_to');
    validateDateOrder(body, 'education_shs_from', 'education_shs_to');
    validateDateOrder(body, 'education_vocational_from', 'education_vocational_to');
    validateDateOrder(body, 'education_college_from', 'education_college_to');

    ['residential_address_lat', 'current_address_lat', 'mailing_address_lat'].forEach(field => validateLatLngField(body, field, -90, 90));
    ['residential_address_lng', 'current_address_lng', 'mailing_address_lng'].forEach(field => validateLatLngField(body, field, -180, 180));

    await validateDepartmentId(pool, body);
    await validateWageType(pool, body);

    if (Object.prototype.hasOwnProperty.call(body, 'payroll_schedule') && body.payroll_schedule != null && body.payroll_schedule !== '') {
      body.payroll_schedule = normalizePayrollSchedule(body.payroll_schedule);
    }
    validateEmployeeMoneyField(body, 'allowances');
    validateEmployeeMoneyField(body, 'allowance');
    validateEmployeeMoneyField(body, 'base_rate');
    validateGovernmentIdField(body, 'sss_number', /^\d{10}$/);
    validateGovernmentIdField(body, 'tin', /^\d{9}$/);
    validateGovernmentIdField(body, 'philhealth_number', /^\d{12}$/);
    validateGovernmentIdField(body, 'pagibig_number', /^\d{12}$/);
    validateBankAccountField(body);

    if (Array.isArray(body.sewingRates)) {
      for (const rate of body.sewingRates) {
        if (!Number.isInteger(Number(rate.sewing_id)) || Number(rate.sewing_id) <= 0) throw rejectEmployeeInput('sewingRates');
        const value = Number(rate.rate);
        if (!Number.isFinite(value) || value < 0 || value > 1000000) throw rejectEmployeeInput('sewingRates');
      }
    } else if (Object.prototype.hasOwnProperty.call(body, 'sewingRates') && body.sewingRates != null) {
      throw rejectEmployeeInput('sewingRates');
    }
  } catch (error) {
    await auditSecurityEvent(req, {
      action: 'blocked_employee_invalid_input',
      module: 'EMPLOYEE_SECURITY',
      targetTable: 'employees',
      targetRecord: req.params?.id || null,
      newValue: { field: error.field || null, reason: error.reason || null, path: req.originalUrl },
      result: 'blocked',
    });
    return res.status(error.status || 400).json({
      error: error.message || 'Invalid employee input.',
      field: error.field || null,
      reason: error.reason || null
    });
  }

  return null;
}

function lifecycleTruthy(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on' || value === 'yes';
}

function normalizeHiringType(value) {
  return String(value || '').trim() === 'Agency-Hired' ? 'Agency-Hired' : 'Direct Hire';
}

function normalizeEmployeeEmploymentType(value, hiringType) {
  if (hiringType === 'Agency-Hired') return 'Contractual';
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized.includes('part')) return 'Part-time';
  if (normalized.includes('contract')) return 'Contractual';
  return 'Full-time';
}

function optionalLifecycleDate(value, field) {
  if (value == null || value === '') return null;
  return strictDateOnly(value, field);
}

function normalizeLifecycleAction(value) {
  const action = String(value || 'AUTO').trim().toUpperCase();
  const allowed = new Set(['AUTO', 'DIRECT_ACTIVE', 'SCREENING_REQUIRED', 'TRAINING_REQUIRED', 'ON_HOLD']);
  return allowed.has(action) ? action : 'AUTO';
}

function lifecycleNote(value) {
  return String(value || '').trim().replace(/[\x00<>]/g, '').slice(0, 500);
}

function employeeCodeNumber(code) {
  const match = String(code || '').trim().match(/^EMP0*(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

function formatEmployeeCode(number, config = {}) {
  const prefix = String(config.prefix || 'EMP').trim().toUpperCase();
  const padding = Math.min(Math.max(Number(config.number_padding || 6), 1), 12);
  return `${prefix}${String(Number(number || 0)).padStart(padding, '0')}`;
}

function sanitizeEmployeeCode(value) {
  return String(value || '').trim().toUpperCase();
}

function isValidEmployeeCode(value) {
  return /^[A-Z0-9_-]+$/i.test(String(value || '').trim());
}

async function employeeColumnExists(executor, columnName) {
  const [rows] = await executor.execute(
    `SELECT COUNT(*) AS total
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'employees'
        AND COLUMN_NAME = ?`,
    [columnName]
  );
  return Number(rows[0]?.total || 0) > 0;
}

async function ensureEmployeeAuthColumns(executor) {
  if (!(await employeeColumnExists(executor, 'Password_Hash'))) {
    await executor.execute('ALTER TABLE employees ADD COLUMN Password_Hash VARCHAR(255) NULL');
  }
  if (!(await employeeColumnExists(executor, 'Password_Changed_At'))) {
    await executor.execute('ALTER TABLE employees ADD COLUMN Password_Changed_At DATETIME NULL');
  }
  if (!(await employeeColumnExists(executor, 'Failed_Login_Attempts'))) {
    await executor.execute('ALTER TABLE employees ADD COLUMN Failed_Login_Attempts INT NOT NULL DEFAULT 0');
  }
  if (!(await employeeColumnExists(executor, 'force_password_change'))) {
    await executor.execute('ALTER TABLE employees ADD COLUMN force_password_change BOOLEAN NOT NULL DEFAULT FALSE');
  }
}

async function ensureEmployeeIdConfigSchema(executor) {
  const [codeColumn] = await executor.execute("SHOW COLUMNS FROM employees LIKE 'employee_code'");
  if (!codeColumn.length) {
    await executor.execute('ALTER TABLE employees ADD COLUMN employee_code VARCHAR(20) NULL AFTER id');
  }

  const [duplicateRows] = await executor.execute(`
    SELECT employee_code, COUNT(*) AS total
      FROM employees
     WHERE employee_code IS NOT NULL AND employee_code <> ''
     GROUP BY employee_code
    HAVING COUNT(*) > 1
     LIMIT 1
  `);
  if (!duplicateRows.length) {
    const [indexRows] = await executor.execute(`
      SELECT COUNT(*) AS total
        FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'employees'
         AND INDEX_NAME = 'uq_employees_employee_code'
    `);
    if (!Number(indexRows[0]?.total || 0)) {
      try {
        await executor.execute('CREATE UNIQUE INDEX uq_employees_employee_code ON employees (employee_code)');
      } catch (err) {
        if (err.code !== 'ER_DUP_KEYNAME' && err.code !== 'ER_DUP_ENTRY') throw err;
      }
    }
  } else {
    console.warn('Employee code unique index skipped because duplicate employee_code values already exist.');
  }

  await executor.execute(`
    CREATE TABLE IF NOT EXISTS employee_id_config (
      id TINYINT PRIMARY KEY DEFAULT 1,
      prefix VARCHAR(12) NOT NULL DEFAULT 'EMP',
      starting_number INT NOT NULL DEFAULT 1,
      number_padding TINYINT NOT NULL DEFAULT 6,
      current_sequence INT NOT NULL DEFAULT 0,
      auto_generate_enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  const [rows] = await executor.execute('SELECT COUNT(*) AS total FROM employee_id_config WHERE id = 1');
  if (!Number(rows[0]?.total || 0)) {
    const [onboardingTables] = await executor.execute("SHOW TABLES LIKE 'onboarding_applicant'");
    const [maxRows] = onboardingTables.length
      ? await executor.execute(
          `SELECT employee_code AS code FROM employees WHERE employee_code LIKE 'EMP%'
           UNION ALL
           SELECT intended_employee_code AS code
             FROM onboarding_applicant
            WHERE deleted_at IS NULL
              AND intended_employee_code IS NOT NULL
              AND intended_employee_code LIKE 'EMP%'`
        )
      : await executor.execute("SELECT employee_code AS code FROM employees WHERE employee_code LIKE 'EMP%'");
    const maxSequence = maxRows.reduce((max, row) => Math.max(max, employeeCodeNumber(row.code)), 0);
    await executor.execute(
      `INSERT INTO employee_id_config
         (id, prefix, starting_number, number_padding, current_sequence, auto_generate_enabled)
       VALUES (1, 'EMP', 1, 6, ?, 1)`,
      [maxSequence]
    );
  }
}

async function getEmployeeIdConfig(executor) {
  await ensureEmployeeIdConfigSchema(executor);
  const [[config]] = await executor.execute('SELECT * FROM employee_id_config WHERE id = 1');
  return config || {
    prefix: 'EMP',
    starting_number: 1,
    number_padding: 6,
    current_sequence: 0,
    auto_generate_enabled: 1,
  };
}

async function generateNextEmployeeCode(executor, reserve = false) {
  await ensureEmployeeIdConfigSchema(executor);

  if (reserve) {
    const [[config]] = await executor.execute('SELECT * FROM employee_id_config WHERE id = 1 FOR UPDATE');
    const nextSequence = Math.max(Number(config.current_sequence || 0) + 1, Number(config.starting_number || 1));
    await executor.execute('UPDATE employee_id_config SET current_sequence = ? WHERE id = 1', [nextSequence]);
    return formatEmployeeCode(nextSequence, config);
  }

  const config = await getEmployeeIdConfig(executor);
  const nextSequence = Math.max(Number(config.current_sequence || 0) + 1, Number(config.starting_number || 1));
  return formatEmployeeCode(nextSequence, config);
}

function personLabel(row) {
  const name = [row.first_name, row.last_name]
    .map(value => value ? decryptColumnValue(value) : null)
    .filter(Boolean)
    .join(' ')
    .trim();
  return name ? `${name} (${row.employee_code || row.applicant_code || 'no code'})` : (row.employee_code || row.applicant_code || 'existing record');
}

async function findEmployeeIntakeDuplicate(executor, employeeCode, email) {
  const [employeeCodeRows] = await executor.execute(
    `SELECT id, employee_code, email, first_name, last_name
       FROM employees
      WHERE employee_code = ?
      LIMIT 1`,
    [employeeCode]
  );
  if (employeeCodeRows.length) {
    return {
      source: 'Employee Directory',
      field: 'employee_code',
      message: `Employee code ${employeeCode} already exists in the Employee Directory for ${personLabel(employeeCodeRows[0])}.`,
      record: employeeCodeRows[0],
    };
  }

  const [employeeEmailRows] = await executor.execute(
    `SELECT id, employee_code, email, first_name, last_name
       FROM employees
      WHERE email_hash = SHA2(LOWER(?), 256)
      LIMIT 1`,
    [email]
  );
  if (employeeEmailRows.length) {
    return {
      source: 'Employee Directory',
      field: 'email',
      message: `Email ${email} is already used in the Employee Directory by ${personLabel(employeeEmailRows[0])}. Use a different email, or edit the existing employee record instead.`,
      record: employeeEmailRows[0],
    };
  }

  const [onboardingCodeRows] = await executor.execute(
    `SELECT applicant_id, applicant_code, intended_employee_code, first_name, last_name, workflow_status
       FROM onboarding_applicant
      WHERE deleted_at IS NULL
        AND intended_employee_code = ?
      LIMIT 1`,
    [employeeCode]
  );
  if (onboardingCodeRows.length) {
    return {
      source: 'Onboarding',
      field: 'employee_code',
      message: `Employee code ${employeeCode} is already reserved by onboarding record ${personLabel(onboardingCodeRows[0])}.`,
      record: onboardingCodeRows[0],
    };
  }

  const [onboardingEmailRows] = await executor.execute(
    `SELECT applicant_id, applicant_code, intended_employee_code AS employee_code, first_name, last_name, workflow_status
       FROM onboarding_applicant
      WHERE deleted_at IS NULL
        AND email_hash = SHA2(LOWER(?), 256)
      LIMIT 1`,
    [email]
  );
  if (onboardingEmailRows.length) {
    return {
      source: 'Onboarding',
      field: 'email',
      message: `Email ${email} is already active in onboarding as ${personLabel(onboardingEmailRows[0])}. Continue that onboarding record instead of creating a duplicate.`,
      record: onboardingEmailRows[0],
    };
  }

  return null;
}

async function employeeIntakeDuplicatePayload(executor, duplicate) {
  const payload = {
    error: duplicate.message,
    duplicate: {
      source: duplicate.source,
      field: duplicate.field,
      record_code: duplicate.record.employee_code || duplicate.record.intended_employee_code || duplicate.record.applicant_code || null,
      record_id: duplicate.record.id || duplicate.record.applicant_id || null,
      workflow_status: duplicate.record.workflow_status || null,
    },
  };
  if (duplicate.field === 'employee_code') {
    payload.next_employee_code = await generateNextEmployeeCode(executor);
  }
  return payload;
}

async function writeEmployeeLifecycleAudit(executor, req, action, targetEmployeeId, oldValue = null, newValue = null) {
  await executor.execute(
    `INSERT INTO system_audit_log
       (user_id, employee_id, target_employee_id, action_performed, module,
        old_value, new_value, ip_address, user_agent)
     VALUES (?, ?, ?, ?, 'EMPLOYEE_LIFECYCLE', ?, ?, ?, ?)`,
    [
      req.user.id,
      req.user.employeeId || null,
      targetEmployeeId || null,
      action,
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
      String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 45),
      String(req.headers['user-agent'] || 'unknown').slice(0, 500),
    ]
  );
}

// Employees
app.get('/api/employees/next-code', requireAuth, requireRole(ROLES.staff_management), async (_req, res) => {
  try {
    const pool = require('./config/db');
    const config = await getEmployeeIdConfig(pool);
    const employeeCode = await generateNextEmployeeCode(pool);
    res.json({ employee_code: employeeCode, config });
  } catch (err) {
    console.error('Error generating next employee code:', err);
    res.status(500).json({ error: 'Failed to generate employee code.' });
  }
});

app.get('/api/employees/id-config', requireAuth, requireRole(EMPLOYEE_ID_ADMIN_ROLES), async (_req, res) => {
  try {
    const pool = require('./config/db');
    const config = await getEmployeeIdConfig(pool);
    res.json(config);
  } catch (err) {
    console.error('Error loading employee ID config:', err);
    res.status(500).json({ error: 'Failed to load employee ID configuration.' });
  }
});

app.put('/api/employees/id-config', requireAuth, requireRole(EMPLOYEE_ID_ADMIN_ROLES), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeIdConfigSchema(pool);
    if (await rejectUnsupportedRouteFields(req, res, EMPLOYEE_ID_CONFIG_ALLOWED_FIELDS, { module: 'EMPLOYEE_ID_SECURITY' })) return;

    const prefix = sanitizeEmployeeCode(req.body.prefix || 'EMP');
    const startingNumber = Number(req.body.starting_number || 1);
    const numberPadding = Number(req.body.number_padding || 6);
    const currentSequence = Number(req.body.current_sequence || 0);
    const autoGenerateEnabled = req.body.auto_generate_enabled === false || req.body.auto_generate_enabled === '0' ? 0 : 1;

    if (!prefix || !/^[A-Z0-9_-]+$/i.test(prefix)) {
      return res.status(400).json({ error: 'Prefix can only contain letters, numbers, hyphens, and underscores.' });
    }
    if (prefix.length > 12) return res.status(400).json({ error: 'Prefix is too long.' });
    if (!Number.isInteger(startingNumber) || startingNumber < 1) return res.status(400).json({ error: 'Starting number must be greater than zero.' });
    if (!Number.isInteger(numberPadding) || numberPadding < 1 || numberPadding > 12) return res.status(400).json({ error: 'Number padding must be between 1 and 12.' });
    if (!Number.isInteger(currentSequence) || currentSequence < 0) return res.status(400).json({ error: 'Current sequence must be zero or greater.' });

    if (autoGenerateEnabled) {
      await ensureOnboardingLifecycleSchema(pool);
      const nextSequence = Math.max(currentSequence + 1, startingNumber);
      const nextEmployeeCode = formatEmployeeCode(nextSequence, {
        prefix,
        number_padding: numberPadding,
      });
      const duplicate = await findEmployeeIntakeDuplicate(pool, nextEmployeeCode, 'employee-id-config-check@example.invalid');
      if (duplicate?.field === 'employee_code') {
        return res.status(400).json({
          error: `Employee ID configuration would generate duplicate ID ${nextEmployeeCode}. Increase the current sequence or use a different prefix.`,
          next_employee_code: nextEmployeeCode,
        });
      }
    }

    const [[oldConfig]] = await pool.execute('SELECT * FROM employee_id_config WHERE id = 1');
    await pool.execute(
      `UPDATE employee_id_config
          SET prefix = ?, starting_number = ?, number_padding = ?, current_sequence = ?, auto_generate_enabled = ?
        WHERE id = 1`,
      [prefix, startingNumber, numberPadding, currentSequence, autoGenerateEnabled]
    );
    const config = await getEmployeeIdConfig(pool);
    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_ID_CONFIGURATION_UPDATED', null, oldConfig, config);
    res.json({ message: 'Employee ID configuration saved.', config });
  } catch (err) {
    console.error('Error saving employee ID config:', err);
    res.status(500).json({ error: 'Failed to save employee ID configuration.' });
  }
});

app.get('/api/employees/code-available/:code', requireAuth, requireRole(EMPLOYEE_ID_ADMIN_ROLES), async (req, res) => {
  try {
    const pool = require('./config/db');
    const code = sanitizeEmployeeCode(req.params.code);
    if (!code) return res.status(400).json({ error: 'Employee ID is required.' });
    if (!isValidEmployeeCode(code)) return res.status(400).json({ error: 'Employee ID can only contain letters, numbers, hyphens, and underscores.' });
    await ensureOnboardingLifecycleSchema(pool);
    const duplicate = await findEmployeeIntakeDuplicate(pool, code, 'employee-code-check-placeholder@example.invalid');
    res.json({ available: !duplicate || duplicate.field !== 'employee_code' });
  } catch (err) {
    console.error('Error checking employee code:', err);
    res.status(500).json({ error: 'Failed to check employee ID.' });
  }
});

async function ensureEmployeeSetupSchema(pool) {
  const [departmentColumns] = await pool.execute("SHOW COLUMNS FROM departments LIKE 'is_active'");
  if (!departmentColumns.length) {
    await pool.execute('ALTER TABLE departments ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1');
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS positions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      department_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_positions_department_name (department_id, name),
      CONSTRAINT fk_positions_department
        FOREIGN KEY (department_id) REFERENCES departments(id)
        ON DELETE CASCADE
    )
  `);
}

async function ensureEmployeeLifecycleColumns(pool) {
  const [statusColumns] = await pool.execute("SHOW COLUMNS FROM employees LIKE 'status'");
  if (statusColumns.length && !String(statusColumns[0].Type || '').includes('Offboarded')) {
    await pool.execute(
      "ALTER TABLE employees MODIFY COLUMN status ENUM('Active','Inactive','Resigned','Terminated','End of Contract','Suspended','Retired','Offboarded','Rehired') NOT NULL DEFAULT 'Active'"
    );
  }

  const columns = [
    ['hiring_type', "ENUM('Direct Hire','Agency-Hired') NULL DEFAULT 'Direct Hire'"],
    ['agency_name', 'VARCHAR(180) NULL'],
    ['agency_contact_person', 'VARCHAR(180) NULL'],
    ['agency_contact_number', 'VARCHAR(80) NULL'],
    ['deployment_status', "ENUM('Pending Deployment','Deployed','On Hold','Ended') NULL DEFAULT 'Pending Deployment'"],
    ['contract_start_date', 'DATE NULL'],
    ['contract_end_date', 'DATE NULL'],
    ['lifecycle_status', "ENUM('Active','Pending Onboarding','Pending Training','On Hold') NULL DEFAULT 'Active'"],
    ['separation_date', 'DATE NULL'],
    ['separation_reason', 'VARCHAR(120) NULL'],
    ['offboarding_remarks', 'VARCHAR(500) NULL'],
    ['offboarding_clearance_result', "ENUM('Pending','Cleared','Not Cleared','Not Applicable') NULL"],
    ['updated_at', 'TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'],
  ];

  for (const [name, definition] of columns) {
    const [existing] = await pool.execute(`SHOW COLUMNS FROM employees LIKE '${name}'`);
    if (!existing.length) {
      await pool.execute(`ALTER TABLE employees ADD COLUMN ${name} ${definition}`);
    }
  }

  const [lifecycleColumns] = await pool.execute("SHOW COLUMNS FROM employees LIKE 'lifecycle_status'");
  if (lifecycleColumns.length && !String(lifecycleColumns[0].Type || '').includes('On Hold')) {
    await pool.execute(
      "ALTER TABLE employees MODIFY COLUMN lifecycle_status ENUM('Active','Pending Onboarding','Pending Training','On Hold','For Onboarding','Under Screening','In Training','Rejected','Transferred') NULL DEFAULT 'Active'"
    );
  }

  const [wageRateActive] = await pool.execute("SHOW COLUMNS FROM employee_wage_rates LIKE 'is_active'");
  if (!wageRateActive.length) {
    await pool.execute('ALTER TABLE employee_wage_rates ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1');
  }

  const userColumns = [
    ['account_status', "ENUM('Active','Disabled','Offboarded','Inactive') NOT NULL DEFAULT 'Active'"],
    ['token_version', 'INT NOT NULL DEFAULT 0'],
    ['force_password_change', 'BOOLEAN NOT NULL DEFAULT FALSE'],
  ];
  for (const [name, definition] of userColumns) {
    const [existing] = await pool.execute(`SHOW COLUMNS FROM users LIKE '${name}'`);
    if (!existing.length) await pool.execute(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
  }
}

async function ensureEmployeeLifecycleManagementSchema(pool) {
  await ensureEmployeeLifecycleColumns(pool);
  await ensureOffboardingDocumentSchema(pool);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS employee_lifecycle_event (
      lifecycle_event_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      event_type ENUM('ONBOARDED','OFFBOARDED','REONBOARDED','CONTRACT_RENEWED','STATUS_CHANGED') NOT NULL,
      previous_status VARCHAR(40) NULL,
      new_status VARCHAR(40) NULL,
      effective_date DATE NULL,
      reason VARCHAR(180) NULL,
      remarks VARCHAR(500) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_employee_lifecycle_event_employee (employee_id, created_at),
      INDEX idx_employee_lifecycle_event_type (event_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS employee_offboarding_case (
      offboarding_case_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      status ENUM('Pending','Approved','Completed','Cancelled') NOT NULL DEFAULT 'Pending',
      offboarding_type ENUM('Resignation','Termination','End of Contract','Retirement','AWOL','Redundancy') NOT NULL,
      separation_type ENUM('Resigned','Terminated','End of Contract','Retired','Offboarded') NOT NULL,
      effective_date DATE NOT NULL,
      last_working_day DATE NOT NULL,
      separation_date DATE NOT NULL,
      separation_reason VARCHAR(180) NOT NULL,
      clearance_status ENUM('Pending','Cleared','Not Cleared') NOT NULL DEFAULT 'Pending',
      final_pay_status ENUM('Pending','For Processing','Processed','Released') NOT NULL DEFAULT 'Pending',
      account_action ENUM('Disable Immediately','Disable on Effective Date') NOT NULL DEFAULT 'Disable on Effective Date',
      account_deactivated TINYINT(1) NOT NULL DEFAULT 0,
      remarks VARCHAR(500) NULL,
      created_by INT NULL,
      completed_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME NULL,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_employee_offboarding_case_employee (employee_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS employee_reonboarding_case (
      reonboarding_case_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      previous_offboarding_case_id BIGINT NULL,
      status ENUM('Pending','Approved','Completed','Cancelled') NOT NULL DEFAULT 'Pending',
      rehire_date DATE NOT NULL,
      department_id INT NULL,
      work_location VARCHAR(160) NULL,
      position VARCHAR(120) NULL,
      employment_type ENUM('Full-time','Part-time','Contractual','Regular') NULL,
      hiring_type ENUM('Direct Hire','Agency-Hired') NULL,
      new_supervisor VARCHAR(120) NULL,
      employee_level ENUM('Rank and File','Supervisor','Manager','Executive') NULL,
      payroll_setup_status ENUM('Pending','Ready') NOT NULL DEFAULT 'Pending',
      assigned_system_role VARCHAR(80) NULL,
      force_password_reset TINYINT(1) NOT NULL DEFAULT 1,
      contract_start_date DATE NULL,
      contract_end_date DATE NULL,
      account_reactivated TINYINT(1) NOT NULL DEFAULT 0,
      remarks VARCHAR(500) NULL,
      created_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_employee_reonboarding_case_employee (employee_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute("ALTER TABLE employee_offboarding_case MODIFY COLUMN status ENUM('Pending','In Progress','For Offboarding','Clearance Pending','Payroll Review','Final Approval','Approved','Completed','Offboarded','Inactive','Cancelled') NOT NULL DEFAULT 'For Offboarding'").catch(() => {});
  await pool.execute("ALTER TABLE employee_offboarding_case MODIFY COLUMN offboarding_type ENUM('Resignation','Termination','End of Contract','Retirement','AWOL','Redundancy') NOT NULL").catch(() => {});
  await pool.execute("ALTER TABLE employee_offboarding_case MODIFY COLUMN separation_type ENUM('Resigned','Terminated','End of Contract','Retired','Offboarded') NOT NULL").catch(() => {});
  await pool.execute("ALTER TABLE employee_offboarding_case MODIFY COLUMN clearance_status ENUM('Pending','Cleared','Not Cleared') NOT NULL DEFAULT 'Pending'").catch(() => {});
  await pool.execute("ALTER TABLE employee_offboarding_case MODIFY COLUMN final_pay_status ENUM('Pending','For Processing','For Approval','Approved','Processed','Released','With Issue') NOT NULL DEFAULT 'Pending'").catch(() => {});
  await pool.execute("ALTER TABLE employee_reonboarding_case MODIFY COLUMN status ENUM('Pending','Approved','Completed','Cancelled') NOT NULL DEFAULT 'Pending'").catch(() => {});

  const offboardingColumns = [
    ['offboarding_type', "ENUM('Resignation','Termination','End of Contract','Retirement','AWOL') NULL"],
    ['effective_date', 'DATE NULL'],
    ['last_working_day', 'DATE NULL'],
    ['company_property_status', "ENUM('Pending','Partially Returned','Completed','Not Applicable') NOT NULL DEFAULT 'Pending'"],
    ['turnover_status', "ENUM('Pending','Completed','Not Required') NOT NULL DEFAULT 'Pending'"],
    ['exit_interview_status', "ENUM('Pending','Completed','Not Required') NOT NULL DEFAULT 'Pending'"],
    ['attendance_leave_clearance', "ENUM('Pending','Checked','With Issue') NOT NULL DEFAULT 'Pending'"],
    ['payroll_clearance_status', "ENUM('Pending','Checked','Cleared','With Issue') NOT NULL DEFAULT 'Pending'"],
    ['payroll_checked_by', 'INT NULL'],
    ['payroll_checked_at', 'DATETIME NULL'],
    ['final_attendance_cutoff', 'DATE NULL'],
    ['unpaid_salary', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00'],
    ['final_deductions', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00'],
    ['final_allowances', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00'],
    ['pending_benefits', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00'],
    ['last_payroll_period_checked', "ENUM('Yes','No') NOT NULL DEFAULT 'No'"],
    ['attendance_checked', "ENUM('Yes','No') NOT NULL DEFAULT 'No'"],
    ['leave_balance_checked', "ENUM('Yes','No') NOT NULL DEFAULT 'No'"],
    ['deductions_checked', "ENUM('Yes','No') NOT NULL DEFAULT 'No'"],
    ['loans_or_cash_advances_checked', "ENUM('Yes','No','Not Applicable') NOT NULL DEFAULT 'No'"],
    ['benefits_or_13th_month_checked', "ENUM('Yes','No') NOT NULL DEFAULT 'No'"],
    ['payroll_remarks', 'VARCHAR(500) NULL'],
    ['final_pay_status', "ENUM('Pending','For Processing','For Approval','Approved','Processed','Released','With Issue') NOT NULL DEFAULT 'Pending'"],
    ['final_pay_approved_by', 'INT NULL'],
    ['final_pay_approved_at', 'DATETIME NULL'],
    ['final_pay_release_date', 'DATE NULL'],
    ['final_pay_remarks', 'VARCHAR(500) NULL'],
    ['it_access_status', "ENUM('Pending','Disabled','Revoked') NOT NULL DEFAULT 'Pending'"],
    ['permissions_revoked', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['sessions_invalidated', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['biometric_access_removed', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['it_processed_by', 'INT NULL'],
    ['it_processed_at', 'DATETIME NULL'],
    ['processed_by', 'INT NULL'],
    ['account_action', "ENUM('Disable Immediately','Disable on Effective Date') NOT NULL DEFAULT 'Disable on Effective Date'"],
  ];
  for (const [name, definition] of offboardingColumns) {
    const [existing] = await pool.execute(`SHOW COLUMNS FROM employee_offboarding_case LIKE '${name}'`);
    if (!existing.length) await pool.execute(`ALTER TABLE employee_offboarding_case ADD COLUMN ${name} ${definition}`);
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS employee_offboarding_clearance_item (
      clearance_item_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      offboarding_case_id BIGINT NOT NULL,
      item_key VARCHAR(80) NOT NULL,
      item_label VARCHAR(160) NOT NULL,
      status ENUM('Pending','Cleared','Not Applicable') NOT NULL DEFAULT 'Pending',
      checked_by INT NULL,
      checked_at DATETIME NULL,
      remarks VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_offboarding_clearance_item (offboarding_case_id, item_key),
      INDEX idx_offboarding_clearance_item_case (offboarding_case_id, status),
      INDEX idx_offboarding_clearance_item_checked_by (checked_by),
      CONSTRAINT fk_offboarding_clearance_item_case
        FOREIGN KEY (offboarding_case_id) REFERENCES employee_offboarding_case(offboarding_case_id)
        ON DELETE CASCADE,
      CONSTRAINT fk_offboarding_clearance_item_checked_by
        FOREIGN KEY (checked_by) REFERENCES users(id)
        ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const reonboardingColumns = [
    ['status', "ENUM('Pending','Approved','Completed','Cancelled') NOT NULL DEFAULT 'Pending'"],
    ['work_location', 'VARCHAR(160) NULL'],
    ['hiring_type', "ENUM('Direct Hire','Agency-Hired') NULL"],
    ['new_supervisor', 'VARCHAR(120) NULL'],
    ['employee_level', "ENUM('Rank and File','Supervisor','Manager','Executive') NULL"],
    ['payroll_setup_status', "ENUM('Pending','Ready') NOT NULL DEFAULT 'Pending'"],
    ['assigned_system_role', 'VARCHAR(80) NULL'],
    ['force_password_reset', 'TINYINT(1) NOT NULL DEFAULT 1'],
  ];
  for (const [name, definition] of reonboardingColumns) {
    const [existing] = await pool.execute(`SHOW COLUMNS FROM employee_reonboarding_case LIKE '${name}'`);
    if (!existing.length) await pool.execute(`ALTER TABLE employee_reonboarding_case ADD COLUMN ${name} ${definition}`);
  }
}

let employeeLifecycleManagementSchemaReadyPromise = null;
function ensureEmployeeLifecycleManagementSchemaOnce(pool) {
  if (!employeeLifecycleManagementSchemaReadyPromise) {
    employeeLifecycleManagementSchemaReadyPromise = ensureEmployeeLifecycleManagementSchema(pool)
      .catch(error => {
        employeeLifecycleManagementSchemaReadyPromise = null;
        throw error;
      });
  }
  return employeeLifecycleManagementSchemaReadyPromise;
}

async function ensureOnboardingLifecycleSchema(pool) {
  await ensureEmployeeLifecycleColumns(pool);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS onboarding_position_route (
      position_route_id INT AUTO_INCREMENT PRIMARY KEY,
      position_name VARCHAR(120) NOT NULL UNIQUE,
      department_id INT NULL,
      requires_onboarding TINYINT(1) NOT NULL DEFAULT 1,
      requires_training TINYINT(1) NOT NULL DEFAULT 1,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_by INT NULL,
      updated_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
      INDEX idx_onboarding_route_active (is_active, position_name)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS onboarding_applicant (
      applicant_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      applicant_code VARCHAR(24) NOT NULL UNIQUE,
      intended_employee_code VARCHAR(20) NULL,
      source_module VARCHAR(60) NOT NULL DEFAULT 'ONBOARDING',
      first_name VARCHAR(100) NOT NULL,
      middle_name VARCHAR(100) NULL,
      last_name VARCHAR(100) NOT NULL,
      suffix VARCHAR(20) NULL,
      email_hash CHAR(64) NOT NULL,
      email_encrypted TEXT NOT NULL,
      pii_encrypted LONGTEXT NOT NULL,
      hiring_type ENUM('Agency-Hired','Direct Hire') NOT NULL,
      agency_name VARCHAR(180) NULL,
      deployment_status ENUM('Pending Deployment','Deployed','On Hold','Ended') NULL,
      contract_start_date DATE NULL,
      contract_end_date DATE NULL,
      applied_position VARCHAR(120) NOT NULL,
      department_id INT NULL,
      branch VARCHAR(120) NOT NULL,
      expected_wage_type_id INT NULL,
      expected_base_rate DECIMAL(12,2) NULL,
      requires_onboarding TINYINT(1) NOT NULL DEFAULT 1,
      requires_training TINYINT(1) NOT NULL DEFAULT 1,
      workflow_status ENUM(
        'For Onboarding','Under Screening','Pending Screening','Screening','Training',
        'For Approval','Approved','Rejected','For Re-evaluation','On Hold','Transferred'
      ) NOT NULL DEFAULT 'Under Screening',
      screening_status ENUM(
        'Pending Screening','For Interview','For Requirements Checking',
        'Passed Screening','Failed Screening','Not Required'
      ) NOT NULL DEFAULT 'Pending Screening',
      training_status ENUM(
        'Not Yet Started','In Training','Completed Training',
        'Failed Training','For Final Evaluation','Not Required'
      ) NOT NULL DEFAULT 'Not Yet Started',
      approval_status ENUM('Pending','Approved','Rejected','For Re-evaluation','On Hold') NOT NULL DEFAULT 'Pending',
      biometric_device_id INT NULL,
      biometric_reference_hash CHAR(64) NULL,
      biometric_reference_encrypted TEXT NULL,
      converted_employee_id INT NULL,
      created_by INT NOT NULL,
      updated_by INT NULL,
      approved_by INT NULL,
      transferred_by INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      approved_at DATETIME NULL,
      transferred_at DATETIME NULL,
      deleted_at DATETIME NULL,
      deleted_by INT NULL,
      deletion_reason VARCHAR(500) NULL,
      FOREIGN KEY (department_id) REFERENCES departments(id) ON DELETE SET NULL,
      FOREIGN KEY (expected_wage_type_id) REFERENCES wage_types(id) ON DELETE SET NULL,
      FOREIGN KEY (converted_employee_id) REFERENCES employees(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
      INDEX idx_onboarding_workflow (workflow_status, created_at),
      INDEX idx_onboarding_screening (screening_status, training_status),
      INDEX idx_onboarding_email_hash (email_hash),
      INDEX idx_onboarding_deleted (deleted_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS onboarding_applicant_document (
      document_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      applicant_id BIGINT NOT NULL,
      transferred_employee_id INT NULL,
      document_type VARCHAR(80) NOT NULL,
      original_file_name VARCHAR(255) NOT NULL,
      encrypted_file_path VARCHAR(500) NOT NULL,
      mime_type VARCHAR(120) NOT NULL,
      file_size_bytes INT NOT NULL,
      verification_status ENUM('Pending','Verified','Rejected') NOT NULL DEFAULT 'Pending',
      rejection_reason VARCHAR(500) NULL,
      uploaded_by INT NOT NULL,
      verified_by INT NULL,
      uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      verified_at DATETIME NULL,
      FOREIGN KEY (applicant_id) REFERENCES onboarding_applicant(applicant_id) ON DELETE CASCADE,
      FOREIGN KEY (transferred_employee_id) REFERENCES employees(id) ON DELETE SET NULL,
      FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE RESTRICT,
      INDEX idx_onboarding_doc_applicant (applicant_id, uploaded_at),
      INDEX idx_onboarding_doc_employee (transferred_employee_id)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS onboarding_applicant_activity (
      activity_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      applicant_id BIGINT NOT NULL,
      actor_user_id INT NOT NULL,
      action VARCHAR(100) NOT NULL,
      reason VARCHAR(500) NULL,
      old_value JSON NULL,
      new_value JSON NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (applicant_id) REFERENCES onboarding_applicant(applicant_id) ON DELETE CASCADE,
      FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT,
      INDEX idx_onboarding_activity_applicant (applicant_id, created_at),
      INDEX idx_onboarding_activity_action (action, created_at)
    )
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS onboarding_integrity_chain (
      chain_id BIGINT AUTO_INCREMENT PRIMARY KEY,
      activity_id BIGINT NOT NULL UNIQUE,
      applicant_id BIGINT NOT NULL,
      previous_hash CHAR(64) NULL,
      chain_hash CHAR(64) NOT NULL,
      anchor_status ENUM('PENDING','ANCHORED','FAILED') NOT NULL DEFAULT 'PENDING',
      blockchain_reference VARCHAR(255) NULL,
      anchor_error VARCHAR(500) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      anchored_at DATETIME NULL,
      FOREIGN KEY (activity_id) REFERENCES onboarding_applicant_activity(activity_id) ON DELETE CASCADE,
      FOREIGN KEY (applicant_id) REFERENCES onboarding_applicant(applicant_id) ON DELETE CASCADE,
      INDEX idx_onboarding_chain_applicant (applicant_id, chain_id),
      INDEX idx_onboarding_chain_anchor (anchor_status, created_at)
    )
  `);

  const defaultRoutes = [
    ['Manager', 0, 0],
    ['HR Staff', 0, 0],
    ['Admin Staff', 0, 0],
    ['Office Staff', 0, 0],
    ['Supervisor', 0, 0],
    ['Operator', 1, 1],
    ['Production Worker', 1, 1],
    ['Production Staff', 1, 1],
    ['Piece-Rate Worker', 1, 1],
    ['Factory Worker', 1, 1],
    ['Logistics Helper', 1, 1],
    ['Machine Operator', 1, 1],
  ];

  for (const [position, requiresOnboarding, requiresTraining] of defaultRoutes) {
    await pool.execute(
      `INSERT INTO onboarding_position_route
         (position_name, requires_onboarding, requires_training)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         position_name = VALUES(position_name)`,
      [position, requiresOnboarding, requiresTraining]
    );
  }
}

app.get('/api/employee-setup/lookups', requireAuth, requireRole(ROLES.any), async (_req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeSetupSchema(pool);
    const [departments] = await pool.execute('SELECT id, name, is_active FROM departments WHERE is_active = 1 ORDER BY name');
    const [positions] = await pool.execute(`
      SELECT p.id, p.department_id, p.name, p.is_active, d.name AS department
        FROM positions p
        JOIN departments d ON d.id = p.department_id
       WHERE p.is_active = 1 AND d.is_active = 1
       ORDER BY d.name, p.name
    `);
    res.json({ departments, positions });
  } catch (err) {
    console.error('Error loading employee setup lookups:', err);
    res.status(500).json({ error: 'Failed to load departments and positions.' });
  }
});

app.post('/api/employee-setup/departments', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    if (await rejectUnsupportedRouteFields(req, res, DEPARTMENT_SETUP_ALLOWED_FIELDS, { module: 'EMPLOYEE_SETUP_SECURITY' })) return;
    const name = String(req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Department name is required.' });
    if (name.length > 100) return res.status(400).json({ error: 'Department name is too long.' });

    await ensureEmployeeSetupSchema(pool);
    await pool.execute(
      `INSERT INTO departments (name, is_active)
       VALUES (?, 1)
       ON DUPLICATE KEY UPDATE is_active = 1`,
      [name]
    );
    const [[department]] = await pool.execute('SELECT id, name, is_active FROM departments WHERE name = ? LIMIT 1', [name]);
    res.json({ department, message: 'Department saved.' });
  } catch (err) {
    console.error('Error saving department:', err);
    res.status(500).json({ error: 'Failed to save department.' });
  }
});

app.put('/api/employee-setup/departments/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeSetupSchema(pool);
    if (await rejectUnsupportedRouteFields(req, res, DEPARTMENT_SETUP_ALLOWED_FIELDS, { module: 'EMPLOYEE_SETUP_SECURITY' })) return;
    const id = Number(req.params.id);
    const name = String(req.body.name || '').trim();
    if (!id) return res.status(400).json({ error: 'Department is required.' });
    if (!name) return res.status(400).json({ error: 'Department name is required.' });
    if (name.length > 100) return res.status(400).json({ error: 'Department name is too long.' });

    await pool.execute('UPDATE departments SET name = ?, is_active = 1 WHERE id = ?', [name, id]);
    const [[department]] = await pool.execute('SELECT id, name, is_active FROM departments WHERE id = ? LIMIT 1', [id]);
    res.json({ department, message: 'Department updated.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Department name already exists.' });
    console.error('Error updating department:', err);
    res.status(500).json({ error: 'Failed to update department.' });
  }
});

app.delete('/api/employee-setup/departments/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeSetupSchema(pool);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Department is required.' });

    await pool.execute('UPDATE departments SET is_active = 0 WHERE id = ?', [id]);
    await pool.execute('UPDATE positions SET is_active = 0 WHERE department_id = ?', [id]);
    res.json({ message: 'Department removed from active dropdowns.' });
  } catch (err) {
    console.error('Error deactivating department:', err);
    res.status(500).json({ error: 'Failed to remove department.' });
  }
});

app.post('/api/employee-setup/positions', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeSetupSchema(pool);
    if (await rejectUnsupportedRouteFields(req, res, POSITION_SETUP_ALLOWED_FIELDS, { module: 'EMPLOYEE_SETUP_SECURITY' })) return;
    const departmentId = Number(req.body.department_id);
    const name = String(req.body.name || '').trim();
    if (!departmentId) return res.status(400).json({ error: 'Department is required.' });
    if (!name) return res.status(400).json({ error: 'Position / job title is required.' });
    if (name.length > 120) return res.status(400).json({ error: 'Position / job title is too long.' });

    const [[department]] = await pool.execute('SELECT id FROM departments WHERE id = ? LIMIT 1', [departmentId]);
    if (!department) return res.status(404).json({ error: 'Department not found.' });

    await pool.execute(
      `INSERT INTO positions (department_id, name, is_active)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE is_active = 1, updated_at = NOW()`,
      [departmentId, name]
    );
    const [[position]] = await pool.execute(
      `SELECT p.id, p.department_id, p.name, p.is_active, d.name AS department
         FROM positions p
         JOIN departments d ON d.id = p.department_id
        WHERE p.department_id = ? AND p.name = ?
        LIMIT 1`,
      [departmentId, name]
    );
    res.json({ position, message: 'Position saved.' });
  } catch (err) {
    console.error('Error saving position:', err);
    res.status(500).json({ error: 'Failed to save position.' });
  }
});

app.put('/api/employee-setup/positions/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeSetupSchema(pool);
    if (await rejectUnsupportedRouteFields(req, res, POSITION_SETUP_ALLOWED_FIELDS, { module: 'EMPLOYEE_SETUP_SECURITY' })) return;
    const id = Number(req.params.id);
    const departmentId = Number(req.body.department_id);
    const name = String(req.body.name || '').trim();
    if (!id) return res.status(400).json({ error: 'Position is required.' });
    if (!departmentId) return res.status(400).json({ error: 'Department is required.' });
    if (!name) return res.status(400).json({ error: 'Position / job title is required.' });
    if (name.length > 120) return res.status(400).json({ error: 'Position / job title is too long.' });

    await pool.execute(
      'UPDATE positions SET department_id = ?, name = ?, is_active = 1 WHERE id = ?',
      [departmentId, name, id]
    );
    const [[position]] = await pool.execute(
      `SELECT p.id, p.department_id, p.name, p.is_active, d.name AS department
         FROM positions p
         JOIN departments d ON d.id = p.department_id
        WHERE p.id = ?
        LIMIT 1`,
      [id]
    );
    res.json({ position, message: 'Position updated.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Position already exists in this department.' });
    console.error('Error updating position:', err);
    res.status(500).json({ error: 'Failed to update position.' });
  }
});

app.delete('/api/employee-setup/positions/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeSetupSchema(pool);
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Position is required.' });

    await pool.execute('UPDATE positions SET is_active = 0 WHERE id = ?', [id]);
    res.json({ message: 'Position removed from active dropdowns.' });
  } catch (err) {
    console.error('Error deactivating position:', err);
    res.status(500).json({ error: 'Failed to remove position.' });
  }
});

app.get('/api/employees', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeIntegritySchema(pool);
    const requestedStatus = String(req.query.status || '').trim();
    const includeAllStatuses = /^(all|all status|all statuses)$/i.test(requestedStatus);
    const employeeWhere = [];
    const employeeParams = [];
    if (!includeAllStatuses) {
      if (requestedStatus && EMPLOYEE_ENUMS.status.has(requestedStatus)) {
        employeeWhere.push('e.status = ?');
        employeeParams.push(requestedStatus);
      } else {
        employeeWhere.push("COALESCE(e.status, 'Active') = 'Active'");
      }
    }
    const employeeListSql =
      `SELECT e.id, e.employee_code, e.first_name, e.middle_name, e.last_name, e.suffix,
              e.email, e.contact_number, e.department_id, e.position, e.employment_type,
              e.supervisor, e.work_location, e.shift_schedule, e.status, e.status AS employment_status, e.wage_type_id,
              e.hiring_type, e.deployment_status, e.sss_number, e.philhealth_number,
              e.pagibig_number, e.tin, e.tax_status, e.bank_name, e.bank_account, e.integrity_hash,
              d.name AS department, wt.name AS wage_type,
              (
                SELECT COALESCE(r.label, r.name)
                FROM users u
                LEFT JOIN roles r ON r.id = u.role_id
                WHERE u.employee_id = e.id
                LIMIT 1
              ) AS current_system_role,
              (
                SELECT eoc.offboarding_case_id
                FROM employee_offboarding_case eoc
                WHERE eoc.employee_id = e.id
                  AND eoc.status IN ('Pending','In Progress','For Offboarding','Clearance Pending','Payroll Review','Final Approval')
                ORDER BY eoc.created_at DESC
                LIMIT 1
              ) AS pending_offboarding_request_id,
              (
                SELECT eoc.status
                FROM employee_offboarding_case eoc
                WHERE eoc.employee_id = e.id
                  AND eoc.status IN ('Pending','In Progress','For Offboarding','Clearance Pending','Payroll Review','Final Approval')
                ORDER BY eoc.created_at DESC
                LIMIT 1
              ) AS pending_offboarding_status,
              (
                SELECT erc.reonboarding_case_id
                FROM employee_reonboarding_case erc
                WHERE erc.employee_id = e.id AND erc.status = 'Pending'
                ORDER BY erc.created_at DESC
                LIMIT 1
              ) AS pending_reonboarding_request_id,
              (
                SELECT ewr.rate
                FROM employee_wage_rates ewr
                WHERE ewr.employee_id = e.id
                  AND ewr.end_date IS NULL
                  AND COALESCE(ewr.is_active, 1) = 1
                ORDER BY ewr.effective_date DESC, ewr.id DESC
                LIMIT 1
              ) AS basic_salary,
              (
                SELECT DATE_FORMAT(ewr.effective_date, '%Y-%m-%d')
                FROM employee_wage_rates ewr
                WHERE ewr.employee_id = e.id
                  AND ewr.end_date IS NULL
                  AND COALESCE(ewr.is_active, 1) = 1
                ORDER BY ewr.effective_date DESC, ewr.id DESC
                LIMIT 1
              ) AS wage_effective_date
       FROM employees e
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
       ${employeeWhere.length ? `WHERE ${employeeWhere.join(' AND ')}` : ''}
       ORDER BY e.employee_code`;
    // mysql2's prepared-statement path is unstable on this local MariaDB setup
    // for this large directory query. `query(sql, params)` still keeps dynamic
    // values parameterized while avoiding the prepared-statement crash.
    const [rows] = await pool.query(employeeListSql, employeeParams);
    const directoryDecryptBudget = { failures: 0, limit: 8 };
    const employees = rows.map(row => {
      const integrity = employeeIntegrityStatus(row);
      row.integrity_status = integrity.status;
      row.integrity_hash = integrity.hash;
      return decryptEmployeeDirectoryPii(row, directoryDecryptBudget);
    });
    
    if (req.user.role === 'employee') return res.json(employees.filter(r => r.id === req.user.employeeId).map(employee => employeeDirectoryPayload(employee)));
    if (employeeHasRole(req, ROLES.staff_management)) {
      return res.json(employees.map(employee => employeeDirectoryPayload(employee, {
        includePayrollFields: true,
        revealSensitive: true,
      })));
    }
    if (employeeHasRole(req, ROLES.payroll_any)) {
      return res.json(employees.map(employee => employeeReferencePayload(employee, { includePayrollFields: true })));
    }
    if (employeeHasRole(req, ROLES.admin_any)) {
      return res.json(employees.map(employee => employeeReferencePayload(employee)));
    }
    return res.status(403).json({ error: 'Access denied.' });
  } catch (err) {
    console.error('Error fetching employees:', err);
    res.status(500).json({ error: 'Failed to fetch employees.' }); 
  }
});

app.get('/api/employees/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const employeeId = Number(req.params.id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) return res.status(400).json({ error: 'Valid employee id is required.' });
    if (!canAccessEmployeeRecord(req, employeeId, { allowPermission: true })) {
      return rejectEmployeeIdor(req, res, employeeId, 'blocked_employee_detail_idor_attempt');
    }
    const [rows] = await pool.execute(`
      SELECT e.*, d.name AS department, wt.name AS wage_type,
             (SELECT ewr.rate FROM employee_wage_rates ewr WHERE ewr.employee_id = e.id AND ewr.end_date IS NULL AND COALESCE(ewr.is_active, 1) = 1 ORDER BY ewr.effective_date DESC, ewr.id DESC LIMIT 1) AS basic_salary,
             (SELECT DATE_FORMAT(ewr.effective_date, '%Y-%m-%d') FROM employee_wage_rates ewr WHERE ewr.employee_id = e.id AND ewr.end_date IS NULL AND COALESCE(ewr.is_active, 1) = 1 ORDER BY ewr.effective_date DESC, ewr.id DESC LIMIT 1) AS wage_effective_date
        FROM employees e
        LEFT JOIN departments d ON d.id = e.department_id
        LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
       WHERE e.id = ?
       LIMIT 1
    `, [employeeId]);
    if (!rows.length) return res.status(404).json({ error: 'Employee not found.' });
    const employee = decryptEmployeeGps(decryptEmployeeStrictPii(rows[0]));
    for (const field of ['Password_Hash', 'password_hash', 'encrypted_pii', 'email_hash', 'Failed_Login_Attempts', 'Locked_Until']) delete employee[field];
    res.json(maskEmployeeDetail(visibleEmployeeDetail(employee)));
  } catch (err) {
    console.error('Error fetching employee detail:', err.message);
    res.status(500).json({ error: 'Failed to fetch employee detail.' });
  }
});

app.post('/api/employees/:id/reveal-sensitive', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const employeeId = Number(req.params.id);
    if (!Number.isInteger(employeeId) || employeeId <= 0) return res.status(400).json({ error: 'Valid employee id is required.' });
    if (!canAccessEmployeeRecord(req, employeeId, { allowPermission: true })) {
      return rejectEmployeeIdor(req, res, employeeId, 'blocked_employee_sensitive_reveal_idor_attempt');
    }
    const [rows] = await pool.execute('SELECT * FROM employees WHERE id = ? LIMIT 1', [employeeId]);
    if (!rows.length) return res.status(404).json({ error: 'Employee not found.' });
    const employee = decryptEmployeeGps(decryptEmployeeStrictPii(rows[0]));
    const revealed = {};
    for (const field of EMPLOYEE_PROFILE_MASKED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(employee, field)) revealed[field] = employee[field];
    }
    await auditSecurityEvent(req, {
      action: 'employee_sensitive_fields_revealed',
      module: 'EMPLOYEE_PRIVACY',
      targetTable: 'employees',
      targetRecord: employeeId,
      newValue: { fields: Object.keys(revealed) },
      result: 'success',
    });
    res.json({ employee_id: employeeId, fields: revealed });
  } catch (err) {
    console.error('Error revealing employee fields:', err.message);
    res.status(500).json({ error: 'Failed to reveal sensitive employee fields.' });
  }
});

// Add new employee
app.post('/api/employees', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    
    const pool = require('./config/db');
    await ensureOnboardingLifecycleSchema(pool);
    await ensurePhilippineAddressColumns(pool);
    await ensureEmployeeAuthColumns(pool);
    await ensureEmployeeIntegritySchema(pool);
    const validationResponse = await validateEmployeeRequestBody(req, res, pool, { mode: 'create' });
    if (validationResponse) return validationResponse;
    const { employee_id_mode, employee_code, first_name, middle_name, last_name, suffix, email, contact_number, work_email, mailing_address, nationality, marital_status, date_of_birth, place_of_birth, gender, blood_type, religion, residential_address, current_address, emergency_contact_name, emergency_contact_num, emergency_contact_relationship, emergency_contact_secondary_num, emergency_contact_email, emergency_contact_address, education_school, education_attainment, education_units, education_year_graduated, education_jhs_school, education_jhs_attainment, education_jhs_from, education_jhs_to, education_jhs_year_graduated, education_shs_school, education_shs_attainment, education_shs_from, education_shs_to, education_shs_year_graduated, education_vocational_school, education_vocational_attainment, education_vocational_units, education_vocational_from, education_vocational_to, education_vocational_year_graduated, education_college_school, education_college_attainment, education_college_units, education_college_from, education_college_to, education_college_year_graduated, department_id, position, employment_type, date_hired, end_of_contract, supervisor, work_location, shift_schedule, employee_level, employment_history, status, employment_status, separation_date, separation_reason, offboarding_remarks, wage_type, base_rate, wage_effective_date, sewingRates, salary_grade, allowances, payroll_schedule, sss_number, philhealth_number, pagibig_number, tin, tax_status, bank_name, bank_account, hiring_type, agency_name, agency_contact_person, agency_contact_number, deployment_status, contract_start_date, contract_end_date, requires_onboarding, requires_training, lifecycle_action, lifecycle_note } = req.body;
    const normalizedEmployeeStatus = normalizeEmploymentStatus(employment_status || status);
    
    console.log('\n=== POST /api/employees ===');
    console.log('User role:', req.user.role);
    console.log('Employee create payload received with allowlisted fields:', Object.keys(req.body));
    
    if (!first_name || !last_name || !email) {
      console.error('❌ Missing required fields');
      return res.status(400).json({ error: 'First name, last name, and email are required.' });
    }
    
    const employeeIdMode = employee_id_mode === 'manual' ? 'manual' : 'auto';
    let finalEmployeeCode = sanitizeEmployeeCode(employee_code);
    if (employeeIdMode === 'manual') {
      if (!finalEmployeeCode) {
        console.error('❌ Missing employee_code');
        return res.status(400).json({ error: 'Employee ID is required when using an existing employee ID.' });
      }
      if (!isValidEmployeeCode(finalEmployeeCode)) {
        return res.status(400).json({ error: 'Employee ID can only contain letters, numbers, hyphens, and underscores.' });
      }
    }

    const { errors: addressErrors, addresses } = validateEmployeeAddresses(req.body);
    if (addressErrors.length) {
      return res.status(400).json({ error: addressErrors.join(' ') });
    }

    if (!position) {
      return res.status(400).json({ error: 'Position / Job Title is required for lifecycle routing.' });
    }

    const normalizedHiringType = normalizeHiringType(hiring_type);
    const normalizedEmploymentType = normalizeEmployeeEmploymentType(employment_type, normalizedHiringType);
    let normalizedContractStartDate = null;
    let normalizedContractEndDate = null;
    try {
      normalizedContractStartDate = normalizedHiringType === 'Agency-Hired'
        ? optionalLifecycleDate(contract_start_date, 'Contract start date')
        : null;
      normalizedContractEndDate = normalizedHiringType === 'Agency-Hired'
        ? optionalLifecycleDate(contract_end_date || end_of_contract, 'Contract end date')
        : null;
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    const normalizedDeploymentStatus = normalizedHiringType === 'Agency-Hired'
      ? (['Pending Deployment', 'Deployed', 'On Hold', 'Ended'].includes(deployment_status) ? deployment_status : 'Pending Deployment')
      : null;
    if (normalizedHiringType === 'Agency-Hired') {
      if (!agency_name || !agency_contact_person || !agency_contact_number) {
        return res.status(400).json({ error: 'Agency name, contact person, and contact number are required for Agency-Hired workers.' });
      }
      if (normalizedContractStartDate && normalizedContractEndDate && normalizedContractEndDate < normalizedContractStartDate) {
        return res.status(400).json({ error: 'Contract end date cannot be earlier than contract start date.' });
      }
    }
    const directoryEndOfContract = normalizedContractEndDate || end_of_contract || null;
    const route = await onboardingRoutes.getPositionRoute(pool, position);
    const normalizedLifecycleAction = normalizeLifecycleAction(lifecycle_action);
    const normalizedLifecycleNote = lifecycleNote(lifecycle_note);
    if (normalizedLifecycleAction === 'ON_HOLD' && normalizedLifecycleNote.length < 8) {
      return res.status(400).json({ error: 'An HR note of at least 8 characters is required when placing a record on hold.' });
    }
    const explicitOnboardingAction = ['SCREENING_REQUIRED', 'TRAINING_REQUIRED', 'ON_HOLD'].includes(normalizedLifecycleAction);
    const explicitDirectAction = normalizedLifecycleAction === 'DIRECT_ACTIVE';
    const shouldRouteToOnboarding = !explicitDirectAction
      && (explicitOnboardingAction || lifecycleTruthy(requires_onboarding) || Number(route.requires_onboarding) === 1);
    const onboardingRequiresTraining = normalizedLifecycleAction === 'TRAINING_REQUIRED'
      || (!explicitDirectAction
        && normalizedLifecycleAction === 'AUTO'
        && (lifecycleTruthy(requires_training) || Number(route.requires_training) === 1));

    if (employeeIdMode === 'auto') {
      const codeConnection = await pool.getConnection();
      try {
        await codeConnection.beginTransaction();
        finalEmployeeCode = await generateNextEmployeeCode(codeConnection, true);
        await codeConnection.commit();
      } catch (error) {
        await codeConnection.rollback();
        throw error;
      } finally {
        codeConnection.release();
      }
    }

    if (shouldRouteToOnboarding) {
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const duplicate = await findEmployeeIntakeDuplicate(connection, finalEmployeeCode, email);
        if (duplicate) {
          await connection.rollback();
          if (duplicate.field === 'employee_code') {
            await writeEmployeeLifecycleAudit(pool, req, `DUPLICATE_EMPLOYEE_ID_ATTEMPT [${finalEmployeeCode}]`, null, null, {
              employee_code: finalEmployeeCode,
              mode: employeeIdMode,
              source: duplicate.source,
            });
            return res.status(409).json({ error: 'Employee ID already exists.', duplicate: { field: 'employee_code' } });
          }
          return res.status(409).json(await employeeIntakeDuplicatePayload(connection, duplicate));
        }

        const onboardingResult = await onboardingRoutes.createOnboardingApplicantRecord(connection, req, {
          ...req.body,
          employee_code: finalEmployeeCode,
          hiring_type: normalizedHiringType,
          employment_type: normalizedEmploymentType,
          applied_position: position,
          branch: work_location || 'Marulas Industrial Corporation',
          expected_wage_type_id: req.body.wage_type_id,
          expected_base_rate: base_rate,
          civil_status: marital_status,
          agency_name,
          agency_contact_person,
          agency_contact_number,
          deployment_status: normalizedDeploymentStatus,
          contract_start_date: normalizedContractStartDate,
          contract_end_date: normalizedContractEndDate,
          current_address_same_as_home: addresses.sameCurrent ? 1 : 0,
          mailing_address_same_as_home: addresses.sameMailing ? 1 : 0,
          residential_address: addresses.home.address,
          residential_address_lat: addresses.home.lat,
          residential_address_lng: addresses.home.lng,
          current_address: addresses.current.address,
          current_address_lat: addresses.current.lat,
          current_address_lng: addresses.current.lng,
          mailing_address: addresses.mailing.address,
          mailing_address_lat: addresses.mailing.lat,
          mailing_address_lng: addresses.mailing.lng,
          requires_onboarding: true,
          requires_training: onboardingRequiresTraining,
          initial_workflow_status: normalizedLifecycleAction === 'ON_HOLD' ? 'On Hold' : undefined,
          lifecycle_action: normalizedLifecycleAction,
          lifecycle_note: normalizedLifecycleNote,
        }, {
          sourceModule: 'EMPLOYEE_MANAGEMENT',
          intendedEmployeeCode: finalEmployeeCode,
        });
        await writeEmployeeLifecycleAudit(connection, req, `EMPLOYEE_RECORD_ROUTED_TO_ONBOARDING [${finalEmployeeCode}]`, null, null, {
          employee_code: finalEmployeeCode,
          applicant_id: onboardingResult.applicant_id,
          position,
          lifecycle_action: normalizedLifecycleAction,
          lifecycle_note: normalizedLifecycleNote || null,
          requires_training: onboardingRequiresTraining,
          route_source: route.source || 'position_route',
          workflow_status: onboardingResult.workflow_status,
        });
        await writeEmployeeLifecycleAudit(connection, req, employeeIdMode === 'manual' ? 'EXISTING_EMPLOYEE_ID_ENTERED' : 'EMPLOYEE_ID_AUTO_GENERATED', null, null, {
          employee_code: finalEmployeeCode,
          mode: employeeIdMode,
        });
        await connection.commit();
        return res.status(201).json({
          ...onboardingResult,
          id: null,
          employee_code: finalEmployeeCode,
          routed_to: 'onboarding',
          message: normalizedLifecycleAction === 'ON_HOLD'
            ? `${finalEmployeeCode} placed on hold in onboarding for HR review.`
            : `${finalEmployeeCode} routed to onboarding for ${position}.`,
        });
      } catch (error) {
        await connection.rollback();
        return res.status(400).json({ error: error.message });
      } finally {
        connection.release();
      }
    }

    const duplicate = await findEmployeeIntakeDuplicate(pool, finalEmployeeCode, email);
    if (duplicate) {
      if (duplicate.field === 'employee_code') {
        await writeEmployeeLifecycleAudit(pool, req, `DUPLICATE_EMPLOYEE_ID_ATTEMPT [${finalEmployeeCode}]`, null, null, {
          employee_code: finalEmployeeCode,
          mode: employeeIdMode,
          source: duplicate.source,
        });
        return res.status(409).json({ error: 'Employee ID already exists.', duplicate: { field: 'employee_code' } });
      }
      return res.status(409).json(await employeeIntakeDuplicatePayload(pool, duplicate));
    }

    const generatedTemporaryPassword = nodeCrypto.randomBytes(24).toString('base64');
    const employeePasswordHash = await hashTemporaryPassword(generatedTemporaryPassword);
    
    const [result] = await pool.execute(
      `INSERT INTO employees (employee_code, first_name, middle_name, last_name, suffix, email, contact_number, work_email, mailing_address, nationality, marital_status, date_of_birth, place_of_birth, gender, blood_type, religion, residential_address, current_address, emergency_contact_name, emergency_contact_num, emergency_contact_relationship, emergency_contact_secondary_num, emergency_contact_email, emergency_contact_address, education_school, education_attainment, education_units, education_year_graduated, education_jhs_school, education_jhs_attainment, education_jhs_from, education_jhs_to, education_jhs_year_graduated, education_shs_school, education_shs_attainment, education_shs_from, education_shs_to, education_shs_year_graduated, education_vocational_school, education_vocational_attainment, education_vocational_units, education_vocational_from, education_vocational_to, education_vocational_year_graduated, education_college_school, education_college_attainment, education_college_units, education_college_from, education_college_to, education_college_year_graduated, department_id, position, employment_type, date_hired, end_of_contract, supervisor, work_location, shift_schedule, employee_level, employment_history, status, separation_date, separation_reason, offboarding_remarks, salary_grade, allowances, payroll_schedule, sss_number, philhealth_number, pagibig_number, tin, tax_status, bank_name, bank_account, Password_Hash, Password_Changed_At, Failed_Login_Attempts, force_password_change)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 0, 1)`,
      [finalEmployeeCode,
       employeeDbValue('first_name', first_name), employeeDbValue('middle_name', middle_name || null), employeeDbValue('last_name', last_name), employeeDbValue('suffix', suffix || null),
       employeeDbValue('email', email), employeeDbValue('contact_number', contact_number || null), employeeDbValue('work_email', work_email || null), employeeDbValue('mailing_address', addresses.mailing.address || null),
       employeeDbValue('nationality', nationality || 'Filipino'), employeeDbValue('marital_status', marital_status || null), employeeDbValue('date_of_birth', date_of_birth || null), employeeDbValue('place_of_birth', place_of_birth || null),
       employeeDbValue('gender', gender || null), employeeDbValue('blood_type', blood_type || null), employeeDbValue('religion', religion || null), employeeDbValue('residential_address', addresses.home.address || null), employeeDbValue('current_address', addresses.current.address || null),
       employeeDbValue('emergency_contact_name', emergency_contact_name || null), employeeDbValue('emergency_contact_num', emergency_contact_num || null), employeeDbValue('emergency_contact_relationship', emergency_contact_relationship || null),
       employeeDbValue('emergency_contact_secondary_num', emergency_contact_secondary_num || null), employeeDbValue('emergency_contact_email', emergency_contact_email || null), employeeDbValue('emergency_contact_address', emergency_contact_address || null),
       employeeDbValue('education_school', education_school || null), employeeDbValue('education_attainment', education_attainment || null), employeeDbValue('education_units', education_units || null), employeeDbValue('education_year_graduated', education_year_graduated || null),
       employeeDbValue('education_jhs_school', education_jhs_school || null), employeeDbValue('education_jhs_attainment', education_jhs_attainment || null), employeeDbValue('education_jhs_from', education_jhs_from || null), employeeDbValue('education_jhs_to', education_jhs_to || null), employeeDbValue('education_jhs_year_graduated', education_jhs_year_graduated || null),
       employeeDbValue('education_shs_school', education_shs_school || null), employeeDbValue('education_shs_attainment', education_shs_attainment || null), employeeDbValue('education_shs_from', education_shs_from || null), employeeDbValue('education_shs_to', education_shs_to || null), employeeDbValue('education_shs_year_graduated', education_shs_year_graduated || null),
       employeeDbValue('education_vocational_school', education_vocational_school || null), employeeDbValue('education_vocational_attainment', education_vocational_attainment || null), employeeDbValue('education_vocational_units', education_vocational_units || null), employeeDbValue('education_vocational_from', education_vocational_from || null), employeeDbValue('education_vocational_to', education_vocational_to || null), employeeDbValue('education_vocational_year_graduated', education_vocational_year_graduated || null),
       employeeDbValue('education_college_school', education_college_school || null), employeeDbValue('education_college_attainment', education_college_attainment || null), employeeDbValue('education_college_units', education_college_units || null), employeeDbValue('education_college_from', education_college_from || null), employeeDbValue('education_college_to', education_college_to || null), employeeDbValue('education_college_year_graduated', education_college_year_graduated || null),
       department_id || null, position || null, normalizedEmploymentType, date_hired || null, directoryEndOfContract, supervisor || null, work_location || null, shift_schedule || null, employee_level || null, employment_history || null, normalizedEmployeeStatus, separation_date || null,
       employeeDbValue('separation_reason', separation_reason || null), employeeDbValue('offboarding_remarks', offboarding_remarks || null),
       salary_grade || null, allowances || null, payroll_schedule || null,
       employeeDbValue('sss_number', sss_number || null), employeeDbValue('philhealth_number', philhealth_number || null), employeeDbValue('pagibig_number', pagibig_number || null), employeeDbValue('tin', tin || null), employeeDbValue('tax_status', tax_status || null), employeeDbValue('bank_name', bank_name || null), employeeDbValue('bank_account', bank_account || null), employeePasswordHash]
    );
    
    const employee_id = result.insertId;
    await pool.execute(
      `UPDATE employees SET
         email_hash = ?,
         residential_address_lat = NULL, residential_address_lng = NULL,
         residential_address_lat_encrypted = ?, residential_address_lng_encrypted = ?,
         residential_address_region = ?, residential_address_province = ?, residential_address_city_municipality = ?,
         residential_address_barangay = ?, residential_address_street_address = ?, residential_address_full_address = ?, residential_address_place_id = ?,
         current_address_lat = NULL, current_address_lng = NULL,
         current_address_lat_encrypted = ?, current_address_lng_encrypted = ?, current_address_same_as_home = ?,
         current_address_region = ?, current_address_province = ?, current_address_city_municipality = ?,
         current_address_barangay = ?, current_address_street_address = ?, current_address_full_address = ?, current_address_place_id = ?,
         mailing_address_lat = NULL, mailing_address_lng = NULL,
         mailing_address_lat_encrypted = ?, mailing_address_lng_encrypted = ?, mailing_address_same_as_home = ?
         , mailing_address_region = ?, mailing_address_province = ?, mailing_address_city_municipality = ?,
         mailing_address_barangay = ?, mailing_address_street_address = ?, mailing_address_full_address = ?, mailing_address_place_id = ?
      WHERE id = ?`,
      [
        hashNullable(email),
        encryptColumnValue(dbNullable(addresses.home.lat)), encryptColumnValue(dbNullable(addresses.home.lng)),
        employeeDbValue('residential_address_region', addresses.home.region), employeeDbValue('residential_address_province', addresses.home.province), employeeDbValue('residential_address_city_municipality', addresses.home.city_municipality),
        employeeDbValue('residential_address_barangay', addresses.home.barangay), employeeDbValue('residential_address_street_address', addresses.home.street_address), employeeDbValue('residential_address_full_address', addresses.home.full_address || addresses.home.address), employeeDbValue('residential_address_place_id', addresses.home.place_id || null),
        encryptColumnValue(dbNullable(addresses.current.lat)), encryptColumnValue(dbNullable(addresses.current.lng)), addresses.sameCurrent ? 1 : 0,
        employeeDbValue('current_address_region', addresses.current.region), employeeDbValue('current_address_province', addresses.current.province), employeeDbValue('current_address_city_municipality', addresses.current.city_municipality),
        employeeDbValue('current_address_barangay', addresses.current.barangay), employeeDbValue('current_address_street_address', addresses.current.street_address), employeeDbValue('current_address_full_address', addresses.current.full_address || addresses.current.address), employeeDbValue('current_address_place_id', addresses.current.place_id || null),
        encryptColumnValue(dbNullable(addresses.mailing.lat)), encryptColumnValue(dbNullable(addresses.mailing.lng)), addresses.sameMailing ? 1 : 0,
        employeeDbValue('mailing_address_region', addresses.mailing.region), employeeDbValue('mailing_address_province', addresses.mailing.province), employeeDbValue('mailing_address_city_municipality', addresses.mailing.city_municipality),
        employeeDbValue('mailing_address_barangay', addresses.mailing.barangay), employeeDbValue('mailing_address_street_address', addresses.mailing.street_address), employeeDbValue('mailing_address_full_address', addresses.mailing.full_address || addresses.mailing.address), employeeDbValue('mailing_address_place_id', addresses.mailing.place_id || null),
        employee_id
      ]
    );

    const piiUpdateFields = [
      'hiring_type = ?',
      'agency_name = ?',
      'agency_contact_person = ?',
      'agency_contact_number = ?',
      'deployment_status = ?',
      'contract_start_date = ?',
      'contract_end_date = ?',
      "lifecycle_status = 'Active'"
    ];
    const piiUpdateValues = [
      normalizedHiringType,
      normalizedHiringType === 'Agency-Hired' ? agency_name || null : null,
      employeeDbValue('agency_contact_person', normalizedHiringType === 'Agency-Hired' ? agency_contact_person || null : null),
      employeeDbValue('agency_contact_number', normalizedHiringType === 'Agency-Hired' ? agency_contact_number || null : null),
      normalizedDeploymentStatus,
      normalizedContractStartDate,
      normalizedContractEndDate
    ];
    if (await employeeColumnExists(pool, 'encrypted_pii')) {
      piiUpdateFields.unshift('encrypted_pii = ?');
      piiUpdateValues.unshift(encryptPII({
        contact_number: contact_number || '',
        work_email: work_email || '',
        residential_address: addresses.home.address || '',
        residential_address_lat: addresses.home.lat == null ? '' : String(addresses.home.lat),
        residential_address_lng: addresses.home.lng == null ? '' : String(addresses.home.lng),
        current_address: addresses.current.address || '',
        current_address_lat: addresses.current.lat == null ? '' : String(addresses.current.lat),
        current_address_lng: addresses.current.lng == null ? '' : String(addresses.current.lng),
        current_address_same_as_home: !!addresses.sameCurrent,
        mailing_address: addresses.mailing.address || '',
        mailing_address_lat: addresses.mailing.lat == null ? '' : String(addresses.mailing.lat),
        mailing_address_lng: addresses.mailing.lng == null ? '' : String(addresses.mailing.lng),
        mailing_address_same_as_home: !!addresses.sameMailing,
        nationality: nationality || 'Filipino',
        date_of_birth: date_of_birth || '',
        place_of_birth: place_of_birth || '',
        gender: gender || '',
        civil_status: marital_status || '',
        blood_type: blood_type || '',
        religion: religion || '',
        emergency_contact_name: emergency_contact_name || '',
        emergency_contact_relationship: emergency_contact_relationship || '',
        emergency_contact_number: emergency_contact_num || '',
        emergency_contact_secondary_number: emergency_contact_secondary_num || '',
        emergency_contact_email: emergency_contact_email || '',
        emergency_contact_address: emergency_contact_address || '',
        sss_number: sss_number || '',
        philhealth_number: philhealth_number || '',
        pagibig_number: pagibig_number || '',
        tin: tin || '',
        tax_status: tax_status || '',
        bank_name: bank_name || '',
        bank_account: bank_account || '',
        hiring_type: normalizedHiringType,
        agency_name: normalizedHiringType === 'Agency-Hired' ? agency_name || '' : '',
        agency_contact_person: normalizedHiringType === 'Agency-Hired' ? agency_contact_person || '' : '',
        agency_contact_number: normalizedHiringType === 'Agency-Hired' ? agency_contact_number || '' : '',
        deployment_status: normalizedDeploymentStatus || '',
        contract_start_date: normalizedContractStartDate || '',
        contract_end_date: normalizedContractEndDate || '',
      }));
    }
    await pool.execute(
      `UPDATE employees SET ${piiUpdateFields.join(', ')} WHERE id = ?`,
      [...piiUpdateValues, employee_id]
    );
    await sealEmployeeIntegrity(pool, employee_id);
    await writeEmployeeLifecycleAudit(pool, req, `EMPLOYEE_RECORD_CREATED_DIRECT [${finalEmployeeCode}]`, employee_id, null, {
      employee_code: finalEmployeeCode,
      position,
      route_source: route.source || 'position_route',
      lifecycle_action: normalizedLifecycleAction,
      lifecycle_note: normalizedLifecycleNote || null,
      hiring_type: normalizedHiringType,
      lifecycle_status: 'Active',
    });
    await writeEmployeeLifecycleAudit(pool, req, employeeIdMode === 'manual' ? 'EXISTING_EMPLOYEE_ID_ENTERED' : 'EMPLOYEE_ID_AUTO_GENERATED', employee_id, null, {
      employee_code: finalEmployeeCode,
      mode: employeeIdMode,
    });
    console.log('✅ Employee inserted successfully!');
    console.log('Insert result:', { insertId: employee_id, affectedRows: result.affectedRows });
    console.log('Employee Code:', finalEmployeeCode);
    
    // Save wage configuration if provided
    if (wage_type) {
      try {
        console.log('💾 Saving wage configuration for new employee...');
        
        const wage_type_id = await resolveWageTypeId(pool, wage_type);
        
        if (wage_type_id) {
          
          // Update employee wage_type_id
          await pool.execute(
            'UPDATE employees SET wage_type_id = ? WHERE id = ?',
            [wage_type_id, employee_id]
          );
          
          console.log('✅ Updated employee wage_type_id to:', wage_type_id);
          
          // Save base rate for all wage types (or per-piece primary rate)
          if (base_rate !== undefined && base_rate !== null && base_rate !== '') {
            // Insert new base rate with wage_type_id
            await pool.execute(
              'INSERT INTO employee_wage_rates (employee_id, wage_type_id, rate, effective_date) VALUES (?, ?, ?, COALESCE(?, CURDATE()))',
              [employee_id, wage_type_id, parseFloat(base_rate), wage_effective_date || date_hired || null]
            );
            
          }
          
          // Save sewing type specific rates if provided
          if (sewingRates && Array.isArray(sewingRates) && sewingRates.length > 0) {
            for (const sewingRate of sewingRates) {
              if (sewingRate.sewing_id && sewingRate.rate) {
                try {
                  await pool.execute(
                    `INSERT INTO employee_wage_rates 
                     (employee_id, wage_type_id, sewing_type_id, rate, effective_date) 
                     VALUES (?, ?, ?, ?, NOW())`,
                    [employee_id, wage_type_id, sewingRate.sewing_id, parseFloat(sewingRate.rate)]
                  );
                } catch (err) {
                  console.warn('⚠️ Error saving sewing rate:', err.message);
                }
              }
            }
          }
        } else {
          console.warn('⚠️ Wage type not found:', wage_type);
        }
      } catch (err) {
        console.warn('⚠️ Error saving wage configuration:', err.message);
        // Don't fail the whole request if wage save fails, but return both success and warning
      }
    }
    
    return res.status(201).json({ 
      id: employee_id, 
      employee_code: finalEmployeeCode, 
      message: 'Employee added successfully with payroll configuration.' 
    });
  } catch (err) { 
    console.error('❌ ERROR adding employee:');
    console.error('Message:', err.message);
    console.error('SQL Error:', err.sqlMessage);
    console.error('SQL State:', err.sqlState);
    console.error('Full error:', err);
    res.setHeader('Content-Type', 'application/json');
    if (err.code === 'ER_DUP_ENTRY') {
      if (err.sqlMessage && err.sqlMessage.includes('employee_code')) {
        return res.status(409).json({ error: 'Employee ID already exists.' });
      }
      let nextEmployeeCode = null;
      try {
        nextEmployeeCode = await generateNextEmployeeCode(require('./config/db'));
      } catch (codeError) {
        console.warn('Unable to include next employee code in duplicate response:', codeError.message);
      }
      return res.status(409).json({
        error: 'Employee code or email was just used by another record. Please refresh the Employee ID and check the email address.',
        next_employee_code: nextEmployeeCode,
      });
    }
    return res.status(500).json({ error: 'Failed to add employee.' }); 
  }
});

// Update Employee
app.put('/api/employees/:id', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    
    const pool = require('./config/db');
    await ensureEmployeeLifecycleColumns(pool);
    await ensurePhilippineAddressColumns(pool);
    await ensureEmployeeIntegritySchema(pool);
    const { id } = req.params; // numeric employee id
    const validationResponse = await validateEmployeeRequestBody(req, res, pool, { mode: 'update' });
    if (validationResponse) return validationResponse;
    const [existingEmployeeRows] = await pool.execute(
      'SELECT * FROM employees WHERE id = ? OR employee_code = ? LIMIT 1',
      [id, id]
    );
    const existingEmployee = existingEmployeeRows[0] || null;
    if (!existingEmployee) {
      return res.status(404).json({ error: 'Employee not found.' });
    }
    applyEmployeeUpdateDefaults(req.body, existingEmployee);
    const { employee_code, first_name, middle_name, last_name, suffix, email, contact_number, work_email, mailing_address, nationality, marital_status, date_of_birth, place_of_birth, gender, blood_type, religion, residential_address, current_address, emergency_contact_name, emergency_contact_num, emergency_contact_relationship, emergency_contact_secondary_num, emergency_contact_email, emergency_contact_address, education_school, education_attainment, education_units, education_year_graduated, education_jhs_school, education_jhs_attainment, education_jhs_from, education_jhs_to, education_jhs_year_graduated, education_shs_school, education_shs_attainment, education_shs_from, education_shs_to, education_shs_year_graduated, education_vocational_school, education_vocational_attainment, education_vocational_units, education_vocational_from, education_vocational_to, education_vocational_year_graduated, education_college_school, education_college_attainment, education_college_units, education_college_from, education_college_to, education_college_year_graduated, department_id, position, employment_type, hiring_type, agency_name, agency_contact_person, agency_contact_number, deployment_status, contract_start_date, contract_end_date, date_hired, end_of_contract, supervisor, work_location, shift_schedule, employee_level, employment_history, status, employment_status, separation_date, separation_reason, offboarding_remarks, wage_type, base_rate, wage_effective_date, sewingRates, salary_grade, allowances, payroll_schedule, sss_number, philhealth_number, pagibig_number, tin, tax_status, bank_name, bank_account } = req.body;
    const normalizedEmployeeStatus = normalizeEmploymentStatus(employment_status || status);
    
    console.log('\n=== PUT /api/employees/:id ===');
    console.log('Employee ID:', id);
    console.log('Employee update payload received with allowlisted fields:', Object.keys(req.body));
    
    if (!first_name || !last_name || !email) {
      console.error('❌ Missing required fields');
      return res.status(400).json({ error: 'First name, last name, and email are required.' });
    }

    const { errors: addressErrors, addresses } = validateEmployeeAddresses(req.body);
    if (addressErrors.length) {
      return res.status(400).json({ error: addressErrors.join(' ') });
    }

    const requestedEmployeeCode = sanitizeEmployeeCode(employee_code);
    const shouldChangeEmployeeCode = requestedEmployeeCode && existingEmployee && requestedEmployeeCode !== existingEmployee.employee_code;
    if (shouldChangeEmployeeCode) {
      if (!isValidEmployeeCode(requestedEmployeeCode)) {
        return res.status(400).json({ error: 'Employee ID can only contain letters, numbers, hyphens, and underscores.' });
      }
      const [codeRows] = await pool.execute(
        'SELECT id FROM employees WHERE employee_code = ? AND id <> ? LIMIT 1',
        [requestedEmployeeCode, existingEmployee.id]
      );
      if (codeRows.length) {
        await writeEmployeeLifecycleAudit(pool, req, `DUPLICATE_EMPLOYEE_ID_ATTEMPT [${requestedEmployeeCode}]`, existingEmployee.id, null, {
          employee_code: requestedEmployeeCode,
          mode: 'manual_update',
        });
        return res.status(409).json({ error: 'Employee ID already exists.', duplicate: { field: 'employee_code' } });
      }
    }

    const hasAgencyDetails = !!(
      String(agency_name || '').trim() ||
      String(agency_contact_person || '').trim() ||
      String(agency_contact_number || '').trim() ||
      contract_start_date ||
      contract_end_date ||
      (deployment_status && deployment_status !== 'Pending Deployment') ||
      employment_type === 'Contractual'
    );
    const normalizedHiringType = hiring_type === 'Agency-Hired' || hasAgencyDetails ? 'Agency-Hired' : 'Direct Hire';
    const agencyNameValue = normalizedHiringType === 'Agency-Hired' ? agency_name || null : null;
    const agencyContactPersonValue = normalizedHiringType === 'Agency-Hired' ? agency_contact_person || null : null;
    const agencyContactNumberValue = normalizedHiringType === 'Agency-Hired' ? agency_contact_number || null : null;
    const deploymentStatusValue = normalizedHiringType === 'Agency-Hired' ? deployment_status || 'Pending Deployment' : null;
    const contractStartValue = normalizedHiringType === 'Agency-Hired' ? contract_start_date || null : null;
    const contractEndValue = normalizedHiringType === 'Agency-Hired' ? contract_end_date || end_of_contract || null : null;
    const directoryEndOfContract = contractEndValue || end_of_contract || null;


    const [result] = await pool.execute(
      `UPDATE employees SET 
        first_name=?, middle_name=?, last_name=?, suffix=?, email=?, contact_number=?, work_email=?, mailing_address=?,
        nationality=?, marital_status=?, date_of_birth=?, place_of_birth=?, gender=?, blood_type=?, religion=?, residential_address=?, current_address=?, emergency_contact_name=?,
        emergency_contact_num=?, emergency_contact_relationship=?, emergency_contact_secondary_num=?, emergency_contact_email=?, emergency_contact_address=?,
        education_school=?, education_attainment=?, education_units=?, education_year_graduated=?,
        education_jhs_school=?, education_jhs_attainment=?, education_jhs_year_graduated=?,
        education_shs_school=?, education_shs_attainment=?, education_shs_year_graduated=?,
        education_jhs_from=?, education_jhs_to=?, education_shs_from=?, education_shs_to=?,
        education_vocational_school=?, education_vocational_attainment=?, education_vocational_units=?, education_vocational_from=?, education_vocational_to=?, education_vocational_year_graduated=?,
        education_college_school=?, education_college_attainment=?, education_college_units=?, education_college_from=?, education_college_to=?, education_college_year_graduated=?,
        department_id=?, position=?, employment_type=?, hiring_type=?, agency_name=?, agency_contact_person=?, agency_contact_number=?, deployment_status=?, contract_start_date=?, contract_end_date=?,
        date_hired=?, end_of_contract=?, supervisor=?, work_location=?, shift_schedule=?, employee_level=?, employment_history=?, status=?,
        separation_date=?, separation_reason=?, offboarding_remarks=?,
        salary_grade=?, allowances=?, payroll_schedule=?,
        sss_number=?, philhealth_number=?, pagibig_number=?, tin=?, tax_status=?, bank_name=?, bank_account=?
       WHERE id=? OR employee_code=?`,
      [employeeDbValue('first_name', first_name), employeeDbValue('middle_name', middle_name || null), employeeDbValue('last_name', last_name), employeeDbValue('suffix', suffix || null), employeeDbValue('email', email), employeeDbValue('contact_number', contact_number || null), employeeDbValue('work_email', work_email || null), employeeDbValue('mailing_address', addresses.mailing.address || null),
       employeeDbValue('nationality', nationality || 'Filipino'), employeeDbValue('marital_status', marital_status || null), employeeDbValue('date_of_birth', date_of_birth || null), employeeDbValue('place_of_birth', place_of_birth || null), employeeDbValue('gender', gender || null), employeeDbValue('blood_type', blood_type || null), employeeDbValue('religion', religion || null), employeeDbValue('residential_address', addresses.home.address || null), employeeDbValue('current_address', addresses.current.address || null),
       employeeDbValue('emergency_contact_name', emergency_contact_name || null), employeeDbValue('emergency_contact_num', emergency_contact_num || null), employeeDbValue('emergency_contact_relationship', emergency_contact_relationship || null), employeeDbValue('emergency_contact_secondary_num', emergency_contact_secondary_num || null), employeeDbValue('emergency_contact_email', emergency_contact_email || null), employeeDbValue('emergency_contact_address', emergency_contact_address || null),
       employeeDbValue('education_school', education_school || null), employeeDbValue('education_attainment', education_attainment || null), employeeDbValue('education_units', education_units || null), employeeDbValue('education_year_graduated', education_year_graduated || null),
       employeeDbValue('education_jhs_school', education_jhs_school || null), employeeDbValue('education_jhs_attainment', education_jhs_attainment || null), employeeDbValue('education_jhs_year_graduated', education_jhs_year_graduated || null),
       employeeDbValue('education_shs_school', education_shs_school || null), employeeDbValue('education_shs_attainment', education_shs_attainment || null), employeeDbValue('education_shs_year_graduated', education_shs_year_graduated || null),
       employeeDbValue('education_jhs_from', education_jhs_from || null), employeeDbValue('education_jhs_to', education_jhs_to || null), employeeDbValue('education_shs_from', education_shs_from || null), employeeDbValue('education_shs_to', education_shs_to || null),
       employeeDbValue('education_vocational_school', education_vocational_school || null), employeeDbValue('education_vocational_attainment', education_vocational_attainment || null), employeeDbValue('education_vocational_units', education_vocational_units || null), employeeDbValue('education_vocational_from', education_vocational_from || null), employeeDbValue('education_vocational_to', education_vocational_to || null), employeeDbValue('education_vocational_year_graduated', education_vocational_year_graduated || null),
       employeeDbValue('education_college_school', education_college_school || null), employeeDbValue('education_college_attainment', education_college_attainment || null), employeeDbValue('education_college_units', education_college_units || null), employeeDbValue('education_college_from', education_college_from || null), employeeDbValue('education_college_to', education_college_to || null), employeeDbValue('education_college_year_graduated', education_college_year_graduated || null),
       department_id || null, position || null,
       employment_type || 'Regular', normalizedHiringType, agencyNameValue, employeeDbValue('agency_contact_person', agencyContactPersonValue), employeeDbValue('agency_contact_number', agencyContactNumberValue), deploymentStatusValue, contractStartValue, contractEndValue,
       date_hired || null, directoryEndOfContract, supervisor || null, work_location || null, shift_schedule || null, employee_level || null, employment_history || null, normalizedEmployeeStatus,
       separation_date || null, employeeDbValue('separation_reason', separation_reason || null), employeeDbValue('offboarding_remarks', offboarding_remarks || null),
       salary_grade || null, allowances || null, payroll_schedule || null,
       employeeDbValue('sss_number', sss_number || null), employeeDbValue('philhealth_number', philhealth_number || null), employeeDbValue('pagibig_number', pagibig_number || null), employeeDbValue('tin', tin || null), employeeDbValue('tax_status', tax_status || null), employeeDbValue('bank_name', bank_name || null), employeeDbValue('bank_account', bank_account || null), id, id]
    );
    
    console.log('✅ UPDATE executed');
    await pool.execute(
      `UPDATE employees SET
         email_hash = ?,
         residential_address_lat = NULL, residential_address_lng = NULL,
         residential_address_lat_encrypted = ?, residential_address_lng_encrypted = ?,
         residential_address_region = ?, residential_address_province = ?, residential_address_city_municipality = ?,
         residential_address_barangay = ?, residential_address_street_address = ?, residential_address_full_address = ?, residential_address_place_id = ?,
         current_address_lat = NULL, current_address_lng = NULL,
         current_address_lat_encrypted = ?, current_address_lng_encrypted = ?, current_address_same_as_home = ?,
         current_address_region = ?, current_address_province = ?, current_address_city_municipality = ?,
         current_address_barangay = ?, current_address_street_address = ?, current_address_full_address = ?, current_address_place_id = ?,
         mailing_address_lat = NULL, mailing_address_lng = NULL,
         mailing_address_lat_encrypted = ?, mailing_address_lng_encrypted = ?, mailing_address_same_as_home = ?
         , mailing_address_region = ?, mailing_address_province = ?, mailing_address_city_municipality = ?,
         mailing_address_barangay = ?, mailing_address_street_address = ?, mailing_address_full_address = ?, mailing_address_place_id = ?
      WHERE id = ? OR employee_code = ?`,
      [
        hashNullable(email),
        encryptColumnValue(dbNullable(addresses.home.lat)), encryptColumnValue(dbNullable(addresses.home.lng)),
        employeeDbValue('residential_address_region', addresses.home.region), employeeDbValue('residential_address_province', addresses.home.province), employeeDbValue('residential_address_city_municipality', addresses.home.city_municipality),
        employeeDbValue('residential_address_barangay', addresses.home.barangay), employeeDbValue('residential_address_street_address', addresses.home.street_address), employeeDbValue('residential_address_full_address', addresses.home.full_address || addresses.home.address), employeeDbValue('residential_address_place_id', addresses.home.place_id || null),
        encryptColumnValue(dbNullable(addresses.current.lat)), encryptColumnValue(dbNullable(addresses.current.lng)), addresses.sameCurrent ? 1 : 0,
        employeeDbValue('current_address_region', addresses.current.region), employeeDbValue('current_address_province', addresses.current.province), employeeDbValue('current_address_city_municipality', addresses.current.city_municipality),
        employeeDbValue('current_address_barangay', addresses.current.barangay), employeeDbValue('current_address_street_address', addresses.current.street_address), employeeDbValue('current_address_full_address', addresses.current.full_address || addresses.current.address), employeeDbValue('current_address_place_id', addresses.current.place_id || null),
        encryptColumnValue(dbNullable(addresses.mailing.lat)), encryptColumnValue(dbNullable(addresses.mailing.lng)), addresses.sameMailing ? 1 : 0,
        employeeDbValue('mailing_address_region', addresses.mailing.region), employeeDbValue('mailing_address_province', addresses.mailing.province), employeeDbValue('mailing_address_city_municipality', addresses.mailing.city_municipality),
        employeeDbValue('mailing_address_barangay', addresses.mailing.barangay), employeeDbValue('mailing_address_street_address', addresses.mailing.street_address), employeeDbValue('mailing_address_full_address', addresses.mailing.full_address || addresses.mailing.address), employeeDbValue('mailing_address_place_id', addresses.mailing.place_id || null),
        id, id
      ]
    );

    console.log('Rows affected:', result.affectedRows);
    console.log('Change count:', result.changedRows);
    
    if (result.affectedRows === 0) {
      console.error('❌ No rows updated! Employee ID might not exist:', id);
      return res.status(404).json({ error: 'Employee not found.' });
    }

    if (shouldChangeEmployeeCode) {
      await pool.execute('UPDATE employees SET employee_code = ? WHERE id = ?', [requestedEmployeeCode, existingEmployee.id]);
      await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_ID_CHANGED', existingEmployee.id, {
        employee_code: existingEmployee.employee_code,
      }, {
        employee_code: requestedEmployeeCode,
      });
    }

    await deactivateLinkedUserAccounts(pool, existingEmployee?.id || Number(id), normalizedEmployeeStatus, req);
    await sealEmployeeIntegrity(pool, existingEmployee.id);
    await auditSecurityEvent(req, {
      action: 'employee_update_succeeded',
      module: 'EMPLOYEE_SECURITY',
      targetTable: 'employees',
      targetRecord: existingEmployee.id,
      newValue: { fields: Object.keys(req.body), path: req.originalUrl },
      result: 'allowed',
    });

    // Save wage configuration if provided
    if (wage_type) {
      try {
        console.log('💾 Saving wage configuration...');
        
        const wage_type_id = await resolveWageTypeId(pool, wage_type);
        
        if (wage_type_id) {
          
          // Update employee wage_type_id
          await pool.execute(
            'UPDATE employees SET wage_type_id = ? WHERE id = ?',
            [wage_type_id, id]
          );
          
          console.log('✅ Updated employee wage_type_id to:', wage_type_id);
          
          const hasBaseRateInput = Object.prototype.hasOwnProperty.call(req.body, 'base_rate');

          // Save base rate for all wage types (or per-piece primary rate). If the user
          // clears the field, end the active wage rate so the old value stops showing.
          if (hasBaseRateInput && (base_rate === null || base_rate === '')) {
            await pool.execute(
              'UPDATE employee_wage_rates SET end_date = NOW() WHERE employee_id = ? AND end_date IS NULL',
              [id]
            );
            console.log('✅ Cleared active base rate for employee:', id);
          } else if (base_rate !== undefined && base_rate !== null && base_rate !== '') {
            // Mark previous rates as ended
            await pool.execute(
              'UPDATE employee_wage_rates SET end_date = NOW() WHERE employee_id = ? AND end_date IS NULL',
              [id]
            );
            
            // Insert new base rate with wage_type_id
            await pool.execute(
              'INSERT INTO employee_wage_rates (employee_id, wage_type_id, rate, effective_date) VALUES (?, ?, ?, COALESCE(?, CURDATE()))',
              [id, wage_type_id, parseFloat(base_rate), wage_effective_date || date_hired || null]
            );
            
          }
          
          // Save sewing type specific rates if provided
          if (sewingRates && Array.isArray(sewingRates) && sewingRates.length > 0) {
            for (const sewingRate of sewingRates) {
              if (sewingRate.sewing_id && sewingRate.rate) {
                try {
                  await pool.execute(
                    `INSERT INTO employee_wage_rates 
                     (employee_id, wage_type_id, sewing_type_id, rate, effective_date) 
                     VALUES (?, ?, ?, ?, NOW())`,
                    [id, wage_type_id, sewingRate.sewing_id, parseFloat(sewingRate.rate)]
                  );
                } catch (err) {
                  console.warn('⚠️ Error saving sewing rate:', err.message);
                }
              }
            }
          }
        } else {
          console.warn('⚠️ Wage type not found:', wage_type);
        }
      } catch (err) {
        console.error('❌ Error saving wage configuration:', err.message);
        // Log error but continue - don't fail entire request
      }
    }
    
    console.log('✅ Employee updated successfully');
    return res.status(200).json({ message: 'Employee updated successfully.' });
  } catch (err) { 
    console.error('Error updating employee:', err.message, err.sqlMessage);
    res.setHeader('Content-Type', 'application/json');
    return res.status(500).json({ error: 'Failed to update employee.' }); 
  }
});

// Full offboarding workflow
app.post('/api/employees/:id/offboard', requireAuth, requireRole(ROLES.any), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  const pool = require('./config/db');
  let connection;
  try {
    res.setHeader('Content-Type', 'application/json');
    await ensureEmployeeLifecycleManagementSchema(pool);
    const { id } = req.params;
    if (await rejectEmployeeUnsupportedSubresourceFields(req, res, EMPLOYEE_OFFBOARD_ALLOWED_FIELDS, 'offboarding')) return;
    if (!canCreateOffboarding(req)) return rejectLifecycleUnauthorized(req, res, 'blocked_employee_offboarding_unauthorized', id);

    let offboardingType;
    let targetStatus;
    let clearanceStatus;
    let finalPayStatus;
    let accountAction;
    let companyPropertyStatus;
    let turnoverStatus;
    let exitInterviewStatus;
    let attendanceLeaveClearance;
    let payrollClearanceStatus;
    let itAccessStatus;
    let offboardingStatus;
    let clearanceItems = [];
    try {
      const choiceOrDefault = (field, allowed, fallback) => {
        if (req.body[field] === undefined || req.body[field] === null || String(req.body[field]).trim() === '') {
          req.body[field] = fallback;
        }
        return validateLifecycleChoice(req.body, field, allowed);
      };
      offboardingType = validateLifecycleChoice(req.body, 'offboarding_type', new Set(EMPLOYEE_OFFBOARDING_TYPES.keys()));
      targetStatus = EMPLOYEE_OFFBOARDING_TYPES.get(offboardingType);
      validateEmployeeDateField(req.body, 'effective_date', { required: true });
      validateEmployeeDateField(req.body, 'last_working_day', { required: true });
      validateDateOrder(req.body, 'effective_date', 'last_working_day');
      validateEmployeeTextField(req.body, 'reason', { max: 180, pattern: EMPLOYEE_SAFE_TEXT_PATTERN, allowEmpty: false });
      clearanceStatus = choiceOrDefault('clearance_status', EMPLOYEE_CLEARANCE_STATUSES, 'Pending');
      finalPayStatus = choiceOrDefault('final_pay_status', EMPLOYEE_FINAL_PAY_STATUSES, 'Pending');
      companyPropertyStatus = choiceOrDefault('company_property_status', EMPLOYEE_COMPANY_PROPERTY_STATUSES, 'Pending');
      turnoverStatus = choiceOrDefault('turnover_status', EMPLOYEE_TURNOVER_STATUSES, 'Pending');
      exitInterviewStatus = choiceOrDefault('exit_interview_status', EMPLOYEE_EXIT_INTERVIEW_STATUSES, 'Pending');
      attendanceLeaveClearance = choiceOrDefault('attendance_leave_clearance', EMPLOYEE_ATTENDANCE_LEAVE_CLEARANCES, 'Pending');
      payrollClearanceStatus = choiceOrDefault('payroll_clearance_status', EMPLOYEE_PAYROLL_CLEARANCE_STATUSES, 'Pending');
      itAccessStatus = choiceOrDefault('it_access_status', EMPLOYEE_IT_ACCESS_STATUSES, 'Pending');
      offboardingStatus = normalizeOffboardingStatusForStorage(choiceOrDefault('offboarding_status', EMPLOYEE_OFFBOARDING_PROCESS_STATUSES, 'For Offboarding'));
      if (isTerminalOffboardingStatus(offboardingStatus)) return res.status(400).json({ error: 'Offboarding cannot be created as completed. Complete it after clearance, payroll review, and final approval.' });
      clearanceItems = validateOffboardingClearanceItems(req.body.clearance_items);
      if (clearanceItems.length) clearanceStatus = normalizeClearanceStatusFromItems(clearanceItems);
      accountAction = validateLifecycleChoice(req.body, 'account_action', EMPLOYEE_ACCOUNT_ACTIONS);
      validateEmployeeTextField(req.body, 'remarks', { max: 500, pattern: EMPLOYEE_SAFE_TEXT_PATTERN });
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message || 'Invalid offboarding details.', field: error.field || null });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [employeeRows] = await connection.execute(
      `SELECT e.id, e.employee_code, e.first_name, e.middle_name, e.last_name, e.status, e.position,
              e.department_id, d.name AS department
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
        WHERE e.id = ?
        LIMIT 1
        FOR UPDATE`,
      [id]
    );
    if (!employeeRows.length) {
      await connection.rollback();
      await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_OFFBOARDING_FAILED_NOT_FOUND', Number(id), null, null).catch(() => {});
      return res.status(404).json({ error: 'Employee not found.' });
    }
    const employee = employeeRows[0];
    if (employee.status !== 'Active') {
      await connection.rollback();
      return res.status(400).json({ error: 'Only Active employees can be offboarded.' });
    }

    const [pendingRows] = await connection.execute(
      `SELECT offboarding_case_id
         FROM employee_offboarding_case
        WHERE employee_id = ?
          AND status IN ('Pending','In Progress','For Offboarding','Clearance Pending','Payroll Review','Final Approval')
        LIMIT 1`,
      [id]
    );
    if (pendingRows.length) {
      await connection.rollback();
      return res.status(400).json({ error: 'Employee already has a pending offboarding request.', request_id: pendingRows[0].offboarding_case_id });
    }

    const shouldDisableNow = accountAction === 'Disable Immediately';
    const accountDeactivated = shouldDisableNow ? await deactivateLinkedUserAccounts(connection, Number(id), targetStatus, req) : 0;

    const [caseResult] = await connection.execute(
      `INSERT INTO employee_offboarding_case
         (employee_id, status, offboarding_type, separation_type, effective_date, last_working_day,
          separation_date, separation_reason, clearance_status, company_property_status, turnover_status,
          exit_interview_status, attendance_leave_clearance, payroll_clearance_status, final_pay_status,
          it_access_status, account_action, account_deactivated, sessions_invalidated, remarks, created_by, processed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        offboardingStatus,
        offboardingType,
        targetStatus,
        req.body.effective_date,
        req.body.last_working_day,
        req.body.effective_date,
        req.body.reason,
        clearanceStatus,
        companyPropertyStatus,
        turnoverStatus,
        exitInterviewStatus,
        attendanceLeaveClearance,
        payrollClearanceStatus,
        finalPayStatus,
        itAccessStatus,
        accountAction,
        accountDeactivated > 0 ? 1 : 0,
        accountDeactivated > 0 ? 1 : 0,
        req.body.remarks || null,
        req.user.id || null,
        req.user.id || null,
      ]
    );
    await seedOffboardingChecklistItems(connection, caseResult.insertId);
    if (clearanceItems.length) {
      await upsertOffboardingChecklistItems(connection, req, caseResult.insertId, clearanceItems);
    }

    await connection.execute(
      `UPDATE employees
          SET lifecycle_status = 'On Hold',
              separation_date = ?,
              separation_reason = ?,
              offboarding_remarks = ?,
              updated_at = NOW()
        WHERE id = ?`,
      [req.body.effective_date, employeeDbValue('separation_reason', req.body.reason), employeeDbValue('offboarding_remarks', req.body.remarks || null), id]
    );

    await connection.execute(
      `INSERT INTO employee_lifecycle_event
         (employee_id, event_type, previous_status, new_status, effective_date, reason, remarks, created_by)
       VALUES (?, 'STATUS_CHANGED', ?, ?, ?, ?, ?, ?)`,
      [id, employee.status || null, offboardingStatus, req.body.effective_date, req.body.reason, req.body.remarks || null, req.user.id || null]
    );

    await writeEmployeeLifecycleAudit(connection, req, 'OFFBOARDING_CREATED', Number(id), {
      status: employee.status,
    }, {
      status: offboardingStatus,
      target_employee_status: targetStatus,
      offboarding_case_id: caseResult.insertId,
      offboarding_type: offboardingType,
      clearance_status: clearanceStatus,
      final_pay_status: finalPayStatus,
      checklist_items: clearanceItems.length || EMPLOYEE_OFFBOARDING_CHECKLIST_ITEMS.length,
      account_action: accountAction,
      account_deactivated: accountDeactivated > 0,
    });

    const safeEmployeeName = employeeDisplayName(decryptEmployeeStrictPii({ ...employee })) || employee.employee_code;

    await connection.commit();
    return res.status(200).json({
      message: `Offboarding request created for ${safeEmployeeName}.`,
      offboarding_case_id: caseResult.insertId,
      employee_name: safeEmployeeName,
      employee_code: employee.employee_code,
      status: employee.status,
      request_status: offboardingStatus,
      clearance_status: clearanceStatus,
    });
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Error offboarding employee:', err.message, err.sqlMessage);
    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_OFFBOARDING_FAILED', Number(req.params.id), null, { error: err.message }).catch(() => {});
    return res.status(500).json({ error: 'Failed to offboard employee.' });
  } finally {
    if (connection) connection.release();
  }
});

app.patch('/api/employees/offboarding/:caseId', requireAuth, requireRole(ROLES.any), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  const pool = require('./config/db');
  let connection;
  try {
    await ensureEmployeeLifecycleManagementSchema(pool);
    await ensureEmployeeIntegritySchema(pool);
    const caseId = Number(req.params.caseId);
    if (!caseId) return res.status(400).json({ error: 'Valid offboarding case id is required.' });

    const isHrProcessor = canCreateOffboarding(req);
    const isItProcessor = canUpdateItOffboarding(req);
    if (!isHrProcessor && !isItProcessor) {
      return rejectLifecycleUnauthorized(req, res, 'unauthorized_offboarding_attempt_denied', caseId);
    }

    const hrFields = new Set(['clearance_status', 'company_property_status', 'turnover_status', 'exit_interview_status', 'attendance_leave_clearance', 'offboarding_status', 'clearance_items', 'remarks']);
    const itFields = new Set(['it_access_status', 'permissions_revoked', 'sessions_invalidated', 'biometric_access_removed', 'it_processed_at']);
    const allowed = new Set([...(isHrProcessor ? hrFields : []), ...(isItProcessor ? itFields : [])]);
    if (await rejectEmployeeUnsupportedSubresourceFields(req, res, allowed, 'offboarding_update')) return;

    const updates = [];
    const values = [];
    let requestedStatus = null;
    let clearanceItems = [];
    const setChoice = (field, allowedValues) => {
      if (!Object.prototype.hasOwnProperty.call(req.body, field)) return null;
      const value = validateLifecycleChoice(req.body, field, allowedValues);
      updates.push(`${field} = ?`);
      values.push(value);
      return value;
    };
    const setBool = field => {
      if (!Object.prototype.hasOwnProperty.call(req.body, field)) return null;
      const value = req.body[field] === true || req.body[field] === 'true' || req.body[field] === '1' || req.body[field] === 'Yes' ? 1 : 0;
      updates.push(`${field} = ?`);
      values.push(value);
      return value;
    };

    try {
      setChoice('clearance_status', EMPLOYEE_CLEARANCE_STATUSES);
      setChoice('company_property_status', EMPLOYEE_COMPANY_PROPERTY_STATUSES);
      setChoice('turnover_status', EMPLOYEE_TURNOVER_STATUSES);
      setChoice('exit_interview_status', EMPLOYEE_EXIT_INTERVIEW_STATUSES);
      setChoice('attendance_leave_clearance', EMPLOYEE_ATTENDANCE_LEAVE_CLEARANCES);
      const requestedStatusRaw = setChoice('offboarding_status', EMPLOYEE_OFFBOARDING_PROCESS_STATUSES);
      if (requestedStatusRaw) {
        requestedStatus = normalizeOffboardingStatusForStorage(requestedStatusRaw);
        values[values.length - 1] = requestedStatus;
      }
      if (isHrProcessor && Object.prototype.hasOwnProperty.call(req.body, 'clearance_items')) {
        clearanceItems = validateOffboardingClearanceItems(req.body.clearance_items);
      }
      setChoice('it_access_status', EMPLOYEE_IT_ACCESS_STATUSES);
      setBool('permissions_revoked');
      setBool('sessions_invalidated');
      setBool('biometric_access_removed');
      if (Object.prototype.hasOwnProperty.call(req.body, 'it_processed_at')) {
        if (req.body.it_processed_at) {
          try {
            req.body.it_processed_at = strictDateOnly(req.body.it_processed_at, 'IT processed date', { noFuture: true });
          } catch (error) {
            return res.status(400).json({ error: error.message || 'IT processed date is invalid.', field: 'it_processed_at' });
          }
        }
        updates.push('it_processed_at = ?');
        values.push(req.body.it_processed_at || null);
      }
      if (isHrProcessor && Object.prototype.hasOwnProperty.call(req.body, 'remarks')) {
        validateEmployeeTextField(req.body, 'remarks', { max: 500, pattern: EMPLOYEE_SAFE_TEXT_PATTERN });
        updates.push('remarks = ?');
        values.push(req.body.remarks || null);
      }
      if (!updates.length && !clearanceItems.length) return res.status(400).json({ error: 'No valid offboarding fields supplied.' });
      if (isItProcessor && (req.body.it_access_status || req.body.permissions_revoked || req.body.sessions_invalidated || req.body.biometric_access_removed || req.body.it_processed_at)) {
        updates.push('it_processed_by = ?');
        values.push(req.user.id || null);
      }
      if (requestedStatus && isTerminalOffboardingStatus(requestedStatus)) {
        updates.push('completed_by = ?', 'completed_at = NOW()');
        values.push(req.user.id || null);
      }
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message || 'Invalid offboarding update.', field: error.field || null });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [caseRows] = await connection.execute(
      `SELECT oc.*, e.status AS employee_status
         FROM employee_offboarding_case oc
         JOIN employees e ON e.id = oc.employee_id
        WHERE oc.offboarding_case_id = ?
        LIMIT 1
        FOR UPDATE`,
      [caseId]
    );
    if (!caseRows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Offboarding case not found.' });
    }
    const current = caseRows[0];
    requestedStatus = requestedStatus || current.status;
    if (!isAllowedOffboardingTransition(current.status, requestedStatus)) {
      await connection.rollback();
      return res.status(400).json({ error: `Invalid offboarding transition from ${current.status} to ${requestedStatus}.` });
    }
    const oldChecklistItems = await loadOffboardingChecklistItems(connection, caseId);
    if (clearanceItems.length) {
      await upsertOffboardingChecklistItems(connection, req, caseId, clearanceItems);
    }
    const checklistItems = await loadOffboardingChecklistItems(connection, caseId);
    const checklistComplete = areOffboardingChecklistItemsComplete(checklistItems);
    const derivedClearanceStatus = normalizeClearanceStatusFromItems(checklistItems);
    const next = { ...current, ...req.body, status: requestedStatus, clearance_status: derivedClearanceStatus };
    const truthyProcessValue = value => value === true || value === 1 || value === '1' || value === 'true' || value === 'Yes';
    const completing = isTerminalOffboardingStatus(requestedStatus);
    if (completing) {
      const payrollOk = ['Checked', 'Cleared'].includes(String(current.payroll_clearance_status || next.payroll_clearance_status));
      const finalPayOk = ['Approved', 'Released', 'Processed'].includes(String(current.final_pay_status || next.final_pay_status));
      if (!checklistComplete || !payrollOk || !finalPayOk) {
        await connection.rollback();
        return res.status(400).json({ error: 'Checklist clearance, payroll review, and final pay approval must be completed before final approval.' });
      }
    }

    const hasExplicitStatusUpdate = updates.some(update => update.startsWith('offboarding_status') || update.startsWith('status'));
    const statusUpdateIndex = updates.findIndex(update => update === 'offboarding_status = ?');
    if (statusUpdateIndex >= 0) updates[statusUpdateIndex] = 'status = ?';
    if (clearanceItems.length) {
      const autoStatus = checklistComplete ? 'Payroll Review' : 'Clearance Pending';
      if (!hasExplicitStatusUpdate && ['For Offboarding', 'Clearance Pending', 'Pending', 'In Progress'].includes(current.status)) {
        updates.push('status = ?');
        values.push(autoStatus);
        requestedStatus = autoStatus;
      }
      if (!updates.some(update => update === 'clearance_status = ?')) {
        updates.push('clearance_status = ?');
        values.push(derivedClearanceStatus);
      }
    }

    if (updates.length) {
      values.push(caseId);
      await connection.execute(`UPDATE employee_offboarding_case SET ${updates.join(', ')} WHERE offboarding_case_id = ?`, values);
    }

    if (isItProcessor && (req.body.it_access_status || req.body.permissions_revoked || req.body.sessions_invalidated || req.body.biometric_access_removed)) {
      await writeEmployeeLifecycleAudit(connection, req, 'IT_ACCESS_REVOKED', current.employee_id, null, { offboarding_case_id: caseId, ...req.body });
    }

    if (requestedStatus === 'Cancelled') {
      await connection.execute(
        `UPDATE employees
            SET status = 'Active',
                lifecycle_status = 'Active',
                separation_date = NULL,
                separation_reason = NULL,
                offboarding_remarks = NULL,
                offboarding_clearance_result = NULL,
                updated_at = NOW()
          WHERE id = ?`,
        [current.employee_id]
      );
      await connection.execute(
        `INSERT INTO employee_lifecycle_event
           (employee_id, event_type, previous_status, new_status, effective_date, reason, remarks, created_by)
         VALUES (?, 'STATUS_CHANGED', ?, 'Active', ?, 'Offboarding cancelled', ?, ?)`,
        [current.employee_id, current.employee_status || null, current.effective_date, req.body.remarks || current.remarks || null, req.user.id || null]
      );
      await writeEmployeeLifecycleAudit(connection, req, 'OFFBOARDING_CANCELLED', current.employee_id, { offboarding_case_id: caseId, status: current.status }, { status: 'Active', remarks: req.body.remarks || null });
      await sealEmployeeIntegrity(connection, current.employee_id);
    } else if (completing) {
      const finalEmployeeStatus = employeeStatusFromOffboardingFinalStatus(requestedStatus, current.separation_type);
      await connection.execute(
        `UPDATE employees
            SET status = ?,
                lifecycle_status = 'Active',
                separation_date = ?,
                separation_reason = ?,
                offboarding_remarks = ?,
                offboarding_clearance_result = ?,
                updated_at = NOW()
          WHERE id = ?`,
        [
          finalEmployeeStatus,
          current.effective_date,
          employeeDbValue('separation_reason', current.separation_reason),
          employeeDbValue('offboarding_remarks', req.body.remarks || current.remarks || null),
          derivedClearanceStatus,
          current.employee_id,
        ]
      );
      const accountDeactivated = await deactivateLinkedUserAccounts(connection, Number(current.employee_id), finalEmployeeStatus, req);
      await connection.execute(
        `UPDATE biometric_employee_mapping
            SET is_active = 0,
                updated_by = ?
          WHERE employee_id = ?`,
        [req.user.id || null, current.employee_id]
      ).catch(() => {});
      await connection.execute(
        `UPDATE employee_offboarding_case
            SET it_access_status = 'Revoked',
                permissions_revoked = 1,
                sessions_invalidated = 1,
                biometric_access_removed = 1,
                it_processed_by = ?,
                it_processed_at = NOW(),
                account_deactivated = CASE WHEN ? > 0 THEN 1 ELSE account_deactivated END
          WHERE offboarding_case_id = ?`,
        [req.user.id || null, accountDeactivated || 0, caseId]
      );
      await connection.execute(
        `INSERT INTO employee_lifecycle_event
           (employee_id, event_type, previous_status, new_status, effective_date, reason, remarks, created_by)
         VALUES (?, 'OFFBOARDED', ?, ?, ?, ?, ?, ?)`,
        [current.employee_id, current.employee_status || null, finalEmployeeStatus, current.effective_date, current.separation_reason, req.body.remarks || current.remarks || null, req.user.id || null]
      );
      await writeEmployeeLifecycleAudit(connection, req, 'OFFBOARDING_FINAL_APPROVED', current.employee_id, { offboarding_case_id: caseId, status: current.status }, { offboarding_case_id: caseId, status: finalEmployeeStatus, clearance_status: derivedClearanceStatus });
      await sealEmployeeIntegrity(connection, current.employee_id);
    } else {
      await writeEmployeeLifecycleAudit(connection, req, clearanceItems.length ? 'OFFBOARDING_CLEARANCE_CHECKLIST_UPDATED' : 'CLEARANCE_UPDATED', current.employee_id, {
        offboarding_case_id: caseId,
        status: current.status,
        clearance_status: current.clearance_status,
        checklist_items: oldChecklistItems,
      }, {
        offboarding_case_id: caseId,
        status: requestedStatus,
        clearance_status: derivedClearanceStatus,
        checklist_items: checklistItems,
        ...req.body,
      });
    }

    await connection.commit();
    return res.json({
      message: completing ? 'Offboarding final approval completed.' : requestedStatus === 'Cancelled' ? 'Offboarding cancelled and employee restored to Active.' : 'Offboarding updated.',
      offboarding_case_id: caseId,
      request_status: requestedStatus,
    });
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Error updating offboarding:', err.message, err.sqlMessage);
    return res.status(500).json({ error: 'Failed to update offboarding.' });
  } finally {
    if (connection) connection.release();
  }
});

// Re-onboard a previously offboarded employee
app.post('/api/employees/:id/reonboard', requireAuth, requireRole(ROLES.any), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  const pool = require('./config/db');
  let connection;
  try {
    res.setHeader('Content-Type', 'application/json');
    await ensureEmployeeLifecycleManagementSchema(pool);
    await ensureEmployeeIntegritySchema(pool);
    const { id } = req.params;
    if (await rejectEmployeeUnsupportedSubresourceFields(req, res, EMPLOYEE_REONBOARD_ALLOWED_FIELDS, 'reonboarding')) return;
    if (!canCreateReonboarding(req)) return rejectLifecycleUnauthorized(req, res, 'blocked_employee_reonboarding_unauthorized', id);

    req.body.rehire_date = req.body.rehire_date || req.body.date_hired;
    let payrollSetupStatus;
    let forcePasswordReset = true;
    try {
      validateEmployeeDateField(req.body, 'rehire_date', { required: true });
      validateEmployeeTextField(req.body, 'new_position', { max: 120, pattern: EMPLOYEE_SAFE_TEXT_PATTERN, allowEmpty: false });
      validateEmployeeTextField(req.body, 'work_location', { max: 160, pattern: EMPLOYEE_SAFE_TEXT_PATTERN });
      validateEmployeeNameLikeField(req.body, 'new_supervisor', { max: 120 });
      validateEmployeeTextField(req.body, 'remarks', { max: 500, pattern: EMPLOYEE_SAFE_TEXT_PATTERN });
      validateEmployeeEnumField(req.body, 'employment_type', EMPLOYEE_ENUMS.employment_type);
      validateEmployeeEnumField(req.body, 'hiring_type', EMPLOYEE_ENUMS.hiring_type);
      validateEmployeeEnumField(req.body, 'employee_level', EMPLOYEE_ENUMS.employee_level);
      payrollSetupStatus = validateLifecycleChoice(req.body, 'payroll_setup_status', EMPLOYEE_PAYROLL_SETUP_STATUSES);
      validateEmployeeTextField(req.body, 'assigned_system_role', { max: 80, pattern: EMPLOYEE_SAFE_TEXT_PATTERN, allowEmpty: false });
      forcePasswordReset = req.body.force_password_reset === false || req.body.force_password_reset === 'false' || req.body.force_password_reset === '0' ? 0 : 1;
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message || 'Invalid re-onboarding details.', field: error.field || null });
    }

    connection = await pool.getConnection();
    await connection.beginTransaction();

    const [employeeRows] = await connection.execute(
      `SELECT e.id, e.employee_code, e.first_name, e.middle_name, e.last_name, e.status, e.position,
              e.department_id, e.separation_date, e.separation_reason, d.name AS department
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
        WHERE e.id = ?
        LIMIT 1
        FOR UPDATE`,
      [id]
    );
    if (!employeeRows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Employee not found.' });
    }
    const employee = employeeRows[0];
    if (!EMPLOYEE_REONBOARDABLE_STATUSES.has(employee.status)) {
      await connection.rollback();
      return res.status(400).json({ error: 'Only Resigned, Terminated, End of Contract, Retired, or Offboarded employees can be re-onboarded.' });
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'department_id')) {
      await validateDepartmentId(connection, req.body);
    }
    if (!req.body.department_id && !req.body.work_location) {
      await connection.rollback();
      return res.status(400).json({ error: 'Department or work location is required.', field: 'department_id' });
    }

    const [roleRows] = await connection.execute('SELECT id, name FROM roles WHERE name = ? OR label = ? LIMIT 1', [req.body.assigned_system_role, req.body.assigned_system_role]);
    if (!roleRows.length) {
      await connection.rollback();
      return res.status(400).json({ error: 'Assigned system role is invalid.', field: 'assigned_system_role' });
    }

    const [offboardingRows] = await connection.execute(
      `SELECT offboarding_case_id, effective_date, separation_reason
         FROM employee_offboarding_case
        WHERE employee_id = ?
        ORDER BY created_at DESC
        LIMIT 1`,
      [id]
    );
    const previousOffboardingCaseId = offboardingRows[0]?.offboarding_case_id || null;

    const [pendingRows] = await connection.execute(
      `SELECT reonboarding_case_id
         FROM employee_reonboarding_case
        WHERE employee_id = ?
          AND status = 'Pending'
        LIMIT 1`,
      [id]
    );
    if (pendingRows.length) {
      await connection.rollback();
      return res.status(400).json({ error: 'Employee already has a pending re-onboarding request.', request_id: pendingRows[0].reonboarding_case_id });
    }

    await connection.execute(
      `UPDATE users
          SET role_id = ?,
              is_active = 1,
              account_status = 'Active',
              force_password_change = ?,
              password_changed_at = NOW(),
              token_version = COALESCE(token_version, 0) + 1
        WHERE employee_id = ?`,
      [roleRows[0].id, forcePasswordReset, id]
    );
    const accountReactivated = await reactivateLinkedUserAccounts(connection, Number(id), req);

    const [caseResult] = await connection.execute(
      `INSERT INTO employee_reonboarding_case
         (employee_id, previous_offboarding_case_id, status, rehire_date, department_id, work_location,
          position, employment_type, hiring_type, new_supervisor, employee_level, payroll_setup_status,
          assigned_system_role, force_password_reset, account_reactivated, remarks, created_by)
       VALUES (?, ?, 'Pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        previousOffboardingCaseId,
        req.body.rehire_date,
        req.body.department_id || null,
        req.body.work_location || null,
        req.body.new_position || null,
        req.body.employment_type || null,
        req.body.hiring_type || null,
        req.body.new_supervisor || null,
        req.body.employee_level || null,
        payrollSetupStatus,
        roleRows[0].name,
        forcePasswordReset,
        accountReactivated > 0 ? 1 : 0,
        req.body.remarks || null,
        req.user.id || null,
      ]
    );

    const updateFields = [
      'status = ?',
      "lifecycle_status = 'Active'",
      'date_hired = ?',
      'position = ?',
      'employment_type = ?',
      'hiring_type = ?',
      'supervisor = ?',
      'employee_level = ?',
      'separation_date = NULL',
      'separation_reason = NULL',
      'offboarding_remarks = NULL',
      'updated_at = NOW()',
    ];
    const updateValues = ['Active', req.body.rehire_date, req.body.new_position, req.body.employment_type || null, req.body.hiring_type || null, req.body.new_supervisor || null, req.body.employee_level || null];

    if (Object.prototype.hasOwnProperty.call(req.body, 'department_id')) {
      updateFields.push('department_id = ?');
      updateValues.push(req.body.department_id || null);
    }
    if (Object.prototype.hasOwnProperty.call(req.body, 'work_location')) {
      updateFields.push('work_location = ?');
      updateValues.push(req.body.work_location || null);
    }
    updateValues.push(id);

    await connection.execute(`UPDATE employees SET ${updateFields.join(', ')} WHERE id = ?`, updateValues);
    await sealEmployeeIntegrity(connection, Number(id));

    await connection.execute(
      `INSERT INTO employee_lifecycle_event
         (employee_id, event_type, previous_status, new_status, effective_date, reason, remarks, created_by)
       VALUES (?, 'REONBOARDED', ?, 'Active', ?, 'Re-onboarding', ?, ?)`,
      [id, employee.status || null, req.body.rehire_date, req.body.remarks || null, req.user.id || null]
    );

    await writeEmployeeLifecycleAudit(connection, req, 'EMPLOYEE_REONBOARDED', Number(id), {
      status: employee.status,
      previous_offboarding_case_id: previousOffboardingCaseId,
    }, {
      status: 'Active',
      reonboarding_case_id: caseResult.insertId,
      assigned_system_role: roleRows[0].name,
      payroll_setup_status: payrollSetupStatus,
      account_reactivated: accountReactivated > 0,
      force_password_reset: Boolean(forcePasswordReset),
    });

    await connection.commit();
    return res.status(200).json({
      message: 'Re-onboarding request created and employee restored to Active status.',
      reonboarding_case_id: caseResult.insertId,
      request_status: 'Pending',
      status: 'Active',
    });
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Error re-onboarding employee:', err.message, err.sqlMessage);
    return res.status(500).json({ error: 'Failed to re-onboard employee.' });
  } finally {
    if (connection) connection.release();
  }
});

app.get('/api/employees/:id/lifecycle', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeLifecycleManagementSchema(pool);
    const employeeId = await ensureEmployeeRouteAccess(pool, req, res, {
      action: 'blocked_employee_lifecycle_idor_attempt',
    });
    if (!employeeId) return;

    const [events] = await pool.execute(
      `SELECT lifecycle_event_id, event_type, previous_status, new_status, effective_date,
              reason, remarks, created_by, created_at
         FROM employee_lifecycle_event
        WHERE employee_id = ?
        ORDER BY created_at DESC`,
      [employeeId]
    );
    const [offboardingCases] = await pool.execute(
      `SELECT offboarding_case_id, status, offboarding_type, separation_type, effective_date,
              last_working_day, separation_date, separation_reason,
              clearance_status, final_pay_status, account_action, account_deactivated,
              company_property_status, turnover_status, exit_interview_status, attendance_leave_clearance,
              payroll_clearance_status, payroll_checked_by, payroll_checked_at,
              final_attendance_cutoff, unpaid_salary, final_deductions, final_allowances, pending_benefits,
              payroll_remarks, final_pay_approved_by, final_pay_approved_at,
              final_pay_release_date, final_pay_remarks, it_access_status, permissions_revoked,
              sessions_invalidated, biometric_access_removed, it_processed_by, it_processed_at,
              remarks, created_at, completed_at
         FROM employee_offboarding_case
        WHERE employee_id = ?
        ORDER BY created_at DESC`,
      [employeeId]
    );
    for (const offboardingCase of offboardingCases) {
      offboardingCase.clearance_items = await loadOffboardingChecklistItems(pool, offboardingCase.offboarding_case_id);
      offboardingCase.documents = await loadOffboardingDocuments(pool, offboardingCase.offboarding_case_id);
    }
    const [reonboardingCases] = await pool.execute(
      `SELECT reonboarding_case_id, previous_offboarding_case_id, rehire_date, department_id,
              work_location, position, employment_type, hiring_type, new_supervisor,
              employee_level, payroll_setup_status, assigned_system_role, force_password_reset,
              contract_start_date, contract_end_date,
              account_reactivated, remarks, created_at
         FROM employee_reonboarding_case
        WHERE employee_id = ?
        ORDER BY created_at DESC`,
      [employeeId]
    );

    res.json({ events, offboarding_cases: offboardingCases, reonboarding_cases: reonboardingCases });
  } catch (err) {
    console.error('Error loading employee lifecycle:', err.message, err.sqlMessage);
    res.status(500).json({ error: 'Failed to load employee lifecycle.' });
  }
});

// Update Employee Status
app.patch('/api/employees/:id/status', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    const pool = require('./config/db');
    await ensureEmployeeLifecycleColumns(pool);
    await ensureEmployeeIntegritySchema(pool);
    const { id } = req.params; // id = numeric employee id
    if (await rejectEmployeeUnsupportedSubresourceFields(req, res, EMPLOYEE_STATUS_ALLOWED_FIELDS, 'status')) return;
    const { separation_date, separation_reason, offboarding_remarks } = req.body;
    const requestedStatus = normalizeBlank(req.body.employment_status || req.body.status);

    if (!requestedStatus || !EMPLOYEE_ENUMS.status.has(requestedStatus)) {
      await auditSecurityEvent(req, {
        action: 'blocked_employee_invalid_status',
        module: 'EMPLOYEE_SECURITY',
        targetTable: 'employees',
        targetRecord: id,
        newValue: { field: 'status', value: requestedStatus, path: req.originalUrl },
        result: 'blocked',
      });
      return res.status(400).json({ error: `Invalid status. Must be one of: ${EMPLOYEE_STATUS_OPTIONS.join(', ')}.` });
    }
    const status = requestedStatus;
    try {
      validateEmployeeDateField(req.body, 'separation_date');
      validateEmployeeTextField(req.body, 'separation_reason', { max: 120 });
      validateEmployeeTextField(req.body, 'offboarding_remarks', { max: 500, pattern: EMPLOYEE_SAFE_TEXT_PATTERN });
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message || 'Invalid status details.', field: error.field || null });
    }

    console.log('PATCH /api/employees/:id/status - Employee ID:', id, '- New Status:', status);

    const [result] = await pool.execute(
      `UPDATE employees
          SET status = ?,
              separation_date = ?,
              separation_reason = ?,
              offboarding_remarks = ?
        WHERE id = ?`,
      [status, req.body.separation_date || null, req.body.separation_reason || null, req.body.offboarding_remarks || null, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    await deactivateLinkedUserAccounts(pool, Number(id), status, req);
    await sealEmployeeIntegrity(pool, Number(id));

    return res.status(200).json({ message: `Employee status updated to ${status}.` });
  } catch (err) {
    console.error('Error updating employee status:', err.message, err.sqlMessage);
    return res.status(500).json({ error: 'Failed to update employee status.' });
  }
});

// Delete Employee
app.delete('/api/employees/:id', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/json');
    const pool = require('./config/db');
    await ensureEmployeeLifecycleColumns(pool);
    await ensureEmployeeIntegritySchema(pool);
    const { id } = req.params; // id = numeric employee id

    console.log('DELETE /api/employees/:id - Employee ID:', id);

    const [existingRows] = await pool.execute('SELECT id, status FROM employees WHERE id = ? LIMIT 1', [id]);
    if (!existingRows.length) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    const [result] = await pool.execute(
      `UPDATE employees
          SET status = 'Inactive',
              separation_date = COALESCE(separation_date, CURDATE()),
              separation_reason = COALESCE(separation_reason, 'Soft deleted by HR'),
              offboarding_remarks = COALESCE(offboarding_remarks, 'Employee record removed from active use.'),
              updated_at = NOW()
        WHERE id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    await deactivateLinkedUserAccounts(pool, Number(id), 'Inactive', req);
    await sealEmployeeIntegrity(pool, Number(id));
    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_SOFT_DELETED', Number(id), {
      status: existingRows[0].status,
    }, {
      status: 'Inactive',
    });

    return res.status(200).json({ message: 'Employee removed from active records.' });
  } catch (err) {
    console.error('Error deleting employee:', err.message, err.sqlMessage);
    return res.status(500).json({ error: 'Failed to delete employee.' });
  }
});

app.get('/api/employees/offboarding/:caseId/documents', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    await ensureEmployeeLifecycleManagementSchema(pool);
    const caseId = Number(req.params.caseId);
    if (!caseId) return res.status(400).json({ error: 'Valid offboarding case id is required.' });
    if (!canCreateOffboarding(req)) return rejectLifecycleUnauthorized(req, res, 'blocked_offboarding_document_list_unauthorized', caseId);

    const [cases] = await pool.execute(
      `SELECT offboarding_case_id, employee_id
         FROM employee_offboarding_case
        WHERE offboarding_case_id = ?
        LIMIT 1`,
      [caseId]
    );
    if (!cases.length) return res.status(404).json({ error: 'Offboarding request not found.' });
    if (!canAccessEmployeeRecord(req, cases[0].employee_id, { allowPermission: false })) {
      return rejectEmployeeIdor(req, res, cases[0].employee_id, 'blocked_offboarding_document_list_idor_attempt');
    }

    const documents = await loadOffboardingDocuments(pool, caseId);
    return res.json(documents);
  } catch (err) {
    console.error('Error fetching offboarding documents:', err.message, err.sqlMessage);
    return res.status(500).json({ error: 'Failed to fetch offboarding documents.' });
  }
});

app.post('/api/employees/offboarding/:caseId/documents', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, uploadSensitiveSingle('file'), async (req, res) => {
  let encryptedPath = null;
  try {
    const pool = require('./config/db');
    await ensureEmployeeLifecycleManagementSchema(pool);
    const caseId = Number(req.params.caseId);
    if (!caseId) {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: 'Valid offboarding case id is required.' });
    }
    if (await rejectEmployeeUnsupportedSubresourceFields(req, res, EMPLOYEE_OFFBOARDING_DOCUMENT_ALLOWED_FIELDS, 'offboarding documents')) {
      discardUploadedFile(req.file);
      return;
    }
    if (!canCreateOffboarding(req)) {
      discardUploadedFile(req.file);
      return rejectLifecycleUnauthorized(req, res, 'blocked_offboarding_document_upload_unauthorized', caseId);
    }
    if (!req.file) return res.status(400).json({ error: 'No file provided.' });

    const [cases] = await pool.execute(
      `SELECT oc.offboarding_case_id, oc.employee_id, oc.status, e.employee_code
         FROM employee_offboarding_case oc
         JOIN employees e ON e.id = oc.employee_id
        WHERE oc.offboarding_case_id = ?
        LIMIT 1`,
      [caseId]
    );
    if (!cases.length) {
      discardUploadedFile(req.file);
      return res.status(404).json({ error: 'Offboarding request not found.' });
    }
    const offboardingCase = cases[0];
    if (!canAccessEmployeeRecord(req, offboardingCase.employee_id, { allowPermission: false })) {
      discardUploadedFile(req.file);
      return rejectEmployeeIdor(req, res, offboardingCase.employee_id, 'blocked_offboarding_document_upload_idor_attempt');
    }
    if (isTerminalOffboardingStatus(offboardingCase.status)) {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: 'Cannot attach documents to a completed offboarding request.' });
    }

    const docType = normalizeOffboardingDocumentType(req.body.docType || req.body.document_type);
    encryptedPath = await storeEncryptedBuffer('employee-documents', req.file.buffer);
    const [result] = await pool.execute(
      `INSERT INTO documents
         (employee_id, offboarding_case_id, document_type, document_stage, file_name, file_path,
          file_name_encrypted, encrypted_file_path, file_mime_type, file_size_bytes, uploaded_by)
       VALUES (?, ?, ?, 'Offboarding', NULL, NULL, ?, ?, ?, ?, ?)`,
      [offboardingCase.employee_id, caseId, docType, encryptColumnValue(req.file.originalname),
        encryptedPath, req.file.mimetype, req.file.size, req.user.id || null]
    );
    encryptedPath = null;
    await writeEmployeeLifecycleAudit(pool, req, 'OFFBOARDING_DOCUMENT_UPLOADED', offboardingCase.employee_id, null, {
      offboarding_case_id: caseId,
      document_id: result.insertId,
      document_type: docType,
    });

    return res.status(200).json({
      message: 'Offboarding document uploaded successfully.',
      document: {
        id: result.insertId,
        offboarding_case_id: caseId,
        document_type: docType,
        document_label: offboardingDocumentLabel(docType),
        file_name: req.file.originalname,
      },
    });
  } catch (err) {
    console.error('Error uploading offboarding document:', err.message, err.sqlMessage);
    discardUploadedFile(req.file);
    if (encryptedPath) await deleteEncryptedFile(encryptedPath).catch(() => {});
    return res.status(500).json({ error: 'Failed to upload offboarding document.' });
  }
});

// Upload employee document
app.post('/api/employees/:id/documents', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, uploadSensitiveSingle('file'), async (req, res) => {
  let encryptedPath = null;
  try {
    const pool = require('./config/db');
    await ensureOffboardingDocumentSchema(pool);
    const { id } = req.params; // id = employee_code
    if (await rejectEmployeeUnsupportedSubresourceFields(req, res, EMPLOYEE_DOCUMENT_ALLOWED_FIELDS, 'documents')) {
      discardUploadedFile(req.file);
      return;
    }
    const allowedDocTypes = new Set(['Resume', 'Government_ID', 'NBI_Clearance', 'Contract', 'Other']);
    const docType = allowedDocTypes.has(req.body.docType) ? req.body.docType : 'Other';
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided.' });
    }
    
    // Get employee ID from employee_code
    const [empRows] = await pool.execute('SELECT id FROM employees WHERE employee_code = ?', [id]);
    if (empRows.length === 0) {
      discardUploadedFile(req.file);
      return res.status(404).json({ error: 'Employee not found.' });
    }
    
    const employeeId = empRows[0].id;
    encryptedPath = await storeEncryptedBuffer('employee-documents', req.file.buffer);
    
    // Insert a new document record. Multiple files of the same document type
    // are valid because HR may collect updated or supplemental copies.
    const [result] = await pool.execute(
      `INSERT INTO documents
         (employee_id, document_type, file_name, file_path, file_name_encrypted,
          encrypted_file_path, file_mime_type, file_size_bytes)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)`,
      [employeeId, docType, encryptColumnValue(req.file.originalname), encryptedPath, req.file.mimetype, req.file.size]
    );
    encryptedPath = null;
    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_DOCUMENT_UPLOADED', employeeId, null, {
      document_id: result.insertId,
      document_type: docType,
    });
    
    console.log('✅ Document uploaded successfully');
    return res.status(200).json({
      message: 'Document uploaded successfully.',
      file_name: req.file.originalname
    });
    
  } catch (err) {
    console.error('Error uploading document:', err.message);
    discardUploadedFile(req.file);
    if (encryptedPath) await deleteEncryptedFile(encryptedPath).catch(() => {});
    return res.status(500).json({ error: 'Failed to upload document.' });
  }
});

// Get employee documents
app.get('/api/employees/:id/documents', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params; // id = employee_code
    
    // Get employee ID from employee_code
    const [empRows] = await pool.execute('SELECT id FROM employees WHERE employee_code = ?', [id]);
    if (empRows.length === 0) {
      return res.status(404).json({ error: 'Employee not found.' });
    }
    
    const employeeId = empRows[0].id;
    if (!canAccessEmployeeRecord(req, employeeId, { allowPermission: false })) {
      return rejectEmployeeIdor(req, res, employeeId, 'blocked_employee_document_list_idor_attempt');
    }
    
    await ensureOffboardingDocumentSchema(pool);

    // Fetch all documents for this employee, including optional lifecycle support files.
    const [docs] = await pool.execute(
      `SELECT id, offboarding_case_id, document_type, document_stage, file_name, file_name_encrypted, uploaded_date
         FROM documents
        WHERE employee_id = ?
        ORDER BY document_stage, document_type, uploaded_date DESC`,
      [employeeId]
    );
    
    return res.json(docs.map(document => ({
      id: document.id,
      offboarding_case_id: document.offboarding_case_id,
      document_type: document.document_type,
      document_stage: document.document_stage,
      file_name: decryptColumnValue(document.file_name_encrypted || document.file_name) || 'Document',
      uploaded_date: document.uploaded_date,
      document_label: document.document_stage === 'Offboarding'
        ? offboardingDocumentLabel(document.document_type)
        : document.document_type,
    })));
    
  } catch (err) {
    console.error('Error fetching documents:', err.message);
    return res.status(500).json({ error: 'Failed to fetch documents.' });
  }
});

// View employee document
app.get('/api/employees/:id/documents/:docId/view', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, docId } = req.params;

    const [empRows] = await pool.execute('SELECT id FROM employees WHERE employee_code = ?', [id]);
    if (empRows.length === 0) {
      return res.status(404).json({ error: 'Employee not found.' });
    }
    if (!canAccessEmployeeRecord(req, empRows[0].id, { allowPermission: false })) {
      return rejectEmployeeIdor(req, res, empRows[0].id, 'blocked_employee_document_view_idor_attempt');
    }

    const [docs] = await pool.execute(
      `SELECT file_name, file_path, file_name_encrypted, encrypted_file_path, file_mime_type
         FROM documents
        WHERE id = ? AND employee_id = ?
        LIMIT 1`,
      [docId, empRows[0].id]
    );

    if (!docs.length || (!docs[0].encrypted_file_path && !docs[0].file_path)) {
      return res.status(404).json({ error: 'Document not found.' });
    }

    const document = docs[0];
    const safeName = (decryptColumnValue(document.file_name_encrypted || document.file_name) || 'document.bin')
      .replace(/["\r\n]/g, '_');
    if (document.encrypted_file_path) {
      const buffer = await readEncryptedBuffer(document.encrypted_file_path);
      res.setHeader('Content-Type', document.file_mime_type || 'application/octet-stream');
      res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
      return res.send(buffer);
    }

    const relativePath = String(document.file_path || '').replace(/^\/+/, '');
    const absolutePath = path.resolve(__dirname, 'public', relativePath);
    const uploadsRoot = path.resolve(__dirname, 'public', 'uploads');

    if (!absolutePath.startsWith(uploadsRoot + path.sep) || !fs.existsSync(absolutePath)) {
      return res.status(404).json({ error: 'Document file not found.' });
    }

    res.setHeader('Content-Disposition', `inline; filename="${safeName}"`);
    return res.sendFile(absolutePath);
  } catch (err) {
    console.error('Error viewing document:', err.message);
    return res.status(500).json({ error: 'Failed to view document.' });
  }
});

// Delete employee document
app.delete('/api/employees/:id/documents/:docId', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, docId } = req.params;
    const employeeId = await ensureEmployeeRouteAccess(pool, req, res, {
      param: 'id',
      action: 'blocked_employee_document_delete_idor_attempt',
    });
    if (!employeeId) return;

    // Get document info
    const [docs] = await pool.execute(
      'SELECT file_path, encrypted_file_path FROM documents WHERE id = ? AND employee_id = ?',
      [docId, employeeId]
    );
    if (docs.length === 0) {
      return res.status(404).json({ error: 'Document not found.' });
    }
    
    if (docs[0].encrypted_file_path) {
      await deleteEncryptedFile(docs[0].encrypted_file_path);
    } else if (docs[0].file_path) {
      const legacyRelative = String(docs[0].file_path).replace(/^[/\\]+/, '');
      const filePath = path.resolve(__dirname, 'public', legacyRelative);
      const uploadsRoot = path.resolve(__dirname, 'public', 'uploads');
      if (filePath.startsWith(`${uploadsRoot}${path.sep}`) && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
    
    // Delete database record
    await pool.execute('DELETE FROM documents WHERE id = ? AND employee_id = ?', [docId, employeeId]);
    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_DOCUMENT_DELETED', employeeId, {
      document_id: docId,
    }, null);
    
    console.log('✅ Document deleted successfully');
    return res.status(200).json({ message: 'Document deleted successfully.' });
    
  } catch (err) {
    console.error('Error deleting document:', err.message);
    return res.status(500).json({ error: 'Failed to delete document.' });
  }
});

// Employee family members
app.get('/api/employees/:id/family', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const employeeId = await ensureEmployeeRouteAccess(pool, req, res, {
      action: 'blocked_employee_family_idor_attempt',
    });
    if (!employeeId) return;

    const [rows] = await pool.execute(
      `SELECT id, employee_id, relationship_type, extension_name, first_name, middle_name, last_name,
              date_of_birth, telephone_number, business_address, occupation, employer_name, deceased,
              pii_encrypted
       FROM employee_family_members
       WHERE employee_id = ?
       ORDER BY id`,
      [employeeId]
    );

    res.json(rows.map(row => decryptRowPii(row, 'pii_encrypted', FAMILY_PII_FIELDS)));
  } catch (err) {
    console.error('Error fetching family members:', err.message);
    res.status(500).json({ error: 'Failed to fetch family members.' });
  }
});

app.post('/api/employees/:id/family', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    if (await rejectEmployeeUnsupportedSubresourceFields(req, res, EMPLOYEE_FAMILY_ALLOWED_FIELDS, 'family')) return;
    validateEmployeeSubresourceBody(req.body, EMPLOYEE_FAMILY_ALLOWED_FIELDS, { dateFields: ['date_of_birth'] });
    const {
      relationship_type,
      extension_name,
      first_name,
      middle_name,
      last_name,
      date_of_birth,
      telephone_number,
      business_address,
      occupation,
      employer_name,
      deceased
    } = req.body;

    if (!relationship_type || !first_name || !last_name) {
      return res.status(400).json({ error: 'Relationship type, first name, and last name are required.' });
    }

    const [result] = await pool.execute(
      `INSERT INTO employee_family_members
       (employee_id, relationship_type, extension_name, first_name, middle_name, last_name, date_of_birth,
        telephone_number, business_address, occupation, employer_name, deceased, pii_encrypted)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      [
        id,
        encryptSelectedFields({
          relationship_type,
          extension_name,
          first_name,
          middle_name,
          last_name,
          date_of_birth,
          telephone_number,
          business_address,
          occupation,
          employer_name,
          deceased: deceased === true || deceased === 'true' || deceased === '1' ? 1 : 0
        }, FAMILY_PII_FIELDS)
      ]
    );

    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_FAMILY_MEMBER_ADDED', Number(id), null, {
      family_member_id: result.insertId,
    });
    res.status(201).json({ id: result.insertId, message: 'Family member added.' });
  } catch (err) {
    console.error('Error adding family member:', err.message);
    if (err.status) return res.status(err.status).json({ error: err.message || 'Invalid family member details.' });
    res.status(500).json({ error: 'Failed to add family member.' });
  }
});

app.delete('/api/employees/:id/family/:familyId', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, familyId } = req.params;

    const [result] = await pool.execute(
      'DELETE FROM employee_family_members WHERE id = ? AND employee_id = ?',
      [familyId, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Family member not found.' });
    }

    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_FAMILY_MEMBER_DELETED', Number(id), {
      family_member_id: familyId,
    }, null);
    res.json({ message: 'Family member deleted.' });
  } catch (err) {
    console.error('Error deleting family member:', err.message);
    res.status(500).json({ error: 'Failed to delete family member.' });
  }
});

// Employee previous work experiences
app.get('/api/employees/:id/work-experiences', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const employeeId = await ensureEmployeeRouteAccess(pool, req, res, {
      action: 'blocked_employee_work_experience_idor_attempt',
    });
    if (!employeeId) return;

    const [rows] = await pool.execute(
      `SELECT id, employee_id, company_name, position_title, employment_type, date_from, date_to,
              supervisor_name, company_address, reason_for_leaving, pii_encrypted
       FROM employee_work_experiences
       WHERE employee_id = ?
       ORDER BY id DESC`,
      [employeeId]
    );

    res.json(rows.map(row => decryptRowPii(row, 'pii_encrypted', WORK_EXPERIENCE_PII_FIELDS)));
  } catch (err) {
    console.error('Error fetching work experiences:', err.message);
    res.status(500).json({ error: 'Failed to fetch work experiences.' });
  }
});

app.post('/api/employees/:id/work-experiences', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    if (await rejectEmployeeUnsupportedSubresourceFields(req, res, EMPLOYEE_WORK_EXPERIENCE_ALLOWED_FIELDS, 'work-experiences')) return;
    validateEmployeeSubresourceBody(req.body, EMPLOYEE_WORK_EXPERIENCE_ALLOWED_FIELDS, { dateFields: ['date_from', 'date_to'] });
    validateDateOrder(req.body, 'date_from', 'date_to');
    const {
      company_name,
      position_title,
      employment_type,
      date_from,
      date_to,
      supervisor_name,
      company_address,
      reason_for_leaving
    } = req.body;

    if (!company_name || !position_title) {
      return res.status(400).json({ error: 'Company name and position title are required.' });
    }

    const [result] = await pool.execute(
      `INSERT INTO employee_work_experiences
       (employee_id, company_name, position_title, employment_type, date_from, date_to,
        supervisor_name, company_address, reason_for_leaving, pii_encrypted)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      [
        id,
        encryptSelectedFields({
          company_name,
          position_title,
          employment_type,
          date_from,
          date_to,
          supervisor_name,
          company_address,
          reason_for_leaving
        }, WORK_EXPERIENCE_PII_FIELDS)
      ]
    );

    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_WORK_EXPERIENCE_ADDED', Number(id), null, {
      work_experience_id: result.insertId,
    });
    res.status(201).json({ id: result.insertId, message: 'Work experience added.' });
  } catch (err) {
    console.error('Error adding work experience:', err.message);
    if (err.status) return res.status(err.status).json({ error: err.message || 'Invalid work experience details.' });
    res.status(500).json({ error: 'Failed to add work experience.' });
  }
});

app.delete('/api/employees/:id/work-experiences/:experienceId', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, experienceId } = req.params;

    const [result] = await pool.execute(
      'DELETE FROM employee_work_experiences WHERE id = ? AND employee_id = ?',
      [experienceId, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Work experience not found.' });
    }

    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_WORK_EXPERIENCE_DELETED', Number(id), {
      work_experience_id: experienceId,
    }, null);
    res.json({ message: 'Work experience deleted.' });
  } catch (err) {
    console.error('Error deleting work experience:', err.message);
    res.status(500).json({ error: 'Failed to delete work experience.' });
  }
});

// Employee education/training records
app.get('/api/employees/:id/certifications', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const employeeId = await ensureEmployeeRouteAccess(pool, req, res, {
      action: 'blocked_employee_certification_idor_attempt',
    });
    if (!employeeId) return;
    const [rows] = await pool.execute(
      `SELECT id, employee_id, certification_name, issuing_organization, issue_date, expiry_date,
              certificate_file_name, certificate_file_path, pii_encrypted
       FROM employee_certifications
       WHERE employee_id = ?
       ORDER BY id DESC`,
      [employeeId]
    );
    res.json(rows.map(row => decryptRowPii(row, 'pii_encrypted', CERTIFICATION_PII_FIELDS)));
  } catch (err) {
    console.error('Error fetching certifications:', err.message);
    res.status(500).json({ error: 'Failed to fetch certifications.' });
  }
});

app.post('/api/employees/:id/certifications', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, uploadSingle('certificate'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    if (await rejectEmployeeUnsupportedSubresourceFields(req, res, EMPLOYEE_CERTIFICATION_ALLOWED_FIELDS, 'certifications')) {
      discardUploadedFile(req.file);
      return;
    }
    validateEmployeeSubresourceBody(req.body, EMPLOYEE_CERTIFICATION_ALLOWED_FIELDS, { dateFields: ['issue_date', 'expiry_date'] });
    validateDateOrder(req.body, 'issue_date', 'expiry_date');
    const { certification_name, issuing_organization, issue_date, expiry_date } = req.body;

    if (!certification_name) return res.status(400).json({ error: 'Certification name is required.' });

    const [result] = await pool.execute(
      `INSERT INTO employee_certifications
       (employee_id, certification_name, issuing_organization, issue_date, expiry_date, certificate_file_name, certificate_file_path, pii_encrypted)
       VALUES (?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      [
        id,
        req.file?.originalname || null,
        req.file ? `/uploads/${req.file.filename}` : null,
        encryptSelectedFields({ certification_name, issuing_organization, issue_date, expiry_date }, CERTIFICATION_PII_FIELDS)
      ]
    );

    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_CERTIFICATION_ADDED', Number(id), null, {
      certification_id: result.insertId,
    });
    res.status(201).json({ id: result.insertId, message: 'Certification added.' });
  } catch (err) {
    console.error('Error adding certification:', err.message);
      discardUploadedFile(req.file);
    if (err.status) return res.status(err.status).json({ error: err.message || 'Invalid certification details.' });
    res.status(500).json({ error: 'Failed to add certification.' });
  }
});

app.delete('/api/employees/:id/certifications/:certificationId', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, certificationId } = req.params;
    const [rows] = await pool.execute('SELECT certificate_file_path FROM employee_certifications WHERE id = ? AND employee_id = ?', [certificationId, id]);

    if (!rows.length) return res.status(404).json({ error: 'Certification not found.' });

    if (rows[0].certificate_file_path) {
      const filePath = path.join(__dirname, 'public', rows[0].certificate_file_path);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }

    await pool.execute('DELETE FROM employee_certifications WHERE id = ? AND employee_id = ?', [certificationId, id]);
    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_CERTIFICATION_DELETED', Number(id), {
      certification_id: certificationId,
    }, null);
    res.json({ message: 'Certification deleted.' });
  } catch (err) {
    console.error('Error deleting certification:', err.message);
    res.status(500).json({ error: 'Failed to delete certification.' });
  }
});

app.get('/api/employees/:id/trainings', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const employeeId = await ensureEmployeeRouteAccess(pool, req, res, {
      action: 'blocked_employee_training_idor_attempt',
    });
    if (!employeeId) return;
    const [rows] = await pool.execute(
      `SELECT id, employee_id, training_name, provider, date_from, date_to, training_hours, remarks, pii_encrypted
       FROM employee_trainings
       WHERE employee_id = ?
       ORDER BY id DESC`,
      [employeeId]
    );
    res.json(rows.map(row => decryptRowPii(row, 'pii_encrypted', TRAINING_PII_FIELDS)));
  } catch (err) {
    console.error('Error fetching trainings:', err.message);
    res.status(500).json({ error: 'Failed to fetch trainings.' });
  }
});

app.post('/api/employees/:id/trainings', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    if (await rejectEmployeeUnsupportedSubresourceFields(req, res, EMPLOYEE_TRAINING_ALLOWED_FIELDS, 'trainings')) return;
    validateEmployeeSubresourceBody(req.body, EMPLOYEE_TRAINING_ALLOWED_FIELDS, {
      dateFields: ['date_from', 'date_to'],
      numericFields: ['training_hours'],
    });
    validateDateOrder(req.body, 'date_from', 'date_to');
    const { training_name, provider, date_from, date_to, training_hours, remarks } = req.body;

    if (!training_name) return res.status(400).json({ error: 'Training name is required.' });

    const [result] = await pool.execute(
      `INSERT INTO employee_trainings
       (employee_id, training_name, provider, date_from, date_to, training_hours, remarks, pii_encrypted)
       VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      [
        id,
        encryptSelectedFields({ training_name, provider, date_from, date_to, training_hours, remarks }, TRAINING_PII_FIELDS)
      ]
    );

    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_TRAINING_ADDED', Number(id), null, {
      training_id: result.insertId,
    });
    res.status(201).json({ id: result.insertId, message: 'Training added.' });
  } catch (err) {
    console.error('Error adding training:', err.message);
    if (err.status) return res.status(err.status).json({ error: err.message || 'Invalid training details.' });
    res.status(500).json({ error: 'Failed to add training.' });
  }
});

app.delete('/api/employees/:id/trainings/:trainingId', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, trainingId } = req.params;
    const [result] = await pool.execute('DELETE FROM employee_trainings WHERE id = ? AND employee_id = ?', [trainingId, id]);

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Training not found.' });
    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_TRAINING_DELETED', Number(id), {
      training_id: trainingId,
    }, null);
    res.json({ message: 'Training deleted.' });
  } catch (err) {
    console.error('Error deleting training:', err.message);
    res.status(500).json({ error: 'Failed to delete training.' });
  }
});

app.get('/api/employees/:id/skills', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    const employeeId = await ensureEmployeeRouteAccess(pool, req, res, {
      action: 'blocked_employee_skill_idor_attempt',
    });
    if (!employeeId) return;
    const [rows] = await pool.execute(
      `SELECT id, employee_id, skill_name, proficiency, remarks
       FROM employee_skills
       WHERE employee_id = ?
       ORDER BY skill_name`,
      [employeeId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching skills:', err.message);
    res.status(500).json({ error: 'Failed to fetch skills.' });
  }
});

app.post('/api/employees/:id/skills', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params;
    if (await rejectEmployeeUnsupportedSubresourceFields(req, res, EMPLOYEE_SKILL_ALLOWED_FIELDS, 'skills')) return;
    validateEmployeeSubresourceBody(req.body, EMPLOYEE_SKILL_ALLOWED_FIELDS);
    const { skill_name, proficiency, remarks } = req.body;

    if (!skill_name) return res.status(400).json({ error: 'Skill name is required.' });

    const [result] = await pool.execute(
      'INSERT INTO employee_skills (employee_id, skill_name, proficiency, remarks) VALUES (?, ?, ?, ?)',
      [id, skill_name, proficiency || null, remarks || null]
    );

    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_SKILL_ADDED', Number(id), null, {
      skill_id: result.insertId,
    });
    res.status(201).json({ id: result.insertId, message: 'Skill added.' });
  } catch (err) {
    console.error('Error adding skill:', err.message);
    if (err.status) return res.status(err.status).json({ error: err.message || 'Invalid skill details.' });
    res.status(500).json({ error: 'Failed to add skill.' });
  }
});

app.delete('/api/employees/:id/skills/:skillId', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id, skillId } = req.params;
    const [result] = await pool.execute('DELETE FROM employee_skills WHERE id = ? AND employee_id = ?', [skillId, id]);

    if (result.affectedRows === 0) return res.status(404).json({ error: 'Skill not found.' });
    await writeEmployeeLifecycleAudit(pool, req, 'EMPLOYEE_SKILL_DELETED', Number(id), {
      skill_id: skillId,
    }, null);
    res.json({ message: 'Skill deleted.' });
  } catch (err) {
    console.error('Error deleting skill:', err.message);
    res.status(500).json({ error: 'Failed to delete skill.' });
  }
});

// ============================================================
// EMPLOYEE PHOTOS — Upload, retrieve, and delete employee photos
// ============================================================

// Upload employee photo (store as base64 in database)
app.post('/api/employees/:id/photo', requireAuth, requireRole(ROLES.staff_management), EMPLOYEE_PARAMETER_TAMPER_GUARD, uploadSensitiveSingle('photo'), async (req, res) => {
  let connection;
  let pendingPhotoPath = null;
  let previousPhotoPath = null;
  try {
    const pool = require('./config/db');
    connection = await pool.getConnection();
    const { id } = req.params; // numeric employee ID
    
    if (!req.file) {
      return res.status(400).json({ error: 'No photo provided.' });
    }

    const [[previousPhoto]] = await connection.execute(
      'SELECT photo_encrypted_path FROM employee_photos WHERE employee_id = ? LIMIT 1',
      [id]
    );
    previousPhotoPath = previousPhoto?.photo_encrypted_path || null;
    pendingPhotoPath = await storeEncryptedBuffer('employee-photos', req.file.buffer);
    await connection.beginTransaction();

    await connection.execute(
      `INSERT INTO employee_photos (employee_id, photo_data, photo_data_encrypted, photo_encrypted_path, photo_mime_type, photo_size)
       VALUES (?, NULL, NULL, ?, ?, ?)
       ON DUPLICATE KEY UPDATE 
       photo_data = NULL,
       photo_data_encrypted = NULL,
       photo_encrypted_path = VALUES(photo_encrypted_path),
       photo_mime_type = VALUES(photo_mime_type),
       photo_size = VALUES(photo_size),
       updated_at = NOW()`,
      [id, pendingPhotoPath, req.file.mimetype, req.file.size]
    );
    const [photoRows] = await connection.execute(
      'SELECT id FROM employee_photos WHERE employee_id = ? LIMIT 1',
      [id]
    );
    if (photoRows[0]?.id) {
      await connection.execute('UPDATE employees SET photo_id = ? WHERE id = ?', [photoRows[0].id, id]);
    }
    await writeEmployeeLifecycleAudit(connection, req, 'EMPLOYEE_PHOTO_UPDATED', Number(id), null, {
      photo_id: photoRows[0]?.id || null,
      file_size: req.file.size,
      mime_type: req.file.mimetype
    });
    await connection.commit();
    const committedPhotoPath = pendingPhotoPath;
    pendingPhotoPath = null;
    if (previousPhotoPath && previousPhotoPath !== committedPhotoPath) {
      await deleteEncryptedFile(previousPhotoPath).catch(() => {});
    }

    console.log('✅ Employee photo uploaded successfully');
    return res.status(200).json({
      message: 'Photo uploaded successfully.',
      file_name: req.file.originalname,
      file_size: req.file.size
    });
    
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    if (pendingPhotoPath) await deleteEncryptedFile(pendingPhotoPath).catch(() => {});
    console.error('Error uploading photo:', err.message);
    discardUploadedFile(req.file);
    return res.status(500).json({ error: 'Failed to upload photo.' });
  } finally {
    connection?.release();
  }
});

// Get employee photo
app.get('/api/employees/:id/photo', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { id } = req.params; // numeric employee ID
    const employeeId = Number.parseInt(id, 10);
    if (!canAccessEmployeeRecord(req, employeeId, { allowPermission: false })) {
      return rejectEmployeeIdor(req, res, employeeId, 'blocked_employee_photo_idor_attempt');
    }
    
    const [photos] = await pool.execute(
      `SELECT photo_data_encrypted, photo_encrypted_path, photo_mime_type FROM employee_photos WHERE employee_id = ?`,
      [employeeId]
    );

    if (photos.length === 0) {
      return res.status(404).json({ error: 'No photo found for this employee.' });
    }

    const { photo_data_encrypted, photo_encrypted_path, photo_mime_type } = photos[0];
    const photoBuffer = photo_encrypted_path
      ? await readEncryptedBuffer(photo_encrypted_path)
      : Buffer.from(decryptColumnValue(photo_data_encrypted), 'base64');
    
    // Send binary photo data
    res.set('Cache-Control', 'private, no-store');
    res.set('Content-Type', photo_mime_type);
    res.send(photoBuffer);
    
  } catch (err) {
    console.error('Error fetching photo:', err.message);
    return res.status(500).json({ error: 'Failed to fetch photo.' });
  }
});

// Delete employee photo
app.delete('/api/employees/:id/photo', requireAuth, requireRole(ROLES.staff_management), async (req, res) => {
  let connection;
  try {
    const pool = require('./config/db');
    connection = await pool.getConnection();
    const { id } = req.params; // numeric employee ID
    await connection.beginTransaction();

    const [[photo]] = await connection.execute(
      'SELECT photo_encrypted_path FROM employee_photos WHERE employee_id = ? FOR UPDATE',
      [id]
    );

    const [result] = await connection.execute(
      `DELETE FROM employee_photos WHERE employee_id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'No photo found for this employee.' });
    }
    await connection.execute('UPDATE employees SET photo_id = NULL WHERE id = ?', [id]);
    await writeEmployeeLifecycleAudit(connection, req, 'EMPLOYEE_PHOTO_DELETED', Number(id));
    await connection.commit();
    if (photo?.photo_encrypted_path) await deleteEncryptedFile(photo.photo_encrypted_path).catch(() => {});

    console.log('✅ Employee photo deleted successfully');
    return res.status(200).json({ message: 'Photo deleted successfully.' });
    
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    console.error('Error deleting photo:', err.message);
    return res.status(500).json({ error: 'Failed to delete photo.' });
  } finally {
    connection?.release();
  }
});

const LEAVE_PERMISSION_ROLES = {
  'leave.request.create': ['employee', 'hr_admin', 'hr_manager', 'admin', 'system_admin', 'payroll_officer', 'payroll_manager'],
  'leave.request.view_own': ['employee', 'hr_admin', 'hr_manager', 'admin', 'system_admin', 'payroll_officer', 'payroll_manager'],
  'leave.manual.create': ['hr_admin', 'hr_manager', 'admin', 'system_admin', 'payroll_officer', 'payroll_manager'],
  'leave.request.approve': [...ROLES.hr_final_approval, 'payroll_officer', 'payroll_manager'],
  'leave.request.view_all': ['hr_admin', 'hr_manager', 'admin', 'system_admin', 'payroll_officer', 'payroll_manager'],
  'leave.balance.manage': ['hr_admin', 'hr_manager', 'admin', 'system_admin', 'payroll_officer', 'payroll_manager'],
  'leave.report.view': ['hr_admin', 'hr_manager', 'admin', 'system_admin', 'payroll_officer', 'payroll_manager'],
  'leave.audit.view': ['hr_admin', 'hr_manager', 'admin', 'system_admin', 'payroll_officer', 'payroll_manager']
};

function hasLeavePermission(user, permission) {
  return LEAVE_PERMISSION_ROLES[permission]?.includes(user?.role);
}

function requireLeavePermission(permission) {
  return (req, res, next) => {
    if (!hasLeavePermission(req.user, permission)) {
      return res.status(403).json({ error: `Missing permission: ${permission}` });
    }
    next();
  };
}

function leaveStepUpPassword(req) {
  return String(req.body?.currentPassword || req.body?.current_password || req.body?.password_confirmation || '');
}

async function verifyLeaveStepUpPassword(pool, req) {
  const userId = Number(req.user?.id || req.user?.userId || req.user?.sub);
  const currentPassword = leaveStepUpPassword(req);
  if (!Number.isInteger(userId) || userId <= 0 || !currentPassword.trim()) return false;

  const [rows] = await pool.execute(`
    SELECT COALESCE(u.password_hash, e.Password_Hash) AS password_hash
      FROM users u
      LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.id = ?
     LIMIT 1
  `, [userId]);

  return verifyPassword(rows[0]?.password_hash, currentPassword);
}

const LEAVE_PAYROLL_APPROVER_ROLES = new Set(['payroll_officer', 'payroll_manager']);
const LEAVE_HR_FINAL_APPROVER_ROLES = new Set(ROLES.hr_final_approval);

function isLeavePayrollApprover(user) {
  return LEAVE_PAYROLL_APPROVER_ROLES.has(user?.role);
}

function isLeaveHrFinalApprover(user) {
  return LEAVE_HR_FINAL_APPROVER_ROLES.has(user?.role);
}

function normalizePayType(wageType) {
  const value = String(wageType || '').toLowerCase();
  if (value.includes('hour')) return 'Per Hour';
  if (value.includes('trip')) return 'Per Trip';
  if (value.includes('piece')) return 'Per Piece';
  return 'Per Day';
}

function normalizeLegacyLeaveName(type) {
  const value = String(type || '').toLowerCase();
  if (value.includes('sick')) return 'Sick Leave';
  if (value.includes('emergency')) return 'Emergency Leave';
  if (value.includes('maternity')) return 'Maternity Leave';
  if (value.includes('paternity')) return 'Paternity Leave';
  if (value.includes('solo')) return 'Solo Parent Leave';
  if (value.includes('magna')) return 'Magna Carta for Women Leave';
  if (value.includes('vawc')) return 'VAWC Leave';
  return 'Vacation Leave';
}

function boolValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function decimalValue(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function leaveBalanceIntegrityAmount(value) {
  return decimalValue(value).toFixed(2);
}

function leaveBalanceIntegrityPayload(row) {
  return [
    'leave_balance:v1',
    String(row.employee_id ?? ''),
    row.leave_type_id === null || row.leave_type_id === undefined ? '' : String(row.leave_type_id),
    String(row.leave_type || ''),
    String(row.year ?? ''),
    leaveBalanceIntegrityAmount(row.balance),
    leaveBalanceIntegrityAmount(row.used),
    leaveBalanceIntegrityAmount(row.total_days),
    leaveBalanceIntegrityAmount(row.used_days),
    leaveBalanceIntegrityAmount(row.remaining_days),
  ].join('|');
}

function computeLeaveBalanceIntegrityHash(row) {
  return nodeCrypto.createHash('sha256').update(leaveBalanceIntegrityPayload(row), 'utf8').digest('hex');
}

function secureVaultFileExists(relativePath) {
  if (!relativePath) return false;
  const resolved = path.resolve(VAULT_ROOT, String(relativePath));
  if (!resolved.startsWith(path.resolve(VAULT_ROOT) + path.sep)) return false;
  return fs.existsSync(resolved);
}

function publicUploadFileExists(relativePath) {
  if (!relativePath) return false;
  const uploadRoot = path.resolve(__dirname, 'public', 'uploads');
  const resolved = path.resolve(__dirname, 'public', String(relativePath).replace(/^\/+/, ''));
  if (!resolved.startsWith(uploadRoot + path.sep)) return false;
  return fs.existsSync(resolved);
}

function leaveAttachmentState(row) {
  const hasReference = Boolean(row?.attachment_encrypted_path || row?.file_path);
  if (!hasReference) return { status: 'none', available: false, missing: false };
  const exists = row.attachment_encrypted_path
    ? secureVaultFileExists(row.attachment_encrypted_path)
    : publicUploadFileExists(row.file_path);
  return {
    status: exists ? 'available' : 'missing',
    available: exists,
    missing: !exists,
  };
}

function leaveBalanceIntegrityStatus(row) {
  const storedHash = String(row.integrity_hash || '').trim().toLowerCase();
  if (!storedHash) return { status: 'UNSEALED', hash: null };
  const expectedHash = computeLeaveBalanceIntegrityHash({
    employee_id: row.employee_id,
    leave_type_id: row.leave_type_id,
    leave_type: row.leave_type,
    year: row.year,
    balance: row.stored_balance ?? row.balance,
    used: row.stored_used ?? row.used,
    total_days: row.stored_total_days ?? row.total_days,
    used_days: row.stored_used_days ?? row.used_days,
    remaining_days: row.stored_remaining_days ?? row.remaining_days,
  });
  return {
    status: storedHash === expectedHash ? 'VALID' : 'TAMPERED',
    hash: storedHash,
    expected_hash: expectedHash,
  };
}

function monthsBetween(startDate, endDate = new Date()) {
  if (!startDate) return 0;
  const start = new Date(startDate);
  if (Number.isNaN(start.getTime())) return 0;
  return (endDate.getFullYear() - start.getFullYear()) * 12 + (endDate.getMonth() - start.getMonth());
}

async function getLeaveType(pool, { id, name, includeInactive = false } = {}) {
  const params = [];
  let where = '';
  if (id) {
    where = 'id = ?';
    params.push(Number(id));
  } else {
    where = '(LOWER(name) = LOWER(?) OR LOWER(name) = LOWER(?))';
    params.push(name || '', normalizeLegacyLeaveName(name));
  }
  if (!includeInactive) where += ' AND is_active = 1';
  const [rows] = await pool.execute(`SELECT * FROM leave_types WHERE ${where} LIMIT 1`, params);
  return rows[0] || null;
}

async function ensureLeaveBalance(pool, employeeId, leaveType, year) {
  return getConfiguredLeaveBalance(pool, employeeId, leaveType, year);
}

async function getConfiguredLeaveBalance(executor, employeeId, leaveType, year, lock = false) {
  const [rows] = await executor.execute(
    `SELECT *,
            COALESCE(NULLIF(total_days, 0), balance, 0) AS total_days_value,
            COALESCE(NULLIF(used_days, 0), used, 0) AS used_days_value,
            COALESCE(remaining_days, COALESCE(NULLIF(total_days, 0), balance, 0) - COALESCE(NULLIF(used_days, 0), used, 0)) AS remaining_days_value
       FROM leave_balances
      WHERE employee_id = ?
        AND year = ?
        AND (leave_type_id = ? OR leave_type = ?)
      LIMIT 1
      ${lock ? 'FOR UPDATE' : ''}`,
    [employeeId, year, leaveType.id, leaveType.name]
  );
  return rows[0] || null;
}

async function writeLeaveAudit(pool, leaveId, employeeId, actorUserId, action, remarks = null, oldStatus = null, newStatus = null, metadata = null) {
  await pool.execute(
    `INSERT INTO leave_audit_trail
       (leave_request_id, employee_id, actor_user_id, action, remarks, old_status, new_status, metadata,
        remarks_encrypted, metadata_encrypted)
     VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?)`,
    [
      leaveId || null,
      employeeId || null,
      actorUserId || null,
      action,
      oldStatus || null,
      newStatus || null,
      encryptAuditValue(remarks),
      encryptAuditValue(metadata),
    ]
  );
}

function validateLeaveEligibility(employee, leaveType, hasAttachment) {
  const errors = [];
  const gender = String(employee.gender || '').toLowerCase();
  const civilStatus = String(employee.marital_status || employee.civil_status || '').toLowerCase();

  if (leaveType.female_only && gender !== 'female') errors.push('This leave type is for female employees only.');
  if (leaveType.male_only && gender !== 'male') errors.push('This leave type is for male employees only.');
  if (leaveType.married_only && !civilStatus.includes('married')) errors.push('This leave type requires married civil status.');
  if (leaveType.solo_parent_required && !employee.solo_parent_status) errors.push('This leave type requires solo parent status.');
  if (leaveType.minimum_service_months && monthsBetween(employee.date_hired) < leaveType.minimum_service_months) {
    errors.push(`This leave type requires at least ${leaveType.minimum_service_months} month(s) of service.`);
  }
  if ((leaveType.requires_attachment || leaveType.medical_certificate_required || leaveType.legal_document_required) && !hasAttachment) {
    errors.push('Supporting attachment is required for this leave type.');
  }
  return errors;
}

// Leave
app.get('/api/leave/types', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const includeInactive = req.query.include_inactive === '1';
    if (includeInactive && !hasLeavePermission(req.user, 'leave.balance.manage')) {
      return res.status(403).json({ error: 'Missing permission: leave.balance.manage' });
    }
    const [rows] = await pool.execute(
      `SELECT *
       FROM leave_types
       ${includeInactive ? '' : 'WHERE is_active = 1'}
       ORDER BY FIELD(category, 'Company', 'Statutory'), name`
    );
    res.json(rows);
  } catch (err) {
    console.error('Error fetching leave types:', err.message);
    res.status(500).json({ error: 'Failed to fetch leave types.' });
  }
});

app.post('/api/leave/types', requireAuth, requireLeavePermission('leave.balance.manage'), async (req, res) => {
  try {
    const pool = require('./config/db');
    if (await rejectUnsupportedRouteFields(req, res, LEAVE_TYPE_ALLOWED_FIELDS, { module: 'LEAVE_SECURITY' })) return;
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const category = body.category === 'Statutory' ? 'Statutory' : 'Company';
    if (!name) return res.status(400).json({ error: 'Leave name is required.' });

    const fields = [
      name,
      body.code ? String(body.code).trim() : null,
      category,
      body.description || null,
      decimalValue(body.max_allowed_days),
      boolValue(body.is_paid) ? 1 : 0,
      boolValue(body.is_active) ? 1 : 0,
      boolValue(body.requires_attachment) ? 1 : 0,
      boolValue(body.allow_unpaid_extension) ? 1 : 0,
      decimalValue(body.max_extension_days),
      boolValue(body.female_only) ? 1 : 0,
      boolValue(body.male_only) ? 1 : 0,
      boolValue(body.married_only) ? 1 : 0,
      boolValue(body.solo_parent_required) ? 1 : 0,
      boolValue(body.medical_certificate_required) ? 1 : 0,
      boolValue(body.legal_document_required) ? 1 : 0,
      parseInt(body.minimum_service_months, 10) || 0,
      req.user.id
    ];

    if (body.id) {
      await pool.execute(
        `UPDATE leave_types SET
           name = ?, code = ?, category = ?, description = ?, max_allowed_days = ?,
           is_paid = ?, is_active = ?, requires_attachment = ?,
           allow_unpaid_extension = ?, max_extension_days = ?,
           female_only = ?, male_only = ?, married_only = ?, solo_parent_required = ?,
           medical_certificate_required = ?, legal_document_required = ?,
           minimum_service_months = ?, updated_by = ?
         WHERE id = ?`,
        [...fields, Number(body.id)]
      );
      await writeLeaveAudit(pool, null, null, req.user.id, 'leave_type_updated', name);
      return res.json({ message: 'Leave type updated.' });
    }

    await pool.execute(
      `INSERT INTO leave_types
         (name, code, category, description, max_allowed_days, is_paid, is_active,
          requires_attachment, allow_unpaid_extension, max_extension_days,
          female_only, male_only, married_only, solo_parent_required,
          medical_certificate_required, legal_document_required, minimum_service_months, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fields
    );
    await writeLeaveAudit(pool, null, null, req.user.id, 'leave_type_created', name);
    res.json({ message: 'Leave type saved.' });
  } catch (err) {
    console.error('Error saving leave type:', err.message);
    res.status(500).json({ error: 'Failed to save leave type.' });
  }
});

app.get('/api/leave', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    let q = `SELECT lr.*,
                    COALESCE(lt.name, lr.type) AS type,
                    COALESCE(lt.category, lr.leave_category, 'Company') AS leave_category,
                    e.first_name, e.middle_name, e.last_name, e.suffix, e.employee_code,
                    d.name AS department, wt.name AS wage_type,
                    CASE
                      WHEN LOWER(COALESCE(wt.name, '')) LIKE '%hour%' THEN 'Per Hour'
                      WHEN LOWER(COALESCE(wt.name, '')) LIKE '%trip%' THEN 'Per Trip'
                      WHEN LOWER(COALESCE(wt.name, '')) LIKE '%piece%' THEN 'Per Piece'
                      ELSE 'Per Day'
                    END AS pay_type,
                    filed.username AS filed_by_name,
                    encoded.username AS encoded_by_name,
                    payrollReviewer.username AS payroll_approved_by_name,
                    reviewer.username AS reviewed_by_name,
                    COALESCE(NULLIF(lb.total_days, 0), lb.balance, 0) AS balance_total_days,
                    COALESCE(NULLIF(lb.used_days, 0), lb.used, 0) AS balance_used_days,
                    COALESCE(lb.remaining_days, COALESCE(NULLIF(lb.total_days, 0), lb.balance, 0) - COALESCE(NULLIF(lb.used_days, 0), lb.used, 0)) AS balance_remaining_days
             FROM leave_requests lr
             JOIN employees e ON e.id = lr.employee_id
             LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
             LEFT JOIN leave_balances lb
               ON lb.employee_id = lr.employee_id
              AND lb.year = YEAR(lr.date_from)
              AND (lb.leave_type_id = lt.id OR lb.leave_type = COALESCE(lt.name, lr.type))
             LEFT JOIN departments d ON d.id = e.department_id
             LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
             LEFT JOIN users filed ON filed.id = lr.filed_by
             LEFT JOIN users encoded ON encoded.id = lr.encoded_by
             LEFT JOIN users payrollReviewer ON payrollReviewer.id = lr.payroll_approved_by
             LEFT JOIN users reviewer ON reviewer.id = COALESCE(lr.approved_by, lr.rejected_by, lr.reviewed_by)`;
    const p = [];
    if (!hasLeavePermission(req.user, 'leave.request.view_all')) {
      q += ' WHERE lr.employee_id = ?';
      p.push(req.user.employeeId);
    }
    q += ' ORDER BY lr.created_at DESC';
    const [rows] = await pool.execute(q, p);
    res.json(rows.map(row => {
      decryptEmployeeStrictPii(row);
      const employeeName = [row.first_name, row.middle_name, row.last_name, row.suffix]
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const {
        reason, reason_encrypted, remarks, remarks_encrypted,
        rejection_remarks, rejection_remarks_encrypted,
        payroll_approval_remarks, payroll_approval_remarks_encrypted,
        approval_remarks, approval_remarks_encrypted,
        file_path, attachment_name_encrypted, attachment_encrypted_path,
        ...safeRow
      } = row;
      const attachment = leaveAttachmentState({ file_path, attachment_encrypted_path });
      return {
        ...safeRow,
        employee_name: employeeName || row.employee_code || `Employee #${row.employee_id}`,
        sensitive_details_available: !!(reason_encrypted || remarks_encrypted || rejection_remarks_encrypted || payroll_approval_remarks_encrypted || approval_remarks_encrypted || reason || remarks || rejection_remarks || payroll_approval_remarks || approval_remarks),
        attachment_available: attachment.available,
        attachment_missing: attachment.missing,
        attachment_status: attachment.status,
      };
    }));
  } catch (err) { res.status(500).json({ error: 'Failed to fetch leave.' }); }
});

app.get('/api/leave/balances', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const employeeId = hasLeavePermission(req.user, 'leave.request.view_all')
      ? parseInt(req.query.employee_id, 10)
      : req.user.employeeId;

    if (!employeeId) return res.status(400).json({ error: 'employee_id is required.' });

    const [rows] = await pool.execute(
      `SELECT lb.id, lb.employee_id, lb.leave_type_id, lb.leave_type, lt.category,
              lb.balance AS stored_balance, lb.used AS stored_used,
              lb.total_days AS stored_total_days, lb.used_days AS stored_used_days,
              lb.remaining_days AS stored_remaining_days, lb.integrity_hash,
              COALESCE(NULLIF(lb.total_days, 0), lb.balance, 0) AS total_days,
              COALESCE(NULLIF(lb.used_days, 0), lb.used, 0) AS used_days,
              COALESCE(lb.remaining_days, COALESCE(NULLIF(lb.total_days, 0), lb.balance, 0) - COALESCE(NULLIF(lb.used_days, 0), lb.used, 0)) AS remaining_days,
              COALESCE(NULLIF(lb.total_days, 0), lb.balance, 0) AS balance,
              COALESCE(NULLIF(lb.used_days, 0), lb.used, 0) AS used,
              COALESCE(lb.remaining_days, COALESCE(NULLIF(lb.total_days, 0), lb.balance, 0) - COALESCE(NULLIF(lb.used_days, 0), lb.used, 0)) AS remaining,
              lb.year, lb.updated_at, updater.username AS last_updated_by_name
       FROM leave_balances lb
       LEFT JOIN leave_types lt ON lt.id = lb.leave_type_id
       LEFT JOIN users updater ON updater.id = lb.last_updated_by
       WHERE lb.employee_id = ? AND lb.year = ?
       ORDER BY FIELD(COALESCE(lt.category, 'Company'), 'Company', 'Statutory'), lb.leave_type`,
      [employeeId, year]
    );
    res.json(rows.map(row => {
      const integrity = leaveBalanceIntegrityStatus(row);
      return {
        ...row,
        integrity_status: integrity.status,
        integrity_hash: integrity.hash,
      };
    }));
  } catch (err) {
    console.error('Error fetching leave balances:', err.message);
    res.status(500).json({ error: 'Failed to fetch leave balances.' });
  }
});

app.put('/api/leave/balances', requireAuth, requireLeavePermission('leave.balance.manage'), async (req, res) => {
  try {
    const pool = require('./config/db');
    if (await rejectUnsupportedRouteFields(req, res, LEAVE_BALANCE_ALLOWED_FIELDS, { module: 'LEAVE_SECURITY' })) return;
    const employeeId = parseInt(req.body.employee_id, 10);
    const leaveType = await getLeaveType(pool, { id: req.body.leave_type_id, name: req.body.leave_type, includeInactive: true });
    const year = parseInt(req.body.year, 10) || new Date().getFullYear();
    const totalDays = Number(req.body.total_days ?? req.body.balance);
    const usedDays = Number(req.body.used_days ?? req.body.used ?? 0);

    if (!employeeId || !leaveType || Number.isNaN(totalDays) || Number.isNaN(usedDays)) {
      return res.status(400).json({ error: 'employee_id, leave_type, total_days, and used_days are required.' });
    }
    if (totalDays < 0 || usedDays < 0 || usedDays > totalDays) {
      return res.status(400).json({ error: 'Used days cannot exceed total days.' });
    }

    const remainingDays = totalDays - usedDays;
    const integrityHash = computeLeaveBalanceIntegrityHash({
      employee_id: employeeId,
      leave_type_id: leaveType.id,
      leave_type: leaveType.name,
      year,
      balance: totalDays,
      used: usedDays,
      total_days: totalDays,
      used_days: usedDays,
      remaining_days: remainingDays,
    });
    await pool.execute(
      `INSERT INTO leave_balances
         (employee_id, leave_type_id, leave_type, balance, used, total_days, used_days, remaining_days, integrity_hash, year, last_updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         leave_type_id = VALUES(leave_type_id),
         leave_type = VALUES(leave_type),
         balance = VALUES(balance),
         used = VALUES(used),
         total_days = VALUES(total_days),
         used_days = VALUES(used_days),
         remaining_days = VALUES(remaining_days),
         integrity_hash = VALUES(integrity_hash),
         last_updated_by = VALUES(last_updated_by)`,
      [employeeId, leaveType.id, leaveType.name, totalDays, usedDays, totalDays, usedDays, remainingDays, integrityHash, year, req.user.id]
    );
    await writeLeaveAudit(pool, null, employeeId, req.user.id, 'leave_balance_adjusted', `${leaveType.name}: ${remainingDays}/${totalDays} day(s) remaining`, null, null, {
      leave_type_id: leaveType.id,
      year,
      total_days: totalDays,
      used_days: usedDays,
      remaining_days: remainingDays
    });
    res.json({ message: 'Leave balance updated.' });
  } catch (err) {
    console.error('Error updating leave balance:', err.message);
    res.status(500).json({ error: 'Failed to update leave balance.' });
  }
});

app.post('/api/leave', requireAuth, requireRole(ROLES.any), uploadSensitiveSingle('attachment'), async (req, res) => {
  let pendingEncryptedAttachmentPath = null;
  try {
    const pool = require('./config/db');
    if (await rejectUnsupportedRouteFields(req, res, LEAVE_REQUEST_ALLOWED_FIELDS, { module: 'LEAVE_SECURITY' })) {
      discardUploadedFile(req.file);
      return;
    }
    const { type, leave_type_id, days, reason, employee_id, filing_source, remarks } = req.body;
    const source = filing_source === 'Manual' ? 'Manual' : 'Portal';

    if (source === 'Manual' && !hasLeavePermission(req.user, 'leave.manual.create')) {
      return res.status(403).json({ error: 'Missing permission: leave.manual.create' });
    }
    if (source === 'Portal' && !hasLeavePermission(req.user, 'leave.request.create')) {
      return res.status(403).json({ error: 'Missing permission: leave.request.create' });
    }

    let empId = source === 'Manual' ? parseInt(employee_id, 10) : req.user.employeeId;
    if (source === 'Portal' && req.user.role !== 'employee' && employee_id) {
      empId = parseInt(employee_id, 10);
    }

    if (!empId) {
      return res.status(400).json({ error: 'Employee is required.' });
    }

    const [empRows] = await pool.execute(
      `SELECT e.*, wt.name as wage_type
       FROM employees e
       LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
       WHERE e.id = ?`,
      [empId]
    );
    if (!empRows.length) return res.status(404).json({ error: 'Employee not found.' });
    const employee = empRows[0];
    decryptEmployeeStrictPii(employee);
    if (String(employee.status || '').toLowerCase() !== 'active') {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: 'Only active employees can file leave.' });
    }

    const leaveType = await getLeaveType(pool, { id: leave_type_id, name: type });
    if (!leaveType) {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: 'Active leave type is required.' });
    }

    const payType = normalizePayType(employee.wage_type);
    if (source === 'Portal' && ['Per Trip', 'Per Piece'].includes(payType)) {
      discardUploadedFile(req.file);
      return res.status(403).json({ error: 'Per Trip and Per Piece employees cannot file leave through the portal. HR must manually encode their leave records.' });
    }

    let date_from;
    let date_to;
    try {
      date_from = strictDateOnly(req.body.date_from, 'Leave start date', { noPast: source === 'Portal' });
      date_to = strictDateOnly(req.body.date_to || req.body.date_from, 'Leave end date', { noPast: source === 'Portal' });
    } catch (error) {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: error.message || 'Valid leave dates are required.' });
    }
    const computedDays = inclusiveDays(date_from, date_to);
    const requestedDays = decimalValue(days, computedDays);
    if (computedDays <= 0 || requestedDays <= 0 || requestedDays > computedDays) {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: 'Valid leave dates and duration are required.' });
    }
    if (computedDays > 366) {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: 'Leave date range cannot exceed 366 days.' });
    }

    const eligibilityErrors = validateLeaveEligibility(employee, leaveType, Boolean(req.file));
    if (eligibilityErrors.length) {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: eligibilityErrors.join(' ') });
    }

    const year = yearFromDateOnly(date_from);
    const [overlaps] = await pool.execute(
      `SELECT id FROM leave_requests
       WHERE employee_id = ?
         AND status IN ('Pending','Payroll Approved','Approved')
         AND date_from <= ? AND date_to >= ?
       LIMIT 1`,
      [empId, date_to, date_from]
    );
    if (overlaps.length) {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: 'This employee already has an overlapping leave request.' });
    }

    const balance = await getConfiguredLeaveBalance(pool, empId, leaveType, year);
    if (source === 'Portal') {
      if (!balance) {
        discardUploadedFile(req.file);
        return res.status(400).json({ error: 'No leave balance is configured for this employee, leave type, and year.' });
      }
      const integrity = leaveBalanceIntegrityStatus(balance);
      if (integrity.status === 'TAMPERED') {
        discardUploadedFile(req.file);
        await writeLeaveAudit(pool, null, empId, req.user.id, 'leave_balance_integrity_blocked', 'Leave balance integrity check failed before filing.', null, null, {
          leave_type_id: leaveType.id,
          year,
        });
        return res.status(409).json({ error: 'Leave balance integrity check failed. Ask HR Admin to verify your leave balance before filing.' });
      }
      const remaining = decimalValue(balance.remaining_days_value);
      if (requestedDays > remaining) {
        discardUploadedFile(req.file);
        return res.status(400).json({ error: 'Requested duration exceeds the available leave balance.' });
      }
    }

    const [annualRows] = await pool.execute(
      `SELECT COALESCE(SUM(days), 0) AS total_days
       FROM leave_requests
       WHERE employee_id = ?
         AND COALESCE(leave_type_id, 0) = ?
         AND YEAR(date_from) = ?
         AND status IN ('Pending','Payroll Approved','Approved')`,
      [empId, leaveType.id, year]
    );
    const extensionDays = leaveType.allow_unpaid_extension ? decimalValue(leaveType.max_extension_days) : 0;
    const annualLimit = decimalValue(leaveType.max_allowed_days) + extensionDays;
    if (decimalValue(annualRows[0]?.total_days) + requestedDays > annualLimit) {
      discardUploadedFile(req.file);
      return res.status(400).json({ error: 'Requested duration exceeds the configured annual limit for this leave type.' });
    }

    if (req.file) {
      pendingEncryptedAttachmentPath = await storeEncryptedBuffer('leave-attachments', req.file.buffer);
    }
    const [result] = await pool.execute(
      `INSERT INTO leave_requests
       (employee_id, leave_type_id, leave_category, type, date_from, date_to, days,
        reason, reason_encrypted, file_path, attachment_name_encrypted, attachment_encrypted_path,
        attachment_mime_type, attachment_size_bytes, filing_source, status,
        remarks, remarks_encrypted, filed_by, submitted_by, encoded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, 'Pending', NULL, ?, ?, ?, ?)`,
      [
        empId, leaveType.id, leaveType.category, leaveType.name, date_from, date_to, requestedDays,
        encryptColumnValue(reason),
        req.file ? encryptColumnValue(req.file.originalname) : null,
        pendingEncryptedAttachmentPath,
        req.file?.mimetype || null,
        req.file?.size || null,
        source,
        encryptColumnValue(remarks),
        req.user.id,
        req.user.id,
        source === 'Manual' ? req.user.id : null,
      ]
    );
    pendingEncryptedAttachmentPath = null;

    await writeLeaveAudit(pool, result.insertId, empId, req.user.id, source === 'Manual' ? 'leave_manual_encoded' : 'leave_created', remarks || reason || null, null, 'Pending', { leave_type: leaveType.name, filing_source: source });
    res.json({ id: result.insertId, message: 'Leave request submitted.' });
  } catch (err) {
    if (pendingEncryptedAttachmentPath) await deleteEncryptedFile(pendingEncryptedAttachmentPath).catch(() => {});
    console.error('Error saving leave request:', err.message);
    res.status(500).json({ error: 'Failed to submit leave.' });
  }
});

app.post('/api/leave/:id/reveal-sensitive', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    if (await rejectUnsupportedRouteFields(req, res, LEAVE_STEP_UP_ALLOWED_FIELDS, { module: 'LEAVE_SECURITY' })) return;
    const [[leave]] = await pool.execute(
      `SELECT employee_id, reason, reason_encrypted, remarks, remarks_encrypted,
              rejection_remarks, rejection_remarks_encrypted,
              payroll_approval_remarks, payroll_approval_remarks_encrypted,
              approval_remarks, approval_remarks_encrypted,
              file_path, attachment_encrypted_path
         FROM leave_requests WHERE id = ? LIMIT 1`,
      [req.params.id]
    );
    if (!leave) return res.status(404).json({ error: 'Leave request not found.' });
    if (!hasLeavePermission(req.user, 'leave.request.view_all') && Number(leave.employee_id) !== Number(req.user.employeeId)) {
      return res.status(403).json({ error: 'You may only reveal your own leave request.' });
    }
    const passwordVerified = await verifyLeaveStepUpPassword(pool, req);
    if (!passwordVerified) {
      await writeLeaveAudit(pool, req.params.id, leave.employee_id, req.user.id, 'leave_sensitive_step_up_failed');
      return res.status(403).json({ error: 'Current password confirmation is required.' });
    }
    await writeLeaveAudit(pool, req.params.id, leave.employee_id, req.user.id, 'leave_sensitive_details_revealed');
    const attachment = leaveAttachmentState(leave);
    return res.json({
      reason: decryptColumnValue(leave.reason_encrypted || leave.reason),
      remarks: decryptColumnValue(leave.remarks_encrypted || leave.remarks),
      rejection_remarks: decryptColumnValue(leave.rejection_remarks_encrypted || leave.rejection_remarks),
      payroll_approval_remarks: decryptColumnValue(leave.payroll_approval_remarks_encrypted || leave.payroll_approval_remarks),
      approval_remarks: decryptColumnValue(leave.approval_remarks_encrypted || leave.approval_remarks),
      attachment_available: attachment.available,
      attachment_missing: attachment.missing,
      attachment_status: attachment.status,
    });
  } catch (err) {
    console.error('Error revealing leave details:', err.message);
    return res.status(500).json({ error: 'Failed to reveal leave details.' });
  }
});

app.post('/api/leave/:id/attachment', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    if (await rejectUnsupportedRouteFields(req, res, LEAVE_STEP_UP_ALLOWED_FIELDS, { module: 'LEAVE_SECURITY' })) return;
    const [[leave]] = await pool.execute(
      `SELECT employee_id, attachment_name_encrypted, attachment_encrypted_path, attachment_mime_type
         FROM leave_requests WHERE id = ? LIMIT 1`,
      [req.params.id]
    );
    if (!leave?.attachment_encrypted_path) return res.status(404).json({ error: 'Leave attachment not found.' });
    if (!hasLeavePermission(req.user, 'leave.request.view_all') && Number(leave.employee_id) !== Number(req.user.employeeId)) {
      return res.status(403).json({ error: 'You may only access your own leave attachment.' });
    }
    const passwordVerified = await verifyLeaveStepUpPassword(pool, req);
    if (!passwordVerified) {
      await writeLeaveAudit(pool, req.params.id, leave.employee_id, req.user.id, 'leave_attachment_step_up_failed');
      return res.status(403).json({ error: 'Current password confirmation is required.' });
    }
    if (!secureVaultFileExists(leave.attachment_encrypted_path)) {
      await writeLeaveAudit(pool, req.params.id, leave.employee_id, req.user.id, 'leave_attachment_missing');
      return res.status(404).json({ error: 'Leave attachment file is missing.' });
    }
    const buffer = await readEncryptedBuffer(leave.attachment_encrypted_path);
    const fileName = decryptColumnValue(leave.attachment_name_encrypted) || 'leave-attachment.bin';
    await writeLeaveAudit(pool, req.params.id, leave.employee_id, req.user.id, 'leave_attachment_downloaded');
    res.setHeader('Content-Type', leave.attachment_mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName.replace(/["\r\n]/g, '_')}"`);
    return res.send(buffer);
  } catch (err) {
    console.error('Error downloading leave attachment:', err.message);
    return res.status(500).json({ error: 'Failed to download leave attachment.' });
  }
});

app.get('/api/leave/:id/attachment', requireAuth, requireRole(ROLES.any), async (req, res) => {
  return res.status(405).json({ error: 'Current password confirmation is required to download leave attachment.' });
});

app.patch('/api/leave/:id/status', requireAuth, requireLeavePermission('leave.request.approve'), async (req, res) => {
  const pool = require('./config/db');
  const connection = await pool.getConnection();
  try {
    if (await rejectUnsupportedRouteFields(req, res, LEAVE_STATUS_ALLOWED_FIELDS, { module: 'LEAVE_SECURITY' })) return;
    await connection.beginTransaction();
    const requestedStatus = req.body.status === 'Denied' ? 'Rejected' : req.body.status;
    const remarks = req.body.remarks || null;
    if (requestedStatus === 'Rejected' && !remarks) {
      await connection.rollback();
      return res.status(400).json({ error: 'Remarks are required when rejecting leave.' });
    }
    if (!['Approved', 'Payroll Approved', 'Rejected', 'Cancelled', 'Pending'].includes(requestedStatus)) {
      await connection.rollback();
      return res.status(400).json({ error: 'Invalid leave status.' });
    }

    const [rows] = await connection.execute(
      `SELECT lr.*, COALESCE(lt.name, lr.type) AS leave_type_name, lt.id AS configured_leave_type_id, lt.max_allowed_days
       FROM leave_requests lr
       LEFT JOIN leave_types lt ON lt.id = lr.leave_type_id
       WHERE lr.id = ?
       FOR UPDATE`,
      [req.params.id]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Leave request not found.' });
    }
    const leave = rows[0];
    const payrollApprover = isLeavePayrollApprover(req.user);
    const hrFinalApprover = isLeaveHrFinalApprover(req.user);
    let status = requestedStatus;

    if (Number(req.user.employeeId) === Number(leave.employee_id) && ['Approved', 'Payroll Approved', 'Rejected'].includes(status)) {
      await connection.rollback();
      await writeLeaveAudit(pool, req.params.id, leave.employee_id, req.user.id, 'leave_self_approval_blocked', 'Users cannot approve or reject their own leave request.', leave.status, requestedStatus);
      return res.status(403).json({ error: 'You cannot approve or reject your own leave request.' });
    }

    if (status === 'Approved' || status === 'Payroll Approved') {
      if (payrollApprover) {
        if (leave.status !== 'Pending') {
          await connection.rollback();
          return res.status(409).json({ error: 'Payroll can only endorse pending leave requests.' });
        }
        status = 'Payroll Approved';
      } else if (hrFinalApprover) {
        if (leave.status !== 'Payroll Approved') {
          await connection.rollback();
          return res.status(409).json({ error: 'Payroll approval is required before HR final approval.' });
        }
        status = 'Approved';
      } else {
        await connection.rollback();
        return res.status(403).json({ error: 'Only Payroll roles can endorse leave and HR Manager can give final approval.' });
      }
    }

    if (status === 'Rejected') {
      if (!payrollApprover && !hrFinalApprover) {
        await connection.rollback();
        return res.status(403).json({ error: 'Only Payroll or HR Manager can reject leave requests.' });
      }
      if (!['Pending', 'Payroll Approved'].includes(leave.status)) {
        await connection.rollback();
        return res.status(409).json({ error: `Cannot reject a ${leave.status} leave request.` });
      }
    }

    if (status === 'Cancelled' && !hrFinalApprover) {
      await connection.rollback();
      return res.status(403).json({ error: 'Only HR Manager can cancel an approved leave request.' });
    }

    const leaveType = await getLeaveType(connection, { id: leave.configured_leave_type_id, name: leave.leave_type_name, includeInactive: true });
    if (!leaveType) {
      await connection.rollback();
      return res.status(400).json({ error: 'Leave type configuration was not found.' });
    }
    const year = yearFromDateOnly(leave.date_from);

    if (status === 'Approved' && leave.status !== 'Approved') {
      const balance = await getConfiguredLeaveBalance(connection, leave.employee_id, leaveType, year, true);
      if (!balance) {
        await connection.rollback();
        return res.status(400).json({ error: 'No leave balance is configured for this employee, leave type, and year.' });
      }
      const integrity = leaveBalanceIntegrityStatus(balance);
      if (integrity.status === 'TAMPERED') {
        await connection.rollback();
        await writeLeaveAudit(pool, req.params.id, leave.employee_id, req.user.id, 'leave_balance_integrity_blocked', 'Leave balance integrity check failed before approval.', leave.status, status, {
          leave_balance_id: balance.id,
          leave_type_id: leaveType.id,
          year,
        });
        return res.status(409).json({ error: 'Leave balance integrity check failed. Ask System Administrator or HR Admin to verify this balance before approval.' });
      }
      const requestedDays = decimalValue(leave.days || 1);
      if (decimalValue(balance.remaining_days_value) < requestedDays) {
        await connection.rollback();
        return res.status(400).json({ error: 'Insufficient leave balance for approval.' });
      }
      const nextUsed = decimalValue(balance.used_days_value) + requestedDays;
      const nextRemaining = decimalValue(balance.total_days_value) - nextUsed;
      const nextIntegrityHash = computeLeaveBalanceIntegrityHash({
        employee_id: balance.employee_id,
        leave_type_id: balance.leave_type_id || leaveType.id,
        leave_type: balance.leave_type || leaveType.name,
        year: balance.year,
        balance: balance.balance ?? balance.total_days_value,
        used: nextUsed,
        total_days: balance.total_days ?? balance.total_days_value,
        used_days: nextUsed,
        remaining_days: nextRemaining,
      });
      await connection.execute(
        `UPDATE leave_balances
            SET used_days = ?, remaining_days = ?, used = ?, integrity_hash = ?, last_updated_by = ?
          WHERE id = ?`,
        [nextUsed, nextRemaining, nextUsed, nextIntegrityHash, req.user.id, balance.id]
      );
    }

    await connection.execute(
      `UPDATE leave_requests SET
         status = ?,
         reviewed_by = ?,
         reviewed_at = NOW(),
         payroll_approved_by = CASE WHEN ? = 'Payroll Approved' THEN ? ELSE payroll_approved_by END,
         payroll_approved_at = CASE WHEN ? = 'Payroll Approved' THEN NOW() ELSE payroll_approved_at END,
         payroll_approval_remarks = NULL,
         payroll_approval_remarks_encrypted = CASE WHEN ? = 'Payroll Approved' THEN ? ELSE payroll_approval_remarks_encrypted END,
         approved_by = CASE WHEN ? = 'Approved' THEN ? ELSE approved_by END,
         approved_at = CASE WHEN ? = 'Approved' THEN NOW() ELSE approved_at END,
         approval_date = CASE WHEN ? = 'Approved' THEN NOW() ELSE approval_date END,
         approval_remarks = NULL,
         approval_remarks_encrypted = CASE WHEN ? = 'Approved' THEN ? ELSE approval_remarks_encrypted END,
         rejected_by = CASE WHEN ? = 'Rejected' THEN ? ELSE rejected_by END,
         rejected_at = CASE WHEN ? = 'Rejected' THEN NOW() ELSE rejected_at END,
         rejection_remarks = NULL,
         rejection_remarks_encrypted = CASE WHEN ? = 'Rejected' THEN ? ELSE rejection_remarks_encrypted END,
         remarks = NULL,
         remarks_encrypted = COALESCE(?, remarks_encrypted)
       WHERE id = ?`,
      [
        status, req.user.id,
        status, req.user.id,
        status,
        status, encryptColumnValue(remarks),
        status, req.user.id,
        status,
        status,
        status, encryptColumnValue(remarks),
        status, req.user.id,
        status,
        status, encryptColumnValue(remarks),
        encryptColumnValue(remarks),
        req.params.id,
      ]
    );
    const action = status === 'Payroll Approved' ? 'leave_payroll_approved' : status === 'Approved' ? 'leave_approved' : status === 'Rejected' ? 'leave_rejected' : status === 'Cancelled' ? 'leave_cancelled' : 'leave_updated';
    await writeLeaveAudit(connection, req.params.id, leave.employee_id, req.user.id, action, remarks, leave.status, status);
    await connection.commit();
    res.json({
      message: status === 'Payroll Approved'
        ? 'Leave endorsed by Payroll. HR final approval is required.'
        : 'Leave status updated.',
      status,
    });
  } catch (err) {
    await connection.rollback().catch(() => {});
    console.error('Error updating leave:', err.message);
    res.status(500).json({ error: 'Failed to update leave.' });
  } finally {
    connection.release();
  }
});

app.get('/api/leave/audit', requireAuth, requireLeavePermission('leave.audit.view'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const [rows] = await pool.execute(
      `SELECT lat.*, e.employee_code, e.first_name, e.middle_name, e.last_name, u.username AS actor_name
       FROM leave_audit_trail lat
       LEFT JOIN employees e ON e.id = lat.employee_id
       LEFT JOIN users u ON u.id = lat.actor_user_id
       ORDER BY lat.created_at DESC
       LIMIT 200`
    );
    res.json(rows.map(row => {
      decryptEmployeeStrictPii(row);
      return {
        id: row.id,
        leave_request_id: row.leave_request_id,
        employee_id: row.employee_id,
        action: row.action,
        old_status: row.old_status,
        new_status: row.new_status,
        actor_name: row.actor_name,
        created_at: row.created_at,
        employee_name: employeeDisplayName(row) || row.employee_code || '-',
        remarks_available: !!(row.remarks_encrypted || row.remarks),
        metadata_available: !!(row.metadata_encrypted || row.metadata),
      };
    }));
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch leave audit trail.' });
  }
});

app.get('/api/leave/reports/:reportType', requireAuth, requireLeavePermission('leave.report.view'), async (req, res) => {
  try {
    const pool = require('./config/db');
    const { reportType } = req.params;
    const format = ['pdf', 'excel', 'csv'].includes(req.query.format) ? req.query.format : 'csv';
    let rows = [];
    if (reportType === 'balances') {
      [rows] = await pool.execute(
        `SELECT e.employee_code, e.first_name, e.middle_name, e.last_name, d.name AS department,
                lb.leave_type, lb.balance, lb.used, (lb.balance - lb.used) AS remaining, lb.year
         FROM leave_balances lb
         JOIN employees e ON e.id = lb.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         ORDER BY e.last_name, lb.leave_type`
      );
    } else {
      [rows] = await pool.execute(
        `SELECT e.employee_code, e.first_name, e.middle_name, e.last_name, d.name AS department,
                lr.type, lr.date_from, lr.date_to, lr.days, lr.filing_source, lr.status, lr.created_at
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         ORDER BY lr.created_at DESC`
      );
    }
    rows = rows.map(row => {
      decryptEmployeeStrictPii(row);
      const { first_name, middle_name, last_name, ...rest } = row;
      return { employee: employeeDisplayName(row) || row.employee_code || '-', ...rest };
    });
    const keys = Object.keys(rows[0] || { report: 'No data' });
    const csv = [keys.join(','), ...rows.map(row => keys.map(key => `"${String(row[key] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n');
    const extension = format === 'excel' ? 'xls' : format;
    res.setHeader('Content-Type', format === 'pdf' ? 'application/pdf' : format === 'excel' ? 'application/vnd.ms-excel' : 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${reportType}-leave-report.${extension}"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Failed to export leave report.' });
  }
});

// Attendance — now handled by /api/attendance router (server/attendance.js)

const employeeOnlyRequestAccess = (req, res, next) => {
  if (req.user?.role !== 'employee') {
    return res.status(403).json({ error: 'Requests are available only to employee accounts.' });
  }
  next();
};

async function rejectRetiredGeneralRequests(req, res) {
  await auditSecurityEvent(req, {
    action: 'blocked_retired_general_request_endpoint',
    module: 'GENERAL_REQUEST_SECURITY',
    targetTable: 'general_requests',
    targetRecord: req.params?.id || req.user?.employeeId || null,
    newValue: {
      path: req.originalUrl,
      method: req.method,
      reason: 'COE/COS/Request Exit is outside the approved capstone scope.'
    },
    result: 'blocked',
  }).catch(() => {});
  return res.status(410).json({ error: 'This request type is no longer supported. Please use Leave Request only.' });
}

// General Requests (COE, COS, Exit) are retired. Leave requests remain under /api/leave.
app.get('/api/requests', requireAuth, employeeOnlyRequestAccess, async (req, res) => {
  return rejectRetiredGeneralRequests(req, res);
});

app.post('/api/requests', requireAuth, employeeOnlyRequestAccess, async (req, res) => {
  return rejectRetiredGeneralRequests(req, res);
});

app.patch('/api/requests/:id/status', requireAuth, requireRole(ROLES.hr_final_approval), async (req, res) => {
  return rejectRetiredGeneralRequests(req, res);
});

// Payroll runs — payroll roles + admin only
app.get('/api/payroll/runs', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('./config/db');
    const [rows] = await pool.execute(`SELECT * FROM payroll_runs ORDER BY created_at DESC`);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch payroll runs.' }); }
});

app.post('/api/payroll/runs', requireAuth, requireRole(['payroll_officer']), async (req, res) => {
  try {
    const pool = require('./config/db');
    if (await rejectUnsupportedRouteFields(req, res, PAYROLL_RUN_ALLOWED_FIELDS, { module: 'PAYROLL_SECURITY' })) return;
    const { period_start, period_end } = req.body;
    const [result] = await pool.execute(
      `INSERT INTO payroll_runs (period_start,period_end,run_date,status,created_by) VALUES (?,?,CURDATE(),'Draft',?)`,
      [period_start, period_end, req.user.id]
    );
    res.json({ id: result.insertId, message: 'Payroll run created.' });
  } catch (err) { res.status(500).json({ error: 'Failed to create payroll run.' }); }
});

app.patch('/api/payroll/runs/:id/approve', requireAuth, requireRole(['payroll_manager']), async (req, res) => {
  try {
    const pool = require('./config/db');
    if (await rejectUnsupportedRouteFields(req, res, PAYROLL_RUN_APPROVE_ALLOWED_FIELDS, { module: 'PAYROLL_SECURITY' })) return;
    await pool.execute(
      `UPDATE payroll_runs SET status=?, approved_by=?, approved_at=NOW() WHERE id=?`,
      ['Approved', req.user.id, req.params.id]
    );
    res.json({ message: 'Payroll run updated.' });
  } catch (err) { res.status(500).json({ error: 'Failed to update payroll run.' }); }
});

// Payslips
app.get('/api/payroll/payslips', requireAuth, requireRole(ROLES.any), async (req, res) => {
  try {
    const pool = require('./config/db');
    let q = `SELECT ps.*, e.employee_code, e.first_name, e.middle_name, e.last_name,
             pr.period_start, pr.period_end
             FROM payslips ps JOIN employees e ON e.id=ps.employee_id
             JOIN payroll_runs pr ON pr.id=ps.payroll_run_id`;
    const p = [];
    if (req.user.role === 'employee') { q += ' WHERE ps.employee_id = ?'; p.push(req.user.employeeId); }
    q += ' ORDER BY ps.generated_at DESC';
    const [rows] = await pool.execute(q, p);
    res.json(rows.map(row => {
      decryptEmployeeStrictPii(row);
      return { ...row, employee_name: employeeDisplayName(row) || row.employee_code || '-' };
    }));
  } catch (err) { res.status(500).json({ error: 'Failed to fetch payslips.' }); }
});

// Blockchain integrity summary. Detailed actions stay protected in route modules.
app.get('/api/blockchain', requireAuth, requireRole([...ROLES.admin_any, ...ROLES.payroll_any]), async (req, res) => {
  try {
    const pool = require('./config/db');
    const [tableRows] = await pool.execute(
      `SELECT COUNT(*) AS exists_count
         FROM INFORMATION_SCHEMA.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'BLOCKCHAIN_AUDIT_LOG'`
    );
    if (!tableRows[0]?.exists_count) {
      return res.json({
        message: 'Permissioned payroll blockchain audit log is not initialized. Run database/migrate-permissioned-blockchain-payroll.sql.',
        records: [],
      });
    }

    const [rows] = await pool.execute(
      `SELECT bal.Audit_ID, bal.Payroll_ID, bal.Event_Type, bal.Actor_Role,
              bal.Transaction_Hash, bal.Payload_Hash, bal.Status, bal.Created_At,
              pr.Blockchain_Status, pr.Approval_Status
         FROM BLOCKCHAIN_AUDIT_LOG bal
         LEFT JOIN PAYROLL_RECORD pr ON pr.Payroll_ID = bal.Payroll_ID
        ORDER BY bal.Created_At DESC, bal.Audit_ID DESC
        LIMIT 50`
    );
    res.json({
      message: 'Use /api/blockchain/payroll/finalized for payroll blockchain records.',
      records: rows,
    });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch blockchain audit summary.' }); }
});

// Employee self-service profile and HR change-request review
app.use('/api', selfServiceRoutes);

// Error handling middleware (before SPA fallback)
app.use((err, req, res, next) => {
  const { status, body } = clientErrorResponse(err);
  console.error('Request error:', {
    status,
    method: req.method,
    path: req.originalUrl,
    message: err.message,
  });
  res.status(status).json(body);
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function getLocalIPv4Addresses() {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  const virtualPattern = /virtual|vmware|vbox|virtualbox|hyper-v|wsl|docker|loopback/i;

  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')) {
        candidates.push({
          name,
          address: address.address,
          isVirtual: virtualPattern.test(name),
          isWifi: /wi-?fi|wireless|wlan/i.test(name),
        });
      }
    }
  }

  return candidates;
}

function getPreferredLocalIPv4Address() {
  const candidates = getLocalIPv4Addresses();
  return (
    candidates.find(item => item.isWifi && !item.isVirtual)
    || candidates.find(item => !item.isVirtual)
    || candidates[0]
    || { address: 'localhost' }
  ).address;
}

function logServerUrls(protocol) {
  const localIp = getPreferredLocalIPv4Address();
  const candidates = getLocalIPv4Addresses();
  console.log(`Local access: ${protocol}://localhost:${PORT}`);
  console.log(`Network access: ${protocol}://${localIp}:${PORT}`);
  console.log(`Health check: ${protocol}://${localIp}:${PORT}/health`);
  if (candidates.length > 1) {
    console.log('Other local IPv4 URLs:');
    candidates
      .filter(item => item.address !== localIp)
      .forEach(item => console.log(`- ${item.name}: ${protocol}://${item.address}:${PORT}`));
  }
}

if (process.env.TLS_CERT_PATH && process.env.TLS_KEY_PATH) {
  const tlsOptions = {
    cert: fs.readFileSync(process.env.TLS_CERT_PATH),
    key: fs.readFileSync(process.env.TLS_KEY_PATH),
    ca: process.env.TLS_CA_PATH ? fs.readFileSync(process.env.TLS_CA_PATH) : undefined,
    minVersion: 'TLSv1.3',
  };
  const server = https.createServer(tlsOptions, app);
  attachSocketDeviceDetection(server);
  server.listen(PORT, HOST, () => {
    console.log(`LGSV_HR running with TLS 1.3 on ${HOST}:${PORT}`);
    logServerUrls('https');
  });
} else {
  const server = http.createServer(app);
  attachSocketDeviceDetection(server);
  server.listen(PORT, HOST, () => {
    console.log(`LGSV_HR local development server listening on ${HOST}:${PORT}`);
    logServerUrls('http');
    if (process.env.NODE_ENV === 'production') {
      console.warn('TLS certificate paths are not configured. Terminate TLS 1.3 at the trusted reverse proxy.');
    }
  });
}
