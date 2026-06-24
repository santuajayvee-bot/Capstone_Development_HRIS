/* Shared browser validation for HRIS forms.
 * Server-side validation remains the authority; this provides immediate feedback.
 */
(function attachHrisFormValidation() {
  const NAME_MESSAGE = 'Name fields must contain letters only and cannot contain numbers.';
  const NUMERIC_MESSAGE = 'This field must contain numbers only.';
  const PHONE_MESSAGE = 'Please enter a valid Philippine mobile number. Format: +63 9XX XXX XXXX.';
  const EMAIL_MESSAGE = 'Please enter a valid email address.';
  const GOVERNMENT_ID_MESSAGE = 'This field must contain numbers only. Spaces and hyphens are allowed as separators.';
  const UNSAFE_MESSAGE = 'Input contains disallowed characters or patterns.';

  const NAME_FIELDS = new Set(['first_name', 'middle_name', 'last_name', 'beneficiary_name', 'emergency_contact_name', 'emergency_name']);
  const PHONE_FIELDS = new Set([
    'contact_number', 'contact_num', 'mobile', 'phone', 'phone_number',
    'emergency_contact_num', 'emergency_contact_number',
    'emergency_contact_secondary_num', 'emergency_contact_secondary_number',
    'agency_contact_number'
  ]);
  const INTEGER_FIELDS = new Set([
    'employee_number', 'employee_id', 'sss_number', 'sss', 'philhealth_number',
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
    const key = normalizeKey(element.name || element.id);
    const explicit = normalizeKey(element.dataset.validation);
    if (explicit) return explicit;
    if (element.tagName === 'SELECT') return '';
    if (NAME_FIELDS.has(key) || /^(?:emerg|emergency)_name$/.test(key)) return 'name';
    if (PHONE_FIELDS.has(key) || /(?:^|_)(?:contact|phone|mobile)$/.test(key)) return 'phone';
    if (INTEGER_FIELDS.has(key)) return 'integer';
    if (DECIMAL_FIELDS.has(key) || /(?:salary|rate|hours)$/.test(key)) return 'decimal';
    if (EMAIL_FIELDS.has(key) || /email$/.test(key)) return 'email';
    return '';
  }

  function phoneLocalDigits(value) {
    let digits = String(value || '').replace(/\D/g, '');
    if (digits.startsWith('63')) digits = digits.slice(2);
    if (digits.startsWith('0')) digits = digits.slice(1);
    return digits.slice(0, 10);
  }

  function formatPhilippinePhone(value) {
    const local = phoneLocalDigits(value);
    if (!local) return '';
    const part1 = local.slice(0, 3);
    const part2 = local.slice(3, 6);
    const part3 = local.slice(6, 10);
    return `+63 ${[part1, part2, part3].filter(Boolean).join(' ')}`.trim();
  }

  function isValidPhilippinePhone(value) {
    const local = phoneLocalDigits(value);
    return /^9\d{9}$/.test(local);
  }

  function normalizePhoneInput(element, { commit = false } = {}) {
    if (fieldType(element) !== 'phone' || typeof element.value !== 'string') return;
    const formatted = formatPhilippinePhone(element.value);
    if (formatted || commit) element.value = formatted;
  }

  function applyPhoneFieldHints(scope = document) {
    const fields = scope.querySelectorAll?.('input, textarea') || [];
    fields.forEach(element => {
      if (fieldType(element) !== 'phone') return;
      element.type = 'tel';
      element.inputMode = 'tel';
      element.maxLength = 17;
      element.placeholder = element.placeholder && !/numbers only/i.test(element.placeholder)
        ? element.placeholder
        : '+63 9XX XXX XXXX';
      element.title = 'Format: +63 9XX XXX XXXX';
      if (element.value) normalizePhoneInput(element, { commit: true });
    });
  }

  function unsafe(value) {
    return /<\s*\/?\s*script\b/i.test(value)
      || /\bon[a-z]+\s*=/i.test(value)
      || /\b(?:union\s+(?:all\s+)?select|drop\s+table|delete\s+from|insert\s+into|update\s+\w+\s+set|select\s+.+\s+from)\b/i.test(value)
      || /(?:'|\")\s*(?:or|and)\s+(?:'|\"|\d)/i.test(value);
  }

  function fieldLabel(element) {
    const wrappingLabel = element.closest('label');
    if (wrappingLabel) {
      const clone = wrappingLabel.cloneNode(true);
      clone
        .querySelectorAll('input, select, textarea, button, .field-validation-message')
        .forEach(child => child.remove());
      const text = clone.textContent.trim();
      if (text) return text;
    }

    if (element.id) {
      const escapedId = window.CSS?.escape ? CSS.escape(element.id) : element.id.replace(/["\\]/g, '\\$&');
      const explicit = document.querySelector(`label[for="${escapedId}"]`);
      if (explicit?.textContent?.trim()) return explicit.textContent.trim();
    }

    return element.getAttribute('aria-label')
      || element.placeholder
      || String(element.name || element.id || 'This field')
        .replace(/^(?:emp_|profile_edit_|edit_|salary_|payroll_)/, '')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
  }

  function withFieldLabel(element, message) {
    return `${fieldLabel(element)}: ${message}`;
  }

  function labeledValidationMessage(element, message = '') {
    const text = String(message || validationMessage(element, { commit: true }) || 'Please check this field.');
    return text.includes(':') ? text : withFieldLabel(element, text);
  }

  function currentInvalidElement() {
    return document.querySelector('.input-validation-error')
      || document.querySelector('input:invalid, select:invalid, textarea:invalid')
      || (document.activeElement?.matches?.('input, select, textarea') ? document.activeElement : null);
  }

  function formatValidationAlert(message) {
    const raw = String(message || '');
    if (raw.includes(':')) return raw;
    const element = currentInvalidElement();
    if (!element) return raw;

    const actualMessage = validationMessage(element, { commit: true }) || element.validationMessage || '';
    if (actualMessage && actualMessage !== raw && !actualMessage.includes(raw)) return raw;
    return labeledValidationMessage(element, raw);
  }

  function revealInvalidField(element) {
    const section = element.closest('.form-section');
    if (section?.id?.startsWith('form-') && window.getComputedStyle(section).display === 'none' && typeof window.switchFormTab === 'function') {
      window.switchFormTab(section.id.replace(/^form-/, ''));
    }
    const profilePanel = element.closest('.profile-edit-tab-panel, .profile-tab-panel');
    if (profilePanel?.id && !profilePanel.classList.contains('active') && typeof window.switchProfileTab === 'function') {
      window.switchProfileTab(profilePanel.id.replace(/^profile-(?:edit-)?tab-/, ''));
    }

    element.classList.add('input-validation-error');
    element.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    setTimeout(() => element.focus?.({ preventScroll: true }), 120);
  }

  function notifyInvalidField(element) {
    revealInvalidField(element);
    const message = labeledValidationMessage(element, element.validationMessage);
    if (typeof window.showAlert === 'function') {
      window.showAlert(message, 'Validation Error', 'warning');
    } else {
      window.alert(message);
    }
  }

  function setInlineValidationMessage(element, message) {
    if (!element?.id) return;
    const id = `${element.id}-validation-message`;
    let feedback = document.getElementById(id);
    if (!message) {
      feedback?.remove();
      element.removeAttribute('aria-describedby');
      return;
    }

    if (!feedback) {
      feedback = document.createElement('div');
      feedback.id = id;
      feedback.className = 'field-validation-message';
      const label = element.closest('label');
      if (label && label.contains(element)) {
        label.appendChild(feedback);
      } else {
        element.insertAdjacentElement('afterend', feedback);
      }
    }
    feedback.textContent = message;
    element.setAttribute('aria-describedby', id);
  }

  function validationMessage(element, { commit = false } = {}) {
    if (!element || element.disabled || element.type === 'hidden' || element.type === 'file') return '';
    if (typeof element.value !== 'string') return '';

    // Preserve a trailing space while typing so multi-word names remain enterable.
    const value = element.value.trim();
    if (commit && element.value !== value) element.value = value;
    if (!value) return element.required ? withFieldLabel(element, 'This field is required.') : '';
    if (unsafe(value)) return withFieldLabel(element, UNSAFE_MESSAGE);

    const type = fieldType(element);
    if (type === 'name' && !/^[\p{L}]+(?:[ '-][\p{L}]+)*$/u.test(value.replace(/\s+/g, ' '))) return withFieldLabel(element, NAME_MESSAGE);
    if (type === 'phone' && !isValidPhilippinePhone(value)) return withFieldLabel(element, PHONE_MESSAGE);
    if (type === 'government_id' && !/^[\d\s-]+$/.test(value)) return withFieldLabel(element, GOVERNMENT_ID_MESSAGE);
    if (type === 'integer' && !/^\d+$/.test(value)) return withFieldLabel(element, NUMERIC_MESSAGE);
    if (type === 'decimal' && !/^\d+(?:\.\d+)?$/.test(value)) return withFieldLabel(element, NUMERIC_MESSAGE);
    if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value)) return withFieldLabel(element, EMAIL_MESSAGE);
    return '';
  }

  function validateElement(element, options) {
    if (!element || typeof element.setCustomValidity !== 'function') return true;
    if (options?.commit) normalizePhoneInput(element, options);
    const message = validationMessage(element, options);
    element.setCustomValidity(message);
    element.classList.toggle('input-validation-error', Boolean(message));
    setInlineValidationMessage(element, message);
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
      notifyInvalidField(firstInvalid);
      return false;
    }
    return true;
  }

  document.addEventListener('input', event => {
    normalizePhoneInput(event.target, { commit: false });
    validateElement(event.target, { commit: false });
  }, true);
  document.addEventListener('change', event => {
    normalizePhoneInput(event.target, { commit: true });
    validateElement(event.target, { commit: true });
  }, true);
  document.addEventListener('blur', event => {
    normalizePhoneInput(event.target, { commit: true });
    validateElement(event.target, { commit: true });
  }, true);
  document.addEventListener('invalid', event => {
    if (!event.target?.matches?.('input, select, textarea')) return;
    event.preventDefault();
    if (event.target.dataset.invalidAlertOpen === '1') return;
    event.target.dataset.invalidAlertOpen = '1';
    validateElement(event.target, { commit: true });
    notifyInvalidField(event.target);
    setTimeout(() => { delete event.target.dataset.invalidAlertOpen; }, 500);
  }, true);
  document.addEventListener('submit', event => {
    if (!validateScope(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener('DOMContentLoaded', () => applyPhoneFieldHints(document));
  document.addEventListener('partialsLoaded', () => applyPhoneFieldHints(document));
  applyPhoneFieldHints(document);

  window.LGSVValidation = {
    validateElement,
    validateScope,
    applyPhoneFieldHints,
    formatValidationAlert,
    NAME_MESSAGE,
    NUMERIC_MESSAGE,
    PHONE_MESSAGE,
    GOVERNMENT_ID_MESSAGE,
    EMAIL_MESSAGE
  };
})();
