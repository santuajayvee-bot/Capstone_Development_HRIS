/* ============================================================
   EMPLOYEES.JS — Employee list filtering & search
   ============================================================ */

let EMPLOYEES = []; // Will be populated from API
let EMPLOYEES_RAW = []; // Store raw API data for editing
let CURRENT_VIEW = 'list'; // 'list' or 'manage'

async function fetchEmployees() {
  try {
    console.log('📡 Fetching employees from API...');
    const response = await apiFetch('/api/employees');
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
    
    const grid = document.getElementById('emp-grid');
    if (grid) {
      grid.innerHTML = `
        <div style="grid-column: 1/-1; padding: 40px; text-align: center; color: #ff6b6b;">
          <div style="font-size: 18px; font-weight: 600; margin-bottom: 8px;">Failed to Load Employees</div>
          <div style="font-size: 14px; color: #999;">${error.message}</div>
          <button onclick="location.reload()" style="margin-top: 16px; padding: 8px 16px; background: #4f7cff; color: white; border: none; border-radius: 4px; cursor: pointer;">Retry</button>
        </div>
      `;
    }
    
    return [];
  }
}

function renderEmployees(list) {
  const tbody = document.getElementById('emp-tbody');
  if (!tbody) return;
  
  const renderedRows = list.map(e => {
    const statusClass = e.status === 'Active' ? 'active' : 'inactive';
    const statusDisplay = e.status === 'Active' ? '✓ Active' : '✗ Inactive';
    
    // Check if they were recently onboarded
    const isNewHire = e._raw && e._raw.onboarding_status === 'completed';
    const hireLabel = isNewHire 
      ? '<span style="background:#4f7cff22; color:#4f7cff; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:700; margin-left:8px;">NEWLY REGULARIZED</span>'
      : '<span style="background:#6c757d11; color:#6c757d; padding:2px 6px; border-radius:4px; font-size:10px; font-weight:700; margin-left:8px;">REGULAR</span>';

    return `
    <tr onclick="openEmployeeDetailModal('${e.id}')" style="cursor:pointer;" data-emp-id="${e.id}">
      <td class="emp-id">${e.empCode}</td>
      <td class="emp-name">
        ${e.name}
        ${hireLabel}
      </td>
      <td class="emp-email">${e.email}</td>
      <td>${e.phone}</td>
      <td>${e.city}</td>
      <td>${e.dept}</td>
      <td>${e.position}</td>
      <td>${e.supervisor}</td>
      <td><span class="emp-status ${statusClass}">${statusDisplay}</span></td>
      <td class="emp-action">View</td>
    </tr>
  `;
  }).join('');
  
  tbody.innerHTML = renderedRows;
  
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
  if (countEl) countEl.textContent = `Showing ${list.length} of ${EMPLOYEES.length} employees`;
}

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
  
  const empPosition = document.querySelector('#form-employment input#emp-position');
  if (empPosition) empPosition.value = employee.position || '';
  
  const empType = document.querySelector('#form-employment select#emp-type');
  if (empType) empType.value = employee.employment_type || 'Full-time';
  
  const empHiredDate = document.querySelector('#form-employment input#emp-hired-date');
  if (empHiredDate) empHiredDate.value = employee.date_hired || '';
  
  const empSupervisor = document.querySelector('#form-employment input#emp-supervisor');
  if (empSupervisor) empSupervisor.value = employee.supervisor || '';
  
  const empLocation = document.querySelector('#form-employment input#emp-location');
  if (empLocation) empLocation.value = employee.work_location || '';
  
  console.log('Form prefilled successfully');
}

