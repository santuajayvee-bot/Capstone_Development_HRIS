/* ============================================================
   EMPLOYEES.JS — Employee list filtering & search
   ============================================================ */

let EMPLOYEES = []; // Will be populated from API
let EMPLOYEES_RAW = []; // Store raw API data for editing

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
    
    return `
    <tr onclick="openEmployeeProfile('${e.id}', 'personal')" style="cursor:pointer;" data-emp-id="${e.id}">
      <td class="emp-id">${e.empCode}</td>
      <td class="emp-name">${e.name}</td>
      <td class="emp-email">${e.email}</td>
      <td>${e.phone}</td>
      <td>${e.city}</td>
      <td>${e.dept}</td>
      <td>${e.position}</td>
      <td>${e.supervisor}</td>
      <td><span class="emp-status ${statusClass}">${statusDisplay}</span></td>
      <td class="emp-action" onclick="event.stopPropagation();">
        <div class="emp-action-menu">
          <button class="emp-action-trigger" type="button" title="Employee actions" aria-label="Employee actions" onclick="toggleEmployeeActionMenu(event, '${e.id}')"><span class="dot"></span><span class="dot"></span><span class="dot"></span></button>
          <div class="emp-action-dropdown" id="emp-action-menu-${e.id}">
            <button class="emp-menu-item" type="button" onclick="openEmployeeProfile('${e.id}', 'personal')">View Profile</button>
            <button class="emp-menu-item activate" type="button" onclick="setEmployeeStatus('${e.id}', 'Active')" ${e.status === 'Active' ? 'disabled' : ''}>Activate</button>
            <button class="emp-menu-item deactivate" type="button" onclick="setEmployeeStatus('${e.id}', 'Inactive')" ${e.status === 'Inactive' ? 'disabled' : ''}>Deactivate</button>
          </div>
        </div>
      </td>
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

function closeEmployeeActionMenus() {
  document.querySelectorAll('.emp-action-dropdown.open').forEach(menu => {
    menu.classList.remove('open');
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
    menu.classList.add('open');
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
  
  const empPosition = document.querySelector('#form-employment input#emp-position');
  if (empPosition) empPosition.value = employee.position || '';
  
  const empType = document.querySelector('#form-employment select#emp-type');
  if (empType) empType.value = employee.employment_type || 'Regular';
  
  const empHiredDate = document.querySelector('#form-employment input#emp-hired-date');
  if (empHiredDate) empHiredDate.value = employee.date_hired || '';
  
  const empSupervisor = document.querySelector('#form-employment input#emp-supervisor');
  if (empSupervisor) empSupervisor.value = employee.supervisor || '';
  
  const empLocation = document.querySelector('#form-employment input#emp-location');
  if (empLocation) empLocation.value = employee.work_location || '';
  
  console.log('Form prefilled successfully');
}

function filterEmployees() {
  const search = document.getElementById('emp-search')?.value.toLowerCase() || '';
  const status = document.getElementById('emp-status')?.value || '';
  const dept   = document.getElementById('emp-dept')?.value || '';

  const filtered = EMPLOYEES.filter(e => {
    const matchSearch = e.name.toLowerCase().includes(search) || e.email.toLowerCase().includes(search);
    const matchStatus = !status || status === 'All Status' || e.status === status;
    const matchDept   = !dept   || dept   === 'All Departments' || e.dept   === dept;
    return matchSearch && matchStatus && matchDept;
  });

  console.log(`Filtered: ${filtered.length} employees (search: "${search}", status: "${status}", dept: "${dept}")`);
  
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
  const confirmMsg = `Are you sure you want to ${newStatus === 'Active' ? 'activate' : 'deactivate'} this employee?`;

  closeEmployeeActionMenus();
  const confirmed = await showConfirm(confirmMsg, 'Confirm Action', 'Yes', 'Cancel');
  if (!confirmed) return;

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
    await showAlert(data.message || 'Status updated successfully', 'Success', 'success');
    await fetchEmployees();
  } catch (error) {
    console.error('Error updating status:', error);
    await showAlert('Failed to update employee status: ' + error.message, 'Error', 'error');
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
  document.querySelector('#form-employment input#emp-position').value = '';
  document.querySelector('#form-employment select#emp-type').value = 'Regular';
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
    // Convert wage type name to numeric ID for form select
    let wageTypeId = '';
    if (employee.wage_type) {
      const wageTypeMap = {
        'Base Salary': '1',
        'Hourly': '2',
        'Per-Piece': '3',
        'Per-Piece (Sewing)': '3',
        'Per-Trip': '4',
        'Per-Trip (Logistics)': '4'
      };
      wageTypeId = wageTypeMap[employee.wage_type] || '';
    }
    document.getElementById('edit-payroll-wage-type').value = wageTypeId;
    document.getElementById('edit-payroll-rate').value = employee.base_rate || '';
    
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
    await showAlert('First name, last name, and email are required', 'Validation Error', 'warning');
    return;
  }

  // Collect sewing type rates if wage type is per-piece
  let sewingRates = [];
  if (wageType === '3') { // Per-Piece (Sewing)
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
        wage_type: wageType === '1' ? 'Base Salary' : wageType === '2' ? 'Hourly' : wageType === '3' ? 'Per-Piece' : 'Per-Trip',
        base_rate: baseRate ? parseFloat(baseRate) : null,
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
  
  if (wageTypeValue === '3') {
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

  fetchEmployees();

  // Auto-refresh employees every 5 seconds to catch new additions
  if (!EMPLOYEE_PAGE_INITIALIZED) {
    setInterval(fetchEmployees, 5000);
    EMPLOYEE_PAGE_INITIALIZED = true;
  }

  document.getElementById('emp-search') ?.addEventListener('input',  filterEmployees);
  document.getElementById('emp-dept')   ?.addEventListener('change', filterEmployees);
  document.getElementById('emp-status') ?.addEventListener('change', filterEmployees);
}

document.addEventListener('DOMContentLoaded', initializeEmployeePage);
document.addEventListener('partialsLoaded', initializeEmployeePage);

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
      await showAlert('❌ For Hourly wage: Please enter a VALID hourly rate (must be greater than 0)', 'Validation Error', 'warning');
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
      await showAlert('❌ For ' + wageTypeMap[wageTypeId] + ': Please enter a VALID rate (must be greater than 0)', 'Validation Error', 'warning');
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
  if (typeof value === 'string' && value.includes('T')) return value.split('T')[0];
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
  setText('profile-initials', initials);
  setText('profile-company', 'Marulas Industrial Corp');
  setText('profile-emp-id', employee.employee_code || employee.id);
  setText('profile-dob', employee.date_of_birth);
  setText('profile-email', employee.email);
  setText('profile-phone', employee.contact_number);
  setText('profile-joined', employee.date_hired);

  const pageTitle = document.getElementById('page-title');
  if (pageTitle) pageTitle.textContent = getEmployeeFullName(employee);
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
    'profile-edit-type': employee.employment_type || 'Regular',
    'profile-edit-hired': formatValue(employee.date_hired) === '-' ? '' : formatValue(employee.date_hired),
    'profile-edit-end-contract': formatValue(employee.end_of_contract) === '-' ? '' : formatValue(employee.end_of_contract),
    'profile-edit-supervisor': employee.supervisor,
    'profile-edit-location': employee.work_location,
    'profile-edit-shift-schedule': employee.shift_schedule,
    'profile-edit-employee-level': employee.employee_level,
    'profile-edit-employment-history': employee.employment_history,
    'profile-edit-status': employee.status || 'Active',
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
}

function toggleProfileEditMode(forceState = null, skipTabSync = false) {
  const view = document.getElementById('profile-view-root');
  const edit = document.getElementById('profile-edit-root');
  let nextState = forceState === null ? !edit?.classList.contains('active') : !!forceState;

  if (nextState && PROFILE_TABLE_ONLY_TABS.has(currentProfileTab)) {
    nextState = false;
  }

  if (view) view.classList.toggle('hidden', nextState);
  if (edit) edit.classList.toggle('active', nextState);
  if (!skipTabSync) switchProfileTab(currentProfileTab);
}

async function saveProfilePageChanges() {
  if (!currentProfileEmployee) return;

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
    residential_address: document.getElementById('profile-edit-address')?.value || null,
    current_address: document.getElementById('profile-edit-current-address')?.value || null,
    mailing_address: document.getElementById('profile-edit-mailing-address')?.value || null,
    position: document.getElementById('profile-edit-position')?.value || null,
    employment_type: document.getElementById('profile-edit-type')?.value || 'Regular',
    date_hired: document.getElementById('profile-edit-hired')?.value || null,
    end_of_contract: document.getElementById('profile-edit-end-contract')?.value || null,
    supervisor: document.getElementById('profile-edit-supervisor')?.value || null,
    work_location: document.getElementById('profile-edit-location')?.value || null,
    shift_schedule: document.getElementById('profile-edit-shift-schedule')?.value || null,
    employee_level: document.getElementById('profile-edit-employee-level')?.value || null,
    employment_history: document.getElementById('profile-edit-employment-history')?.value || null,
    status: document.getElementById('profile-edit-status')?.value || 'Active',
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
    base_rate: document.getElementById('profile-edit-basic-salary')?.value || null,
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

  try {
    const response = await apiFetch(`/api/employees/${currentProfileEmployee.id}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
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
  } catch (error) {
    await showAlert(error.message, 'Upload Failed', 'error');
  } finally {
    event.target.value = '';
  }
}

