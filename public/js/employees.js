/* ============================================================
   EMPLOYEES.JS — Employee list filtering & search
   ============================================================ */

let EMPLOYEES = []; // Will be populated from API
let EMPLOYEES_RAW = []; // Store raw API data for editing
let wageTypesForPayroll = [];
let EMPLOYEE_DIRECTORY_PAGE = 1;
const EMPLOYEE_DIRECTORY_PAGE_SIZE = 10;
const EMPLOYMENT_STATUS_OPTIONS = ['Active', 'Inactive', 'Resigned', 'Terminated', 'End of Contract', 'Suspended', 'Retired', 'Offboarded', 'Rehired'];
const OFFBOARDING_DETAIL_STATUSES = new Set(['Inactive', 'Resigned', 'Terminated', 'End of Contract', 'Suspended', 'Retired', 'Offboarded']);
const REONBOARDABLE_STATUSES = new Set(['Resigned', 'Terminated', 'End of Contract', 'Retired', 'Offboarded']);
const ORG_SETUP_DEFAULT_PAGE_SIZE = 10;
const ORG_SETUP_PAGINATION = {
  departments: 1,
  positions: 1
};
const EMPLOYEE_PHOTO_URLS = new Map();

function normalizeWageTypeName(value) {
  const name = String(value || '').trim();
  if (/piece/i.test(name)) return 'Per-Piece';
  if (/trip|logistics/i.test(name)) return 'Per-Trip';
  if (/hour/i.test(name)) return 'Hourly';
  if (/day|daily/i.test(name)) return 'Daily';
  if (/base|salary/i.test(name)) return 'Base Salary';
  return name;
}

function getPayrollWageTypeNameById(id) {
  const selected = wageTypesForPayroll.find(item => String(item.id) === String(id));
  return selected ? normalizeWageTypeName(selected.name) : '';
}

function getPayrollWageTypeIdByName(name) {
  const normalized = normalizeWageTypeName(name);
  const selected = wageTypesForPayroll.find(item => normalizeWageTypeName(item.name) === normalized);
  return selected ? String(selected.id) : '';
}

function isPayrollWageType(idOrName, target) {
  const name = getPayrollWageTypeNameById(idOrName) || normalizeWageTypeName(idOrName);
  return normalizeWageTypeName(name) === target;
}

function usesPayrollBaseRate(idOrName) {
  return isPayrollWageType(idOrName, 'Daily') || isPayrollWageType(idOrName, 'Hourly');
}

function statusClassName(status) {
  return String(status || 'Active').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function statusBadgeText(status) {
  return EMPLOYMENT_STATUS_OPTIONS.includes(status) ? status : 'Active';
}

function toggleProfileOffboardingFields() {
  const status = document.getElementById('profile-edit-status')?.value || 'Active';
  const fields = document.getElementById('profile-edit-offboarding-fields');
  if (fields) fields.style.display = OFFBOARDING_DETAIL_STATUSES.has(status) ? 'grid' : 'none';
}

function setPayrollBaseRateVisibility(wageTypeId, prefix = 'emp-payroll') {
  const input = document.getElementById(`${prefix}-primary-rate`);
  if (!input) return;
  const wrapper = input.closest('div');
  const shouldShow = usesPayrollBaseRate(wageTypeId);
  if (wrapper) wrapper.style.display = shouldShow ? '' : 'none';
  input.required = shouldShow;
  if (!shouldShow) input.value = '';
}

function setEditPayrollBaseRateVisibility(wageTypeId) {
  const input = document.getElementById('edit-payroll-rate');
  if (!input) return;
  const wrapper = input.closest('div');
  const shouldShow = usesPayrollBaseRate(wageTypeId);
  if (wrapper) wrapper.style.display = shouldShow ? '' : 'none';
  input.required = shouldShow;
  if (!shouldShow) input.value = '';
}

function populatePayrollWageTypeSelects() {
  if (!wageTypesForPayroll.length) return;
  ['edit-payroll-wage-type', 'emp-payroll-wage-select', 'payroll-config-wage-select'].forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    const selected = select.value;
    select.innerHTML = '<option value="">- Select wage type -</option>' + wageTypesForPayroll
      .map(type => `<option value="${type.id}">${employeeSetupEscape(normalizeWageTypeName(type.name))}</option>`)
      .join('');
    if (selected && wageTypesForPayroll.some(type => String(type.id) === String(selected))) {
      select.value = selected;
    }
  });
}

function employeeSetupEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  }[char]));
}

function employeeActionDotsIcon() {
  if (typeof window.renderActionDotsIcon === 'function') return window.renderActionDotsIcon();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="action-dots-icon bi bi-three-dots-vertical" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0"/>
  </svg>`;
}

async function refreshEmployeeSetupUI() {
  if (typeof loadEmployeePositionOptions !== 'function') return;
  await loadEmployeePositionOptions();
  renderEmployeeDepartmentFilter();
  renderEmployeeSetupPositionDepartmentSelect();
  renderEmployeeSetupRows();
  loadEmployeeIdConfigForSetup();
  if (typeof initializeEmployeePositionDropdowns === 'function') {
    initializeEmployeePositionDropdowns();
  }
}

async function loadEmployeeIdConfigForSetup() {
  const prefixInput = document.getElementById('emp-code-prefix-config');
  if (!prefixInput || prefixInput.dataset.loaded === '1') return;

  try {
    const response = await apiFetch('/api/employees/id-config');
    if (!response?.ok) throw new Error('Unable to load employee ID configuration.');
    const config = await response.json();
    prefixInput.value = config.prefix || 'EMP';
    document.getElementById('emp-code-start-config').value = config.starting_number ?? 1;
    document.getElementById('emp-code-padding-config').value = config.number_padding ?? 6;
    document.getElementById('emp-code-sequence-config').value = config.current_sequence ?? 0;
    document.getElementById('emp-code-auto-config').value = String(Number(config.auto_generate_enabled ?? 1));
    prefixInput.dataset.loaded = '1';
  } catch (error) {
    console.error('Employee ID config load error:', error);
  }
}

async function saveEmployeeIdConfig(event) {
  event.preventDefault();
  const payload = {
    prefix: document.getElementById('emp-code-prefix-config')?.value || 'EMP',
    starting_number: Number(document.getElementById('emp-code-start-config')?.value || 1),
    number_padding: Number(document.getElementById('emp-code-padding-config')?.value || 6),
    current_sequence: Number(document.getElementById('emp-code-sequence-config')?.value || 0),
    auto_generate_enabled: document.getElementById('emp-code-auto-config')?.value || '1'
  };

  const response = await apiFetch('/api/employees/id-config', {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return showAlert?.(data.error || 'Failed to save Employee ID configuration.', 'Error', 'error') || alert(data.error || 'Failed to save Employee ID configuration.');
  }

  document.getElementById('emp-code-prefix-config').dataset.loaded = '';
  await loadEmployeeIdConfigForSetup();
  await showAlert?.(data.message || 'Employee ID configuration saved.', 'Saved', 'success');
}

function renderEmployeeDepartmentFilter() {
  const select = document.querySelector('.filter-bar select#emp-dept');
  if (!select || typeof getEmployeeDepartments !== 'function') return;
  const selected = select.value;
  const departments = getEmployeeDepartments();
  select.innerHTML = '<option>All Departments</option>' + departments
    .map(department => `<option>${employeeSetupEscape(department.name)}</option>`)
    .join('');
  if (selected && (selected === 'All Departments' || departments.some(department => department.name === selected))) {
    select.value = selected;
  }
}

function renderEmployeeSetupPositionDepartmentSelect() {
  const select = document.getElementById('setup-position-department');
  if (!select || typeof getEmployeeDepartments !== 'function') return;
  const selected = select.value;
  const departments = getEmployeeDepartments();
  select.innerHTML = '<option value="">Select department</option>' + departments
    .map(department => `<option value="${department.id}">${employeeSetupEscape(department.name)}</option>`)
    .join('');
  if (selected && departments.some(department => String(department.id) === String(selected))) {
    select.value = selected;
  }
}

function renderOrganizationSetupPositionDepartmentFilter() {
  const select = document.getElementById('org-setup-position-department-filter');
  if (!select || typeof getEmployeeDepartments !== 'function') return;
  const selected = select.value;
  const departments = getEmployeeDepartments();
  select.innerHTML = '<option value="">All Departments</option>' + departments
    .map(department => `<option value="${department.id}">${employeeSetupEscape(department.name)}</option>`)
    .join('');
  if (selected && departments.some(department => String(department.id) === String(selected))) {
    select.value = selected;
  }
}

function getOrganizationSetupPositionFilters() {
  return {
    search: String(document.getElementById('org-setup-position-search')?.value || '').trim().toLowerCase(),
    departmentId: String(document.getElementById('org-setup-position-department-filter')?.value || ''),
    status: String(document.getElementById('org-setup-position-status-filter')?.value || '').toLowerCase()
  };
}

function filterOrganizationSetupPositions(positions) {
  const filters = getOrganizationSetupPositionFilters();
  return positions.filter(position => {
    const isActive = Number(position.is_active ?? 1) === 1;
    if (filters.departmentId && String(position.department_id) !== filters.departmentId) return false;
    if (filters.status === 'active' && !isActive) return false;
    if (filters.status === 'inactive' && isActive) return false;
    if (filters.search) {
      const haystack = `${position.name || ''} ${position.department || ''}`.toLowerCase();
      if (!haystack.includes(filters.search)) return false;
    }
    return true;
  });
}

function getOrganizationSetupPageSize(type) {
  if (type !== 'positions') return ORG_SETUP_DEFAULT_PAGE_SIZE;
  const value = Number(document.getElementById('org-setup-position-page-size')?.value || ORG_SETUP_DEFAULT_PAGE_SIZE);
  return Number.isFinite(value) && value > 0 ? value : ORG_SETUP_DEFAULT_PAGE_SIZE;
}

function applyOrganizationSetupPositionFilters() {
  ORG_SETUP_PAGINATION.positions = 1;
  renderEmployeeSetupRows();
}

function resetOrganizationSetupPositionFilters() {
  const search = document.getElementById('org-setup-position-search');
  const department = document.getElementById('org-setup-position-department-filter');
  const status = document.getElementById('org-setup-position-status-filter');
  const pageSize = document.getElementById('org-setup-position-page-size');
  if (search) search.value = '';
  if (department) department.value = '';
  if (status) status.value = '';
  if (pageSize) pageSize.value = String(ORG_SETUP_DEFAULT_PAGE_SIZE);
  applyOrganizationSetupPositionFilters();
}

function renderEmployeeSetupRows() {
  const departmentBody = document.getElementById('org-setup-departments-tbody');
  const positionBody = document.getElementById('org-setup-positions-tbody');
  if (!departmentBody || !positionBody || typeof getEmployeeDepartments !== 'function' || typeof getEmployeePositions !== 'function') return;
  const departments = getEmployeeDepartments();
  const positions = getEmployeePositions();
  renderOrganizationSetupPositionDepartmentFilter();
  const positionCountByDepartment = new Map();
  positions.forEach(position => {
    const key = Number(position.department_id);
    positionCountByDepartment.set(key, (positionCountByDepartment.get(key) || 0) + 1);
  });

  const departmentPage = getOrganizationSetupPaginationMeta('departments', departments.length);
  const pagedDepartments = departments.slice(departmentPage.startIndex, departmentPage.endIndex);

  departmentBody.innerHTML = pagedDepartments.length
    ? pagedDepartments.map(department => `
        <tr>
          <td>${employeeSetupEscape(department.name)}</td>
          <td>${positionCountByDepartment.get(Number(department.id)) || 0}</td>
          <td><span class="org-setup-status active">Active</span></td>
          <td>
            <div class="org-setup-row-actions">
              <button class="btn btn-outline" type="button" onclick="editEmployeeSetupDepartment(${department.id})">Edit</button>
              <button class="btn btn-outline" type="button" onclick="deleteEmployeeSetupDepartment(${department.id})">Deactivate</button>
            </div>
          </td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" class="table-empty">No departments configured.</td></tr>';
  renderOrganizationSetupPagination('departments', departmentPage, departments.length, 'departments');

  const filteredPositions = filterOrganizationSetupPositions(positions);
  const sortedPositions = [...filteredPositions].sort((a, b) => {
    const departmentCompare = String(a.department || '').localeCompare(String(b.department || ''));
    return departmentCompare || String(a.name || '').localeCompare(String(b.name || ''));
  });

  const positionPage = getOrganizationSetupPaginationMeta('positions', sortedPositions.length);
  const pagedPositions = sortedPositions.slice(positionPage.startIndex, positionPage.endIndex);

  positionBody.innerHTML = pagedPositions.length
    ? pagedPositions.map(position => `
        <tr>
          <td>${employeeSetupEscape(position.department || '—')}</td>
          <td>${employeeSetupEscape(position.name)}</td>
          <td><span class="org-setup-status ${Number(position.is_active ?? 1) === 1 ? 'active' : ''}">${Number(position.is_active ?? 1) === 1 ? 'Active' : 'Inactive'}</span></td>
          <td>
            <div class="org-setup-row-actions">
              <button class="btn btn-outline" type="button" onclick="editEmployeeSetupPosition(${position.id})">Edit</button>
              <button class="btn btn-outline" type="button" onclick="deleteEmployeeSetupPosition(${position.id})">Deactivate</button>
            </div>
          </td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" class="table-empty">No positions match the selected filters.</td></tr>';
  renderOrganizationSetupPagination('positions', positionPage, sortedPositions.length, 'positions');
}

function getOrganizationSetupPaginationMeta(type, totalItems) {
  const pageSize = getOrganizationSetupPageSize(type);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  ORG_SETUP_PAGINATION[type] = Math.min(Math.max(ORG_SETUP_PAGINATION[type] || 1, 1), totalPages);
  const currentPage = ORG_SETUP_PAGINATION[type];
  const startIndex = (currentPage - 1) * pageSize;
  const endIndex = Math.min(startIndex + pageSize, totalItems);
  return { currentPage, totalPages, startIndex, endIndex };
}

function renderOrganizationSetupPagination(type, meta, totalItems, label) {
  const info = document.getElementById(`org-setup-${type}-info`);
  const page = document.getElementById(`org-setup-${type}-page`);
  const previousButton = document.getElementById(`org-setup-${type}-prev`);
  const nextButton = document.getElementById(`org-setup-${type}-next`);

  const from = totalItems ? meta.startIndex + 1 : 0;
  const to = totalItems ? meta.endIndex : 0;

  if (info) info.textContent = `Showing ${from} to ${to} of ${totalItems} ${label}`;
  if (page) page.textContent = `Page ${meta.currentPage} of ${meta.totalPages}`;
  if (previousButton) previousButton.disabled = meta.currentPage <= 1;
  if (nextButton) nextButton.disabled = meta.currentPage >= meta.totalPages;
}

function changeOrganizationSetupPage(type, direction) {
  if (!ORG_SETUP_PAGINATION[type]) ORG_SETUP_PAGINATION[type] = 1;
  ORG_SETUP_PAGINATION[type] += direction;
  renderEmployeeSetupRows();
}

async function saveEmployeeSetupDepartment(event) {
  event.preventDefault();
  const input = document.getElementById('setup-department-name');
  const name = input?.value.trim();
  if (!name) return showAlert?.('Department name is required.', 'Validation Error', 'warning') || alert('Department name is required.');

  const response = await apiFetch('/api/employee-setup/departments', {
    method: 'POST',
    body: JSON.stringify({ name })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showAlert?.(data.error || 'Failed to save department.', 'Error', 'error') || alert(data.error || 'Failed to save department.');

  input.value = '';
  if (window.EMPLOYEE_POSITION_OPTIONS_PROMISE) window.EMPLOYEE_POSITION_OPTIONS_PROMISE = null;
  await resetEmployeeSetupLookupCache();
  await refreshEmployeeSetupUI();
  await showAlert?.(data.message || 'Department saved.', 'Saved', 'success');
}

async function saveEmployeeSetupPosition(event) {
  event.preventDefault();
  const departmentSelect = document.getElementById('setup-position-department');
  const nameInput = document.getElementById('setup-position-name');
  const department_id = departmentSelect?.value;
  const name = nameInput?.value.trim();
  if (!department_id) return showAlert?.('Please select a department.', 'Validation Error', 'warning') || alert('Please select a department.');
  if (!name) return showAlert?.('Position / job title is required.', 'Validation Error', 'warning') || alert('Position / job title is required.');

  const response = await apiFetch('/api/employee-setup/positions', {
    method: 'POST',
    body: JSON.stringify({ department_id, name })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showAlert?.(data.error || 'Failed to save position.', 'Error', 'error') || alert(data.error || 'Failed to save position.');

  nameInput.value = '';
  await resetEmployeeSetupLookupCache();
  await refreshEmployeeSetupUI();
  await showAlert?.(data.message || 'Position saved.', 'Saved', 'success');
}

async function resetEmployeeSetupLookupCache() {
  if (typeof window.resetEmployeePositionOptions === 'function') {
    window.resetEmployeePositionOptions();
  }
  if (typeof loadEmployeePositionOptions === 'function') {
    await loadEmployeePositionOptions();
  }
}

async function employeeSetupConfirm(message) {
  if (typeof showConfirm === 'function') return showConfirm(message);
  return confirm(message);
}

async function editEmployeeSetupDepartment(departmentId) {
  const department = getEmployeeDepartments?.().find(item => Number(item.id) === Number(departmentId));
  if (!department) return;
  const name = prompt('Edit department name:', department.name);
  if (name === null) return;
  const cleanName = name.trim();
  if (!cleanName) return showAlert?.('Department name is required.', 'Validation Error', 'warning') || alert('Department name is required.');

  const response = await apiFetch(`/api/employee-setup/departments/${departmentId}`, {
    method: 'PUT',
    body: JSON.stringify({ name: cleanName })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showAlert?.(data.error || 'Failed to update department.', 'Error', 'error') || alert(data.error || 'Failed to update department.');
  await resetEmployeeSetupLookupCache();
  await refreshEmployeeSetupUI();
  await showAlert?.(data.message || 'Department updated.', 'Saved', 'success');
}

async function deleteEmployeeSetupDepartment(departmentId) {
  const department = getEmployeeDepartments?.().find(item => Number(item.id) === Number(departmentId));
  if (!department) return;
  const ok = await employeeSetupConfirm(`Remove "${department.name}" from active dropdowns? Existing employees will keep their current department.`);
  if (!ok) return;

  const response = await apiFetch(`/api/employee-setup/departments/${departmentId}`, { method: 'DELETE' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showAlert?.(data.error || 'Failed to remove department.', 'Error', 'error') || alert(data.error || 'Failed to remove department.');
  await resetEmployeeSetupLookupCache();
  await refreshEmployeeSetupUI();
  await showAlert?.(data.message || 'Department removed.', 'Saved', 'success');
}

async function editEmployeeSetupPosition(positionId) {
  const position = getEmployeePositions?.().find(item => Number(item.id) === Number(positionId));
  if (!position) return;
  const name = prompt('Edit position / job title:', position.name);
  if (name === null) return;
  const cleanName = name.trim();
  if (!cleanName) return showAlert?.('Position / job title is required.', 'Validation Error', 'warning') || alert('Position / job title is required.');

  const response = await apiFetch(`/api/employee-setup/positions/${positionId}`, {
    method: 'PUT',
    body: JSON.stringify({ department_id: position.department_id, name: cleanName })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showAlert?.(data.error || 'Failed to update position.', 'Error', 'error') || alert(data.error || 'Failed to update position.');
  await resetEmployeeSetupLookupCache();
  await refreshEmployeeSetupUI();
  await showAlert?.(data.message || 'Position updated.', 'Saved', 'success');
}

async function deleteEmployeeSetupPosition(positionId) {
  const position = getEmployeePositions?.().find(item => Number(item.id) === Number(positionId));
  if (!position) return;
  const ok = await employeeSetupConfirm(`Remove "${position.name}" from active dropdowns? Existing employees will keep their current job title.`);
  if (!ok) return;

  const response = await apiFetch(`/api/employee-setup/positions/${positionId}`, { method: 'DELETE' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return showAlert?.(data.error || 'Failed to remove position.', 'Error', 'error') || alert(data.error || 'Failed to remove position.');
  await resetEmployeeSetupLookupCache();
  await refreshEmployeeSetupUI();
  await showAlert?.(data.message || 'Position removed.', 'Saved', 'success');
}

async function fetchEmployees() {
  try {
    console.log('📡 Fetching employees from API...');
    const response = await apiFetch('/api/employees?status=all');
    if (!response) {
      console.error('❌ No response from API (401 logout triggered?)');
      return;
    }
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(`HTTP ${response.status}: ${errorData.error || response.statusText}`);
    }
    
    const data = await response.json();
    console.log('✅ API returned', data.length, 'employees');
    
    if (!data || data.length === 0) {
      console.warn('⚠️  API returned empty employee list');
      EMPLOYEES = [];
      EMPLOYEES_RAW = [];
      renderEmployees([]);
      return [];
    }
    
    EMPLOYEES_RAW = data; // Store raw data for editing
    
    EMPLOYEES = data.map(e => {
      // Extract city from residential_address (first part before comma)
      const cityFromAddress = e.residential_address ? e.residential_address.split(',')[0].trim() : '—';
      
      return {
        id: e.id, // Numeric database ID for API calls
        empCode: e.employee_code || '—', // Employee code (EMP00011) for display
        name: `${e.first_name || ''} ${e.last_name || ''}`.trim() || 'Unknown',
        initials: `${(e.first_name || 'U')[0]}${(e.last_name || 'K')[0]}`.toUpperCase(),
        gradient: 'linear-gradient(135deg,#4f7cff,#22d3a5)', // Default gradient
        email: e.email || 'no-email@company.com',
        phone: e.contact_number || '—',
        city: cityFromAddress,
        dept: e.department || '—',
        position: e.position || '—',
        supervisor: e.supervisor || '—',
        status: e.status || 'Active',
        // Store raw data ref for editing
        _raw: e
      };
    });
    
    console.log('✅ Fetched', EMPLOYEES.length, 'employees from API');
    console.log('📊 First employee:', EMPLOYEES[0]);
    console.log('📊 API raw data first employee:', EMPLOYEES_RAW[0]);
    
    renderEmployees(EMPLOYEES);
    return EMPLOYEES; // Return the fetched data
  } catch (error) {
    console.error('❌ Error fetching employees:', error.message);
    // Do NOT use fallback data - show error instead
    EMPLOYEES = [];
    EMPLOYEES_RAW = [];
    
    const message = error.message.includes('HTTP 401')
      ? 'Session expired. Please log in again.'
      : error.message;
    const tbody = document.getElementById('emp-tbody');
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" style="padding:32px;text-align:center;color:#ff6b6b;">
            <div style="font-size:18px;font-weight:600;margin-bottom:8px;">Failed to Load Employees</div>
            <div style="font-size:14px;color:var(--muted);">${employeeSetupEscape(message)}</div>
            <button onclick="location.reload()" style="margin-top:16px;padding:8px 16px;background:#4f7cff;color:white;border:none;border-radius:4px;cursor:pointer;">Retry</button>
          </td>
        </tr>
      `;
    }
    const countEl = document.getElementById('emp-count');
    if (countEl) countEl.textContent = 'Unable to load employees';
    
    return [];
  }
}

