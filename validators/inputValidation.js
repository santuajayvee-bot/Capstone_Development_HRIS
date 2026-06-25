/*
 * Shared request validation for HRIS write APIs.
 *
 * This runs before route handlers, so values submitted with Postman or browser
 * developer tools are subject to the same rules as browser form values.
 */

const { auditSecurityEvent } = require('../server/security-controls');

const NAME_FIELDS = new Set([
  'first_name',
  'middle_name',
  'last_name',
  'beneficiary_name',
  'emergency_contact_name',
  'emergency_name',
  'agency_contact_person',
]);

const INTEGER_FIELDS = new Set([
  'contact_num',
  'mobile',
  'phone_number',
  'emergency_contact_phone',
  'employee_number',
  'employee_id',
]);

const PHONE_FIELDS = new Set([
  'contact_number',
  'emergency_contact_num',
  'emergency_contact_number',
  'emergency_contact_secondary_num',
  'emergency_contact_secondary_number',
  'agency_contact_number',
]);

const GOVERNMENT_ID_FIELDS = new Set([
  'sss_number',
  'sss',
  'philhealth_number',
  'philhealth',
  'pagibig_number',
  'pagibig',
  'tin',
  'tax_id',
]);

const DECIMAL_FIELDS = new Set([
  'salary',
  'basic_salary',
  'monthly_salary',
  'daily_rate',
  'hourly_rate',
  'base_rate',
  'expected_base_rate',
  'rate',
  'overtime_rate',
  'overtime_hours',
  'working_hours',
  'hours_worked',
  'training_hours',
  'late_minutes',
  'undertime_minutes',
  'overtime_minutes',
  'quantity',
  'output_quantity',
  'rate_per_piece',
  'rate_or_amount',
  'amount_or_rate',
  'amount',
  'original_amount',
  'installment_amount',
  'remaining_balance',
  'late_fixed_deduction_amount',
  'undertime_fixed_deduction_amount',
  'gross_pay',
  'net_pay',
  'housing_allowance',
  'meal_allowance',
  'transport_allowance',
  'bonus_allowance',
  'allowance',
  'deduction',
  'piece_rate',
  'piece_rate_amount',
  'trip_count',
  'total_allowances',
  'overtime_amount',
]);

const EMAIL_FIELDS = new Set([
  'email',
  'work_email',
  'emergency_contact_email',
]);

// Secrets are not displayable HR text. Preserve them byte-for-byte so a valid
// password or one-time token is never altered by generic field sanitization.
const SECRET_FIELDS = new Set([
  'password',
  'current_password',
  'new_password',
  'confirm_password',
  'temporary_password',
  'mfa_token',
  'otp_code',
  'code',
  'turnstile_token',
  'cf_turnstile_response',
]);

const NAME_MESSAGE = 'Name fields must contain letters only and cannot contain numbers.';
const NUMERIC_MESSAGE = 'This field must contain numbers only.';
const EMAIL_MESSAGE = 'Please enter a valid email address.';
const UNSAFE_INPUT_MESSAGE = 'Input contains disallowed characters or patterns.';
const FIELD_LABELS = {
  contact_number: 'Contact No',
  contact_num: 'Contact No',
  mobile: 'Mobile',
  phone_number: 'Phone Number',
  emergency_contact_num: 'Primary Phone Number',
  emergency_contact_number: 'Emergency Contact Number',
  emergency_contact_secondary_num: 'Secondary Phone Number',
  emergency_contact_secondary_number: 'Secondary Phone Number',
  agency_contact_number: 'Agency Contact Number',
  sss_number: 'SSS',
  sss: 'SSS',
  philhealth_number: 'PhilHealth',
  philhealth: 'PhilHealth',
  pagibig_number: 'Pag-IBIG',
  pagibig: 'Pag-IBIG',
  tin: 'TIN',
  tax_id: 'Tax ID',
  base_rate: 'Basic Salary',
  basic_salary: 'Basic Salary',
  allowances: 'Allowances',
  allowance: 'Allowance',
  hours_worked: 'Hours Worked',
  training_hours: 'Training Hours',
};
const MAX_TEXT_LENGTH = 2000;
const MAX_MONEY_VALUE = Number(process.env.MAX_PAYROLL_AMOUNT || 10000000);
const MAX_RATE_VALUE = Number(process.env.MAX_PAYROLL_RATE || 1000000);
const MAX_HOURS_VALUE = Number(process.env.MAX_PAYROLL_HOURS || 744);
const MAX_QUANTITY_VALUE = Number(process.env.MAX_PAYROLL_QUANTITY || 1000000);

