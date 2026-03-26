/* ============================================================
   EMPLOYEES.JS — Employee list filtering & search
   ============================================================ */

let EMPLOYEES = []; // Will be populated from API
let EMPLOYEES_RAW = []; // Store raw API data for editing
let CURRENT_VIEW = 'list'; // 'list' or 'manage'

async function fetchEmployees() {
  try {
    const response = await apiFetch('/api/employees');
    if (!response) return; // apiFetch handles 401 logout
    if (!response.ok) throw new Error('Failed to fetch employees');
    const data = await response.json();
    EMPLOYEES_RAW = data; // Store raw data for editing
    EMPLOYEES = data.map(e => ({
      id: e.employee_code || '—',
      name: `${e.first_name} ${e.last_name}`,
      initials: `${e.first_name[0]}${e.last_name[0]}`.toUpperCase(),
      gradient: 'linear-gradient(135deg,#4f7cff,#22d3a5)', // Default gradient
      email: e.email,
      phone: e.contact_number || '—',
      city: e.residential_address ? e.residential_address.split(',')[0] : '—', // Simple city extraction
      dept: e.department || '—',
      position: e.position || '—',
      supervisor: e.supervisor || '—',
      status: e.status,
      //  Store raw data ref for editing
      _raw: e
    }));
    console.log('Fetched employees from API:', EMPLOYEES.length, 'employees');
    renderEmployees(EMPLOYEES);
    return EMPLOYEES; // Return the fetched data
  } catch (error) {
    console.error('Error fetching employees:', error);
    // Fallback to static data if API fails
    EMPLOYEES = [
      { id:'EMP00521', name:'Serjo Justine',  initials:'SJ', gradient:'linear-gradient(135deg,#4f7cff,#22d3a5)', email:'sjerp@hrekuh.com',      phone:'+63 02 1267 981', city:'Dasmarinas City',        dept:'HR',         status:'Active' },
      { id:'EMP00522', name:'Chris Brown',    initials:'CB', gradient:'linear-gradient(135deg,#f5a623,#e05c7a)', email:'fistmas@gmail.com',      phone:'+63 52 2345 800',  city:'Caloocan City',          dept:'Production', status:'Active' },
      { id:'EMP00583', name:'LeBron James',   initials:'LJ', gradient:'linear-gradient(135deg,#22d3a5,#4f7cff)', email:'lebr42@james-er.com',    phone:'+63 17 2322 203', city:'Paranaque City',         dept:'HR',         status:'Active' },
      { id:'EMP00600', name:'Nikki Minaj',    initials:'NM', gradient:'linear-gradient(135deg,#7c5cfc,#e05c7a)', email:'nikkitulsa@gmail.com',   phone:'+63 277 537 329', city:'Quezon City',            dept:'Executive',  status:'Active' },
      { id:'EMP00601', name:'Boyd Amorado',   initials:'BA', gradient:'linear-gradient(135deg,#f5a623,#22d3a5)', email:'hmuk.smd72@gmail.com',   phone:'+32 10761 4444',  city:'Paranaque City',         dept:'Executive',  status:'Active' },
      { id:'EMP00602', name:'Sassa Gurl',     initials:'SG', gradient:'linear-gradient(135deg,#e05c7a,#f5a623)', email:'sassag4@email.com',      phone:'+63 96 868 7697', city:'Manila City',            dept:'Executive',  status:'Active' },
    ];
    renderEmployees(EMPLOYEES);
    return EMPLOYEES;
  }
}

function renderEmployees(list) {
  const grid = document.getElementById('emp-grid');
  if (!grid) return;
  grid.innerHTML = list.map(e => `
    <div class="emp-card" onclick="openEmployeeDetail('${e.id}')" style="cursor:pointer;">
      <div class="emp-top">
        <div class="emp-avatar" style="background:${e.gradient}">${e.initials}</div>
        <div>
          <div class="emp-name">${e.name} <span class="badge badge-active">${e.status}</span></div>
          <div class="emp-email">${e.email}</div>
        </div>
      </div>
      <div class="emp-phone">${e.phone} · ${e.city}</div>
      <div class="emp-meta">
        <div class="emp-meta-item"><div class="mlabel">Department</div><div class="mval">${e.dept}</div></div>
        <div class="emp-meta-item"><div class="mlabel">Position</div><div class="mval">${e.position}</div></div>
        <div class="emp-meta-item"><div class="mlabel">Supervisor</div><div class="mval">${e.supervisor}</div></div>
        <div class="emp-meta-item"><div class="mlabel">Employee ID</div><div class="mval">${e.id}</div></div>
      </div>
    </div>
  `).join('');

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
  const search = document.getElementById('manage-search')?.value.toLowerCase() || '';
  const status = document.getElementById('manage-status')?.value || '';
  const dept   = document.getElementById('manage-dept')?.value || '';

  const filtered = EMPLOYEES.filter(e => {
    const matchSearch = e.name.toLowerCase().includes(search) || e.email.toLowerCase().includes(search);
    const matchStatus = !status || status === 'All Status' || e.status === status;
    const matchDept   = !dept   || dept   === 'All Departments' || e.dept   === dept;
    return matchSearch && matchStatus && matchDept;
  });

  console.log(`Filtered: ${filtered.length} employees (search: "${search}", status: "${status}", dept: "${dept}")`);
  loadManageEmployeeList(filtered);
}