function renderEmployees(list) {
  const tbody = document.getElementById('emp-tbody');
  if (!tbody) return;

  const totalEmployees = list.length;
  const totalPages = Math.max(1, Math.ceil(totalEmployees / EMPLOYEE_DIRECTORY_PAGE_SIZE));
  EMPLOYEE_DIRECTORY_PAGE = Math.min(Math.max(EMPLOYEE_DIRECTORY_PAGE, 1), totalPages);
  const startIndex = (EMPLOYEE_DIRECTORY_PAGE - 1) * EMPLOYEE_DIRECTORY_PAGE_SIZE;
  const endIndex = Math.min(startIndex + EMPLOYEE_DIRECTORY_PAGE_SIZE, totalEmployees);
  const pageEmployees = list.slice(startIndex, endIndex);
  
  const renderedRows = pageEmployees.map(e => {
    const employeeId = Number(e.id);
    const employmentStatus = statusBadgeText(e.status);
    const employmentStatusClass = statusClassName(employmentStatus);
    const statusMenuItems = EMPLOYMENT_STATUS_OPTIONS.map(option => `
            <button class="emp-menu-item status-${statusClassName(option)}" type="button" onclick="setEmployeeStatus('${employeeId}', '${option}')" ${employmentStatus === option ? 'disabled' : ''}>Mark ${option}</button>
    `).join('');
    const pendingOffboardingId = e._raw?.pending_offboarding_request_id;
    const pendingReonboardingId = e._raw?.pending_reonboarding_request_id;
    const lifecycleAction = pendingOffboardingId
      ? `<button class="emp-menu-item" type="button" onclick="viewLifecycleRequest('${employeeId}', 'offboarding')">View Offboarding Request</button>`
      : pendingReonboardingId
        ? `<button class="emp-menu-item" type="button" onclick="viewLifecycleRequest('${employeeId}', 'reonboarding')">View Re-onboarding Request</button>`
        : employmentStatus === 'Active'
          ? `<button class="emp-menu-item deactivate" type="button" onclick="openOffboardingDrawer('${employeeId}')">Offboard Employee</button>`
          : REONBOARDABLE_STATUSES.has(employmentStatus)
            ? `<button class="emp-menu-item activate" type="button" onclick="openReonboardingDrawer('${employeeId}')">Re-onboard Employee</button>`
            : '';
    const statusClass = e.status === 'Active' ? 'active' : 'inactive';
    const statusDisplay = e.status === 'Active' ? '✓ Active' : '✗ Inactive';
    
    return `
    <tr onclick="openEmployeeProfile('${employeeId}', 'personal')" style="cursor:pointer;" data-emp-id="${employeeId}">
      <td class="emp-id">${escapeHtml(e.empCode)}</td>
      <td class="emp-name">
        <div class="employee-directory-person">
          <span class="employee-directory-avatar" data-employee-photo="${employeeId}" data-initials="${escapeHtml(e.initials)}">${escapeHtml(e.initials)}</span>
          <span>${escapeHtml(e.name)}</span>
        </div>
      </td>
      <td class="emp-email">${escapeHtml(e.email)}</td>
      <td>${escapeHtml(e.phone)}</td>
      <td>${escapeHtml(e.city)}</td>
      <td>${escapeHtml(e.dept)}</td>
      <td>${escapeHtml(e.position)}</td>
      <td>${escapeHtml(e.supervisor)}</td>
      <td><span class="emp-status ${employmentStatusClass}">${escapeHtml(employmentStatus)}</span></td>
      <td class="emp-action" onclick="event.stopPropagation();">
        <div class="emp-action-menu">
          <button class="emp-action-trigger action-dots-button" type="button" title="Employee actions" aria-label="Employee actions" onclick="toggleEmployeeActionMenu(event, '${employeeId}')">${employeeActionDotsIcon()}</button>
          <div class="emp-action-dropdown" id="emp-action-menu-${employeeId}">
            <button class="emp-menu-item" type="button" onclick="openEmployeeProfile('${employeeId}', 'personal')">View Profile</button>
            ${lifecycleAction ? `<div class="emp-menu-section">Lifecycle</div>${lifecycleAction}` : ''}
            <div class="emp-menu-section">Status</div>
            ${statusMenuItems}
          </div>
        </div>
      </td>
    </tr>
  `;
  }).join('');
  
  tbody.innerHTML = renderedRows || '<tr><td colspan="10" style="text-align:center;color:var(--muted);padding:24px;">No employees found.</td></tr>';
  hydrateEmployeeDirectoryPhotos(tbody);
  
  console.log('✅ Rendered', list.length, 'employees in table');
  if (list.length > 0) {
    console.log('📊 First employee:', {
      name: list[0].name,
      id: list[0].id,
      empCode: list[0].empCode,
      email: list[0].email,
      dept: list[0].dept
    });
  }

  const countEl = document.getElementById('emp-count');
  if (countEl) countEl.textContent = totalEmployees
    ? `Showing ${startIndex + 1}-${endIndex} of ${totalEmployees} employees`
    : 'Showing 0 employees';
  updateEmployeeDirectoryPagination(totalEmployees, startIndex, endIndex, totalPages);
}

function applyEmployeeDirectoryPhoto(element, url) {
  if (!element || !url) return;
  const image = document.createElement('img');
  image.src = url;
  image.alt = 'Employee profile picture';
  element.replaceChildren(image);
}

async function hydrateEmployeeDirectoryPhoto(element) {
  const employeeId = Number(element?.dataset.employeePhoto || 0);
  if (!employeeId) return;
  if (EMPLOYEE_PHOTO_URLS.has(employeeId)) {
    applyEmployeeDirectoryPhoto(element, EMPLOYEE_PHOTO_URLS.get(employeeId));
    return;
  }
  try {
    const response = await apiFetch(`/api/employees/${employeeId}/photo`);
    if (!response?.ok) return;
    const url = URL.createObjectURL(await response.blob());
    EMPLOYEE_PHOTO_URLS.set(employeeId, url);
    applyEmployeeDirectoryPhoto(element, url);
  } catch (_error) {
    element.textContent = element.dataset.initials || '--';
  }
}

function hydrateEmployeeDirectoryPhotos(root = document) {
  root.querySelectorAll('[data-employee-photo]').forEach(hydrateEmployeeDirectoryPhoto);
}

function invalidateEmployeePhoto(employeeId) {
  const id = Number(employeeId || 0);
  const oldUrl = EMPLOYEE_PHOTO_URLS.get(id);
  if (oldUrl) URL.revokeObjectURL(oldUrl);
  EMPLOYEE_PHOTO_URLS.delete(id);
  document.querySelectorAll(`[data-employee-photo="${id}"]`).forEach(element => {
    element.textContent = element.dataset.initials || '--';
    hydrateEmployeeDirectoryPhoto(element);
  });
}

function updateEmployeeDirectoryPagination(totalEmployees, startIndex, endIndex, totalPages) {
  const pagination = document.getElementById('employee-directory-pagination');
  const info = document.getElementById('employee-directory-page-info');
  const label = document.getElementById('employee-directory-page-label');
  const prev = document.getElementById('employee-directory-prev');
  const next = document.getElementById('employee-directory-next');
  if (!pagination || !info || !label || !prev || !next) return;

  pagination.style.display = totalEmployees > EMPLOYEE_DIRECTORY_PAGE_SIZE ? '' : 'none';
  info.textContent = totalEmployees
    ? `Showing ${startIndex + 1}-${endIndex} of ${totalEmployees} employees`
    : 'Showing 0 employees';
  label.textContent = `Page ${EMPLOYEE_DIRECTORY_PAGE} of ${totalPages}`;
  prev.disabled = EMPLOYEE_DIRECTORY_PAGE <= 1;
  next.disabled = EMPLOYEE_DIRECTORY_PAGE >= totalPages;
}

function getFilteredEmployeeList() {
  const search = document.getElementById('emp-search')?.value.toLowerCase() || '';
  const status = document.getElementById('emp-status')?.value || '';
  const dept = document.getElementById('emp-dept')?.value || '';

  return EMPLOYEES.filter(e => {
    const matchSearch = e.name.toLowerCase().includes(search) || e.email.toLowerCase().includes(search);
    const matchStatus = !status || status === 'All Status' || e.status === status;
    const matchDept = !dept || dept === 'All Departments' || e.dept === dept;
    return matchSearch && matchStatus && matchDept;
  });
}

function changeEmployeeDirectoryPage(direction) {
  const filtered = getFilteredEmployeeList();
  const totalPages = Math.max(1, Math.ceil(filtered.length / EMPLOYEE_DIRECTORY_PAGE_SIZE));
  EMPLOYEE_DIRECTORY_PAGE = Math.min(Math.max(EMPLOYEE_DIRECTORY_PAGE + direction, 1), totalPages);
  renderEmployees(filtered);
}

function bindEmployeeDirectoryPagination() {
  const prev = document.getElementById('employee-directory-prev');
  const next = document.getElementById('employee-directory-next');
  if (prev && prev.dataset.bound !== '1') {
    prev.addEventListener('click', () => changeEmployeeDirectoryPage(-1));
    prev.dataset.bound = '1';
  }
  if (next && next.dataset.bound !== '1') {
    next.addEventListener('click', () => changeEmployeeDirectoryPage(1));
    next.dataset.bound = '1';
  }
}

function closeEmployeeActionMenus() {
  document.querySelectorAll('.emp-action-dropdown.open').forEach(menu => {
    menu.classList.remove('open');
    menu.style.top = '';
    menu.style.left = '';
    menu.style.right = '';
  });
  document.querySelectorAll('.emp-action-trigger.active').forEach(button => {
    button.classList.remove('active');
  });
}

function toggleEmployeeActionMenu(event, employeeId) {
  event.stopPropagation();
  const menu = document.getElementById(`emp-action-menu-${employeeId}`);
  const trigger = event.currentTarget;
  const isOpen = menu?.classList.contains('open');

  closeEmployeeActionMenus();

  if (menu && !isOpen) {
    const rect = trigger.getBoundingClientRect();
    menu.classList.add('open');
    const menuHeight = menu.offsetHeight;
    const menuWidth = menu.offsetWidth;
    const preferredTop = rect.bottom + 8;
    const top = preferredTop + menuHeight > window.innerHeight
      ? Math.max(12, rect.top - menuHeight - 8)
      : preferredTop;
    menu.style.top = `${top}px`;
    menu.style.left = `${Math.max(12, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 12))}px`;
    menu.style.right = 'auto';
    trigger.classList.add('active');
  }
}

document.addEventListener('click', closeEmployeeActionMenus);

function openEmployeeDetail(employeeId) {
  const employee = EMPLOYEES_RAW.find(e => e.employee_code === employeeId);
  if (!employee) return;

  // Clear all previous edit mode flags
  window.IS_EDITING = false;
  window.PENDING_EDIT_MODE = false;
  sessionStorage.removeItem('editEmployee');
  
  // Store employee data in sessionStorage for the register form to access
  sessionStorage.setItem('editEmployee', JSON.stringify(employee));
  
  // Set edit mode flags
  window.PENDING_EDIT_MODE = true;
  window.IS_EDITING = true;

  // Navigate to register page using the navigate function from app.js
  navigate('register', null);
  
  // Wait for page to load, then switch to form view
  setTimeout(() => {
    console.log('Switching to form view...');
    if (typeof switchRegisterView === 'function') {
      switchRegisterView('add');
    }
  }, 100);
}

function prefillEmployeeForm(employee) {
  console.log('Prefilling form with employee data:', employee);
  
  // Set EDIT_MODE when prefilling with existing employee data
  if (typeof resetEditMode !== 'function') {
    // Manual fallback if resetEditMode is not available
    window.EDIT_MODE = true;
    window.EDIT_EMPLOYEE_ID = employee.id || employee.employee_code;
  } else {
    // Use the global function to set edit mode - but we need to set it to true
    // Actually, resetEditMode sets it to false, so we need to do this differently
    window.EDIT_MODE = true;
    window.EDIT_EMPLOYEE_ID = employee.id || employee.employee_code;
  }
  
  // Ensure Personal Info tab is active
  const tabs = document.querySelectorAll('.form-tab');
  tabs.forEach(tab => tab.classList.remove('active'));
  if (tabs.length > 0) tabs[0].classList.add('active');
  
  // Show Personal Info section, hide others
  const formPersonal = document.getElementById('form-personal');
  if (!formPersonal) {
    console.error('Form sections not found');
    return;
  }
  
  formPersonal.style.display = 'block';
  const formEmployment = document.getElementById('form-employment');
  const formPayroll = document.getElementById('form-payroll');
  const formDocuments = document.getElementById('form-documents');
  
  if (formEmployment) formEmployment.style.display = 'none';
  if (formPayroll) formPayroll.style.display = 'none';
  if (formDocuments) formDocuments.style.display = 'none';

  // Fill form fields with employee data using the new IDs
  const empId = document.getElementById('emp-id');
  const empFirstName = document.getElementById('emp-first-name');
  const empLastName = document.getElementById('emp-last-name');
  const empContact = document.getElementById('emp-contact');
  const empEmail = document.getElementById('emp-email');
  
  if (empId) {
    empId.value = employee.employee_code || '';
    empId.readOnly = true;
  }
  if (empFirstName) empFirstName.value = employee.first_name || '';
  
  const empMiddleName = document.getElementById('emp-middle-name');
  if (empMiddleName) empMiddleName.value = employee.middle_name || '';
  
  if (empLastName) empLastName.value = employee.last_name || '';
  if (empContact) empContact.value = employee.contact_number || '';
  if (empEmail) empEmail.value = employee.email || '';
  
  const empAddress = document.getElementById('emp-address');
  if (empAddress) empAddress.value = employee.residential_address || '';
  
  const empNationality = document.getElementById('emp-nationality');
  if (empNationality) empNationality.value = employee.nationality || 'Filipino';
  
  const empGender = document.getElementById('emp-gender');
  if (empGender) empGender.value = employee.gender || 'Male';
  
  const empDob = document.getElementById('emp-dob');
  if (empDob) empDob.value = employee.date_of_birth || '';
  
  // Employment details - use specific selectors for form fields
  const empDept = document.querySelector('#form-employment select#emp-dept');
  if (empDept) empDept.value = employee.department || 'HR';
  
  if (typeof bindDepartmentPositionDropdown === 'function') {
    bindDepartmentPositionDropdown('emp-dept', 'emp-position', employee.position || '');
  }
  
  const empType = document.querySelector('#form-employment select#emp-type');
  if (empType) empType.value = employee.employment_type || 'Full-time';

  const empHiringType = document.querySelector('#form-employment select#emp-hiring-type');
  if (empHiringType) empHiringType.value = employee.hiring_type || 'Direct Hire';
  if (typeof toggleEmployeeAgencyFields === 'function') toggleEmployeeAgencyFields();
  
  const empHiredDate = document.querySelector('#form-employment input#emp-hired-date');
  if (empHiredDate) empHiredDate.value = employee.date_hired || '';
  
  const empSupervisor = document.querySelector('#form-employment input#emp-supervisor');
  if (empSupervisor) empSupervisor.value = employee.supervisor || '';
  
  const empLocation = document.querySelector('#form-employment input#emp-location');
  if (empLocation) empLocation.value = employee.work_location || '';
  
  console.log('Form prefilled successfully');
}

function filterEmployees() {
  const filtered = getFilteredEmployeeList();

  console.log(`Filtered: ${filtered.length} employees`);
  
  EMPLOYEE_DIRECTORY_PAGE = 1;
  renderEmployees(filtered);
}

/* Register Page View Switching */
function switchRegisterView(view) {
  const formView = document.getElementById('register-form-view');

  if (!formView) return;
  formView.style.display = 'block';

  const isEditing = window.IS_EDITING === true;

  if (isEditing) {
    console.log('Showing form in EDIT mode with existing data');
    return;
  }

  console.log('Initializing form for NEW employee');
  if (typeof initializeAddForm === 'function') {
    initializeAddForm();
  } else {
    clearEmployeeForm();
    setTimeout(() => generateEmployeeID(), 100);
  }
}

async function toggleEmployeeStatus(employeeId, currentStatus) {
  const newStatus = currentStatus === 'Active' ? 'Inactive' : 'Active';
  await setEmployeeStatus(employeeId, newStatus);
}