function filterEmployees() {
  // Determine which view is active and use appropriate filter IDs
  let search, status, dept;
  
  if (CURRENT_VIEW === 'manage') {
    // Manage view - use manage-* IDs
    search = document.getElementById('manage-search')?.value.toLowerCase() || '';
    status = document.getElementById('manage-status')?.value || '';
    dept   = document.getElementById('manage-dept')?.value || '';
  } else {
    // List view - use emp-* IDs
    search = document.getElementById('emp-search')?.value.toLowerCase() || '';
    status = document.getElementById('emp-status')?.value || '';
    dept   = document.getElementById('emp-dept')?.value || '';
  }

  const filtered = EMPLOYEES.filter(e => {
    const matchSearch = e.name.toLowerCase().includes(search) || e.email.toLowerCase().includes(search);
    const matchStatus = !status || status === 'All Status' || e.status === status;
    const matchDept   = !dept   || dept   === 'All Departments' || e.dept   === dept;
    return matchSearch && matchStatus && matchDept;
  });

  console.log(`Filtered: ${filtered.length} employees (search: "${search}", status: "${status}", dept: "${dept}")`);
  
  // Render appropriate view
  if (CURRENT_VIEW === 'manage') {
    loadManageEmployeeList(filtered);
  } else {
    renderEmployees(filtered);
  }
}

/* View Switching */
function switchView(view) {
  CURRENT_VIEW = view;
  const filterBar = document.querySelector('.filter-bar');
  const empTable = document.getElementById('emp-table');
  const empCount = document.getElementById('emp-count');
  const manageView = document.getElementById('emp-manage-view');
  
  if (view === 'list') {
    // Show list view, hide manage view
    if (filterBar) filterBar.style.display = '';
    if (empTable) empTable.style.display = '';
    if (empCount) empCount.style.display = '';
    if (manageView) manageView.style.display = 'none';
  } else if (view === 'manage') {
    // Check if user is admin (support both 'admin' and 'hr_admin' roles)
    const userStr = sessionStorage.getItem('vp_user');
    const user = userStr ? JSON.parse(userStr) : null;
    const adminRoles = ['admin', 'hr_admin', 'system_admin'];
    if (!adminRoles.includes(user?.role)) {
      alert('Only administrators can access this feature.');
      return;
    }
    // Show manage view, hide list view
    if (filterBar) filterBar.style.display = 'none';
    if (empTable) empTable.style.display = 'none';
    if (empCount) empCount.style.display = 'none';
    if (manageView) {
      manageView.style.display = 'block';
      
      // Ensure employees are loaded before rendering
      if (EMPLOYEES.length === 0) {
        fetchEmployees().then(() => {
          loadManageEmployeeList(EMPLOYEES);
          attachManageViewEventListeners();
        });
      } else {
        loadManageEmployeeList(EMPLOYEES);
        attachManageViewEventListeners();
      }
    }
  }
}

function attachManageViewEventListeners() {
  setTimeout(() => {
    const searchInput = document.getElementById('manage-search');
    const statusSelect = document.getElementById('manage-status');
    const deptSelect = document.getElementById('manage-dept');
    
    if (searchInput) {
      searchInput.removeEventListener('input', filterEmployees);
      searchInput.addEventListener('input', filterEmployees);
    }
    if (statusSelect) {
      statusSelect.removeEventListener('change', filterEmployees);
      statusSelect.addEventListener('change', filterEmployees);
    }
    if (deptSelect) {
      deptSelect.removeEventListener('change', filterEmployees);
      deptSelect.addEventListener('change', filterEmployees);
    }
  }, 100);
}

