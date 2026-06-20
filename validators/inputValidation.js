/*
 * Shared request validation for HRIS write APIs.
 *
 * This runs before route handlers, so values submitted with Postman or browser
 * developer tools are subject to the same rules as browser form values.
 */

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
  'contact_number',
  'contact_num',
  'mobile',
  'phone_number',
  'emergency_contact_num',
  'emergency_contact_number',
  'emergency_contact_secondary_num',
  'emergency_contact_secondary_number',
  'emergency_contact_phone',
  'agency_contact_number',
  'employee_number',
  'employee_id',
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
  'gross_pay',
  'net_pay',
  'housing_allowance',
  'meal_allowance',
  'transport_allowance',
  'bonus_allowance',
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

function normalizeFieldName(key) {
  return String(key || '')
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function isEmpty(value) {
  return value === null || value === undefined || (typeof value === 'string' && value === '');
}

function isSafeText(value) {
  if (typeof value !== 'string') return true;
  return !(
    /<\s*\/?\s*script\b/i.test(value)
    || /\bon[a-z]+\s*=/i.test(value)
    || /\b(?:union\s+(?:all\s+)?select|drop\s+table|delete\s+from|insert\s+into|update\s+\w+\s+set|select\s+.+\s+from)\b/i.test(value)
    || /(?:'|\")\s*(?:or|and)\s+(?:'|\"|\d)/i.test(value)
  );
}

function isName(value) {
  return typeof value === 'string' && /^[\p{L}]+(?:[ '-][\p{L}]+)*$/u.test(value);
}

function isIntegerText(value) {
  return (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0)
    || (typeof value === 'string' && /^\d+$/.test(value));
}

function isDecimalText(value) {
  return (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    || (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value));
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
    if (!isSafeText(value)) {
      errors.push({ field: path, message: UNSAFE_INPUT_MESSAGE });
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
    errors.push({ field: path, message: NAME_MESSAGE });
  } else if (INTEGER_FIELDS.has(normalizedField) && !isIntegerText(value)) {
    errors.push({ field: path, message: NUMERIC_MESSAGE });
  } else if (DECIMAL_FIELDS.has(normalizedField) && !isDecimalText(value)) {
    errors.push({ field: path, message: NUMERIC_MESSAGE });
  } else if (EMAIL_FIELDS.has(normalizedField) && !isEmail(value)) {
    errors.push({ field: path, message: EMAIL_MESSAGE });
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