async function setEmployeeStatus(employeeId, newStatus) {
  const confirmMsg = `Mark this employee as ${newStatus}?`;

  closeEmployeeActionMenus();
  const confirmed = await showConfirm(confirmMsg, 'Confirm Action', 'Yes', 'Cancel');
  if (!confirmed) return;

  try {
    const response = await apiFetch(`/api/employees/${employeeId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employment_status: newStatus })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to update status');
    }

    const data = await response.json();
    await showAlert(data.message || 'Status updated successfully', 'Success', 'success');
    await fetchEmployees();
  } catch (error) {
    console.error('Error updating status:', error);
    await showAlert('Failed to update employee status: ' + error.message, 'Error', 'error');
  }
}

function employeeTodayIsoDate() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 10);
}

async function offboardEmployee(employeeId) {
  openOffboardingDrawer(employeeId);
}

async function reonboardEmployee(employeeId) {
  openReonboardingDrawer(employeeId);
}

function getDirectoryEmployee(employeeId) {
  return EMPLOYEES_RAW.find(e => Number(e.id) === Number(employeeId));
}

function lifecycleReadonly(label, value) {
  return `<label><span>${employeeSetupEscape(label)}</span><input type="text" value="${employeeSetupEscape(value || '-')}" readonly></label>`;
}

function ensureLifecycleDrawer() {
  let drawer = document.getElementById('employee-lifecycle-drawer');
  if (drawer) return drawer;
  drawer = document.createElement('div');
  drawer.id = 'employee-lifecycle-drawer';
  drawer.className = 'employee-lifecycle-drawer';
  drawer.innerHTML = '<div id="employee-lifecycle-panel" class="employee-lifecycle-panel"></div>';
  drawer.addEventListener('click', event => {
    if (event.target === drawer) closeLifecycleDrawer();
  });
  document.body.appendChild(drawer);
  return drawer;
}

function lifecycleFormShell(title, body, submitHandler) {
  const drawer = ensureLifecycleDrawer();
  const panel = document.getElementById('employee-lifecycle-panel');
  panel.innerHTML = `
    <div class="employee-lifecycle-header">
      <div>
        <h2>${employeeSetupEscape(title)}</h2>
        <div id="employee-lifecycle-step-label" class="employee-lifecycle-subtitle"></div>
      </div>
      <button type="button" onclick="closeLifecycleDrawer()" class="employee-lifecycle-close">Close</button>
    </div>
    <div id="employee-lifecycle-steps" class="employee-lifecycle-steps"></div>
    <form id="employee-lifecycle-form" class="employee-lifecycle-form">
      <div id="employee-lifecycle-pages" class="employee-lifecycle-pages">
        ${body}
      </div>
      <div class="employee-lifecycle-footer">
        <button type="button" id="employee-lifecycle-prev" class="btn btn-outline">Previous</button>
        <div id="employee-lifecycle-progress" class="employee-lifecycle-progress"></div>
        <div class="employee-lifecycle-actions">
          <button type="button" onclick="closeLifecycleDrawer()" class="btn btn-outline">Cancel</button>
          <button type="button" id="employee-lifecycle-next" class="btn btn-primary">Next</button>
          <button type="submit" id="employee-lifecycle-submit" class="btn btn-primary">Submit</button>
        </div>
      </div>
    </form>
  `;
  panel.querySelectorAll('label').forEach(label => {
    label.classList.add('employee-lifecycle-field');
    const control = label.querySelector('input,select,textarea');
    if (control?.disabled) control.classList.add('employee-lifecycle-disabled-control');
  });
  panel.querySelectorAll('fieldset').forEach(fieldset => {
    fieldset.classList.add('employee-lifecycle-page');
  });
  panel.querySelectorAll('legend').forEach(legend => {
    legend.classList.add('employee-lifecycle-legend');
  });
  const form = document.getElementById('employee-lifecycle-form');
  form.addEventListener('submit', submitHandler);
  setupLifecycleWizard();
  drawer.style.display = 'flex';
}

function setupLifecycleWizard() {
  const form = document.getElementById('employee-lifecycle-form');
  const pages = [...form.querySelectorAll('fieldset')];
  const steps = document.getElementById('employee-lifecycle-steps');
  const label = document.getElementById('employee-lifecycle-step-label');
  const progress = document.getElementById('employee-lifecycle-progress');
  const prev = document.getElementById('employee-lifecycle-prev');
  const next = document.getElementById('employee-lifecycle-next');
  const submit = document.getElementById('employee-lifecycle-submit');
  if (!pages.length) return;
  let current = 0;
  const pageTitle = page => page.querySelector('legend')?.textContent?.trim() || 'Details';
  steps.innerHTML = pages.map((page, index) => `<button type="button" class="employee-lifecycle-step" data-step="${index}">${index + 1}. ${employeeSetupEscape(pageTitle(page))}</button>`).join('');
  const render = () => {
    pages.forEach((page, index) => {
      page.classList.toggle('active', index === current);
    });
    steps.querySelectorAll('.employee-lifecycle-step').forEach((button, index) => {
      button.classList.toggle('active', index === current);
    });
    label.textContent = pageTitle(pages[current]);
    progress.textContent = `Step ${current + 1} of ${pages.length}`;
    prev.disabled = current === 0;
    next.style.display = current === pages.length - 1 ? 'none' : 'inline-flex';
    submit.style.display = current === pages.length - 1 ? 'inline-flex' : 'none';
  };
  const canLeaveCurrent = () => {
    const controls = [...pages[current].querySelectorAll('input,select,textarea')].filter(control => !control.disabled);
    for (const control of controls) {
      if (!control.checkValidity()) {
        control.reportValidity();
        return false;
      }
    }
    return true;
  };
  prev.onclick = () => { if (current > 0) { current -= 1; render(); } };
  next.onclick = () => { if (current < pages.length - 1 && canLeaveCurrent()) { current += 1; render(); } };
  steps.querySelectorAll('.employee-lifecycle-step').forEach(button => {
    button.onclick = () => {
      const target = Number(button.dataset.step);
      if (target <= current || canLeaveCurrent()) {
        current = target;
        render();
      }
    };
  });
  render();
}

function closeLifecycleDrawer() {
  const drawer = document.getElementById('employee-lifecycle-drawer');
  if (drawer) drawer.style.display = 'none';
}

function fullEmployeeName(employee) {
  return `${employee?.first_name || ''} ${employee?.middle_name || ''} ${employee?.last_name || ''}`.replace(/\s+/g, ' ').trim();
}

function openOffboardingDrawer(employeeId) {
  closeEmployeeActionMenus();
  const employee = getDirectoryEmployee(employeeId);
  if (!employee) return;
  const role = employee.current_system_role || employee.role || '-';
  lifecycleFormShell('Offboard Employee', `
    <fieldset>
      <legend>Employee Information</legend>
      ${lifecycleReadonly('Employee ID', employee.employee_code)}
      ${lifecycleReadonly('Name', fullEmployeeName(employee))}
      ${lifecycleReadonly('Current Position', employee.position)}
      ${lifecycleReadonly('Department', employee.department)}
      ${lifecycleReadonly('Current Status', employee.status)}
      ${lifecycleReadonly('Current System Role', role)}
    </fieldset>
    <fieldset>
      <legend>Offboarding Details</legend>
      <label><span>Offboarding Type</span><select name="offboarding_type" required><option>Resignation</option><option>Termination</option><option>End of Contract</option><option>Retirement</option><option>AWOL</option></select></label>
      <label><span>Effective Date</span><input name="effective_date" type="date" required value="${employeeTodayIsoDate()}"></label>
      <label><span>Last Working Day</span><input name="last_working_day" type="date" required value="${employeeTodayIsoDate()}"></label>
      <label style="grid-column:1/-1;"><span>Reason</span><textarea name="reason" required rows="3"></textarea></label>
      <label><span>Clearance Status</span><select name="clearance_status" required><option>Pending</option><option>Cleared</option><option>Not Cleared</option></select></label>
      <label><span>Account Action</span><select name="account_action" required><option>Disable Immediately</option><option>Disable on Effective Date</option></select></label>
      <label style="grid-column:1/-1;"><span>Remarks</span><textarea name="remarks" rows="3"></textarea></label>
    </fieldset>
    <fieldset>
      <legend>Clearance Checklist</legend>
      <label><span>Company Property Status</span><select name="company_property_status" required><option>Pending</option><option>Partially Returned</option><option>Completed</option><option>Not Applicable</option></select></label>
      <label><span>Turnover Status</span><select name="turnover_status" required><option>Pending</option><option>Completed</option><option>Not Required</option></select></label>
      <label><span>Exit Interview Status</span><select name="exit_interview_status" required><option>Pending</option><option>Completed</option><option>Not Required</option></select></label>
      <label><span>Attendance and Leave Clearance</span><select name="attendance_leave_clearance" required><option>Pending</option><option>Checked</option><option>With Issue</option></select></label>
    </fieldset>
    <fieldset>
      <legend>Payroll Clearance</legend>
      <label><span>Payroll Clearance Status</span><select name="payroll_clearance_status" disabled><option>Pending</option><option>Checked</option><option>Cleared</option><option>With Issue</option></select></label>
      <label><span>Payroll Checked By</span><input name="payroll_checked_by" value="Payroll Officer" disabled></label>
      <label><span>Final Pay Status</span><select name="final_pay_status" disabled><option>Pending</option><option>For Processing</option><option>For Approval</option><option>Approved</option><option>Released</option><option>With Issue</option></select></label>
      <label><span>Final Pay Approved By</span><input name="final_pay_approved_by" value="Payroll Manager" disabled></label>
      <label><span>Final Pay Release Date</span><input name="final_pay_release_date" type="date" disabled></label>
    </fieldset>
    <fieldset>
      <legend>IT Access Revocation</legend>
      <label><span>IT Access Status</span><select name="it_access_status" disabled><option>Pending</option><option>Disabled</option><option>Revoked</option></select></label>
      <label><span>Permissions Revoked</span><select name="permissions_revoked" disabled><option value="false">No</option><option value="true">Yes</option></select></label>
      <label><span>Active Sessions/JWT Invalidated</span><select name="sessions_invalidated" disabled><option value="false">No</option><option value="true">Yes</option></select></label>
      <label><span>Biometric/Attendance Access Removed</span><select name="biometric_access_removed" disabled><option value="false">No</option><option value="true">Yes</option></select></label>
      <label><span>IT Processed By</span><input name="it_processed_by" value="IT Staff" disabled></label>
      <label><span>IT Processed Date</span><input name="it_processed_at" type="datetime-local" disabled></label>
    </fieldset>
    <fieldset>
      <legend>Process Tracking</legend>
      <label><span>Offboarding Status</span><select name="offboarding_status" required><option>In Progress</option><option>Pending</option><option>Cancelled</option></select></label>
      <label><span>Processed By</span><input name="processed_by_display" value="Logged-in HR user" readonly></label>
      <label><span>Completed By</span><input name="completed_by_display" value="Auto-filled on completion" disabled></label>
      <label><span>Completed Date</span><input name="completed_at" type="datetime-local" disabled></label>
    </fieldset>
  `, async event => submitLifecycleForm(event, `/api/employees/${employeeId}/offboard`, 'Employee offboarding request submitted.'));
}

function openReonboardingDrawer(employeeId) {
  closeEmployeeActionMenus();
  const employee = getDirectoryEmployee(employeeId);
  if (!employee) return;
  const departments = typeof getEmployeeDepartments === 'function' ? getEmployeeDepartments() : [];
  const departmentOptions = ['<option value="">Select department</option>'].concat(departments.map(dept => `<option value="${dept.id}" ${String(employee.department_id) === String(dept.id) ? 'selected' : ''}>${employeeSetupEscape(dept.name)}</option>`)).join('');
  lifecycleFormShell('Re-onboard Employee', `
    <fieldset>
      <legend>Previous Employee Information</legend>
      ${lifecycleReadonly('Previous Employee ID', employee.employee_code)}
      ${lifecycleReadonly('Name', fullEmployeeName(employee))}
      ${lifecycleReadonly('Previous Position', employee.position)}
      ${lifecycleReadonly('Previous Department', employee.department)}
      ${lifecycleReadonly('Previous Offboarding Date', employee.separation_date)}
      ${lifecycleReadonly('Previous Offboarding Reason', employee.separation_reason)}
    </fieldset>
    <fieldset>
      <legend>Rehire Details</legend>
      <label><span>Rehire Date</span><input name="rehire_date" type="date" required value="${employeeTodayIsoDate()}"></label>
      <label><span>New Position</span><input name="new_position" required value="${employeeSetupEscape(employee.position || '')}"></label>
      <label><span>Department</span><select name="department_id">${departmentOptions}</select></label>
      <label><span>Work Location</span><input name="work_location" value="${employeeSetupEscape(employee.work_location || '')}"></label>
      <label><span>Employment Type</span><select name="employment_type" required><option>Full-time</option><option>Part-time</option><option>Contractual</option><option>Regular</option></select></label>
      <label><span>Hiring Type</span><select name="hiring_type"><option>Direct Hire</option><option>Agency-Hired</option></select></label>
      <label><span>New Supervisor</span><input name="new_supervisor" value="${employeeSetupEscape(employee.supervisor || '')}"></label>
      <label><span>Employee Level</span><select name="employee_level"><option>Rank and File</option><option>Supervisor</option><option>Manager</option><option>Executive</option></select></label>
    </fieldset>
    <fieldset>
      <legend>Payroll and System Access</legend>
      <label><span>Payroll Setup Status</span><select name="payroll_setup_status" required><option>Pending</option><option>Ready</option></select></label>
      <label><span>Assigned System Role</span><select name="assigned_system_role" required><option value="employee">Regular Employee</option><option value="hr_manager">HR Manager</option><option value="payroll_officer">Payroll Officer</option><option value="payroll_manager">Payroll Manager</option></select></label>
      <label><span>Force Password Reset</span><select name="force_password_reset"><option value="true">Yes</option><option value="false">No</option></select></label>
      <label><span>Account Reactivation</span><input value="Reactivated after approval" readonly></label>
    </fieldset>
    <fieldset>
      <legend>Process Tracking</legend>
      <label><span>Processed By</span><input name="processed_by_display" value="Logged-in HR user" readonly></label>
      <label><span>Re-onboarding Status</span><input value="Pending" readonly></label>
      <label style="grid-column:1/-1;"><span>Remarks</span><textarea name="remarks" rows="3"></textarea></label>
    </fieldset>
  `, async event => submitLifecycleForm(event, `/api/employees/${employeeId}/reonboard`, 'Employee re-onboarding request submitted.'));
}

async function submitLifecycleForm(event, endpoint, fallbackMessage) {
  event.preventDefault();
  const form = event.currentTarget;
  if (endpoint.includes('/offboard')) {
    const confirmed = confirm('Are you sure you want to offboard this employee? This may disable the account and revoke system access.');
    if (!confirmed) return;
  }
  const payload = Object.fromEntries(new FormData(form).entries());

  try {
    const response = await apiFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Failed to submit lifecycle request.');
    closeLifecycleDrawer();
    await showAlert(data.message || fallbackMessage, 'Success', 'success');
    await fetchEmployees();
  } catch (error) {
    console.error('Lifecycle request error:', error);
    await showAlert(error.message, 'Error', 'error');
  }
}

async function viewLifecycleRequest(employeeId, type) {
  closeEmployeeActionMenus();
  try {
    const response = await apiFetch(`/api/employees/${employeeId}/lifecycle`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Failed to load lifecycle request.');
    const list = type === 'offboarding' ? data.offboarding_cases || [] : data.reonboarding_cases || [];
    const request = list.find(item => item.status === 'Pending') || list[0];
    if (!request) return showAlert('No lifecycle request found.', 'Lifecycle Request', 'info');
    const text = Object.entries(request)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${value}`)
      .join('<br>');
    await showAlert(text, type === 'offboarding' ? 'Offboarding Request' : 'Re-onboarding Request', 'info');
  } catch (error) {
    await showAlert(error.message, 'Error', 'error');
  }
}

async function editEmployeeFromManage(employeeId) {
  console.log('Editing employee ID:', employeeId);
  const employee = EMPLOYEES_RAW.find(e => e.id === parseInt(employeeId));
  console.log('Found employee:', employee);
  if (!employee) {
    await showAlert('Employee not found', 'Error', 'error');
    return;
  }

  // Clear all previous edit mode flags
  window.IS_EDITING = false;
  window.PENDING_EDIT_MODE = false;
  sessionStorage.removeItem('editEmployee');
  
  // Store employee data in sessionStorage
  sessionStorage.setItem('editEmployee', JSON.stringify(employee));
  
  // Set edit mode flags
  window.IS_EDITING = true;
  window.PENDING_EDIT_MODE = true;
  console.log('Set edit mode for employee:', employee.employee_code);
  console.log('Flags: IS_EDITING:', window.IS_EDITING, 'PENDING_EDIT_MODE:', window.PENDING_EDIT_MODE);
  
  // Switch to form view
  switchRegisterView('add');
}