/* View Switching */
function switchView(view) {
  CURRENT_VIEW = view;
  const filterBar = document.querySelector('.filter-bar');
  const empGrid = document.getElementById('emp-grid');
  const empCount = document.getElementById('emp-count');
  const manageView = document.getElementById('emp-manage-view');
  
  if (view === 'list') {
    // Show list view, hide manage view
    if (filterBar) filterBar.style.display = '';
    if (empGrid) empGrid.style.display = '';
    if (empCount) empCount.style.display = '';
    if (manageView) manageView.style.display = 'none';
  } else if (view === 'manage') {
    // Check if user is admin
    const userStr = sessionStorage.getItem('vp_user');
    const user = userStr ? JSON.parse(userStr) : null;
    if (user?.role !== 'admin') {
      alert('Only administrators can access this feature.');
      return;
    }
    // Show manage view, hide list view
    if (filterBar) filterBar.style.display = 'none';
    if (empGrid) empGrid.style.display = 'none';
    if (empCount) empCount.style.display = 'none';
    if (manageView) {
      manageView.style.display = 'block';
      renderManagementTable(EMPLOYEES);
    }
  }
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
  
  grid.innerHTML = list.map(e => `
    <div class="emp-card" style="position:relative;">
      <div class="emp-top">
        <div class="emp-avatar" style="background:${e.gradient}">${e.initials}</div>
        <div>
          <div class="emp-name">${e.name} <span class="badge badge-active">${e.status}</span></div>
          <div class="emp-email">${e.email}</div>
        </div>
      </div>
      <div class="emp-phone">${e.phone} · ${e.city}</div>
      <div class="emp-meta">
        <div class="emp-meta-item"><div class="mlabel">Department</div><div class="mval">${e.dept}</div></div>
        <div class="emp-meta-item"><div class="mlabel">Position</div><div class="mval">${e.position}</div></div>
        <div class="emp-meta-item"><div class="mlabel">Supervisor</div><div class="mval">${e.supervisor}</div></div>
        <div class="emp-meta-item"><div class="mlabel">Employee ID</div><div class="mval">${e.id}</div></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;border-top:1px solid #e9ecef;padding-top:12px;">
        <button class="btn btn-sm btn-outline" onclick="editEmployeeFromManage('${e.id}')" style="flex:1;font-size:12px;">Edit</button>
        <button class="btn btn-sm btn-outline" onclick="toggleEmployeeStatus('${e.id}', '${e.status}')" style="flex:1;font-size:12px;" title="Toggle Status">${e.status === 'Active' ? 'Deactivate' : 'Activate'}</button>
        <button class="btn btn-sm btn-outline" onclick="deleteEmployeeFromManage('${e.id}')" style="flex:1;font-size:12px;color:#dc3545;">Delete</button>
      </div>
    </div>
  `).join('');
  
  console.log('Rendered', list.length, 'employees to manage grid');
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
  console.log('Editing employee:', employeeId);
  const employee = EMPLOYEES_RAW.find(e => e.employee_code === employeeId);
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
  console.log('Set edit mode for employee:', employeeId);
  console.log('Flags: IS_EDITING:', window.IS_EDITING, 'PENDING_EDIT_MODE:', window.PENDING_EDIT_MODE);
  
  // Switch to form view
  switchRegisterView('add');
}

async function deleteEmployeeFromManage(employeeId) {
  const emp = EMPLOYEES.find(e => e.id === employeeId);
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
  const grid = document.getElementById('emp-manage-tbody');
  if (!grid) {
    console.error('Grid element "emp-manage-tbody" not found!');
    return;
  }
  
  grid.innerHTML = list.map(e => `
    <div class="emp-card" style="position:relative;">
      <div class="emp-top">
        <div class="emp-avatar" style="background:${e.gradient}">${e.initials}</div>
        <div>
          <div class="emp-name">${e.name} <span class="badge badge-active">${e.status}</span></div>
          <div class="emp-email">${e.email}</div>
        </div>
      </div>
      <div class="emp-phone">${e.phone} · ${e.city}</div>
      <div class="emp-meta">
        <div class="emp-meta-item"><div class="mlabel">Department</div><div class="mval">${e.dept}</div></div>
        <div class="emp-meta-item"><div class="mlabel">Position</div><div class="mval">${e.position}</div></div>
        <div class="emp-meta-item"><div class="mlabel">Supervisor</div><div class="mval">${e.supervisor}</div></div>
        <div class="emp-meta-item"><div class="mlabel">Employee ID</div><div class="mval">${e.id}</div></div>
      </div>
      <div style="display:flex;gap:8px;margin-top:12px;border-top:1px solid #e9ecef;padding-top:12px;">
        <button class="btn btn-sm btn-outline" onclick="editEmployee('${e.id}')" style="flex:1;font-size:12px;">Edit</button>
        <button class="btn btn-sm btn-outline" onclick="toggleEmployeeStatus('${e.id}', '${e.status}')" style="flex:1;font-size:12px;" title="Toggle Status">${e.status === 'Active' ? 'Deactivate' : 'Activate'}</button>
        <button class="btn btn-sm btn-outline" onclick="deleteEmployee('${e.id}', '${e.name}')" style="flex:1;font-size:12px;color:#dc3545;">Delete</button>
      </div>
    </div>
  `).join('');
  
  console.log('Rendered', list.length, 'employees to management grid');
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
function editEmployee(empId) {
  console.log('Editing employee:', empId);
  const employee = EMPLOYEES_RAW.find(e => e.employee_code === empId);
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

// Expose refresh function globally for manual refresh
window.refreshEmployees = fetchEmployees;
window.fetchEmployees = fetchEmployees;
window.switchRegisterView = switchRegisterView;
window.loadManageEmployeeList = loadManageEmployeeList;
window.openEmployeeDetail = openEmployeeDetail;
window.prefillEmployeeForm = prefillEmployeeForm;

// Close modal when clicking outside
window.addEventListener('click', (e) => {
  const modal = document.getElementById('emp-detail-modal');
  if (modal && e.target === modal) closeEmployeeDetail();
});