function openEmployeeDocumentUpload() {
  document.getElementById('profile-doc-input')?.click();
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
  const list = document.getElementById('profile-documents-list');
  if (!list || !employee?.employee_code) return;

  try {
    const response = await apiFetch(`/api/employees/${employee.employee_code}/documents`);
    if (!response.ok) throw new Error('No documents');
    const docs = await response.json();

    if (!docs.length) {
      list.innerHTML = '<div class="profile-empty">No documents uploaded yet.</div>';
      return;
    }

    list.innerHTML = docs.map(doc => `
      <div class="profile-doc-card">
        <div class="profile-doc-main">
          <span class="profile-doc-icon">[]</span>
          <div>
            <div class="profile-value">${escapeHtml(doc.document_name || doc.file_name || doc.document_type || 'Document')}</div>
            <div class="profile-label">${escapeHtml(doc.document_type || 'Document')}</div>
          </div>
        </div>
        <span class="profile-label">${escapeHtml(doc.uploaded_date || doc.uploaded_at || doc.created_at)}</span>
      </div>
    `).join('');
  } catch {
    list.innerHTML = '<div class="profile-empty">No documents uploaded yet.</div>';
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
window.openEmployeeDetail = openEmployeeDetail;
window.toggleEmployeeActionMenu = toggleEmployeeActionMenu;
window.setEmployeeStatus = setEmployeeStatus;
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