async function deleteEmployeeFromManage(employeeId) {
  const emp = EMPLOYEES.find(e => e.id === parseInt(employeeId));
  if (!emp) {
    await showAlert('Employee not found', 'Error', 'error');
    return;
  }
  
  const confirmed = await showConfirm(`Are you sure you want to delete ${emp.name}? This action cannot be undone.`, 'Delete Employee', 'Delete', 'Cancel');
  if (!confirmed) return;
  
  try {
    const response = await apiFetch(`/api/employees/${employeeId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' }
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to delete employee');
    }

    const data = await response.json();
    await showAlert(data.message || 'Employee deleted successfully', 'Success', 'success');
    
    await fetchEmployees();
  } catch (error) {
    console.error('Error deleting employee:', error);
    await showAlert('Failed to delete employee: ' + error.message, 'Error', 'error');
  }
}

function clearEmployeeForm() {
  // Reset edit mode flags
  window.IS_EDITING = false;
  window.PENDING_EDIT_MODE = false;
  
  // Reset edit mode flag if available
  if (typeof resetEditMode === 'function') {
    resetEditMode();
  }
  
  // Clear all form inputs
  document.getElementById('emp-id').value = '';
  document.getElementById('emp-id').readOnly = false;
  document.getElementById('emp-suffix').value = 'None';
  document.getElementById('emp-first-name').value = '';
  document.getElementById('emp-middle-name').value = '';
  document.getElementById('emp-last-name').value = '';
  document.getElementById('emp-contact').value = '';
  document.getElementById('emp-nationality').value = 'Filipino';
  const placeOfBirth = document.getElementById('emp-place-of-birth');
  if (placeOfBirth) placeOfBirth.value = '';
  const bloodType = document.getElementById('emp-blood-type');
  if (bloodType) bloodType.value = '';
  const religion = document.getElementById('emp-religion');
  if (religion) religion.value = '';
  document.getElementById('emp-dob').value = '';
  document.getElementById('emp-gender').value = 'Male';
  const maritalStatus = document.getElementById('emp-marital-status');
  if (maritalStatus) maritalStatus.value = 'Single';
  document.getElementById('emp-email').value = '';
  const workEmail = document.getElementById('emp-work-email');
  if (workEmail) workEmail.value = '';
  document.getElementById('emp-address').value = '';
  const currentAddress = document.getElementById('emp-current-address');
  if (currentAddress) currentAddress.value = '';
  const mailingAddress = document.getElementById('emp-mailing-address');
  if (mailingAddress) mailingAddress.value = '';
  document.getElementById('emp-emerg-name').value = '';
  document.getElementById('emp-emerg-phone').value = '';
  const emergRelationship = document.getElementById('emp-emerg-relationship');
  if (emergRelationship) emergRelationship.value = '';
  const emergSecondaryPhone = document.getElementById('emp-emerg-secondary-phone');
  if (emergSecondaryPhone) emergSecondaryPhone.value = '';
  const emergEmail = document.getElementById('emp-emerg-email');
  if (emergEmail) emergEmail.value = '';
  const emergAddress = document.getElementById('emp-emerg-address');
  if (emergAddress) emergAddress.value = '';
  document.querySelector('#form-employment select#emp-dept').value = 'HR';
  document.querySelector('#form-employment select#emp-type').value = 'Full-time';
  const hiringType = document.querySelector('#form-employment select#emp-hiring-type');
  if (hiringType) hiringType.value = 'Direct Hire';
  const lifecycleAction = document.getElementById('emp-lifecycle-action');
  if (lifecycleAction) lifecycleAction.value = 'AUTO';
  const lifecycleNote = document.getElementById('emp-lifecycle-note');
  if (lifecycleNote) {
    lifecycleNote.value = '';
    lifecycleNote.style.display = 'none';
    lifecycleNote.required = false;
  }
  const agencyFields = document.getElementById('emp-agency-fields');
  if (agencyFields) agencyFields.hidden = true;
  ['emp-agency-name', 'emp-agency-contact-person', 'emp-agency-contact-number', 'emp-contract-start-date', 'emp-contract-end-date'].forEach(id => {
    const field = document.getElementById(id);
    if (field) {
      field.value = '';
      field.required = false;
    }
  });
  const deploymentStatus = document.getElementById('emp-deployment-status');
  if (deploymentStatus) deploymentStatus.value = 'Pending Deployment';
  if (typeof toggleEmployeeAgencyFields === 'function') toggleEmployeeAgencyFields();
  if (typeof toggleEmployeeLifecycleDecisionFields === 'function') toggleEmployeeLifecycleDecisionFields();
  if (typeof bindDepartmentPositionDropdown === 'function') {
    bindDepartmentPositionDropdown('emp-dept', 'emp-position', '');
  } else {
    const positionSelect = document.querySelector('#form-employment select#emp-position');
    if (positionSelect) positionSelect.value = '';
  }
  const empStatusField = document.querySelector('#form-employment select#emp-status-field');
  if (empStatusField) empStatusField.value = 'Active';
  document.querySelector('#form-employment input#emp-hired-date').value = '';
  const empEndContract = document.querySelector('#form-employment input#emp-end-contract');
  if (empEndContract) empEndContract.value = '';
  document.querySelector('#form-employment input#emp-supervisor').value = '';
  document.querySelector('#form-employment input#emp-location').value = '';
  const empShift = document.querySelector('#form-employment select#emp-shift-schedule');
  if (empShift) empShift.value = '';
  const empLevel = document.querySelector('#form-employment select#emp-level');
  if (empLevel) empLevel.value = '';
  const empEmploymentHistory = document.querySelector('#form-employment textarea#emp-employment-history');
  if (empEmploymentHistory) empEmploymentHistory.value = '';
  document.getElementById('emp-salary').value = '';
  document.getElementById('emp-pay-freq').value = 'Monthly';
  const allowances = document.getElementById('emp-allowances');
  if (allowances) allowances.value = '';
  document.getElementById('emp-sss').value = '';
  document.getElementById('emp-philhealth').value = '';
  document.getElementById('emp-pagibig').value = '';
  document.getElementById('emp-tin').value = '';
  const taxStatus = document.getElementById('emp-tax-status');
  if (taxStatus) taxStatus.value = '';
  document.getElementById('emp-bank').value = '';
  document.getElementById('emp-bank-account').value = '';
  
  // Reset to Personal Info tab
  document.querySelectorAll('.form-tab').forEach(tab => tab.classList.remove('active'));
  document.querySelector('.form-tab').classList.add('active');
  document.getElementById('form-personal').style.display = 'block';
  const formContact = document.getElementById('form-contact');
  if (formContact) formContact.style.display = 'none';
  document.getElementById('form-employment').style.display = 'none';
  document.getElementById('form-payroll').style.display = 'none';
  document.getElementById('form-documents').style.display = 'none';
  
  // Clear uploaded files if function is available
  if (typeof clearUploadedFiles === 'function') {
    clearUploadedFiles();
  }
  if (typeof resetRegisterDraftSelection === 'function') {
    resetRegisterDraftSelection();
  }
}

/* Management Table */
function renderManagementTable(list) {
  const grid = document.getElementById('manage-emp-grid');
  if (!grid) {
    console.error('Grid element "manage-emp-grid" not found!');
    return;
  }
  
  grid.innerHTML = list.map(e => {
    const statusClass = e.status === 'Active' ? 'active' : 'inactive';
    const statusDisplay = e.status === 'Active' ? '✓ Active' : '✗ Inactive';
    const toggleLabel = e.status === 'Active' ? 'Deactivate' : 'Activate';
    
    return `
    <tr data-emp-id="${e.id}">
      <td class="emp-id">${e.id}</td>
      <td class="emp-name">${e.name}</td>
      <td>${e.email}</td>
      <td>${e.dept}</td>
      <td>${e.position}</td>
      <td><span class="emp-status-badge ${statusClass}">${statusDisplay}</span></td>
      <td>
        <div class="emp-actions" style="flex-wrap:wrap;">
          <button class="emp-edit-btn" onclick="editEmployee('${e.id}')" title="Edit Employee" style="flex:1;min-width:60px;">Edit</button>
          <button style="padding:6px 12px;border:none;border-radius:6px;cursor:pointer;font-size:12px;font-weight:600;transition:all 0.2s ease;background:#6c757d;color:white;" onclick="openPayrollConfigModal('${e.id}')" title="Configure Payroll">Payroll</button>
          <button class="emp-status-toggle-btn" onclick="toggleEmployeeStatus('${e.id}', '${e.status}')" title="Toggle Status" style="flex:1;min-width:70px;">${toggleLabel}</button>
          <button class="emp-delete-btn" onclick="deleteEmployee('${e.id}', '${e.name}')" title="Delete Employee" style="flex:1;min-width:60px;">Delete</button>
        </div>
      </td>
    </tr>
  `}).join('');
  
  console.log('Rendered', list.length, 'employees to management table');
}

/* Delete Employee */
function deleteEmployee(empId, empName) {
  if (!confirm(`Are you sure you want to delete ${empName}? This action cannot be undone.`)) {
    return;
  }
  
  apiFetch(`/api/employees/${empId}`, {
    method: 'DELETE'
  })
  .then(res => res.json())
  .then(data => {
    if (data.error) {
      alert('Error: ' + data.error);
    } else {
      alert('Employee deleted successfully!');
      fetchEmployees();
    }
  })
  .catch(err => {
    console.error('Delete error:', err);
    alert('Failed to delete employee');
  });
}

/* Edit Employee - Redirect to register form */
let currentEditingEmployeeId = null;

function switchEditTab(tabName) {
  // Hide all tabs
  document.getElementById('edit-tab-personal').style.display = 'none';
  document.getElementById('edit-tab-employment').style.display = 'none';
  document.getElementById('edit-tab-payroll').style.display = 'none';
  document.getElementById('edit-tab-photo').style.display = 'none';
  
  // Remove active state from all buttons
  document.querySelectorAll('.edit-tab-btn').forEach(btn => {
    btn.classList.remove('active');
    btn.style.borderBottomColor = 'transparent';
    btn.style.color = '#666';
  });
  
  // Show selected tab and update button
  const tabMap = {
    'personal': 'edit-tab-personal',
    'employment': 'edit-tab-employment',
    'payroll': 'edit-tab-payroll',
    'photo': 'edit-tab-photo'
  };
  
  if (tabMap[tabName]) {
    document.getElementById(tabMap[tabName]).style.display = 'block';
  }
  
  // Find and activate the clicked button
  document.querySelectorAll('.edit-tab-btn').forEach(btn => {
    const btnText = btn.textContent;
    let match = false;
    if (tabName === 'personal' && btnText.includes('Personal')) match = true;
    if (tabName === 'employment' && btnText.includes('Employment')) match = true;
    if (tabName === 'payroll' && btnText.includes('Payroll')) match = true;
    if (tabName === 'photo' && btnText.includes('Photo')) match = true;
    
    if (match) {
      btn.classList.add('active');
      btn.style.borderBottomColor = '#4f7cff';
      btn.style.color = '#333';
    }
  });
}

async function editEmployee(empId) {
  console.log('Editing employee ID:', empId);
  const employee = EMPLOYEES_RAW.find(e => e.id === parseInt(empId));
  console.log('Found employee:', employee);
  if (!employee) {
    await showAlert('Employee not found', 'Error', 'error');
    return;
  }

  currentEditingEmployeeId = employee.id;
  
  try {
    if (!wageTypesForPayroll.length) await loadPayrollRefData();
    populatePayrollWageTypeSelects();

    // Populate Personal Info Tab
    document.getElementById('edit-emp-first-name').value = employee.first_name || '';
    document.getElementById('edit-emp-last-name').value = employee.last_name || '';
    document.getElementById('edit-emp-email').value = employee.email || '';
    document.getElementById('edit-emp-phone').value = employee.contact_number || '';
    document.getElementById('edit-emp-city').value = employee.residential_address || '';
    
    // Populate Employment Details Tab
    document.getElementById('edit-emp-dept').value = getDeptName(employee.department_id) || 'HR';
    if (typeof bindDepartmentPositionDropdown === 'function') {
      await bindDepartmentPositionDropdown('edit-emp-dept', 'edit-emp-position', employee.position || '');
    } else {
      document.getElementById('edit-emp-position').value = employee.position || '';
    }
    document.getElementById('edit-emp-type').value = employee.employment_type || '';
    document.getElementById('edit-emp-date-hired').value = employee.date_hired ? employee.date_hired.split('T')[0] : '';
    document.getElementById('edit-emp-supervisor').value = employee.supervisor || '';
    document.getElementById('edit-emp-work-location').value = employee.work_location || '';
    
    // Populate Payroll & Compensation Tab
    const wageTypeId = getPayrollWageTypeIdByName(employee.wage_type);
    document.getElementById('edit-payroll-wage-type').value = wageTypeId;
    document.getElementById('edit-payroll-rate').value = usesPayrollBaseRate(wageTypeId) ? (employee.base_rate || '') : '';
    setEditPayrollBaseRateVisibility(wageTypeId);
    
    // Reset file input
    const photoInput = document.getElementById('edit-emp-photo-input');
    if (photoInput) photoInput.value = '';
    
    // Reset photo preview to placeholder
    const photoPreview = document.getElementById('edit-emp-photo-preview');
    const noPhotoPlaceholder = document.getElementById('edit-emp-no-photo');
    if (photoPreview) photoPreview.style.display = 'none';
    if (noPhotoPlaceholder) noPhotoPlaceholder.style.display = 'flex';
    
    // Load employee photo (async, don't await - let it happen in background)
    loadEmployeePhotoPreview(employee.id).catch(err => {
      console.log('Photo loading error (non-critical):', err.message);
    });
    
    // Reset to first tab
    switchEditTab('personal');
    
    // Open the modal
    const modal = document.getElementById('edit-employee-modal');
    if (modal) {
      modal.style.display = 'flex';
      console.log('✓ Edit modal opened for employee:', employee.employee_code);
    } else {
      console.error('❌ Edit modal element not found');
    }
  } catch (error) {
    console.error('❌ Error in editEmployee:', error.message);
    await showAlert('Error opening edit form: ' + error.message, 'Error', 'error');
  }
}

function openAddEmployeeModal() {
  currentEditingEmployeeId = null;
  window.IS_EDITING = false;
  window.PENDING_EDIT_MODE = false;
  sessionStorage.removeItem('editEmployee');
  navigate('register', null);

  setTimeout(() => {
    if (typeof switchRegisterView === 'function') {
      switchRegisterView('add');
    }
  }, 100);
}

function closeEditEmployeeModal() {
  const modal = document.getElementById('edit-employee-modal');
  if (modal) modal.style.display = 'none';
  currentEditingEmployeeId = null;
}

function getDeptName(deptId) {
  const departments = typeof getEmployeeDepartments === 'function' ? getEmployeeDepartments() : [];
  const department = departments.find(item => Number(item.id) === Number(deptId));
  if (department) return department.name;
  const deptMap = { 1: 'HR', 2: 'Accounting', 3: 'Production', 4: 'Logistics', 5: 'Personnel' };
  return deptMap[deptId] || 'HR';
}

function getDeptId(deptName) {
  if (typeof getDepartmentId === 'function') {
    return getDepartmentId(deptName) || 1;
  }
  const deptMap = { HR: 1, Accounting: 2, Production: 3, Logistics: 4, Personnel: 5 };
  return deptMap[deptName] || 1;
}

async function saveEditedEmployee() {
  // Collect Personal Info Tab
  const firstName = document.getElementById('edit-emp-first-name').value;
  const lastName = document.getElementById('edit-emp-last-name').value;
  const email = document.getElementById('edit-emp-email').value;
  const phone = document.getElementById('edit-emp-phone').value;
  const city = document.getElementById('edit-emp-city').value;
  
  // Collect Employment Details Tab
  const dept = document.getElementById('edit-emp-dept').value;
  const position = document.getElementById('edit-emp-position').value;
  const empType = document.getElementById('edit-emp-type').value;
  const dateHired = document.getElementById('edit-emp-date-hired').value;
  const supervisor = document.getElementById('edit-emp-supervisor').value;
  const workLocation = document.getElementById('edit-emp-work-location').value;
  
  // Collect Payroll & Compensation Tab
  const wageType = document.getElementById('edit-payroll-wage-type').value;
  const wageTypeName = getPayrollWageTypeNameById(wageType);
  const baseRate = document.getElementById('edit-payroll-rate').value;

  if (!firstName || !lastName || !email) {
    await showAlert('First name, last name, and email are required', 'Validation Error', 'warning');
    return;
  }

  // Collect sewing type rates if wage type is per-piece
  let sewingRates = [];
  if (isPayrollWageType(wageType, 'Per-Piece')) {
    const sewingInputs = document.querySelectorAll('.edit-payroll-sewing-rate');
    sewingInputs.forEach(input => {
      const rate = input.value;
      const sewingId = input.getAttribute('data-sewing-id');
      if (rate && !isNaN(rate) && parseFloat(rate) > 0) {
        sewingRates.push({
          sewing_id: parseInt(sewingId),
          rate: parseFloat(rate)
        });
      }
    });
    console.log('Collected sewing rates:', sewingRates);
  }

  const isAddingNew = !currentEditingEmployeeId;
  const method = isAddingNew ? 'POST' : 'PUT';
  const endpoint = isAddingNew ? '/api/employees' : `/api/employees/${currentEditingEmployeeId}`;
  
  // For adding new employees, we need an employee code
  let employeeCode = '';
  if (isAddingNew) {
    // Generate next employee code
    const maxCode = Math.max(
      ...EMPLOYEES_RAW.map(e => {
        const match = e.employee_code?.match(/EMP(\d+)/);
        return match ? parseInt(match[1]) : 0;
      }),
      0
    );
    employeeCode = `EMP${String(maxCode + 1).padStart(5, '0')}`;
  }

  try {
    const response = await apiFetch(endpoint, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employee_code: employeeCode,
        first_name: firstName,
        last_name: lastName,
        email: email,
        contact_number: phone,
        residential_address: city,
        department_id: getDeptId(dept),
        position: position,
        employment_type: empType,
        date_hired: dateHired,
        supervisor: supervisor,
        work_location: workLocation,
        wage_type: wageTypeName || null,
        base_rate: usesPayrollBaseRate(wageType) && baseRate ? parseFloat(baseRate) : null,
        sewingRates: sewingRates,
        status: 'Active'
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to save employee');
    }

    const message = isAddingNew ? 'Employee added successfully!' : 'Employee updated successfully!';
    await showAlert(message, 'Success', 'success');
    closeEditEmployeeModal();
    
    await fetchEmployees();
  } catch (error) {
    console.error('Error saving employee:', error);
    await showAlert('Failed to save employee: ' + error.message, 'Error', 'error');
  }
}

// Handle wage type change in edit modal
async function updateEditPayrollWageType(wageTypeValue) {
  const sewingSection = document.getElementById('edit-payroll-sewing-section');
  setEditPayrollBaseRateVisibility(wageTypeValue);
  
  if (isPayrollWageType(wageTypeValue, 'Per-Piece')) {
    // Per-Piece (Sewing) selected
    sewingSection.style.display = 'block';
    
    // Load sewing types if not already loaded
    if (sewingTypesForPayroll.length === 0) {
      try {
        const response = await apiFetch('/api/payroll/sewing-types');
        if (response.ok) {
          sewingTypesForPayroll = await response.json();
          renderEditPayrollSewingTypes();
        }
      } catch (error) {
        console.error('Error loading sewing types:', error);
      }
    } else {
      renderEditPayrollSewingTypes();
    }
  } else {
    // Other wage types - hide sewing section
    sewingSection.style.display = 'none';
  }
}

// Render sewing type inputs in edit modal
function renderEditPayrollSewingTypes() {
  const container = document.getElementById('edit-payroll-sewing-items');
  container.innerHTML = sewingTypesForPayroll.map(type => `
    <div style="margin-bottom:12px;">
      <label style="display:block;font-size:12px;color:#666 !important;margin-bottom:4px;font-weight:600;">${type.name}</label>
      <input type="number" class="edit-payroll-sewing-rate" data-sewing-id="${type.id}" min="0" step="0.01" placeholder="0.00" style="width:100%;padding:8px;border:1px solid #ddd;border-radius:6px;font-size:14px;color:#333 !important;box-sizing:border-box;background:white !important;" />
    </div>
  `).join('');
}

/* Edit Employee - Redirect to register form (kept for legacy) */
function editEmployeeOld(empId) {
  console.log('Editing employee ID:', empId);
  const employee = EMPLOYEES_RAW.find(e => e.id === parseInt(empId));
  console.log('Found employee:', employee);
  if (!employee) {
    alert('Employee not found');
    return;
  }

  // Clear all previous edit mode flags
  window.IS_EDITING = false;
  window.PENDING_EDIT_MODE = false;
  sessionStorage.removeItem('editEmployee');
  
  // Store NEW employee data in sessionStorage
  sessionStorage.setItem('editEmployee', JSON.stringify(employee));
  
  // Set edit mode flags for this NEW employee
  window.IS_EDITING = true;
  window.PENDING_EDIT_MODE = true;
  console.log('Set edit mode for employee:', empId);
  console.log('Flags: IS_EDITING:', window.IS_EDITING, 'PENDING_EDIT_MODE:', window.PENDING_EDIT_MODE);
  
  // Navigate to register page
  navigate('register', null);
  
  // Wait for page to load, then switch to form view
  setTimeout(() => {
    console.log('Switching to form view...');
    if (typeof switchRegisterView === 'function') {
      switchRegisterView('add');
    }
  }, 100);
}

let EMPLOYEE_PAGE_INITIALIZED = false;

function initializeEmployeePage() {
  if (!document.getElementById('emp-tbody')) return;
  if (!document.getElementById('page-employees')?.classList.contains('active')) return;

  refreshEmployeeSetupUI();
  fetchEmployees();

  // Auto-refresh employees every 5 seconds to catch new additions
  if (!EMPLOYEE_PAGE_INITIALIZED) {
    setInterval(fetchEmployees, 5000);
    EMPLOYEE_PAGE_INITIALIZED = true;
  }

  document.getElementById('emp-search') ?.addEventListener('input',  filterEmployees);
  document.getElementById('emp-dept')   ?.addEventListener('change', filterEmployees);
  document.getElementById('emp-status') ?.addEventListener('change', filterEmployees);
  bindEmployeeDirectoryPagination();
}

function initializeOrganizationSetupPage() {
  if (!document.getElementById('org-setup-departments-tbody')) return;
  if (!document.getElementById('page-organization-setup')?.classList.contains('active')) return;
  refreshEmployeeSetupUI();
}

document.addEventListener('DOMContentLoaded', initializeEmployeePage);
document.addEventListener('partialsLoaded', initializeEmployeePage);
document.addEventListener('DOMContentLoaded', initializeOrganizationSetupPage);
document.addEventListener('partialsLoaded', initializeOrganizationSetupPage);

window.initializeEmployeePage = initializeEmployeePage;
window.changeEmployeeDirectoryPage = changeEmployeeDirectoryPage;
window.initializeOrganizationSetupPage = initializeOrganizationSetupPage;
window.changeOrganizationSetupPage = changeOrganizationSetupPage;
window.saveEmployeeIdConfig = saveEmployeeIdConfig;
window.saveEmployeeSetupDepartment = saveEmployeeSetupDepartment;
window.saveEmployeeSetupPosition = saveEmployeeSetupPosition;
window.editEmployeeSetupDepartment = editEmployeeSetupDepartment;
window.deleteEmployeeSetupDepartment = deleteEmployeeSetupDepartment;
window.editEmployeeSetupPosition = editEmployeeSetupPosition;
window.deleteEmployeeSetupPosition = deleteEmployeeSetupPosition;

// Payroll config wage type change handler
document.addEventListener('change', (e) => {
  if (e.target.id === 'payroll-config-wage-select') {
    const wageTypeId = e.target.value;
    setPayrollBaseRateVisibility(wageTypeId, 'payroll-config');
    document.getElementById('payroll-config-hourly-section').style.display = isPayrollWageType(wageTypeId, 'Hourly') ? 'block' : 'none';
    document.getElementById('payroll-config-sewing-section').style.display = isPayrollWageType(wageTypeId, 'Per-Piece') ? 'block' : 'none';
    document.getElementById('payroll-config-logistics-section').style.display = isPayrollWageType(wageTypeId, 'Per-Trip') ? 'block' : 'none';
  }
});

/* ═══════════════════════════════════════════════════════════════════
   Employee Detail Modal Functions
   ═══════════════════════════════════════════════════════════════════ */

let currentEmployeeForModal = null;
let sewingTypesForPayroll = [];
let logisticsRegionsForPayroll = [];

// Open employee detail modal
async function openEmployeeDetailModal(employeeId) {
  const employee = EMPLOYEES_RAW.find(e => e.id === parseInt(employeeId));
  if (!employee) return;
  
  currentEmployeeForModal = employee;
  
  console.log('🔍 Opening employee detail modal');
  console.log('   Employee ID:', employeeId);
  console.log('   Employee Code:', employee.employee_code);
  console.log('   Full Employee:', employee);
  
  // Populate personal info
  document.getElementById('emp-detail-empid').textContent = employee.employee_code || '—';
  document.getElementById('emp-detail-name').textContent = `${employee.first_name} ${employee.last_name}`;
  document.getElementById('emp-detail-status').textContent = employee.status || 'Active';
  document.getElementById('emp-detail-email').textContent = employee.email || '—';
  document.getElementById('emp-detail-phone').textContent = employee.contact_number || '—';
  document.getElementById('emp-detail-city').textContent = employee.residential_address ? employee.residential_address.split(',')[0] : '—';
  
  // Employment details
  document.getElementById('emp-detail-dept').textContent = employee.department || '—';
  document.getElementById('emp-detail-position').textContent = employee.position || '—';
  document.getElementById('emp-detail-employment-type').textContent = employee.employment_type || '—';
  document.getElementById('emp-detail-date-hired').textContent = employee.date_hired ? employee.date_hired.split('T')[0] : '—';
  
  // Reset tabs
  document.querySelectorAll('.emp-detail-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('[id^="emp-detail-tab-"]').forEach(tab => tab.style.display = 'none');
  
  // Show first tab
  document.querySelectorAll('.emp-detail-tab-btn')[0].classList.add('active');
  document.getElementById('emp-detail-tab-personal').style.display = 'block';
  
  // Load payroll compensation data if not already loaded
  if (!wageTypesForPayroll.length || sewingTypesForPayroll.length === 0 || logisticsRegionsForPayroll.length === 0) {
    await loadPayrollRefData();
  }
  
  // Load current payroll config
  await loadEmpPayrollConfig(employee.id);
  
  // Open modal
  const modal = document.getElementById('emp-detail-modal');
  if (modal) modal.style.display = 'flex';
}

// Close employee detail modal
function closeEmployeeDetail() {
  const modal = document.getElementById('emp-detail-modal');
  if (modal) modal.style.display = 'none';
  currentEmployeeForModal = null;
}

// Switch between tabs in employee detail modal
function switchTab(tabName) {
  // Hide all tabs
  document.querySelectorAll('[id^="emp-detail-tab-"]').forEach(tab => tab.style.display = 'none');
  
  // Remove active class from all buttons
  document.querySelectorAll('.emp-detail-tab-btn').forEach(btn => btn.classList.remove('active'));
  
  // Show selected tab
  const tabEl = document.getElementById(`emp-detail-tab-${tabName}`);
  if (tabEl) tabEl.style.display = 'block';
  
  // Add active class to button
  event.target.classList.add('active');
  
  // If switching to payroll tab, ensure data is loaded
  if (tabName === 'payroll' && currentEmployeeForModal) {
    loadEmpPayrollConfig(currentEmployeeForModal.id);
  }
}

// Load sewing types and logistics regions for payroll form
async function loadPayrollRefData() {
  try {
    const [wageRes, sewRes, logRes] = await Promise.all([
      apiFetch('/api/payroll/wage-types'),
      apiFetch('/api/payroll/sewing-types'),
      apiFetch('/api/payroll/logistics-regions')
    ]);
    
    if (wageRes.ok) {
      wageTypesForPayroll = await wageRes.json();
      populatePayrollWageTypeSelects();
    }
    if (sewRes.ok) sewingTypesForPayroll = await sewRes.json();
    if (logRes.ok) logisticsRegionsForPayroll = await logRes.json();
    
    console.log('✅ Loaded payroll ref data');
  } catch (e) {
    console.error('❌ Failed to load payroll ref data:', e);
  }
}

// Load current payroll configuration for employee
async function loadEmpPayrollConfig(employeeId) {
  try {
    const res = await apiFetch(`/api/payroll/employees/${employeeId}/wage-config`);
    if (!res.ok) {
      console.log('No wage config found for employee');
      document.getElementById('emp-payroll-wage-type').textContent = '—';
      document.getElementById('emp-payroll-rate').textContent = '₱0.00';
      document.getElementById('emp-payroll-wage-select').value = '';
      return;
    }
    
    const config = await res.json();
    console.log('Loaded payroll config:', config);
    
    document.getElementById('emp-payroll-wage-type').textContent = config.wage_type || '—';
    document.getElementById('emp-payroll-rate').textContent = `₱${parseFloat(config.current_rate || 0).toLocaleString('en-US', {minimumFractionDigits: 2})}`;
    
    // Set wage type select from DB-backed wage type list
    const wageValue = config.wage_type_id ? String(config.wage_type_id) : getPayrollWageTypeIdByName(config.wage_type);
    document.getElementById('emp-payroll-wage-select').value = wageValue;
    
    // Populate base rate
    if (config.rates && config.rates.length > 0) {
      const firstRate = config.rates[0];
      document.getElementById('emp-payroll-primary-rate').value = usesPayrollBaseRate(wageValue) ? (firstRate.base_rate || '') : '';
      
      // Populate hourly and overtime rates if they exist
      if (firstRate.hourly_rate) {
        document.getElementById('emp-payroll-hourly-rate').value = firstRate.hourly_rate;
      }
      if (firstRate.overtime_rate) {
        document.getElementById('emp-payroll-overtime-rate').value = firstRate.overtime_rate;
      }
    }
    
    // Trigger change to show appropriate form
    if (wageValue) {
      document.getElementById('emp-payroll-wage-select').dispatchEvent(new Event('change'));
    } else {
      setPayrollBaseRateVisibility('');
    }
  } catch (e) {
    console.error('Error loading payroll config:', e);
  }
}

// Handle wage type selection in payroll tab
document.addEventListener('change', (e) => {
  if (e.target.id === 'emp-payroll-wage-select') {
    const wageTypeId = e.target.value;
    setPayrollBaseRateVisibility(wageTypeId);
    
    // Hide all specialized sections
    document.getElementById('emp-payroll-hourly-section').style.display = 'none';
    document.getElementById('emp-payroll-sewing-section').style.display = 'none';
    document.getElementById('emp-payroll-logistics-section').style.display = 'none';
    
    // Show appropriate section based on wage type
    if (isPayrollWageType(wageTypeId, 'Hourly')) {
      // Hourly
      document.getElementById('emp-payroll-hourly-section').style.display = 'block';
    } else if (isPayrollWageType(wageTypeId, 'Per-Piece')) {
      // Per-Piece
      document.getElementById('emp-payroll-sewing-section').style.display = 'block';
      renderEmpPayrollSewingTypes();
    } else if (isPayrollWageType(wageTypeId, 'Per-Trip')) {
      // Per-Trip
      document.getElementById('emp-payroll-logistics-section').style.display = 'block';
      renderEmpPayrollLogisticsRegions();
    }
  }
});

// Render sewing type inputs
function renderEmpPayrollSewingTypes() {
  const container = document.getElementById('emp-payroll-sewing-items');
  container.innerHTML = sewingTypesForPayroll.map(sewing => `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: end; margin-bottom: 12px;">
      <div>
        <label style="display: block; font-size: 10px; color: var(--muted); margin-bottom: 4px;">${sewing.name}</label>
        <input type="text" disabled value="${sewing.description || ''}" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--muted); font-size: 11px;" />
      </div>
      <div>
        <label style="display: block; font-size: 10px; color: var(--muted); margin-bottom: 4px;">Rate (₱)</label>
        <input type="number" class="emp-payroll-rate-input" data-sewing-id="${sewing.id}" min="0" step="0.01" placeholder="${sewing.default_rate || '0.00'}" value="${sewing.default_rate || ''}" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; color: var(--text); background: var(--bg);" />
      </div>
    </div>
  `).join('');
}

// Render logistics region inputs
function renderEmpPayrollLogisticsRegions() {
  const container = document.getElementById('emp-payroll-logistics-items');
  container.innerHTML = logisticsRegionsForPayroll.map(region => `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: end; margin-bottom: 12px;">
      <div>
        <label style="display: block; font-size: 10px; color: var(--muted); margin-bottom: 4px;">${region.name}</label>
        <input type="text" disabled value="${region.description || ''}" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--muted); font-size: 11px;" />
      </div>
      <div>
        <label style="display: block; font-size: 10px; color: var(--muted); margin-bottom: 4px;">Rate (₱)</label>
        <input type="number" class="emp-payroll-rate-input" data-region-id="${region.id}" min="0" step="0.01" placeholder="${region.default_rate || '0.00'}" value="${region.default_rate || ''}" style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 4px; color: var(--text); background: var(--bg);" />
      </div>
    </div>
  `).join('');
}

// Save payroll compensation
async function saveEmpPayrollConfig() {
  console.log('\n🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦');
  console.log('🔵 saveEmpPayrollConfig() CALLED - Form Save Started');
  console.log('🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦🟦\n');
  
  if (!currentEmployeeForModal) {
    console.error('❌ No employee selected');
    alert('❌ No employee selected');
    return;
  }
  
  console.log('✅ Employee found:', currentEmployeeForModal.first_name, currentEmployeeForModal.last_name);
  
  const wageTypeSelect = document.getElementById('emp-payroll-wage-select');
  if (!wageTypeSelect) {
    console.error('❌ Wage type select element not found!');
    await showAlert('❌ Form error: wage type selector not found', 'Error', 'error');
    return;
  }
  
  const wageTypeId = wageTypeSelect.value;
  if (!wageTypeId) {
    console.warn('❌ No wage type selected - User must select a wage type first');
    await showAlert('❌ Please select a wage type first', 'Warning', 'warning');
    return;
  }
  
  console.log('✅ Wage Type ID Selected:', wageTypeId);
  const wageTypeName = getPayrollWageTypeNameById(wageTypeId);
  console.log('   Wage Type Name:', wageTypeName);
  
  const primaryRateElement = document.getElementById('emp-payroll-primary-rate');
  const primaryRateValue = primaryRateElement?.value || '';
  const primaryRate = primaryRateValue ? parseFloat(primaryRateValue) : 0;
  
  const hourlyRateElement = document.getElementById('emp-payroll-hourly-rate');
  const hourlyRateValue = hourlyRateElement?.value || '';
  const hourlyRate = hourlyRateValue ? parseFloat(hourlyRateValue) : 0;
  
  const overtimeRateElement = document.getElementById('emp-payroll-overtime-rate');
  const overtimeRateValue = overtimeRateElement?.value || '';
  const overtimeRate = overtimeRateValue ? parseFloat(overtimeRateValue) : 0;
  
  console.log('📋 Form Values Read:');
  console.log('   Base/Primary Rate:', primaryRate);
  console.log('   Hourly Rate:', hourlyRate);
  console.log('   Overtime Rate:', overtimeRate);
  
  console.log('\n📊 COLLECTING RATES...');
  // Collect rates based on wage type
  const rates = [];
  
  // For Hourly wage type (2)
  if (isPayrollWageType(wageTypeId, 'Hourly')) {
    console.log('→ Collecting HOURLY rates...');
    if (hourlyRate <= 0) {
      console.error('❌ VALIDATION FAILED: Hourly rate must be > 0, got:', hourlyRate);
      await showAlert('❌ For Hourly wage: Please enter a VALID hourly rate (must be greater than 0)', 'Validation Error', 'warning');
      return;
    }
    console.log('   ✅ Hourly rate is valid:', hourlyRate);
    rates.push({
      rate: hourlyRate,
      base_rate: primaryRate || hourlyRate,
      hourly_rate: hourlyRate,
      overtime_rate: overtimeRate || 0,
      sewing_type_id: null,
      logistics_region_id: null
    });
    console.log('   ✅ Hourly rate added to rates array');
  } else if (isPayrollWageType(wageTypeId, 'Per-Piece') || isPayrollWageType(wageTypeId, 'Per-Trip')) {
    // For Per-Piece or Per-Trip - collect from dynamic inputs
    console.log('→ Collecting ' + (isPayrollWageType(wageTypeId, 'Per-Piece') ? 'PER-PIECE' : 'PER-TRIP') + ' rates...');
    const inputs = document.querySelectorAll('.emp-payroll-rate-input');
    console.log('   Found', inputs.length, 'rate input(s)');
    
    inputs.forEach((input, idx) => {
      const rate = parseFloat(input.value) || 0;
      const sewingId = input.getAttribute('data-sewing-id');
      const regionId = input.getAttribute('data-region-id');
      
      if (rate > 0) {
        console.log(`   ✅ Rate ${idx + 1}: ${rate} (sewing: ${sewingId}, region: ${regionId})`);
        rates.push({
          rate,
          base_rate: null,
          hourly_rate: null,
          overtime_rate: null,
          sewing_type_id: sewingId ? parseInt(sewingId) : null,
          logistics_region_id: regionId ? parseInt(regionId) : null
        });
      } else {
        console.log(`   ⊘ Rate ${idx + 1}: EMPTY (0 or not filled)`);
      }
    });
  } else {
    if (!isPayrollWageType(wageTypeId, 'Daily')) {
      await showAlert('Base salary is only supported through Daily or Hourly payroll setup.', 'Validation Error', 'warning');
      return;
    }
    // Base Salary (1) or others
    console.log('→ Collecting BASE SALARY rates...');
    if (primaryRate <= 0) {
      console.error('❌ VALIDATION FAILED: Base salary must be > 0, got:', primaryRate);
      await showAlert('❌ For ' + (wageTypeName || 'selected wage type') + ': Please enter a VALID rate (must be greater than 0)', 'Validation Error', 'warning');
      return;
    }
    console.log('   ✅ Base salary is valid:', primaryRate);
    rates.push({
      rate: primaryRate,
      base_rate: primaryRate,
      hourly_rate: null,
      overtime_rate: null,
      sewing_type_id: null,
      logistics_region_id: null
    });
  }
  
  if (rates.length === 0) {
    await showAlert('❌ Please enter at least one rate value', 'Validation Error', 'warning');
    console.warn('No rates to save:', { wageTypeId, primaryRate, hourlyRate, overtimeRate });
    return;
  }
  
  const payload = { wage_type_id: parseInt(wageTypeId), rates };
  console.log('═══════════════════════════════════════════════════════════');
  console.log('💾 SAVING PAYROLL CONFIG');
  console.log('───────────────────────────────────────────────────────────');
  console.log('Employee ID:', currentEmployeeForModal.id);
  console.log('Employee: ' + currentEmployeeForModal.first_name + ' ' + currentEmployeeForModal.last_name);
  console.log('Wage Type ID:', wageTypeId);
  console.log('Rates to save:', rates);
  console.log('Payload:', JSON.stringify(payload, null, 2));
  console.log('═══════════════════════════════════════════════════════════');
  
  try {
    const res = await apiFetch(`/api/payroll/employees/${currentEmployeeForModal.id}/wage-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    console.log('Response status:', res.status, res.ok ? '✅ OK' : '❌ ERROR');
    
    const responseData = await res.json();
    console.log('Response data:', responseData);
    
    if (res.ok) {
      console.log('✅ SUCCESS - ratesSaved:', responseData.ratesSaved);
      alert(`✅ Payroll configuration saved!\n✓ ${responseData.ratesSaved} rate(s) saved to database for:\n${currentEmployeeForModal.first_name} ${currentEmployeeForModal.last_name}`);
      await loadEmpPayrollConfig(currentEmployeeForModal.id);
    } else {
      console.error('❌ Save failed with status:', res.status);
      alert('❌ Failed to save compensation\n\nError: ' + (responseData.error || 'Unknown error'));
    }
  } catch (e) {
    console.error('❌ Exception during save:', e);
    alert('❌ Error saving configuration: ' + e.message);
  }
}