/* Register Page View Switching - Manage vs Add Employee */
function switchRegisterView(view) {
  const manageView = document.getElementById('register-manage-view');
  const formView = document.getElementById('register-form-view');
  
  if (view === 'manage') {
    // Show manage view with employee list
    if (manageView) manageView.style.display = 'block';
    if (formView) formView.style.display = 'none';
    
    // Fetch fresh data and then load the list
    if (typeof fetchEmployees === 'function') {
      console.log('fetchEmployees available, fetching fresh data...');
      fetchEmployees()
        .then(() => {
          console.log('Data fetched. EMPLOYEES length:', EMPLOYEES.length);
          console.log('EMPLOYEES:', EMPLOYEES);
          loadManageEmployeeList();
        })
        .catch(err => {
          console.error('Error fetching employees:', err);
          // Fallback: load whatever we have
          loadManageEmployeeList();
        });
    } else {
      console.warn('fetchEmployees not available');
      loadManageEmployeeList();
    }
    
    // Add event listeners for search and filter
    setTimeout(() => {
      const searchInput = document.getElementById('manage-search');
      const statusSelect = document.getElementById('manage-status');
      const deptSelect = document.getElementById('manage-dept');
      
      if (searchInput) {
        searchInput.addEventListener('input', filterEmployees);
      }
      if (statusSelect) {
        statusSelect.addEventListener('change', filterEmployees);
      }
      if (deptSelect) {
        deptSelect.addEventListener('change', filterEmployees);
      }
    }, 100);
  } else if (view === 'add') {
    // Show form view for adding new employee or editing existing
    if (manageView) manageView.style.display = 'none';
    if (formView) formView.style.display = 'block';
    
    // Check if we're editing by looking at the global flag set by loadEmployeeData()
    const isEditing = window.IS_EDITING === true;
    
    if (isEditing) {
      // Editing existing employee - don't clear the form
      // The data should already be loaded by loadEmployeeData() called from navigate()
      console.log('Showing form in EDIT mode with existing data');
    } else {
      // Adding new employee - initialize form with fresh flags
      console.log('Initializing form for NEW employee');
      if (typeof initializeAddForm === 'function') {
        initializeAddForm();
      } else {
        // Fallback if initializeAddForm not available
        clearEmployeeForm();
        setTimeout(() => generateEmployeeID(), 100);
      }
    }
  }
}

function loadManageEmployeeList(list = EMPLOYEES) {
  const grid = document.getElementById('manage-emp-grid');
  if (!grid) {
    console.error('Grid element "manage-emp-grid" not found!');
    return;
  }
  
  console.log('Loading manage employee list with', list.length, 'employees');
  
  grid.innerHTML = list.map(e => {
    const statusClass = e.status === 'Active' ? 'active' : 'inactive';
    const statusDisplay = e.status === 'Active' ? '✓ Active' : '✗ Inactive';
    const toggleLabel = e.status === 'Active' ? 'Deactivate' : 'Activate';
    
    // Check if they were recently onboarded
    const isNewHire = e._raw && e._raw.onboarding_status === 'completed';
    const hireLabel = isNewHire 
      ? '<span style="background:#4f7cff22; color:#4f7cff; padding:2px 4px; border-radius:4px; font-size:9px; font-weight:700;">NEWLY REGULARIZED</span>'
      : '<span style="background:#6c757d11; color:#6c757d; padding:2px 4px; border-radius:4px; font-size:9px; font-weight:700;">REGULAR</span>';

    return `
    <tr data-emp-id="${e.id}">
      <td class="emp-id">${e.empCode}</td>
      <td class="emp-name">
        <div style="font-weight:600;">${e.name}</div>
        <div style="margin-top:2px;">${hireLabel}</div>
      </td>
      <td>${e.email}</td>
      <td>${e.dept}</td>
      <td>${e.position}</td>
      <td><span class="emp-status-badge ${statusClass}">${statusDisplay}</span></td>
      <td>
        <div class="emp-actions" style="flex-wrap:wrap;">
          <button class="emp-edit-btn" onclick="editEmployee('${e.id}')" title="Edit Employee" style="flex:1;min-width:60px;">Edit</button>
          <button class="emp-status-toggle-btn" onclick="toggleEmployeeStatus('${e.id}', '${e.status}')" title="Toggle Status" style="flex:1;min-width:70px;">${toggleLabel}</button>
          <button class="emp-delete-btn" onclick="deleteEmployeeFromManage('${e.id}')" title="Delete Employee" style="flex:1;min-width:60px;">Delete</button>
        </div>
      </td>
    </tr>
  `}).join('');
  
  console.log('Rendered', list.length, 'employees to manage table');
}