const SQL_INJECTION_PATTERNS = [
  /\bunion\b\s+(?:all\s+)?\bselect\b/i,
  /\bselect\b[\s\S]{0,80}\bfrom\b/i,
  /\binsert\b\s+\binto\b/i,
  /\bupdate\b\s+[`"'\w]+\s+\bset\b/i,
  /\bdelete\b\s+\bfrom\b/i,
  /\bdrop\b\s+(?:table|database|schema)\b/i,
  /\balter\b\s+\btable\b/i,
  /\btruncate\b\s+\btable\b/i,
  /\bexec(?:ute)?\b\s*\(/i,
  /\binformation_schema\b/i,
  /\bsleep\s*\(/i,
  /\bbenchmark\s*\(/i,
  /(?:--|#|\/\*)/,
  /;\s*(?:select|insert|update|delete|drop|alter|truncate)\b/i,
  /(?:'|")\s*(?:or|and)\s+(?:'|"|\d|true|false)/i,
];

const XSS_PATTERNS = [
  /<\s*\/?\s*script\b/i,
  /<\s*(?:iframe|object|embed|link|meta|base|form|input|button|svg|math)\b/i,
  /\bon[a-z]+\s*=/i,
  /\b(?:javascript|vbscript|data)\s*:/i,
  /<\/?[a-z][\s\S]*>/i,
];

function normalizeFieldName(key) {
  return String(key || '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function fieldLabel(fieldName) {
  const normalized = normalizeFieldName(fieldName);
  return FIELD_LABELS[normalized] || normalized.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
}

function isEmpty(value) {
  return value === null || value === undefined || (typeof value === 'string' && value === '');
}

function isSafeText(value) {
  if (typeof value !== 'string') return true;
  return ![...SQL_INJECTION_PATTERNS, ...XSS_PATTERNS].some(pattern => pattern.test(value));
}

function unsafeCategories(value) {
  if (typeof value !== 'string') return [];
  const categories = [];
  if (SQL_INJECTION_PATTERNS.some(pattern => pattern.test(value))) categories.push('sql_injection');
  if (XSS_PATTERNS.some(pattern => pattern.test(value))) categories.push('xss');
  return categories;
}

function isName(value) {
  return typeof value === 'string' && /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u.test(value);
}

function isIntegerText(value) {
  return (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0)
    || (typeof value === 'string' && /^\d+$/.test(value));
}

function isPhilippinePhone(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const normalized = String(value).trim().replace(/[\s()-]/g, '');
  return /^(09\d{9}|\+639\d{9})$/.test(normalized);
}

function isGovernmentId(value, fieldName) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  const text = String(value).trim();
  if (!/^[\d\s-]+$/.test(text)) return false;
  const digits = text.replace(/\D/g, '');
  if (/sss/.test(fieldName)) return /^\d{10}$/.test(digits);
  if (/philhealth|pagibig/.test(fieldName)) return /^\d{12}$/.test(digits);
  if (/tin|tax_id/.test(fieldName)) return /^\d{9}$/.test(digits);
  return false;
}

function isDecimalText(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0;
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed || /nan|infinity/i.test(trimmed)) return false;
  return /^\d+(?:\.\d{1,4})?$/.test(trimmed);
}

function isEmail(value) {
  return typeof value === 'string'
    && value.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value);
}

function validateAndSanitize(value, fieldName, errors, path = fieldName) {
  const normalizedField = normalizeFieldName(fieldName);
  if (SECRET_FIELDS.has(normalizedField)) return value;

  if (typeof value === 'string') {
    value = value.trim();
    if (NAME_FIELDS.has(normalizedField)) value = value.replace(/\s+/g, ' ');
    if (value.length > MAX_TEXT_LENGTH) {
      errors.push({ field: path, message: `Input must not exceed ${MAX_TEXT_LENGTH} characters.` });
      return value;
    }
    if (!isSafeText(value)) {
      errors.push({ field: path, message: UNSAFE_INPUT_MESSAGE, value });
      return value;
    }
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => validateAndSanitize(item, fieldName, errors, `${path}[${index}]`));
  }

  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      value[key] = validateAndSanitize(item, key, errors, `${path}.${key}`);
    }
    return value;
  }

  if (isEmpty(value)) return value;

  if (NAME_FIELDS.has(normalizedField) && !isName(value)) {
    errors.push({ field: path, message: `${fieldLabel(path)}: ${NAME_MESSAGE}` });
  } else if (PHONE_FIELDS.has(normalizedField) && !isPhilippinePhone(value)) {
    errors.push({ field: path, message: `${fieldLabel(path)}: Please enter a valid Philippine phone number.` });
  } else if (GOVERNMENT_ID_FIELDS.has(normalizedField) && !isGovernmentId(value, normalizedField)) {
    errors.push({ field: path, message: `${fieldLabel(path)}: ${NUMERIC_MESSAGE} Check the required digit length.` });
  } else if (INTEGER_FIELDS.has(normalizedField) && !isIntegerText(value)) {
    errors.push({ field: path, message: `${fieldLabel(path)}: ${NUMERIC_MESSAGE}` });
  } else if (DECIMAL_FIELDS.has(normalizedField)) {
    if (!isDecimalText(value)) {
      errors.push({ field: path, message: `${fieldLabel(path)}: ${NUMERIC_MESSAGE}` });
    } else {
      const numericValue = Number(value);
      const max = /hours?|overtime|undertime|late/.test(normalizedField)
        ? MAX_HOURS_VALUE
        : /quantity|output/.test(normalizedField)
          ? MAX_QUANTITY_VALUE
          : /rate/.test(normalizedField)
            ? MAX_RATE_VALUE
            : MAX_MONEY_VALUE;
      if (numericValue > max) {
        errors.push({ field: path, message: `${fieldLabel(path)}: Numeric value exceeds the configured maximum of ${max}.` });
      }
    }
  } else if (EMAIL_FIELDS.has(normalizedField) && !isEmail(value)) {
    errors.push({ field: path, message: `${fieldLabel(path)}: ${EMAIL_MESSAGE}` });
  }

  return value;
}

function validateRequestBody(req, res, next) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method) || !req.body || typeof req.body !== 'object') {
    return next();
  }

  const errors = [];
  for (const [key, value] of Object.entries(req.body)) {
    req.body[key] = validateAndSanitize(value, key, errors, key);
  }

  if (errors.length) {
    const messages = [...new Set(errors.map(error => error.message))];
    const unsafeErrors = errors.filter(error => error.message === UNSAFE_INPUT_MESSAGE);
    const unsafeFields = unsafeErrors.map(error => error.field);
    const attackTypes = [...new Set(unsafeErrors.flatMap(error => unsafeCategories(error.value || '')))];
    const action = attackTypes.includes('sql_injection')
      ? 'blocked_sql_injection_attempt'
      : attackTypes.includes('xss')
        ? 'blocked_xss_attempt'
        : unsafeFields.length
          ? 'blocked_injection_or_xss_attempt'
          : 'blocked_invalid_input_attempt';
    auditSecurityEvent(req, {
      action,
      module: unsafeFields.length ? 'INPUT_ATTACK_VALIDATION' : 'INPUT_VALIDATION',
      targetTable: req.originalUrl || null,
      newValue: { fields: errors.map(error => error.field), unsafeFields, attackTypes },
      result: 'blocked',
    }).catch(() => {});
    return res.status(400).json({
      success: false,
      error: messages[0],
      message: messages[0],
      errors,
    });
  }

  return next();
}

module.exports = {
  NAME_MESSAGE,
  NUMERIC_MESSAGE,
  EMAIL_MESSAGE,
  UNSAFE_INPUT_MESSAGE,
  validateRequestBody,
  validateAndSanitize,
};