// ============================================================
// EMPLOYEE PHOTO MANAGEMENT
// ============================================================

async function loadEmployeePhotoPreview(employeeId) {
  try {
    const response = await apiFetch(`/api/employees/${employeeId}/photo`);
    if (response && response.ok) {
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const preview = document.getElementById('edit-emp-photo-preview');
      const noPhoto = document.getElementById('edit-emp-no-photo');
      
      preview.src = url;
      preview.style.display = 'block';
      noPhoto.style.display = 'none';
    } else {
      // No photo found
      document.getElementById('edit-emp-photo-preview').style.display = 'none';
      document.getElementById('edit-emp-no-photo').style.display = 'flex';
    }
  } catch (err) {
    console.log('No photo found for employee:', err.message);
    document.getElementById('edit-emp-photo-preview').style.display = 'none';
    document.getElementById('edit-emp-no-photo').style.display = 'flex';
  }
}

async function uploadEmployeePhoto() {
  if (!currentEditingEmployeeId) {
    await showAlert('No employee selected', 'Error', 'error');
    return;
  }

  const fileInput = document.getElementById('edit-emp-photo-input');
  if (!fileInput.files || fileInput.files.length === 0) {
    await showAlert('Please select a photo to upload', 'Warning', 'warning');
    return;
  }

  const file = fileInput.files[0];
  
  // Validate file size (5MB)
  if (file.size > 5 * 1024 * 1024) {
    await showAlert('File size exceeds 5MB limit', 'Error', 'error');
    return;
  }

  // Validate file type
  if (!['image/jpeg', 'image/png', 'image/jpg'].includes(file.type)) {
    await showAlert('Only JPG, JPEG, and PNG files are allowed', 'Error', 'error');
    return;
  }

  try {
    const formData = new FormData();
    formData.append('photo', file);

    const response = await apiFetch(`/api/employees/${currentEditingEmployeeId}/photo`, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to upload photo');
    }

    await showAlert('Photo uploaded successfully!', 'Success', 'success');
    
    // Reload photo preview
    await loadEmployeePhotoPreview(currentEditingEmployeeId);
    window.dispatchEvent(new CustomEvent('profilePhotoUpdated', {
      detail: { employeeId: Number(currentEditingEmployeeId) }
    }));
    
    // Clear file input
    fileInput.value = '';
  } catch (error) {
    console.error('Error uploading photo:', error);
    await showAlert('Failed to upload photo: ' + error.message, 'Error', 'error');
  }
}

async function deleteEmployeePhoto() {
  if (!currentEditingEmployeeId) {
    await showAlert('No employee selected', 'Error', 'error');
    return;
  }

  const confirmed = await showConfirm('Are you sure you want to delete this employee photo?', 'Delete Photo', 'Delete', 'Cancel');
  if (!confirmed) return;

  try {
    const response = await apiFetch(`/api/employees/${currentEditingEmployeeId}/photo`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to delete photo');
    }

    await showAlert('Photo deleted successfully', 'Success', 'success');
    
    // Reset preview
    document.getElementById('edit-emp-photo-preview').style.display = 'none';
    document.getElementById('edit-emp-no-photo').style.display = 'flex';
    window.dispatchEvent(new CustomEvent('profilePhotoUpdated', {
      detail: { employeeId: Number(currentEditingEmployeeId) }
    }));
    
    // Clear file input
    document.getElementById('edit-emp-photo-input').value = '';
  } catch (error) {
    console.error('Error deleting photo:', error);
    await showAlert('Failed to delete photo: ' + error.message, 'Error', 'error');
  }
}

// ============================================================
// EMPLOYEE PROFILE PAGE
// ============================================================

let currentProfileEmployee = null;
let currentProfileTab = 'personal';
let currentProfilePhotoUrl = null;
let currentProfileFamilyMembers = [];
let currentProfileWorkExperiences = [];
let currentProfileCertifications = [];
let currentProfileTrainings = [];

const PROFILE_TABS = new Set([
  'personal',
  'contact',
  'employment',
  'family',
  'education',
  'experience',
  'documents',
  'bank-tax',
  'leave'
]);
const PROFILE_TABLE_ONLY_TABS = new Set(['family', 'experience']);

function openEmployeeProfile(employeeId, tab = 'personal') {
  navigate('employee-profile', null, { employeeId, tab });
}

async function loadEmployeeProfilePage(params = {}) {
  const employeeId = params.employeeId || window.ROUTE_PARAMS?.employeeId || currentProfileEmployee?.id;
  const selectedTab = normalizeProfileTab(params.tab || window.ROUTE_PARAMS?.tab || currentProfileTab || 'personal');

  if (!employeeId) {
    renderProfileEmpty('Select an employee from the directory to view a profile.');
    return;
  }

  if (!EMPLOYEES_RAW.length) {
    await fetchEmployees();
  }

  currentProfileEmployee = EMPLOYEES_RAW.find(emp => String(emp.id) === String(employeeId));
  window.currentProfileEmployee = currentProfileEmployee;

  if (!currentProfileEmployee) {
    renderProfileEmpty('Employee profile not found.');
    return;
  }

  renderProfileSummary(currentProfileEmployee);
  renderProfileTabs(currentProfileEmployee);
  populateProfileEditForm(currentProfileEmployee);
  loadProfilePhoto(currentProfileEmployee.id);
  loadProfileFamilyMembers(currentProfileEmployee.id);
  loadProfileWorkExperiences(currentProfileEmployee.id);
  loadProfileEducationTraining(currentProfileEmployee.id);
  loadProfileDocuments(currentProfileEmployee);
  loadProfileLeaveHistory(currentProfileEmployee);
  switchProfileTab(selectedTab);
}

function normalizeProfileTab(tabName) {
  return PROFILE_TABS.has(tabName) ? tabName : 'personal';
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = formatValue(value);
}

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '-';
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return '-';
    const isoDate = trimmed.match(/^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/);
    if (isoDate) return isoDate[1];
  }
  return String(value);
}