async function toggleEmployeeStatus(employeeId, currentStatus) {
  const newStatus = currentStatus === 'Active' ? 'Inactive' : 'Active';
  const confirmMsg = `Are you sure you want to ${newStatus === 'Active' ? 'activate' : 'deactivate'} this employee?`;
  
  if (!confirm(confirmMsg)) return;

  try {
    const response = await apiFetch(`/api/employees/${employeeId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(error || 'Failed to update status');
    }

    const data = await response.json();
    alert(data.message || 'Status updated successfully');
    
    // Refresh the employee list
    await fetchEmployees();
    loadManageEmployeeList();
  } catch (error) {
    console.error('Error updating status:', error);
    alert('Failed to update employee status: ' + error.message);
  }
}

function editEmployeeFromManage(employeeId) {
  console.log('Editing employee ID:', employeeId);
  const employee = EMPLOYEES_RAW.find(e => e.id === parseInt(employeeId));
  console.log('Found employee:', employee);
  if (!employee) {
    alert('Employee not found');
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
    alert('Employee not found');
    return;
  }
  
  if (!confirm(`Are you sure you want to delete ${emp.name}? This action cannot be undone.`)) return;
  
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
    alert(data.message || 'Employee deleted successfully');
    
    // Refresh the employee list
    await fetchEmployees();
    loadManageEmployeeList();
  } catch (error) {
    console.error('Error deleting employee:', error);
    alert('Failed to delete employee: ' + error.message);
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
  document.getElementById('emp-dob').value = '';
  document.getElementById('emp-gender').value = 'Male';
  document.getElementById('emp-email').value = '';
  document.getElementById('emp-address').value = '';
  document.getElementById('emp-emerg-name').value = '';
  document.getElementById('emp-emerg-phone').value = '';
  document.querySelector('#form-employment select#emp-dept').value = 'HR';
  document.querySelector('#form-employment input#emp-position').value = '';
  document.querySelector('#form-employment select#emp-type').value = 'Full-time';
  document.querySelector('#form-employment input#emp-hired-date').value = '';
  document.querySelector('#form-employment input#emp-supervisor').value = '';
  document.querySelector('#form-employment input#emp-location').value = '';
  document.getElementById('emp-salary').value = '';
  document.getElementById('emp-pay-freq').value = 'Monthly';
  document.getElementById('emp-sss').value = '';
  document.getElementById('emp-philhealth').value = '';
  document.getElementById('emp-pagibig').value = '';
  document.getElementById('emp-tin').value = '';
  document.getElementById('emp-bank').value = '';
  document.getElementById('emp-bank-account').value = '';
  
  // Reset to Personal Info tab
  document.querySelectorAll('.form-tab').forEach(tab => tab.classList.remove('active'));
  document.querySelector('.form-tab').classList.add('active');
  document.getElementById('form-personal').style.display = 'block';
  document.getElementById('form-employment').style.display = 'none';
  document.getElementById('form-payroll').style.display = 'none';
  document.getElementById('form-documents').style.display = 'none';
  
  // Clear uploaded files if function is available
  if (typeof clearUploadedFiles === 'function') {
    clearUploadedFiles();
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
    'payroll': 'edit-tab-payroll'
  };
  
  if (tabMap[tabName]) {
    document.getElementById(tabMap[tabName]).style.display = 'block';
  }
  
  // Find and activate the clicked button
  document.querySelectorAll('.edit-tab-btn').forEach(btn => {
    if (btn.textContent.includes(tabName === 'personal' ? 'Personal' : tabName === 'employment' ? 'Employment' : 'Payroll')) {
      btn.classList.add('active');
      btn.style.borderBottomColor = '#4f7cff';
      btn.style.color = '#333';
    }
  });
}

function editEmployee(empId) {
  console.log('Editing employee ID:', empId);
  const employee = EMPLOYEES_RAW.find(e => e.id === parseInt(empId));
  console.log('Found employee:', employee);
  if (!employee) {
    alert('Employee not found');
    return;
  }

  currentEditingEmployeeId = employee.id;
  
  // Populate Personal Info Tab
  document.getElementById('edit-emp-first-name').value = employee.first_name || '';
  document.getElementById('edit-emp-last-name').value = employee.last_name || '';
  document.getElementById('edit-emp-email').value = employee.email || '';
  document.getElementById('edit-emp-phone').value = employee.contact_number || '';
  document.getElementById('edit-emp-city').value = employee.residential_address || '';
  
  // Populate Employment Details Tab
  document.getElementById('edit-emp-dept').value = getDeptName(employee.department_id) || 'HR';
  document.getElementById('edit-emp-position').value = employee.position || '';
  document.getElementById('edit-emp-type').value = employee.employment_type || '';
  document.getElementById('edit-emp-date-hired').value = employee.date_hired ? employee.date_hired.split('T')[0] : '';
  document.getElementById('edit-emp-supervisor').value = employee.supervisor || '';
  document.getElementById('edit-emp-work-location').value = employee.work_location || '';
  
  // Populate Payroll & Compensation Tab
  document.getElementById('edit-payroll-wage-type').value = employee.wage_type || '';
  document.getElementById('edit-payroll-rate').value = employee.base_rate || '';
  
  // Reset to first tab
  switchEditTab('personal');
  
  // Open the modal
  const modal = document.getElementById('edit-employee-modal');
  if (modal) modal.style.setProperty('display', 'flex', 'important');
}

function closeEditEmployeeModal() {
  const modal = document.getElementById('edit-employee-modal');
  if (modal) modal.style.display = 'none';
  currentEditingEmployeeId = null;
}

function getDeptName(deptId) {
  const deptMap = {
    1: 'HR',
    2: 'Accounting',
    3: 'Production',
    4: 'Logistics',
    5: 'Personnel'
  };
  return deptMap[deptId] || 'HR';
}

function getDeptId(deptName) {
  const deptMap = {
    'HR': 1,
    'Accounting': 2,
    'Production': 3,
    'Logistics': 4,
    'Personnel': 5
  };
  return deptMap[deptName] || 1;
}

async function saveEditedEmployee() {
  if (!currentEditingEmployeeId) {
    alert('Error: No employee selected');
    return;
  }

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
  const baseRate = document.getElementById('edit-payroll-rate').value;

  if (!firstName || !lastName || !email) {
    alert('First name, last name, and email are required');
    return;
  }

  try {
    const response = await apiFetch(`/api/employees/${currentEditingEmployeeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
        wage_type: wageType,
        base_rate: baseRate ? parseFloat(baseRate) : null,
        status: 'Active'
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to update employee');
    }

    alert('Employee updated successfully!');
    closeEditEmployeeModal();
    
    // Refresh the employee list
    await fetchEmployees();
    loadManageEmployeeList(EMPLOYEES);
  } catch (error) {
    console.error('Error saving employee:', error);
    alert('Failed to save employee: ' + error.message);
  }
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

document.addEventListener('DOMContentLoaded', () => {
  fetchEmployees();

  // Auto-refresh employees every 5 seconds to catch new additions
  setInterval(fetchEmployees, 5000);

  document.getElementById('emp-search') ?.addEventListener('input',  filterEmployees);
  document.getElementById('emp-dept')   ?.addEventListener('change', filterEmployees);
  document.getElementById('emp-status') ?.addEventListener('change', filterEmployees);
});

// Payroll config wage type change handler
document.addEventListener('change', (e) => {
  if (e.target.id === 'payroll-config-wage-select') {
    const wageTypeId = e.target.value;
    document.getElementById('payroll-config-hourly-section').style.display = wageTypeId === '2' ? 'block' : 'none';
    document.getElementById('payroll-config-sewing-section').style.display = wageTypeId === '3' ? 'block' : 'none';
    document.getElementById('payroll-config-logistics-section').style.display = wageTypeId === '4' ? 'block' : 'none';
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
  
  // Reset tabs
  document.querySelectorAll('.emp-detail-tab-btn').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('[id^="emp-detail-tab-"]').forEach(tab => tab.style.display = 'none');
  
  // Show first tab
  document.querySelectorAll('.emp-detail-tab-btn')[0].classList.add('active');
  document.getElementById('emp-detail-tab-personal').style.display = 'block';
  
  // Load payroll compensation data if not already loaded
  if (sewingTypesForPayroll.length === 0) {
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
    const [sewRes, logRes] = await Promise.all([
      apiFetch('/api/payroll/sewing-types'),
      apiFetch('/api/payroll/logistics-regions')
    ]);
    
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
    
    // Set wage type select
    const wageMap = { 'Base Salary': '1', 'Hourly': '2', 'Per-Piece': '3', 'Per-Trip': '4' };
    const wageValue = wageMap[config.wage_type] || '';
    document.getElementById('emp-payroll-wage-select').value = wageValue;
    
    // Populate base rate
    if (config.rates && config.rates.length > 0) {
      const firstRate = config.rates[0];
      document.getElementById('emp-payroll-primary-rate').value = firstRate.base_rate || '';
      
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
    }
  } catch (e) {
    console.error('Error loading payroll config:', e);
  }
}

// Handle wage type selection in payroll tab
document.addEventListener('change', (e) => {
  if (e.target.id === 'emp-payroll-wage-select') {
    const wageTypeId = e.target.value;
    
    // Hide all specialized sections
    document.getElementById('emp-payroll-hourly-section').style.display = 'none';
    document.getElementById('emp-payroll-sewing-section').style.display = 'none';
    document.getElementById('emp-payroll-logistics-section').style.display = 'none';
    
    // Show appropriate section based on wage type
    if (wageTypeId === '2') {
      // Hourly
      document.getElementById('emp-payroll-hourly-section').style.display = 'block';
    } else if (wageTypeId === '3') {
      // Per-Piece
      document.getElementById('emp-payroll-sewing-section').style.display = 'block';
      renderEmpPayrollSewingTypes();
    } else if (wageTypeId === '4') {
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
    alert('❌ Form error: wage type selector not found');
    return;
  }
  
  const wageTypeId = wageTypeSelect.value;
  if (!wageTypeId) {
    console.warn('❌ No wage type selected - User must select a wage type first');
    alert('❌ Please select a wage type first');
    return;
  }
  
  console.log('✅ Wage Type ID Selected:', wageTypeId);
  const wageTypeMap = { '1': 'Base Salary', '2': 'Hourly', '3': 'Per-Piece', '4': 'Per-Trip' };
  console.log('   Wage Type Name:', wageTypeMap[wageTypeId]);
  
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
  if (wageTypeId === '2') {
    console.log('→ Collecting HOURLY rates...');
    if (hourlyRate <= 0) {
      console.error('❌ VALIDATION FAILED: Hourly rate must be > 0, got:', hourlyRate);
      alert('❌ For Hourly wage: Please enter a VALID hourly rate (must be greater than 0)');
      return;
    }
    console.log('   ✅ Hourly rate is valid:', hourlyRate);
    rates.push({
      rate: hourlyRate,
      base_rate: primaryRate || 0,
      hourly_rate: hourlyRate,
      overtime_rate: overtimeRate || 0,
      sewing_type_id: null,
      logistics_region_id: null
    });
    console.log('   ✅ Hourly rate added to rates array');
  } else if (wageTypeId === '3' || wageTypeId === '4') {
    // For Per-Piece or Per-Trip - collect from dynamic inputs
    console.log('→ Collecting ' + (wageTypeId === '3' ? 'PER-PIECE' : 'PER-TRIP') + ' rates...');
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
          base_rate: primaryRate || 0,
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
    // Base Salary (1) or others
    console.log('→ Collecting BASE SALARY rates...');
    if (primaryRate <= 0) {
      console.error('❌ VALIDATION FAILED: Base salary must be > 0, got:', primaryRate);
      alert('❌ For ' + wageTypeMap[wageTypeId] + ': Please enter a VALID rate (must be greater than 0)');
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
    alert('❌ Please enter at least one rate value');
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

// Expose functions globally
window.openEmployeeDetailModal = openEmployeeDetailModal;
window.closeEmployeeDetail = closeEmployeeDetail;
window.switchTab = switchTab;
window.saveEmpPayrollConfig = saveEmpPayrollConfig;

// Expose refresh function globally for manual refresh
window.refreshEmployees = fetchEmployees;
window.fetchEmployees = fetchEmployees;
window.switchRegisterView = switchRegisterView;
window.loadManageEmployeeList = loadManageEmployeeList;
window.openEmployeeDetail = openEmployeeDetail;
window.prefillEmployeeForm = prefillEmployeeForm;
window.openPayrollConfigModal = openPayrollConfigModal;
window.closePayrollConfigModal = closePayrollConfigModal;
window.savePayrollConfigFromManage = savePayrollConfigFromManage;
window.editEmployee = editEmployee;
window.switchEditTab = switchEditTab;
window.closeEditEmployeeModal = closeEditEmployeeModal;
window.saveEditedEmployee = saveEditedEmployee;

/* Payroll Configuration Modal (Manage View) */
let currentPayrollEmployeeId = null;

function openPayrollConfigModal(employeeId) {
  const employee = EMPLOYEES_RAW.find(e => e.id === parseInt(employeeId));
  if (!employee) {
    alert('Employee not found');
    return;
  }
  
  currentPayrollEmployeeId = employeeId;
  
  // Set employee info (read-only)
  document.getElementById('payroll-modal-emp-id').textContent = employee.employee_code || '—';
  document.getElementById('payroll-modal-emp-name').textContent = `${employee.first_name} ${employee.last_name}`;
  
  // Load current payroll config
  loadPayrollConfigForModal(employeeId);
  
  // Load ref data if needed
  if (sewingTypesForPayroll.length === 0) {
    loadPayrollRefData();
  }
  
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
      document.getElementById('payroll-config-primary-rate').value = config.base_rate || '';
      
      if (config.wage_type_id === 2) {
        // Hourly
        document.getElementById('payroll-config-hourly-section').style.display = 'block';
        document.getElementById('payroll-config-hourly-rate').value = config.hourly_rate || '';
        document.getElementById('payroll-config-overtime-rate').value = config.overtime_rate || '';
      } else {
        document.getElementById('payroll-config-hourly-section').style.display = 'none';
      }
      
      if (config.wage_type_id === 3) {
        // Sewing
        document.getElementById('payroll-config-sewing-section').style.display = 'block';
        renderPayrollSewingRates(config.rates || []);
      } else {
        document.getElementById('payroll-config-sewing-section').style.display = 'none';
      }
      
      if (config.wage_type_id === 4) {
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
  
  if (wageTypeId === '2') {
    // Hourly
    if (hourlyRate <= 0) {
      alert('Please enter a valid hourly rate');
      return;
    }
    rates.push({
      rate: hourlyRate,
      base_rate: primaryRate,
      hourly_rate: hourlyRate,
      overtime_rate: overtimeRate,
      sewing_type_id: null,
      logistics_region_id: null
    });
  } else if (wageTypeId === '3' || wageTypeId === '4') {
    const inputs = document.querySelectorAll('.emp-payroll-rate-input');
    inputs.forEach((input) => {
      const rate = parseFloat(input.value) || 0;
      const sewingId = input.getAttribute('data-sewing-id');
      const regionId = input.getAttribute('data-region-id');
      
      if (rate > 0) {
        rates.push({
          rate,
          base_rate: primaryRate,
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
