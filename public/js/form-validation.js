/* Shared browser validation for HRIS forms.
 * Server-side validation remains the authority; this provides immediate feedback.
 */
(function attachHrisFormValidation() {
  const NAME_MESSAGE = 'Name fields must contain letters only and cannot contain numbers.';
  const NUMERIC_MESSAGE = 'This field must contain numbers only.';
  const EMAIL_MESSAGE = 'Please enter a valid email address.';
  const UNSAFE_MESSAGE = 'Input contains disallowed characters or patterns.';

  const NAME_FIELDS = new Set(['first_name', 'middle_name', 'last_name', 'beneficiary_name', 'emergency_contact_name', 'emergency_name']);
  const INTEGER_FIELDS = new Set([
    'contact_number', 'contact_num', 'mobile', 'phone_number', 'emergency_contact_num',
    'emergency_contact_number', 'emergency_contact_secondary_num', 'emergency_contact_secondary_number',
    'agency_contact_number', 'employee_number', 'employee_id', 'sss_number', 'sss', 'philhealth_number',
    'philhealth', 'pagibig_number', 'pagibig', 'tin'
  ]);
  const DECIMAL_FIELDS = new Set([
    'salary', 'basic_salary', 'monthly_salary', 'daily_rate', 'hourly_rate', 'base_rate',
    'expected_base_rate', 'rate', 'overtime_rate', 'overtime_hours', 'working_hours',
    'hours_worked', 'training_hours', 'ot_hours', 'gross_pay', 'net_pay', 'housing_allowance',
    'meal_allowance', 'transport_allowance', 'bonus_allowance', 'total_allowances', 'overtime_amount'
  ]);
  const EMAIL_FIELDS = new Set(['email', 'work_email', 'emergency_contact_email']);

  function normalizeKey(value) {
    return String(value || '')
      .replace(/([a-z])([A-Z])/g, '$1_$2')
      .replace(/[\s-]+/g, '_')
      .replace(/^(?:emp_|profile_edit_|edit_|salary_|payroll_)/, '')
      .toLowerCase();
  }

  function fieldType(element) {
    const explicit = element.dataset.validation;
    if (explicit) return explicit;
    const key = normalizeKey(element.name || element.id);
    if (NAME_FIELDS.has(key) || /^(?:emerg|emergency)_name$/.test(key)) return 'name';
    if (INTEGER_FIELDS.has(key) || /(?:^|_)(?:contact|phone|mobile)$/.test(key)) return 'integer';
    if (DECIMAL_FIELDS.has(key) || /(?:salary|rate|hours)$/.test(key)) return 'decimal';
    if (EMAIL_FIELDS.has(key) || /email$/.test(key)) return 'email';
    return '';
  }

  function unsafe(value) {
    return /<\s*\/?\s*script\b/i.test(value)
      || /\bon[a-z]+\s*=/i.test(value)
      || /\b(?:union\s+(?:all\s+)?select|drop\s+table|delete\s+from|insert\s+into|update\s+\w+\s+set|select\s+.+\s+from)\b/i.test(value)
      || /(?:'|\")\s*(?:or|and)\s+(?:'|\"|\d)/i.test(value);
  }

  function validationMessage(element, { commit = false } = {}) {
    if (!element || element.disabled || element.type === 'hidden' || element.type === 'file') return '';
    if (typeof element.value !== 'string') return '';

    // Preserve a trailing space while typing so multi-word names remain enterable.
    const value = element.value.trim();
    if (commit && element.value !== value) element.value = value;
    if (!value) return element.required ? 'This field is required.' : '';
    if (unsafe(value)) return UNSAFE_MESSAGE;

    const type = fieldType(element);
    if (type === 'name' && !/^[\p{L}]+(?:[ '-][\p{L}]+)*$/u.test(value.replace(/\s+/g, ' '))) return NAME_MESSAGE;
    if (type === 'integer' && !/^\d+$/.test(value)) return NUMERIC_MESSAGE;
    if (type === 'decimal' && !/^\d+(?:\.\d+)?$/.test(value)) return NUMERIC_MESSAGE;
    if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value)) return EMAIL_MESSAGE;
    return '';
  }

  function validateElement(element, options) {
    if (!element || typeof element.setCustomValidity !== 'function') return true;
    const message = validationMessage(element, options);
    element.setCustomValidity(message);
    element.classList.toggle('input-validation-error', Boolean(message));
    return !message;
  }

  function validateScope(scope, options = { commit: true }) {
    const elements = scope?.querySelectorAll
      ? scope.querySelectorAll('input, select, textarea')
      : [];
    let firstInvalid = null;
    for (const element of elements) {
      if (!validateElement(element, options) && !firstInvalid) firstInvalid = element;
    }
    if (firstInvalid) {
      const section = firstInvalid.closest('.form-section');
      if (section?.id?.startsWith('form-') && window.getComputedStyle(section).display === 'none' && typeof window.switchFormTab === 'function') {
        window.switchFormTab(section.id.replace(/^form-/, ''));
      }
      firstInvalid.focus();
      firstInvalid.reportValidity?.();
      return false;
    }
    return true;
  }

  document.addEventListener('input', event => validateElement(event.target, { commit: false }), true);
  document.addEventListener('change', event => validateElement(event.target, { commit: true }), true);
  document.addEventListener('blur', event => validateElement(event.target, { commit: true }), true);
  document.addEventListener('submit', event => {
    if (!validateScope(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  window.LGSVValidation = { validateElement, validateScope, NAME_MESSAGE, NUMERIC_MESSAGE, EMAIL_MESSAGE };
})();