function escapeHtml(value) {
  return formatValue(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function field(label, value) {
  return `
    <div class="profile-field">
      <span class="profile-label">${escapeHtml(label)}</span>
      <span class="profile-value">${escapeHtml(value)}</span>
    </div>
  `;
}

function renderProfileEmpty(message) {
  const panel = document.getElementById('profile-tab-personal');
  if (panel) panel.innerHTML = `<div class="profile-empty">${escapeHtml(message)}</div>`;
}

function getEmployeeFullName(employee) {
  return [
    employee.first_name,
    employee.middle_name,
    employee.last_name,
    employee.suffix
  ].filter(Boolean).join(' ') || 'Employee';
}

function renderProfileSummary(employee) {
  const initials = `${employee.first_name?.[0] || ''}${employee.last_name?.[0] || ''}`.toUpperCase() || '--';
  const employeeName = getEmployeeFullName(employee);
  setText('profile-initials', initials);
  setText('profile-title-name', employeeName);
  setText('profile-company', 'Marulas Industrial Corp');
  setText('profile-emp-id', employee.employee_code || employee.id);
  setText('profile-dob', employee.date_of_birth);
  setText('profile-email', employee.email);
  setText('profile-phone', employee.contact_number);
  setText('profile-joined', employee.date_hired);

  const pageTitle = document.getElementById('page-title');
  if (pageTitle) pageTitle.textContent = 'Employee Profile';
}

function renderProfileTabs(employee) {
  const personal = document.getElementById('profile-tab-personal');
  const contact = document.getElementById('profile-tab-contact');
  const employment = document.getElementById('profile-tab-employment');
  const family = document.getElementById('profile-tab-family');
  const education = document.getElementById('profile-tab-education');
  const experience = document.getElementById('profile-tab-experience');
  const documents = document.getElementById('profile-tab-documents');
  const bankTax = document.getElementById('profile-tab-bank-tax');
  const leave = document.getElementById('profile-tab-leave');

  if (personal) {
    personal.innerHTML = `
      <section class="profile-section">
        <div class="profile-field-grid">
          ${field('First Name', employee.first_name)}
          ${field('Middle Name', employee.middle_name)}
          ${field('Last Name', employee.last_name)}
          ${field('Suffix', employee.suffix)}
          ${field('Date of Birth', employee.date_of_birth)}
          ${field('Place of Birth', employee.place_of_birth)}
          ${field('Gender', employee.gender)}
          ${field('Nationality', employee.nationality || 'Filipino')}
          ${field('Civil Status', employee.marital_status)}
          ${field('Blood Type', employee.blood_type)}
          ${field('Religion', employee.religion)}
          ${field('Home Address', employee.residential_address)}
          ${field('Current Address', employee.current_address)}
        </div>
      </section>
    `;
  }

  if (employment) {
    employment.innerHTML = `
      <section class="profile-section">
        <h2 class="profile-section-title">Employment Information</h2>
        <div class="profile-field-grid">
          ${field('Department', employee.department)}
          ${field('Employment Status', employee.status)}
          ${field('Job Title / Position', employee.position)}
          ${field('Employee Type', employee.employment_type)}
          ${field('Hiring Classification', employee.hiring_type || 'Direct Hire')}
          ${field('Agency Name', employee.agency_name)}
          ${field('Agency Contact Person', employee.agency_contact_person)}
          ${field('Agency Contact Number', employee.agency_contact_number)}
          ${field('Deployment Status', employee.deployment_status)}
          ${field('Contract Start', employee.contract_start_date)}
          ${field('Contract End', employee.contract_end_date || employee.end_of_contract)}
          ${field('Date Hired', employee.date_hired)}
          ${field('End of Contract', employee.end_of_contract)}
          ${field('Immediate Supervisor', employee.supervisor)}
          ${field('Work Location', employee.work_location)}
          ${field('Shift Schedule', employee.shift_schedule)}
          ${field('Employee Level', employee.employee_level)}
          ${field('Employment History', employee.employment_history)}
        </div>
      </section>
    `;
  }

  if (contact) {
    contact.innerHTML = `
      <section class="profile-section">
        <h2 class="profile-section-title">Primary Contact Info</h2>
        <div class="profile-field-grid">
          ${field('Full Legal Name', getEmployeeFullName(employee))}
          ${field('Permanent Home Address', employee.residential_address)}
          ${field('Mailing Address', employee.mailing_address || employee.residential_address)}
          ${field('Personal Mobile Number', employee.contact_number)}
          ${field('Personal Email Address', employee.email)}
          ${field('Work Email Address', employee.work_email)}
        </div>
      </section>
      <section class="profile-section">
        <h2 class="profile-section-title">Emergency Contacts</h2>
        <div class="profile-field-grid">
          ${field('Contact Name(s)', employee.emergency_contact_name)}
          ${field('Relationship to Employee', employee.emergency_contact_relationship)}
          ${field('Primary Phone Number', employee.emergency_contact_num)}
          ${field('Secondary Phone Number', employee.emergency_contact_secondary_num)}
          ${field('Alternative Email Address', employee.emergency_contact_email)}
          ${field('Residential Address', employee.emergency_contact_address)}
        </div>
      </section>
    `;
  }

  if (family) {
    family.innerHTML = `
      <div class="profile-family-surface">
        <div class="profile-family-toolbar">
          <button class="profile-family-add" type="button" onclick="openFamilyModal()">+ Family</button>
          <label style="display:flex;gap:8px;align-items:center;color:#1b2430;font-size:13px;">
            Search:
            <input id="profile-family-search" class="profile-family-search" type="search" oninput="renderFamilyMembersTable()" />
          </label>
        </div>
        <div class="profile-family-table-wrap">
          <table class="profile-family-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Full Name</th>
                <th>Relationship</th>
                <th>Date of Birth</th>
                <th>Deceased</th>
              </tr>
            </thead>
            <tbody id="profile-family-tbody">
              <tr><td colspan="5" style="text-align:center;">Loading family records...</td></tr>
            </tbody>
          </table>
        </div>
        <div class="profile-family-footer">
          <span id="profile-family-count">Showing 0 to 0 of 0 entries</span>
          <span>
            <button class="btn btn-outline" type="button" disabled>Previous</button>
            <button class="btn btn-outline" type="button" disabled>Next</button>
          </span>
        </div>
      </div>
    `;
  }

  renderFamilyMembersTable();

  if (education) {
    education.innerHTML = `
      <section class="profile-section">
        <h2 class="profile-section-title">Educational Background</h2>
      </section>
      <div class="profile-record-list">
        <div class="profile-record">
          ${field('Level', 'Junior High School')}
          ${field('School', employee.education_jhs_school)}
          ${field('Highest Educational Attainment', employee.education_jhs_attainment)}
          ${field('From', employee.education_jhs_from)}
          ${field('To', employee.education_jhs_to)}
          ${field('Year Graduated', employee.education_jhs_year_graduated)}
        </div>
        <div class="profile-record">
          ${field('Level', 'Senior High School')}
          ${field('School', employee.education_shs_school)}
          ${field('Highest Educational Attainment / Strand', employee.education_shs_attainment)}
          ${field('From', employee.education_shs_from)}
          ${field('To', employee.education_shs_to)}
          ${field('Year Graduated', employee.education_shs_year_graduated)}
        </div>
        <div class="profile-record">
          ${field('Level', 'Vocational / Technical')}
          ${field('School', employee.education_vocational_school)}
          ${field('Attainment / Course', employee.education_vocational_attainment)}
          ${field('Units / Hours Taken', employee.education_vocational_units)}
          ${field('From', employee.education_vocational_from)}
          ${field('To', employee.education_vocational_to)}
          ${field('Year Graduated', employee.education_vocational_year_graduated)}
        </div>
        <div class="profile-record">
          ${field('Level', 'College')}
          ${field('School', employee.education_college_school || employee.education_school)}
          ${field('Highest Educational Attainment / Course', employee.education_college_attainment || employee.education_attainment)}
          ${field('Units Taken', employee.education_college_units || employee.education_units)}
          ${field('From', employee.education_college_from)}
          ${field('To', employee.education_college_to)}
          ${field('Year Graduated', employee.education_college_year_graduated || employee.education_year_graduated)}
        </div>
      </div>
      <div class="profile-family-surface" style="margin-top:18px;">
        <div class="profile-family-toolbar">
          <button class="profile-family-add" type="button" onclick="openCertificationModal()">+ Certification</button>
          <strong style="color:#1b2430;">Certifications</strong>
        </div>
        <div class="profile-family-table-wrap">
          <table class="profile-family-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Certification</th>
                <th>Issuer</th>
                <th>Issue Date</th>
                <th>Expiry Date</th>
                <th>Certificate</th>
              </tr>
            </thead>
            <tbody id="profile-certifications-tbody">
              <tr><td colspan="6" style="text-align:center;">Loading certifications...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="profile-family-surface" style="margin-top:18px;">
        <div class="profile-family-toolbar">
          <button class="profile-family-add" type="button" onclick="openTrainingModal()">+ Training</button>
          <strong style="color:#1b2430;">Trainings Attended</strong>
        </div>
        <div class="profile-family-table-wrap">
          <table class="profile-family-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Training</th>
                <th>Provider</th>
                <th>From</th>
                <th>To</th>
                <th>Hours</th>
              </tr>
            </thead>
            <tbody id="profile-trainings-tbody">
              <tr><td colspan="6" style="text-align:center;">Loading trainings...</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  renderCertificationsTable();
  renderTrainingsTable();

  if (experience) {
    experience.innerHTML = `
      <div class="profile-family-surface">
        <div class="profile-family-toolbar">
          <button class="profile-family-add" type="button" onclick="openExperienceModal()">+ Experience</button>
          <label style="display:flex;gap:8px;align-items:center;color:#1b2430;font-size:13px;">
            Search:
            <input id="profile-experience-search" class="profile-family-search" type="search" oninput="renderWorkExperiencesTable()" />
          </label>
        </div>
        <div class="profile-family-table-wrap">
          <table class="profile-family-table">
            <thead>
              <tr>
                <th>Action</th>
                <th>Company</th>
                <th>Position</th>
                <th>Employment Type</th>
                <th>From</th>
                <th>To</th>
              </tr>
            </thead>
            <tbody id="profile-experience-tbody">
              <tr><td colspan="6" style="text-align:center;">Loading work experiences...</td></tr>
            </tbody>
          </table>
        </div>
        <div class="profile-family-footer">
          <span id="profile-experience-count">Showing 0 to 0 of 0 entries</span>
          <span>
            <button class="btn btn-outline" type="button" disabled>Previous</button>
            <button class="btn btn-outline" type="button" disabled>Next</button>
          </span>
        </div>
      </div>
    `;
  }

  renderWorkExperiencesTable();

  if (documents) {
    documents.innerHTML = `
      <div class="profile-doc-toolbar">
        <h2 class="profile-section-title">Uploaded Documents</h2>
        <button class="profile-doc-upload" type="button" onclick="openEmployeeDocumentUpload()">Upload Document</button>
        <input id="profile-doc-input" type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" hidden onchange="uploadProfileDocument(event)">
      </div>
      <div id="profile-documents-list" class="profile-doc-grid">
        <div class="profile-empty">Loading documents...</div>
      </div>
    `;
  }

  if (bankTax) {
    bankTax.innerHTML = `
      <section class="profile-section">
        <h2 class="profile-section-title">Salary Configuration</h2>
        <div class="profile-field-grid">
          ${field('Wage Type', employee.wage_type)}
          ${field('Basic Salary', employee.basic_salary || employee.base_rate)}
          ${field('Allowances', employee.allowances)}
          ${field('Payroll Schedule', employee.payroll_schedule)}
        </div>
      </section>
      <section class="profile-section">
        <h2 class="profile-section-title">Bank Account</h2>
        <div class="profile-field-grid">
          ${field('Bank Account Number', employee.bank_account ? '****-****-' + String(employee.bank_account).slice(-4) : '-')}
          ${field('Bank Name', employee.bank_name)}
        </div>
      </section>
      <section class="profile-section">
        <h2 class="profile-section-title">Government & Tax Information</h2>
        <div class="profile-field-grid">
          ${field('SSS', employee.sss_number)}
          ${field('PhilHealth', employee.philhealth_number)}
          ${field('Pag-IBIG', employee.pagibig_number)}
          ${field('TIN', employee.tin)}
          ${field('Tax Status', employee.tax_status)}
        </div>
      </section>
    `;
  }

  if (leave) {
    leave.innerHTML = `
      <section class="profile-section">
        <div class="profile-stat-grid">
          <div class="profile-stat"><span class="profile-label">Annual Leave</span><span class="profile-stat-num" id="profile-annual-leave">12</span><span class="profile-label">days remaining</span></div>
          <div class="profile-stat"><span class="profile-label">Sick Leave</span><span class="profile-stat-num" id="profile-sick-leave">8</span><span class="profile-label">days remaining</span></div>
          <div class="profile-stat"><span class="profile-label">Used This Year</span><span class="profile-stat-num" id="profile-used-leave">0</span><span class="profile-label">days total</span></div>
        </div>
      </section>
      <section class="profile-section">
        <h2 class="profile-section-title">Leave Requests & History</h2>
        <div id="profile-leave-list" class="profile-record-list">
          <div class="profile-empty">Loading leave history...</div>
        </div>
      </section>
    `;
  }
}

function switchProfileTab(tabName) {
  currentProfileTab = normalizeProfileTab(tabName);
  if (PROFILE_TABLE_ONLY_TABS.has(currentProfileTab)) {
    toggleProfileEditMode(false, true);
  }

  document.querySelectorAll('.profile-tab-panel').forEach(panel => panel.classList.remove('active'));
  document.querySelectorAll('.profile-edit-tab-panel').forEach(panel => panel.classList.remove('active'));
  document.querySelectorAll('.profile-tab').forEach(btn => btn.classList.remove('active'));

  const panel = document.getElementById(`profile-tab-${currentProfileTab}`);
  const editPanel = document.getElementById(`profile-edit-tab-${currentProfileTab}`);
  const button = document.querySelector(`[data-profile-tab="${currentProfileTab}"]`);
  if (panel) panel.classList.add('active');
  if (editPanel) editPanel.classList.add('active');
  if (button) button.classList.add('active');
}

async function loadProfileEducationTraining(employeeId) {
  const [certifications, trainings] = await Promise.all([
    apiFetch(`/api/employees/${employeeId}/certifications`).then(r => r.ok ? r.json() : []).catch(() => []),
    apiFetch(`/api/employees/${employeeId}/trainings`).then(r => r.ok ? r.json() : []).catch(() => [])
  ]);

  currentProfileCertifications = certifications;
  currentProfileTrainings = trainings;
  renderCertificationsTable();
  renderTrainingsTable();
}

function renderCertificationsTable() {
  const tbody = document.getElementById('profile-certifications-tbody');
  if (!tbody) return;

  if (!currentProfileCertifications.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No data available in table</td></tr>';
    return;
  }

  tbody.innerHTML = currentProfileCertifications.map(item => `
    <tr>
      <td><button class="profile-family-delete" type="button" onclick="deleteCertification(${item.id})">Delete</button></td>
      <td>${escapeHtml(item.certification_name)}</td>
      <td>${escapeHtml(item.issuing_organization)}</td>
      <td>${escapeHtml(item.issue_date)}</td>
      <td>${escapeHtml(item.expiry_date)}</td>
      <td>${item.certificate_file_path ? `<a href="${escapeHtml(item.certificate_file_path)}" target="_blank" rel="noopener">View</a>` : '-'}</td>
    </tr>
  `).join('');
}

function renderTrainingsTable() {
  const tbody = document.getElementById('profile-trainings-tbody');
  if (!tbody) return;

  if (!currentProfileTrainings.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No data available in table</td></tr>';
    return;
  }

  tbody.innerHTML = currentProfileTrainings.map(item => `
    <tr>
      <td><button class="profile-family-delete" type="button" onclick="deleteTraining(${item.id})">Delete</button></td>
      <td>${escapeHtml(item.training_name)}</td>
      <td>${escapeHtml(item.provider)}</td>
      <td>${escapeHtml(item.date_from)}</td>
      <td>${escapeHtml(item.date_to)}</td>
      <td>${escapeHtml(item.training_hours)}</td>
    </tr>
  `).join('');
}

function openCertificationModal() {
  document.getElementById('profile-certification-modal')?.classList.add('active');
}

function closeCertificationModal() {
  document.getElementById('profile-certification-modal')?.classList.remove('active');
  ['certification-name', 'certification-organization', 'certification-issue-date', 'certification-expiry-date', 'certification-file'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
}

async function saveCertification() {
  if (!currentProfileEmployee) return;
  const name = document.getElementById('certification-name')?.value || '';
  if (!name) {
    await showAlert('Certification name is required.', 'Validation Error', 'warning');
    return;
  }

  const formData = new FormData();
  formData.append('certification_name', name);
  formData.append('issuing_organization', document.getElementById('certification-organization')?.value || '');
  formData.append('issue_date', document.getElementById('certification-issue-date')?.value || '');
  formData.append('expiry_date', document.getElementById('certification-expiry-date')?.value || '');
  const file = document.getElementById('certification-file')?.files?.[0];
  if (file) formData.append('certificate', file);

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.id}/certifications`, {
      method: 'POST',
      body: formData
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to add certification');
    }
    closeCertificationModal();
    await loadProfileEducationTraining(currentProfileEmployee.id);
    await showAlert('Certification saved successfully.', 'Saved', 'success');
  } catch (error) {
    await showAlert(error.message, 'Error', 'error');
  }
}

async function deleteCertification(certificationId) {
  if (!currentProfileEmployee) return;
  const confirmed = await showConfirm('Delete this certification?', 'Delete Certification', 'Delete', 'Cancel');
  if (!confirmed) return;

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.id}/certifications/${certificationId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete certification');
    await loadProfileEducationTraining(currentProfileEmployee.id);
  } catch (error) {
    await showAlert(error.message, 'Error', 'error');
  }
}

function openTrainingModal() {
  document.getElementById('profile-training-modal')?.classList.add('active');
}

function closeTrainingModal() {
  document.getElementById('profile-training-modal')?.classList.remove('active');
  ['training-name', 'training-provider', 'training-date-from', 'training-date-to', 'training-hours', 'training-remarks'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
}

async function saveTraining() {
  if (!currentProfileEmployee) return;
  const payload = {
    training_name: document.getElementById('training-name')?.value || '',
    provider: document.getElementById('training-provider')?.value || null,
    date_from: document.getElementById('training-date-from')?.value || null,
    date_to: document.getElementById('training-date-to')?.value || null,
    training_hours: document.getElementById('training-hours')?.value || null,
    remarks: document.getElementById('training-remarks')?.value || null
  };

  if (!payload.training_name) {
    await showAlert('Training name is required.', 'Validation Error', 'warning');
    return;
  }

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.id}/trainings`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to add training');
    }
    closeTrainingModal();
    await loadProfileEducationTraining(currentProfileEmployee.id);
    await showAlert('Training saved successfully.', 'Saved', 'success');
  } catch (error) {
    await showAlert(error.message, 'Error', 'error');
  }
}

async function deleteTraining(trainingId) {
  if (!currentProfileEmployee) return;
  const confirmed = await showConfirm('Delete this training?', 'Delete Training', 'Delete', 'Cancel');
  if (!confirmed) return;

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.id}/trainings/${trainingId}`, { method: 'DELETE' });
    if (!response.ok) throw new Error('Failed to delete training');
    await loadProfileEducationTraining(currentProfileEmployee.id);
  } catch (error) {
    await showAlert(error.message, 'Error', 'error');
  }
}

function getFamilyFullName(member) {
  return [
    member.first_name,
    member.middle_name,
    member.last_name,
    member.extension_name
  ].filter(Boolean).join(' ') || '-';
}

async function loadProfileFamilyMembers(employeeId) {
  try {
    const response = await apiFetch(`/api/employees/${employeeId}/family`);
    if (!response.ok) throw new Error('Failed to load family records');
    currentProfileFamilyMembers = await response.json();
  } catch (error) {
    console.error('Family records load error:', error);
    currentProfileFamilyMembers = [];
  }

  renderFamilyMembersTable();
}

function renderFamilyMembersTable() {
  const tbody = document.getElementById('profile-family-tbody');
  const count = document.getElementById('profile-family-count');
  if (!tbody) return;

  const search = document.getElementById('profile-family-search')?.value.toLowerCase() || '';
  const rows = currentProfileFamilyMembers.filter(member => {
    const haystack = [
      getFamilyFullName(member),
      member.relationship_type,
      member.date_of_birth,
      member.deceased ? 'yes' : 'no'
    ].join(' ').toLowerCase();
    return haystack.includes(search);
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">No data available in table</td></tr>';
    if (count) count.textContent = 'Showing 0 to 0 of 0 entries';
    return;
  }

  tbody.innerHTML = rows.map(member => `
    <tr>
      <td>
        <button class="profile-family-delete" type="button" onclick="deleteFamilyMember(${member.id})">Delete</button>
      </td>
      <td>${escapeHtml(getFamilyFullName(member))}</td>
      <td>${escapeHtml(member.relationship_type)}</td>
      <td>${escapeHtml(member.date_of_birth)}</td>
      <td>${member.deceased ? 'Yes' : 'No'}</td>
    </tr>
  `).join('');

  if (count) count.textContent = `Showing 1 to ${rows.length} of ${rows.length} entries`;
}

function openFamilyModal() {
  const modal = document.getElementById('profile-family-modal');
  if (modal) modal.classList.add('active');
}

function closeFamilyModal() {
  const modal = document.getElementById('profile-family-modal');
  if (modal) modal.classList.remove('active');
  clearFamilyForm();
}

function clearFamilyForm() {
  [
    'family-extension-name',
    'family-telephone-number',
    'family-first-name',
    'family-date-of-birth',
    'family-business-address',
    'family-middle-name',
    'family-occupation',
    'family-last-name',
    'family-employer-name'
  ].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });

  const relationship = document.getElementById('family-relationship-type');
  const deceased = document.getElementById('family-deceased');
  if (relationship) relationship.value = 'Child';
  if (deceased) deceased.value = '0';
}

