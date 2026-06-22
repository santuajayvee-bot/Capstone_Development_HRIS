/* global apiFetch */

const DraftSession = (() => {
  const sessions = new Map();
  const intervalMs = 5000;
  const expiryDays = 14;

  const configs = [
    { module: 'Employees', form: 'Employee Registration', selector: '#register-form-view', record: () => window.EDIT_EMPLOYEE_ID || document.getElementById('emp-id')?.value || 'new', clearFns: ['saveEmployee'] },
    { module: 'Employees', form: 'Employee Profile Editing', selector: '#profile-edit-root', record: () => window.currentProfileEmployee?.id || new URLSearchParams(location.search).get('employeeId') || 'profile', clearFns: ['saveProfilePageChanges'] },
    { module: 'Leave', form: 'Leave Request Filing', selector: '#req-leave-fields', extraSelectors: ['#req-reason', '#req-attachment'], record: () => 'new', clearFns: ['saveRequest'] },
    { module: 'Leave', form: 'Manual Leave Encoding', selector: '#manual-leave-form', record: () => document.getElementById('manual-employee')?.value || 'new', clearFns: ['submitManualLeave'] },
    {
      module: 'Payroll',
      form: 'Salary Calculation',
      selector: '#payroll-tab-salary',
      record: () => document.getElementById('salary-employee')?.value || document.getElementById('salary-employee-search')?.value || 'new',
      clearFns: ['saveSalaryAsDraft', 'saveCalculation', 'saveSalaryRecord', 'saveProductionTransaction', 'saveLogisticsTransaction'],
      hasMeaningfulData: data => Boolean(String(data['salary-employee'] || data['salary-employee-search'] || '').trim())
    },
    { module: 'Attendance', form: 'Manual Correction', selector: '#override-modal, #att-overtime', record: () => document.getElementById('override-att-id')?.value || document.getElementById('ot-employee')?.value || 'new', clearFns: ['submitOverride', 'encodeOvertime'] },
    { module: 'Onboarding', form: 'Checklist', selector: '#onboarding-checklist-form, #onboarding-form, #onboarding-checklist', record: () => document.getElementById('onboarding-employee-id')?.value || 'new', clearFns: ['saveOnboardingChecklist', 'submitOnboardingChecklist'] },
    { module: 'Employees', form: 'Document Uploads', selector: '#sensitive-data-form, #profile-documents-list, #documents-list, #file-upload-form', record: () => window.currentProfileEmployee?.id || window.EDIT_EMPLOYEE_ID || 'new', clearFns: ['updateSensitiveData', 'uploadProfileDocument', 'uploadEmployeeDocument'] }
  ];

  function key(config) {
    return `${config.module}:${config.form}:${config.record() || 'new'}`;
  }

  function queryOne(selector) {
    const value = String(selector || '').trim();
    if (!value) return null;
    try {
      return document.querySelector(value);
    } catch (error) {
      if (value.startsWith('#') && !value.includes(',') && !value.includes(' ')) {
        return document.getElementById(value.slice(1));
      }
      console.warn('[DraftSession] invalid selector skipped:', value);
      return null;
    }
  }

  function queryFirst(selectorList) {
    return String(selectorList || '')
      .split(',')
      .map(selector => queryOne(selector))
      .find(Boolean) || null;
  }

  function isVisibleElement(element) {
    if (!element || !document.body.contains(element)) return false;
    let current = element;
    while (current && current !== document.body) {
      const style = window.getComputedStyle(current);
      if (style.display === 'none' || style.visibility === 'hidden' || current.hidden) return false;
      current = current.parentElement;
    }
    return element.getClientRects().length > 0;
  }

  function findRoot(config) {
    const root = queryFirst(config.selector);
    return isVisibleElement(root) ? root : null;
  }

  function isAuthenticated() {
    return Boolean(sessionStorage.getItem('vp_token'));
  }

  function controlsFor(config) {
    const roots = [findRoot(config), ...(config.extraSelectors || []).map(queryFirst)].filter(Boolean);
    return [...new Set(roots.flatMap(root => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(root.tagName)) return [root];
      return [...root.querySelectorAll('input, select, textarea')];
    }))].filter(input => !input.disabled && input.type !== 'button' && input.type !== 'submit' && input.type !== 'reset');
  }

  function fieldKey(input) {
    return input.id || input.name;
  }

  function serialize(config) {
    const data = {};
    controlsFor(config).forEach(input => {
      const id = fieldKey(input);
      if (!id) return;
      if (input.type === 'file') {
        data[id] = { file_names: [...(input.files || [])].map(file => file.name) };
        return;
      }
      if (input.type === 'checkbox') data[id] = input.checked;
      else if (input.type === 'radio') {
        if (input.checked) data[id] = input.value;
      } else data[id] = input.value;

      if (input.dataset?.addressSelected === '1') {
        data[`${id}__draft_meta`] = {
          addressSelected: input.dataset.addressSelected,
          latitude: input.dataset.latitude,
          longitude: input.dataset.longitude
        };
      }
    });
    return data;
  }

  function restore(config, data) {
    controlsFor(config).forEach(input => {
      const id = fieldKey(input);
      if (!id || data[id] === undefined || input.type === 'file') return;
      if (input.type === 'checkbox') input.checked = Boolean(data[id]);
      else if (input.type === 'radio') input.checked = input.value === data[id];
      else input.value = data[id] ?? '';

      const meta = data[`${id}__draft_meta`];
      if (meta && window.setAddressSelection) {
        window.setAddressSelection(input, input.value, meta.latitude, meta.longitude);
      }
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function hasMeaningfulData(data, config = {}) {
    if (typeof config.hasMeaningfulData === 'function') return config.hasMeaningfulData(data);
    return Object.entries(data).some(([name, value]) => {
      if (name.endsWith('__draft_meta')) return false;
      if (value && typeof value === 'object') return Array.isArray(value.file_names) && value.file_names.length > 0;
      return value !== null && value !== undefined && String(value).trim() !== '';
    });
  }

  function ensureStatus(root) {
    return null;
  }

  function setStatus(session, text, state = '') {
    if (!session.statusEl) return;
    session.statusEl.textContent = text;
    session.statusEl.className = `draft-save-status ${state}`.trim();
  }

  async function save(config, session) {
    if (!isAuthenticated()) return;
    if (!isVisibleElement(session.root)) return;
    const data = serialize(config);
    if (!hasMeaningfulData(data, config)) return;
    setStatus(session, 'Saving...', 'saving');
    try {
      await apiFetch('/api/form-drafts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module_name: config.module,
          form_name: config.form,
          record_id: config.record() || 'new',
          draft_data: data,
          status: 'Active',
          expiry_days: expiryDays
        })
      });
      session.dirty = false;
      session.savedAt = new Date();
      setStatus(session, '', '');
    } catch (error) {
      setStatus(session, 'Draft save failed', 'error');
      console.error('[DraftSession] save failed:', error);
    }
  }

  async function clear(config, status = 'Submitted') {
    if (!isAuthenticated()) return;
    try {
      await apiFetch('/api/form-drafts/status', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          module_name: config.module,
          form_name: config.form,
          record_id: config.record() || 'new',
          status
        })
      });
      const session = sessions.get(key(config));
      if (session) {
        session.dirty = false;
        setStatus(session, '', '');
      }
    } catch (error) {
      console.warn('[DraftSession] clear failed:', error);
    }
  }

  function showRestorePrompt(config, draft) {
    if (document.querySelector('.draft-restore-banner')) return;
    const banner = document.createElement('div');
    banner.className = 'draft-restore-banner';
    banner.innerHTML = `
      <h3 class="draft-restore-title">Unfinished draft found</h3>
      <p class="draft-restore-copy">${config.form} was last saved ${new Date(draft.last_saved_at).toLocaleString()}.</p>
      <div class="draft-restore-actions">
        <button class="btn btn-outline" type="button" data-draft-discard>Discard Draft</button>
        <button class="btn btn-primary" type="button" data-draft-resume>Resume Draft</button>
      </div>
    `;
    document.body.appendChild(banner);
    banner.querySelector('[data-draft-resume]').addEventListener('click', () => {
      restore(config, typeof draft.draft_data_json === 'string' ? JSON.parse(draft.draft_data_json) : draft.draft_data_json);
      banner.remove();
    });
    banner.querySelector('[data-draft-discard]').addEventListener('click', async () => {
      await clear(config, 'Discarded');
      banner.remove();
    });
  }

  async function checkDraft(config) {
    if (!isAuthenticated()) return;
    if (!findRoot(config)) return;
    try {
      const params = new URLSearchParams({
        module_name: config.module,
        form_name: config.form,
        record_id: config.record() || 'new'
      });
      const response = await apiFetch(`/api/form-drafts?${params.toString()}`);
      if (!response?.ok) return;
      const draft = await response.json();
      if (draft?.draft_data_json) {
        const data = typeof draft.draft_data_json === 'string' ? JSON.parse(draft.draft_data_json) : draft.draft_data_json;
        if (!hasMeaningfulData(data, config)) {
          await clear(config, 'Discarded');
          return;
        }
        showRestorePrompt(config, draft);
      }
    } catch (error) {
      console.warn('[DraftSession] draft check failed:', error);
    }
  }

  function wrapClearFunctions(config) {
    (config.clearFns || []).forEach(fnName => {
      const original = window[fnName];
      if (typeof original !== 'function' || original.__draftWrapped) return;
      const wrapped = async function(...args) {
        const result = await original.apply(this, args);
        await clear(config, 'Submitted');
        return result;
      };
      wrapped.__draftWrapped = true;
      window[fnName] = wrapped;
    });
  }

  function register(config) {
    if (!isAuthenticated()) return;
    const root = findRoot(config);
    if (!root) return;
    const id = key(config);
    if (sessions.has(id)) return;
    const session = { config, root, dirty: false, statusEl: ensureStatus(root) };
    sessions.set(id, session);
    controlsFor(config).forEach(input => {
      input.addEventListener('input', () => { session.dirty = true; });
      input.addEventListener('change', () => { session.dirty = true; });
    });
    wrapClearFunctions(config);
    checkDraft(config);
    session.timer = setInterval(() => {
      if (document.body.contains(root)) save(config, session);
      else clearInterval(session.timer);
    }, intervalMs);
  }

  function scan() {
    if (!isAuthenticated()) return;
    configs.forEach(register);
  }

  function hasDirtySessions() {
    return [...sessions.values()].some(session => session.dirty);
  }

  window.addEventListener('beforeunload', event => {
    if (!hasDirtySessions()) return;
    event.preventDefault();
    event.returnValue = '';
  });

  document.addEventListener('DOMContentLoaded', scan);
  document.addEventListener('partialsLoaded', scan);
  document.addEventListener('click', () => setTimeout(scan, 250));
  setInterval(scan, 4000);

  return { scan, clear };
})();

window.DraftSession = DraftSession;