async function saveFamilyMember() {
  if (!currentProfileEmployee) return;

  const payload = {
    relationship_type: document.getElementById('family-relationship-type')?.value || '',
    extension_name: document.getElementById('family-extension-name')?.value || null,
    first_name: document.getElementById('family-first-name')?.value || '',
    middle_name: document.getElementById('family-middle-name')?.value || null,
    last_name: document.getElementById('family-last-name')?.value || '',
    date_of_birth: document.getElementById('family-date-of-birth')?.value || null,
    telephone_number: document.getElementById('family-telephone-number')?.value || null,
    business_address: document.getElementById('family-business-address')?.value || null,
    occupation: document.getElementById('family-occupation')?.value || null,
    employer_name: document.getElementById('family-employer-name')?.value || null,
    deceased: document.getElementById('family-deceased')?.value === '1'
  };

  if (!payload.relationship_type || !payload.first_name || !payload.last_name) {
    await showAlert('Relationship type, first name, and last name are required.', 'Validation Error', 'warning');
    return;
  }

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.id}/family`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to add family record');
    }

    closeFamilyModal();
    await loadProfileFamilyMembers(currentProfileEmployee.id);
  } catch (error) {
    await showAlert(error.message, 'Error', 'error');
  }
}

async function deleteFamilyMember(familyId) {
  if (!currentProfileEmployee) return;

  const confirmed = await showConfirm('Delete this family record?', 'Delete Family Record', 'Delete', 'Cancel');
  if (!confirmed) return;

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.id}/family/${familyId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to delete family record');
    }

    await loadProfileFamilyMembers(currentProfileEmployee.id);
  } catch (error) {
    await showAlert(error.message, 'Error', 'error');
  }
}

async function loadProfileWorkExperiences(employeeId) {
  try {
    const response = await apiFetch(`/api/employees/${employeeId}/work-experiences`);
    if (!response.ok) throw new Error('Failed to load work experiences');
    currentProfileWorkExperiences = await response.json();
  } catch (error) {
    console.error('Work experience load error:', error);
    currentProfileWorkExperiences = [];
  }

  renderWorkExperiencesTable();
}

function renderWorkExperiencesTable() {
  const tbody = document.getElementById('profile-experience-tbody');
  const count = document.getElementById('profile-experience-count');
  if (!tbody) return;

  const search = document.getElementById('profile-experience-search')?.value.toLowerCase() || '';
  const rows = currentProfileWorkExperiences.filter(item => {
    const haystack = [
      item.company_name,
      item.position_title,
      item.employment_type,
      item.date_from,
      item.date_to
    ].join(' ').toLowerCase();
    return haystack.includes(search);
  });

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No data available in table</td></tr>';
    if (count) count.textContent = 'Showing 0 to 0 of 0 entries';
    return;
  }

  tbody.innerHTML = rows.map(item => `
    <tr>
      <td><button class="profile-family-delete" type="button" onclick="deleteWorkExperience(${item.id})">Delete</button></td>
      <td>${escapeHtml(item.company_name)}</td>
      <td>${escapeHtml(item.position_title)}</td>
      <td>${escapeHtml(item.employment_type)}</td>
      <td>${escapeHtml(item.date_from)}</td>
      <td>${escapeHtml(item.date_to)}</td>
    </tr>
  `).join('');

  if (count) count.textContent = `Showing 1 to ${rows.length} of ${rows.length} entries`;
}

function openExperienceModal() {
  const modal = document.getElementById('profile-experience-modal');
  if (modal) modal.classList.add('active');
}

function closeExperienceModal() {
  const modal = document.getElementById('profile-experience-modal');
  if (modal) modal.classList.remove('active');
  clearExperienceForm();
}

function clearExperienceForm() {
  [
    'experience-company-name',
    'experience-position-title',
    'experience-employment-type',
    'experience-date-from',
    'experience-date-to',
    'experience-supervisor-name',
    'experience-company-address',
    'experience-reason-leaving'
  ].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
}

async function saveWorkExperience() {
  if (!currentProfileEmployee) return;

  const payload = {
    company_name: document.getElementById('experience-company-name')?.value || '',
    position_title: document.getElementById('experience-position-title')?.value || '',
    employment_type: document.getElementById('experience-employment-type')?.value || null,
    date_from: document.getElementById('experience-date-from')?.value || null,
    date_to: document.getElementById('experience-date-to')?.value || null,
    supervisor_name: document.getElementById('experience-supervisor-name')?.value || null,
    company_address: document.getElementById('experience-company-address')?.value || null,
    reason_for_leaving: document.getElementById('experience-reason-leaving')?.value || null
  };

  if (!payload.company_name || !payload.position_title) {
    await showAlert('Company name and position title are required.', 'Validation Error', 'warning');
    return;
  }

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.id}/work-experiences`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to add work experience');
    }

    closeExperienceModal();
    await loadProfileWorkExperiences(currentProfileEmployee.id);
  } catch (error) {
    await showAlert(error.message, 'Error', 'error');
  }
}

async function deleteWorkExperience(experienceId) {
  if (!currentProfileEmployee) return;

  const confirmed = await showConfirm('Delete this work experience?', 'Delete Work Experience', 'Delete', 'Cancel');
  if (!confirmed) return;

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.id}/work-experiences/${experienceId}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to delete work experience');
    }

    await loadProfileWorkExperiences(currentProfileEmployee.id);
  } catch (error) {
    await showAlert(error.message, 'Error', 'error');
  }
}

function populateProfileEditForm(employee) {
  const values = {
    'profile-edit-first-name': employee.first_name,
    'profile-edit-middle-name': employee.middle_name,
    'profile-edit-last-name': employee.last_name,
    'profile-edit-suffix': employee.suffix || 'None',
    'profile-edit-email': employee.email,
    'profile-edit-work-email': employee.work_email,
    'profile-edit-phone': employee.contact_number,
    'profile-edit-nationality': employee.nationality || 'Filipino',
    'profile-edit-dob': formatValue(employee.date_of_birth) === '-' ? '' : formatValue(employee.date_of_birth),
    'profile-edit-place-of-birth': employee.place_of_birth,
    'profile-edit-gender': employee.gender,
    'profile-edit-marital-status': employee.marital_status,
    'profile-edit-blood-type': employee.blood_type,
    'profile-edit-religion': employee.religion,
    'profile-edit-address': employee.residential_address,
    'profile-edit-current-address': employee.current_address,
    'profile-edit-mailing-address': employee.mailing_address,
    'profile-edit-department': employee.department,
    'profile-edit-position': employee.position,
    'profile-edit-type': employee.employment_type || 'Full-time',
    'profile-edit-hiring-type': employee.hiring_type || 'Direct Hire',
    'profile-edit-agency-name': employee.agency_name,
    'profile-edit-agency-contact-person': employee.agency_contact_person,
    'profile-edit-agency-contact-number': employee.agency_contact_number,
    'profile-edit-deployment-status': employee.deployment_status || 'Pending Deployment',
    'profile-edit-contract-start-date': formatValue(employee.contract_start_date) === '-' ? '' : formatValue(employee.contract_start_date),
    'profile-edit-contract-end-date': formatValue(employee.contract_end_date) === '-' ? '' : formatValue(employee.contract_end_date),
    'profile-edit-hired': formatValue(employee.date_hired) === '-' ? '' : formatValue(employee.date_hired),
    'profile-edit-end-contract': formatValue(employee.end_of_contract) === '-' ? '' : formatValue(employee.end_of_contract),
    'profile-edit-supervisor': employee.supervisor,
    'profile-edit-location': employee.work_location,
    'profile-edit-shift-schedule': employee.shift_schedule,
    'profile-edit-employee-level': employee.employee_level,
    'profile-edit-employment-history': employee.employment_history,
    'profile-edit-status': employee.employment_status || employee.status || 'Active',
    'profile-edit-separation-date': formatValue(employee.separation_date) === '-' ? '' : formatValue(employee.separation_date),
    'profile-edit-separation-reason': employee.separation_reason,
    'profile-edit-offboarding-remarks': employee.offboarding_remarks,
    'profile-edit-emergency-name': employee.emergency_contact_name,
    'profile-edit-emergency-relationship': employee.emergency_contact_relationship,
    'profile-edit-emergency-phone': employee.emergency_contact_num,
    'profile-edit-emergency-secondary-phone': employee.emergency_contact_secondary_num,
    'profile-edit-emergency-email': employee.emergency_contact_email,
    'profile-edit-emergency-address': employee.emergency_contact_address,
    'profile-edit-education-jhs-school': employee.education_jhs_school,
    'profile-edit-education-jhs-attainment': employee.education_jhs_attainment,
    'profile-edit-education-jhs-from': employee.education_jhs_from,
    'profile-edit-education-jhs-to': employee.education_jhs_to,
    'profile-edit-education-jhs-year-graduated': employee.education_jhs_year_graduated,
    'profile-edit-education-shs-school': employee.education_shs_school,
    'profile-edit-education-shs-attainment': employee.education_shs_attainment,
    'profile-edit-education-shs-from': employee.education_shs_from,
    'profile-edit-education-shs-to': employee.education_shs_to,
    'profile-edit-education-shs-year-graduated': employee.education_shs_year_graduated,
    'profile-edit-education-vocational-school': employee.education_vocational_school,
    'profile-edit-education-vocational-attainment': employee.education_vocational_attainment,
    'profile-edit-education-vocational-units': employee.education_vocational_units,
    'profile-edit-education-vocational-from': employee.education_vocational_from,
    'profile-edit-education-vocational-to': employee.education_vocational_to,
    'profile-edit-education-vocational-year-graduated': employee.education_vocational_year_graduated,
    'profile-edit-education-college-school': employee.education_college_school || employee.education_school,
    'profile-edit-education-college-attainment': employee.education_college_attainment || employee.education_attainment,
    'profile-edit-education-college-units': employee.education_college_units || employee.education_units,
    'profile-edit-education-college-from': employee.education_college_from,
    'profile-edit-education-college-to': employee.education_college_to,
    'profile-edit-education-college-year-graduated': employee.education_college_year_graduated || employee.education_year_graduated,
    'profile-edit-wage-type': employee.wage_type,
    'profile-edit-basic-salary': employee.basic_salary || employee.base_rate,
    'profile-edit-allowances': employee.allowances,
    'profile-edit-payroll-schedule': employee.payroll_schedule,
    'profile-edit-bank-name': employee.bank_name,
    'profile-edit-bank-account': employee.bank_account,
    'profile-edit-tin': employee.tin,
    'profile-edit-sss': employee.sss_number,
    'profile-edit-philhealth': employee.philhealth_number,
    'profile-edit-pagibig': employee.pagibig_number,
    'profile-edit-tax-status': employee.tax_status
  };

  Object.entries(values).forEach(([id, value]) => {
    const input = document.getElementById(id);
    if (input) input.value = value || '';
  });

  if (window.LGSVValidation?.applyPhoneFieldHints) {
    window.LGSVValidation.applyPhoneFieldHints(document.getElementById('profile-edit-root') || document);
  }

  updateProfileBaseSalaryVisibility();
  const profileWageType = document.getElementById('profile-edit-wage-type');
  if (profileWageType) profileWageType.onchange = updateProfileBaseSalaryVisibility;
  const profileStatus = document.getElementById('profile-edit-status');
  if (profileStatus) profileStatus.onchange = toggleProfileOffboardingFields;
  toggleProfileOffboardingFields();

  bindProfileAgencyFields();
  toggleProfileAgencyFields();

  if (typeof bindDepartmentPositionDropdown === 'function') {
    bindDepartmentPositionDropdown('profile-edit-department', 'profile-edit-position', employee.position || '');
  }

  if (window.setAddressSelection) {
    setAddressSelection(document.getElementById('profile-edit-address'), employee.residential_address || '', employee.residential_address_lat, employee.residential_address_lng);
    setAddressSelection(document.getElementById('profile-edit-current-address'), employee.current_address || '', employee.current_address_lat, employee.current_address_lng);
    setAddressSelection(document.getElementById('profile-edit-mailing-address'), employee.mailing_address || '', employee.mailing_address_lat, employee.mailing_address_lng);
  }
  if (window.setPhilippineAddressValues) {
    setPhilippineAddressValues('profile-edit-address', employee);
    setPhilippineAddressValues('profile-edit-current-address', employee);
    setPhilippineAddressValues('profile-edit-mailing-address', employee);
  }

  const currentSame = document.getElementById('profile-current-same-home');
  if (currentSame) currentSame.checked = Number(employee.current_address_same_as_home) === 1;

  const mailingSame = document.getElementById('profile-mailing-same-home');
  if (mailingSame) mailingSame.checked = Number(employee.mailing_address_same_as_home) === 1;

  if (window.initializeEmployeeAddressAutocomplete) {
    initializeEmployeeAddressAutocomplete();
  }
  currentSame?.dispatchEvent(new Event('change'));
  mailingSame?.dispatchEvent(new Event('change'));
}

function updateProfileBaseSalaryVisibility() {
  const wageType = document.getElementById('profile-edit-wage-type')?.value || '';
  const field = document.getElementById('profile-edit-basic-salary-field');
  const input = document.getElementById('profile-edit-basic-salary');
  const shouldShow = usesPayrollBaseRate(wageType);
  if (field) field.style.display = shouldShow ? '' : 'none';
  if (!shouldShow && input) input.value = '';
}

const PROFILE_PAYROLL_ONLY_FIELDS = [
  'wage_type', 'base_rate', 'allowances', 'payroll_schedule',
  'tax_status', 'bank_name', 'bank_account'
];

function canManageProfilePayrollFields() {
  return ['payroll_officer', 'payroll_manager', 'admin', 'system_admin'].includes(getUser()?.role);
}

function applyProfilePayrollFieldAccess() {
  const canManage = canManageProfilePayrollFields();
  [
    'profile-edit-wage-type', 'profile-edit-basic-salary', 'profile-edit-allowances',
    'profile-edit-payroll-schedule', 'profile-edit-bank-name', 'profile-edit-bank-account',
    'profile-edit-tax-status'
  ].forEach(id => {
    const field = document.getElementById(id);
    if (!field) return;
    field.disabled = !canManage;
    field.title = canManage ? '' : 'Managed by Payroll or System Administration.';
  });
}

function removeUnauthorizedProfilePayrollFields(payload) {
  if (canManageProfilePayrollFields()) return payload;
  PROFILE_PAYROLL_ONLY_FIELDS.forEach(field => delete payload[field]);
  return payload;
}

function toggleProfileAgencyFields() {
  const hiringType = document.getElementById('profile-edit-hiring-type')?.value || 'Direct Hire';
  const employmentType = document.getElementById('profile-edit-type')?.value || '';
  const isAgency = hiringType === 'Agency-Hired' || employmentType === 'Contractual';
  const fields = document.getElementById('profile-edit-agency-fields');
  if (!fields) return;

  fields.style.display = isAgency ? 'grid' : 'none';
  fields.querySelectorAll('input, select').forEach(field => {
    field.required = isAgency && ['profile-edit-agency-name', 'profile-edit-agency-contact-person', 'profile-edit-agency-contact-number'].includes(field.id);
    if (!isAgency) field.required = false;
  });
}

function bindProfileAgencyFields() {
  const hiringType = document.getElementById('profile-edit-hiring-type');
  const employmentType = document.getElementById('profile-edit-type');
  if (hiringType && !hiringType.dataset.agencyListenerAttached) {
    hiringType.dataset.agencyListenerAttached = '1';
    hiringType.addEventListener('change', () => {
      if (hiringType.value === 'Agency-Hired' && employmentType) employmentType.value = 'Contractual';
      toggleProfileAgencyFields();
    });
  }
  if (employmentType && !employmentType.dataset.agencyListenerAttached) {
    employmentType.dataset.agencyListenerAttached = '1';
    employmentType.addEventListener('change', toggleProfileAgencyFields);
  }
}

function toggleProfileEditMode(forceState = null, skipTabSync = false) {
  const view = document.getElementById('profile-view-root');
  const edit = document.getElementById('profile-edit-root');
  const page = document.querySelector('.profile-page');
  let nextState = forceState === null ? !edit?.classList.contains('active') : !!forceState;

  if (nextState && PROFILE_TABLE_ONLY_TABS.has(currentProfileTab)) {
    nextState = false;
  }

  if (view) view.classList.toggle('hidden', nextState);
  if (edit) edit.classList.toggle('active', nextState);
  if (page) page.classList.toggle('profile-editing', nextState);
  if (nextState) applyProfilePayrollFieldAccess();
  if (!skipTabSync) switchProfileTab(currentProfileTab);
}

function focusProfileEditField(field) {
  const fieldToId = {
    contact_number: 'profile-edit-phone',
    emergency_contact_num: 'profile-edit-emergency-phone',
    emergency_contact_secondary_num: 'profile-edit-emergency-secondary-phone',
    agency_contact_number: 'profile-edit-agency-contact-number',
    sss_number: 'profile-edit-sss',
    tin: 'profile-edit-tin',
    philhealth_number: 'profile-edit-philhealth',
    pagibig_number: 'profile-edit-pagibig',
    base_rate: 'profile-edit-basic-salary',
    allowances: 'profile-edit-allowances',
    bank_account: 'profile-edit-bank-account',
    status: 'profile-edit-status',
    employment_status: 'profile-edit-status',
    separation_date: 'profile-edit-separation-date',
    separation_reason: 'profile-edit-separation-reason',
    offboarding_remarks: 'profile-edit-offboarding-remarks'
  };
  const element = document.getElementById(fieldToId[field] || `profile-edit-${String(field || '').replace(/_/g, '-')}`);
  if (!element) return;
  const panel = element.closest('.profile-edit-tab-panel');
  if (panel?.id && typeof switchProfileTab === 'function') {
    switchProfileTab(panel.id.replace(/^profile-edit-tab-/, ''));
  }
  element.classList.add('input-validation-error');
  setTimeout(() => element.focus?.({ preventScroll: false }), 120);
}

async function saveProfilePageChanges() {
  if (!currentProfileEmployee) return;

  const editRoot = document.getElementById('profile-edit-root');
  if (window.LGSVValidation && editRoot && !window.LGSVValidation.validateScope(editRoot)) {
    return;
  }

  const addressResult = window.collectEmployeeAddressPayload
    ? collectEmployeeAddressPayload('profile')
    : { errors: [], payload: {} };
  if (addressResult.errors.length) {
    await showAlert(addressResult.errors.join('<br>'), 'Address Required', 'warning');
    switchProfileTab('contact');
    return;
  }

  const profileEmploymentType = document.getElementById('profile-edit-type')?.value || 'Full-time';
  const profileAgencyName = document.getElementById('profile-edit-agency-name')?.value?.trim() || '';
  const profileAgencyContactPerson = document.getElementById('profile-edit-agency-contact-person')?.value?.trim() || '';
  const profileAgencyContactNumber = document.getElementById('profile-edit-agency-contact-number')?.value?.trim() || '';
  const profileDeploymentStatus = document.getElementById('profile-edit-deployment-status')?.value || null;
  const profileContractStart = document.getElementById('profile-edit-contract-start-date')?.value || null;
  const profileContractEnd = document.getElementById('profile-edit-contract-end-date')?.value || null;
  const hasProfileAgencyDetails = !!(
    profileAgencyName ||
    profileAgencyContactPerson ||
    profileAgencyContactNumber ||
    profileContractStart ||
    profileContractEnd ||
    (profileDeploymentStatus && profileDeploymentStatus !== 'Pending Deployment') ||
    profileEmploymentType === 'Contractual'
  );
  const profileHiringType = hasProfileAgencyDetails
    ? 'Agency-Hired'
    : document.getElementById('profile-edit-hiring-type')?.value || 'Direct Hire';
  const profileEmploymentStatus = document.getElementById('profile-edit-status')?.value || 'Active';
  const includeOffboardingDetails = OFFBOARDING_DETAIL_STATUSES.has(profileEmploymentStatus);

  const payload = {
    first_name: document.getElementById('profile-edit-first-name')?.value || '',
    middle_name: document.getElementById('profile-edit-middle-name')?.value || null,
    last_name: document.getElementById('profile-edit-last-name')?.value || '',
    suffix: document.getElementById('profile-edit-suffix')?.value === 'None' ? null : document.getElementById('profile-edit-suffix')?.value || null,
    email: document.getElementById('profile-edit-email')?.value || '',
    work_email: document.getElementById('profile-edit-work-email')?.value || null,
    contact_number: document.getElementById('profile-edit-phone')?.value || '',
    nationality: document.getElementById('profile-edit-nationality')?.value || 'Filipino',
    marital_status: document.getElementById('profile-edit-marital-status')?.value || null,
    date_of_birth: document.getElementById('profile-edit-dob')?.value || null,
    place_of_birth: document.getElementById('profile-edit-place-of-birth')?.value || null,
    gender: document.getElementById('profile-edit-gender')?.value || null,
    blood_type: document.getElementById('profile-edit-blood-type')?.value || null,
    religion: document.getElementById('profile-edit-religion')?.value || null,
    ...addressResult.payload,
    position: document.getElementById('profile-edit-position')?.value || null,
    employment_type: profileEmploymentType,
    hiring_type: profileHiringType,
    agency_name: profileAgencyName || null,
    agency_contact_person: profileAgencyContactPerson || null,
    agency_contact_number: profileAgencyContactNumber || null,
    deployment_status: profileDeploymentStatus,
    contract_start_date: profileContractStart,
    contract_end_date: profileContractEnd,
    date_hired: document.getElementById('profile-edit-hired')?.value || null,
    end_of_contract: document.getElementById('profile-edit-end-contract')?.value || null,
    supervisor: document.getElementById('profile-edit-supervisor')?.value || null,
    work_location: document.getElementById('profile-edit-location')?.value || null,
    shift_schedule: document.getElementById('profile-edit-shift-schedule')?.value || null,
    employee_level: document.getElementById('profile-edit-employee-level')?.value || null,
    employment_history: document.getElementById('profile-edit-employment-history')?.value || null,
    status: profileEmploymentStatus,
    employment_status: profileEmploymentStatus,
    separation_date: includeOffboardingDetails ? document.getElementById('profile-edit-separation-date')?.value || null : null,
    separation_reason: includeOffboardingDetails ? document.getElementById('profile-edit-separation-reason')?.value || null : null,
    offboarding_remarks: includeOffboardingDetails ? document.getElementById('profile-edit-offboarding-remarks')?.value || null : null,
    emergency_contact_name: document.getElementById('profile-edit-emergency-name')?.value || null,
    emergency_contact_num: document.getElementById('profile-edit-emergency-phone')?.value || null,
    emergency_contact_relationship: document.getElementById('profile-edit-emergency-relationship')?.value || null,
    emergency_contact_secondary_num: document.getElementById('profile-edit-emergency-secondary-phone')?.value || null,
    emergency_contact_email: document.getElementById('profile-edit-emergency-email')?.value || null,
    emergency_contact_address: document.getElementById('profile-edit-emergency-address')?.value || null,
    education_jhs_school: document.getElementById('profile-edit-education-jhs-school')?.value || null,
    education_jhs_attainment: document.getElementById('profile-edit-education-jhs-attainment')?.value || null,
    education_jhs_from: document.getElementById('profile-edit-education-jhs-from')?.value || null,
    education_jhs_to: document.getElementById('profile-edit-education-jhs-to')?.value || null,
    education_jhs_year_graduated: document.getElementById('profile-edit-education-jhs-year-graduated')?.value || null,
    education_shs_school: document.getElementById('profile-edit-education-shs-school')?.value || null,
    education_shs_attainment: document.getElementById('profile-edit-education-shs-attainment')?.value || null,
    education_shs_from: document.getElementById('profile-edit-education-shs-from')?.value || null,
    education_shs_to: document.getElementById('profile-edit-education-shs-to')?.value || null,
    education_shs_year_graduated: document.getElementById('profile-edit-education-shs-year-graduated')?.value || null,
    education_vocational_school: document.getElementById('profile-edit-education-vocational-school')?.value || null,
    education_vocational_attainment: document.getElementById('profile-edit-education-vocational-attainment')?.value || null,
    education_vocational_units: document.getElementById('profile-edit-education-vocational-units')?.value || null,
    education_vocational_from: document.getElementById('profile-edit-education-vocational-from')?.value || null,
    education_vocational_to: document.getElementById('profile-edit-education-vocational-to')?.value || null,
    education_vocational_year_graduated: document.getElementById('profile-edit-education-vocational-year-graduated')?.value || null,
    education_college_school: document.getElementById('profile-edit-education-college-school')?.value || null,
    education_college_attainment: document.getElementById('profile-edit-education-college-attainment')?.value || null,
    education_college_units: document.getElementById('profile-edit-education-college-units')?.value || null,
    education_college_from: document.getElementById('profile-edit-education-college-from')?.value || null,
    education_college_to: document.getElementById('profile-edit-education-college-to')?.value || null,
    education_college_year_graduated: document.getElementById('profile-edit-education-college-year-graduated')?.value || null,
    department_id: getDepartmentId(document.getElementById('profile-edit-department')?.value || currentProfileEmployee.department) || currentProfileEmployee.department_id || null,
    wage_type: document.getElementById('profile-edit-wage-type')?.value || null,
    base_rate: usesPayrollBaseRate(document.getElementById('profile-edit-wage-type')?.value || '')
      ? (document.getElementById('profile-edit-basic-salary')?.value || null)
      : null,
    allowances: document.getElementById('profile-edit-allowances')?.value || null,
    payroll_schedule: document.getElementById('profile-edit-payroll-schedule')?.value || null,
    sss_number: document.getElementById('profile-edit-sss')?.value || null,
    philhealth_number: document.getElementById('profile-edit-philhealth')?.value || null,
    pagibig_number: document.getElementById('profile-edit-pagibig')?.value || null,
    tin: document.getElementById('profile-edit-tin')?.value || null,
    tax_status: document.getElementById('profile-edit-tax-status')?.value || null,
    bank_name: document.getElementById('profile-edit-bank-name')?.value || null,
    bank_account: document.getElementById('profile-edit-bank-account')?.value || null
  };
  removeUnauthorizedProfilePayrollFields(payload);

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      focusProfileEditField(error.field || error.errors?.[0]?.field);
      throw new Error(error.error || 'Failed to save profile');
    }

    await fetchEmployees();
    await loadEmployeeProfilePage({ employeeId: currentProfileEmployee.id, tab: currentProfileTab });
    toggleProfileEditMode(false);
    await showAlert('Profile updated successfully.', 'Saved', 'success');
  } catch (error) {
    console.error('Profile save error:', error);
    await showAlert(error.message, 'Error', 'error');
  }
}

async function loadProfilePhoto(employeeId) {
  const img = document.getElementById('profile-photo-img');
  const initials = document.getElementById('profile-initials');
  if (!img || !initials) return;

  if (currentProfilePhotoUrl) {
    URL.revokeObjectURL(currentProfilePhotoUrl);
    currentProfilePhotoUrl = null;
  }

  try {
    const response = await apiFetch(`/api/employees/${employeeId}/photo`);
    if (!response.ok) throw new Error('No photo');

    const blob = await response.blob();
    currentProfilePhotoUrl = URL.createObjectURL(blob);
    img.src = currentProfilePhotoUrl;
    img.style.display = 'block';
    initials.style.display = 'none';
  } catch {
    img.removeAttribute('src');
    img.style.display = 'none';
    initials.style.display = 'inline';
  }
}

async function uploadProfilePhoto(event) {
  if (!currentProfileEmployee) return;
  const file = event.target.files?.[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('photo', file);

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.id}/photo`, {
      method: 'POST',
      body: formData
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to upload photo');
    }
    await loadProfilePhoto(currentProfileEmployee.id);
    window.dispatchEvent(new CustomEvent('profilePhotoUpdated', {
      detail: { employeeId: Number(currentProfileEmployee.id) }
    }));
  } catch (error) {
    await showAlert(error.message, 'Upload Failed', 'error');
  } finally {
    event.target.value = '';
  }
}

function openEmployeeDocumentUpload() {
  let input = document.getElementById('profile-doc-input');
  if (!input) {
    input = document.createElement('input');
    input.id = 'profile-doc-input';
    input.type = 'file';
    input.accept = '.pdf,.doc,.docx,.jpg,.jpeg,.png';
    input.hidden = true;
    input.addEventListener('change', uploadProfileDocument);
    document.body.appendChild(input);
  }
  input.click();
}

async function uploadProfileDocument(event) {
  if (!currentProfileEmployee) return;
  const file = event.target.files?.[0];
  if (!file) return;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('docType', 'Other');

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.employee_code}/documents`, {
      method: 'POST',
      body: formData
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to upload document');
    }
    await loadProfileDocuments(currentProfileEmployee);
  } catch (error) {
    await showAlert(error.message, 'Upload Failed', 'error');
  } finally {
    event.target.value = '';
  }
}

async function loadProfileDocuments(employee) {
  const lists = [
    document.getElementById('profile-documents-list'),
    document.getElementById('profile-edit-documents-list')
  ].filter(Boolean);
  if (!lists.length || !employee?.employee_code) return;

  const renderLists = html => {
    lists.forEach(list => { list.innerHTML = html; });
  };

  try {
    const response = await apiFetch(`/api/employees/${employee.employee_code}/documents`);
    if (!response.ok) throw new Error('No documents');
    const docs = await response.json();

    if (!docs.length) {
      renderLists('<div class="profile-empty">No documents uploaded yet.</div>');
      return;
    }

    renderLists(docs.map(doc => `
      <div class="profile-doc-card clickable" role="button" tabindex="0"
           onclick="openProfileDocument(${Number(doc.id)})"
           onkeydown="if(event.key === 'Enter' || event.key === ' '){ event.preventDefault(); openProfileDocument(${Number(doc.id)}); }">
        <div class="profile-doc-main">
          <span class="profile-doc-icon">[]</span>
          <div>
            <div class="profile-value">${escapeHtml(doc.document_name || doc.file_name || doc.document_type || 'Document')}</div>
            <div class="profile-label">${escapeHtml(doc.document_type || 'Document')}</div>
          </div>
        </div>
        <span class="profile-label">${escapeHtml(doc.uploaded_date || doc.uploaded_at || doc.created_at)}</span>
      </div>
    `).join(''));
  } catch {
    renderLists('<div class="profile-empty">No documents uploaded yet.</div>');
  }
}

async function openProfileDocument(docId) {
  if (!currentProfileEmployee?.employee_code || !docId) return;

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.employee_code}/documents/${docId}/view`);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to open document');
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const opened = window.open(url, '_blank', 'noopener');
    if (!opened) {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      anchor.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    console.error('Document open error:', error);
    await showAlert(error.message, 'Document Unavailable', 'error');
  }
}

async function loadProfileLeaveHistory(employee) {
  const list = document.getElementById('profile-leave-list');
  if (!list) return;

  try {
    const response = await apiFetch('/api/leave');
    if (!response.ok) throw new Error('No leave data');
    const allLeave = await response.json();
    const rows = allLeave.filter(row => String(row.employee_id) === String(employee.id));
    const usedDays = rows.reduce((sum, row) => sum + (parseFloat(row.days) || 0), 0);

    setText('profile-used-leave', usedDays);

    if (!rows.length) {
      list.innerHTML = '<div class="profile-empty">No leave history yet.</div>';
      return;
    }

    list.innerHTML = rows.map(row => `
      <div class="profile-leave-row">
        <div>
          <div class="profile-value">${escapeHtml(row.type || 'Leave')}</div>
          <div class="profile-label">${escapeHtml(row.date_from)}${row.date_to ? ' to ' + escapeHtml(row.date_to) : ''}</div>
        </div>
        <div style="text-align:right;">
          <div class="profile-value">${escapeHtml(row.days || 1)} days</div>
          <div class="profile-label">${escapeHtml(row.status || 'Pending')}</div>
        </div>
      </div>
    `).join('');
  } catch {
    list.innerHTML = '<div class="profile-empty">No leave history yet.</div>';
  }
}

// Expose functions globally
window.openEmployeeDetailModal = openEmployeeDetailModal;
window.closeEmployeeDetail = closeEmployeeDetail;
window.switchTab = switchTab;
window.saveEmpPayrollConfig = saveEmpPayrollConfig;
window.openAddEmployeeModal = openAddEmployeeModal;
window.closeEditEmployeeModal = closeEditEmployeeModal;
window.saveEditedEmployee = saveEditedEmployee;
window.switchEditTab = switchEditTab;
window.updateEditPayrollWageType = updateEditPayrollWageType;
window.editEmployeeFromManage = editEmployeeFromManage;
window.toggleEmployeeStatus = toggleEmployeeStatus;
window.offboardEmployee = offboardEmployee;
window.reonboardEmployee = reonboardEmployee;
window.openOffboardingDrawer = openOffboardingDrawer;
window.openReonboardingDrawer = openReonboardingDrawer;
window.addEventListener('profilePhotoUpdated', event => {
  const employeeId = Number(event.detail?.employeeId || 0);
  if (!employeeId) return;
  invalidateEmployeePhoto(employeeId);
  if (Number(currentProfileEmployee?.id || 0) === employeeId) loadProfilePhoto(employeeId);
  if (Number(getUser()?.employeeId || 0) === employeeId && typeof refreshSidebarAvatar === 'function') {
    refreshSidebarAvatar();
  }
});

window.closeLifecycleDrawer = closeLifecycleDrawer;
window.viewLifecycleRequest = viewLifecycleRequest;
window.deleteEmployeeFromManage = deleteEmployeeFromManage;
window.uploadEmployeePhoto = uploadEmployeePhoto;
window.deleteEmployeePhoto = deleteEmployeePhoto;
window.loadEmployeePhotoPreview = loadEmployeePhotoPreview;
window.openEmployeeProfile = openEmployeeProfile;
window.loadEmployeeProfilePage = loadEmployeeProfilePage;
window.switchProfileTab = switchProfileTab;
window.toggleProfileEditMode = toggleProfileEditMode;
window.saveProfilePageChanges = saveProfilePageChanges;
window.uploadProfilePhoto = uploadProfilePhoto;
window.openEmployeeDocumentUpload = openEmployeeDocumentUpload;
window.uploadProfileDocument = uploadProfileDocument;
window.openProfileDocument = openProfileDocument;
window.openFamilyModal = openFamilyModal;
window.closeFamilyModal = closeFamilyModal;
window.saveFamilyMember = saveFamilyMember;
window.deleteFamilyMember = deleteFamilyMember;
window.renderFamilyMembersTable = renderFamilyMembersTable;
window.openExperienceModal = openExperienceModal;
window.closeExperienceModal = closeExperienceModal;
window.saveWorkExperience = saveWorkExperience;
window.deleteWorkExperience = deleteWorkExperience;
window.renderWorkExperiencesTable = renderWorkExperiencesTable;
window.openCertificationModal = openCertificationModal;
window.closeCertificationModal = closeCertificationModal;
window.saveCertification = saveCertification;
window.deleteCertification = deleteCertification;
window.openTrainingModal = openTrainingModal;
window.closeTrainingModal = closeTrainingModal;
window.saveTraining = saveTraining;
window.deleteTraining = deleteTraining;

// Expose refresh function globally for manual refresh
window.refreshEmployees = fetchEmployees;
window.fetchEmployees = fetchEmployees;
window.switchRegisterView = switchRegisterView;
window.applyOrganizationSetupPositionFilters = applyOrganizationSetupPositionFilters;
window.resetOrganizationSetupPositionFilters = resetOrganizationSetupPositionFilters;
window.openEmployeeDetail = openEmployeeDetail;
window.toggleEmployeeActionMenu = toggleEmployeeActionMenu;
window.setEmployeeStatus = setEmployeeStatus;
window.offboardEmployee = offboardEmployee;
window.reonboardEmployee = reonboardEmployee;
window.openOffboardingDrawer = openOffboardingDrawer;
window.openReonboardingDrawer = openReonboardingDrawer;
window.closeLifecycleDrawer = closeLifecycleDrawer;
window.viewLifecycleRequest = viewLifecycleRequest;
window.prefillEmployeeForm = prefillEmployeeForm;
window.openPayrollConfigModal = openPayrollConfigModal;
window.closePayrollConfigModal = closePayrollConfigModal;
window.savePayrollConfigFromManage = savePayrollConfigFromManage;
window.editEmployee = editEmployee;
window.switchEditTab = switchEditTab;
window.closeEditEmployeeModal = closeEditEmployeeModal;
window.saveEditedEmployee = saveEditedEmployee;
window.updateEditPayrollWageType = updateEditPayrollWageType;

/* Payroll Configuration Modal (Manage View) */
let currentPayrollEmployeeId = null;

async function openPayrollConfigModal(employeeId) {
  const employee = EMPLOYEES_RAW.find(e => e.id === parseInt(employeeId));
  if (!employee) {
    alert('Employee not found');
    return;
  }
  
  currentPayrollEmployeeId = employeeId;
  
  // Set employee info (read-only)
  document.getElementById('payroll-modal-emp-id').textContent = employee.employee_code || '—';
  document.getElementById('payroll-modal-emp-name').textContent = `${employee.first_name} ${employee.last_name}`;
  
  // Load ref data if needed
  if (!wageTypesForPayroll.length || sewingTypesForPayroll.length === 0 || logisticsRegionsForPayroll.length === 0) {
    await loadPayrollRefData();
  }

  // Load current payroll config
  await loadPayrollConfigForModal(employeeId);
  
  // Show modal
  const modal = document.getElementById('payroll-config-modal');
  if (modal) modal.style.display = 'flex';
}

function closePayrollConfigModal() {
  const modal = document.getElementById('payroll-config-modal');
  if (modal) modal.style.display = 'none';
  currentPayrollEmployeeId = null;
  clearPayrollConfigForm();
}

function clearPayrollConfigForm() {
  document.getElementById('payroll-config-wage-select').value = '';
  document.getElementById('payroll-config-primary-rate').value = '';
  document.getElementById('payroll-config-hourly-rate').value = '';
  document.getElementById('payroll-config-overtime-rate').value = '';
  document.getElementById('payroll-config-hourly-section').style.display = 'none';
  document.getElementById('payroll-config-sewing-section').style.display = 'none';
  document.getElementById('payroll-config-logistics-section').style.display = 'none';
  setPayrollBaseRateVisibility('', 'payroll-config');
}

async function loadPayrollConfigForModal(employeeId) {
  try {
    const res = await apiFetch(`/api/payroll/employees/${employeeId}/wage-config`);
    if (!res.ok) {
      console.log('No wage config found for employee');
      clearPayrollConfigForm();
      return;
    }
    
    const config = await res.json();
    console.log('Loaded payroll config for modal:', config);
    
    if (config.wage_type_id) {
      document.getElementById('payroll-config-wage-select').value = config.wage_type_id;
      document.getElementById('payroll-config-primary-rate').value = usesPayrollBaseRate(config.wage_type_id) ? (config.base_rate || '') : '';
      setPayrollBaseRateVisibility(config.wage_type_id, 'payroll-config');
      
      if (isPayrollWageType(config.wage_type_id, 'Hourly')) {
        // Hourly
        document.getElementById('payroll-config-hourly-section').style.display = 'block';
        document.getElementById('payroll-config-hourly-rate').value = config.hourly_rate || '';
        document.getElementById('payroll-config-overtime-rate').value = config.overtime_rate || '';
      } else {
        document.getElementById('payroll-config-hourly-section').style.display = 'none';
      }
      
      if (isPayrollWageType(config.wage_type_id, 'Per-Piece')) {
        // Sewing
        document.getElementById('payroll-config-sewing-section').style.display = 'block';
        renderPayrollSewingRates(config.rates || []);
      } else {
        document.getElementById('payroll-config-sewing-section').style.display = 'none';
      }
      
      if (isPayrollWageType(config.wage_type_id, 'Per-Trip')) {
        // Logistics
        document.getElementById('payroll-config-logistics-section').style.display = 'block';
        renderPayrollLogisticsRates(config.rates || []);
      } else {
        document.getElementById('payroll-config-logistics-section').style.display = 'none';
      }
    }
  } catch (e) {
    console.error('Error loading payroll config:', e);
  }
}

function renderPayrollSewingRates(rates) {
  const container = document.getElementById('payroll-config-sewing-items');
  container.innerHTML = sewingTypesForPayroll.map(type => {
    const existingRate = rates.find(r => r.sewing_type_id === type.id);
    return `
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:6px;font-weight:600;">${type.name}</label>
        <input type="number" class="emp-payroll-rate-input" data-sewing-id="${type.id}" min="0" step="0.01" placeholder="0.00" value="${existingRate?.rate || ''}" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);" />
      </div>
    `;
  }).join('');
}

function renderPayrollLogisticsRates(rates) {
  const container = document.getElementById('payroll-config-logistics-items');
  container.innerHTML = logisticsRegionsForPayroll.map(region => {
    const existingRate = rates.find(r => r.logistics_region_id === region.id);
    return `
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:12px;color:var(--muted);margin-bottom:6px;font-weight:600;">${region.name}</label>
        <input type="number" class="emp-payroll-rate-input" data-region-id="${region.id}" min="0" step="0.01" placeholder="0.00" value="${existingRate?.rate || ''}" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);" />
      </div>
    `;
  }).join('');
}

async function savePayrollConfigFromManage() {
  if (!currentPayrollEmployeeId) {
    alert('No employee selected');
    return;
  }
  
  const wageTypeId = document.getElementById('payroll-config-wage-select').value;
  if (!wageTypeId) {
    alert('Please select a wage type');
    return;
  }
  
  const primaryRate = parseFloat(document.getElementById('payroll-config-primary-rate').value) || 0;
  const hourlyRate = parseFloat(document.getElementById('payroll-config-hourly-rate').value) || 0;
  const overtimeRate = parseFloat(document.getElementById('payroll-config-overtime-rate').value) || 0;
  
  const rates = [];
  
  if (isPayrollWageType(wageTypeId, 'Hourly')) {
    // Hourly
    if (hourlyRate <= 0) {
      alert('Please enter a valid hourly rate');
      return;
    }
    rates.push({
      rate: hourlyRate,
      base_rate: primaryRate || hourlyRate,
      hourly_rate: hourlyRate,
      overtime_rate: overtimeRate,
      sewing_type_id: null,
      logistics_region_id: null
    });
  } else if (isPayrollWageType(wageTypeId, 'Per-Piece') || isPayrollWageType(wageTypeId, 'Per-Trip')) {
    const inputs = document.querySelectorAll('.emp-payroll-rate-input');
    inputs.forEach((input) => {
      const rate = parseFloat(input.value) || 0;
      const sewingId = input.getAttribute('data-sewing-id');
      const regionId = input.getAttribute('data-region-id');
      
      if (rate > 0) {
        rates.push({
          rate,
          base_rate: null,
          hourly_rate: null,
          overtime_rate: null,
          sewing_type_id: sewingId ? parseInt(sewingId) : null,
          logistics_region_id: regionId ? parseInt(regionId) : null
        });
      }
    });
    
    if (rates.length === 0) {
      alert('Please enter at least one rate');
      return;
    }
  } else {
    if (!isPayrollWageType(wageTypeId, 'Daily')) {
      alert('Base salary is only supported through Daily or Hourly payroll setup.');
      return;
    }
    // Base Salary
    if (primaryRate <= 0) {
      alert('Please enter a valid base rate');
      return;
    }
    rates.push({
      rate: primaryRate,
      base_rate: primaryRate,
      hourly_rate: null,
      overtime_rate: null,
      sewing_type_id: null,
      logistics_region_id: null
    });
  }
  
  const payload = { wage_type_id: parseInt(wageTypeId), rates };
  
  try {
    const res = await apiFetch(`/api/payroll/employees/${currentPayrollEmployeeId}/wage-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    const responseData = await res.json();
    
    if (res.ok) {
      alert(`✅ Payroll configuration saved!\n✓ ${responseData.ratesSaved} rate(s) saved`);
      closePayrollConfigModal();
    } else {
      alert('❌ Failed to save: ' + (responseData.error || 'Unknown error'));
    }
  } catch (e) {
    console.error('Error saving payroll config:', e);
    alert('Error: ' + e.message);
  }
}

// Close modal when clicking outside
window.addEventListener('click', (e) => {
  const modal = document.getElementById('emp-detail-modal');
  if (modal && e.target === modal) closeEmployeeDetail();
  
  const payrollModal = document.getElementById('payroll-config-modal');
  if (payrollModal && e.target === payrollModal) closePayrollConfigModal();
});
