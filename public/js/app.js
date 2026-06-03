/* ============================================================
   public/js/app.js — Router with RBAC route guard
   ============================================================ */

const PAGE_TITLES = {
  dashboard:  'Dashboard',
  employees:  'Employee Management',
  register:   'Register Employee',
  leave:      'Leave Management',
  requests:   'Requests',
  attendance: 'Attendance Tracking',
  '201file':  '201-File Management',
  payroll:    'Payroll',
  onboarding: 'HR Admin - Onboarding Management',
  blockchain: 'Blockchain',
  'system-admin': 'System Administration',
  'employee-dashboard': 'Employee Dashboard',
  'employee-profile': 'Employee Profile',
};

function navigate(pageId, navEl, params = null) {
  // Role guard — check permission before switching
  if (!canAccess(pageId)) {
    showAccessDenied();
    return;
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  const target = document.getElementById('page-' + pageId);
  if (target) target.classList.add('active');

  const titleEl = document.getElementById('page-title');
  if (titleEl) titleEl.textContent = PAGE_TITLES[pageId] || pageId;

  if (navEl) {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    navEl.classList.add('active');
  }

  window.ROUTE_PARAMS = { pageId, ...(params || {}) };
  
  // When navigating to register, load employee data if editing
  if (pageId === 'register' && typeof loadEmployeeData === 'function') {
    loadEmployeeData();
    if (typeof generateEmployeeID === 'function') {
      generateEmployeeID();
    }
  }

  // When navigating to leave, load leave requests
  if (pageId === 'leave' && typeof loadLeaveRequests === 'function') {
    loadLeaveRequests();
  }

  // Refresh role-aware attendance surfaces on every visit.
  if (pageId === 'attendance' && typeof initAttendance === 'function') {
    initAttendance();
  }

  if (pageId === 'onboarding' && typeof initOnboarding === 'function') {
    initOnboarding();
  }

  // When navigating to 201-file, load list
  if (pageId === '201file' && typeof load201FileList === 'function') {
    load201FileList();
  }

  // When navigating to requests, load all requests
  if (pageId === 'requests' && typeof loadAllRequests === 'function') {
    loadAllRequests();
  }

  // When navigating to payroll, load payroll module data
  if (pageId === 'payroll') {
    if (typeof loadPayrollRecords === 'function') {
      loadPayrollRecords();
    }
    if (typeof loadSalaryCalculations === 'function') {
      loadSalaryCalculations();
    }
    if (typeof initializePayrollModule === 'function') {
      initializePayrollModule();
    }
    if (typeof loadSalaryCalculationPage === 'function') {
      loadSalaryCalculationPage();
    }
  }

  // When navigating to system-admin, initialize the module
  if (pageId === 'system-admin' && typeof initSystemAdmin === 'function') {
    initSystemAdmin();
  }

  // When navigating to employee-dashboard, initialize the module
  if (pageId === 'employee-dashboard' && typeof initEmployeeDashboard === 'function') {
    initEmployeeDashboard();
  }

  if (pageId === 'employee-profile' && typeof loadEmployeeProfilePage === 'function') {
    loadEmployeeProfilePage(params || {});
  }
}

function showAccessDenied() {
  // Show access denied page if it exists, otherwise alert
  const denied = document.getElementById('page-denied');
  if (denied) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    denied.classList.add('active');
    const titleEl = document.getElementById('page-title');
    if (titleEl) titleEl.textContent = 'Access Denied';
  } else {
    alert('⛔ You do not have permission to access this page.');
  }
}

window.navigate         = navigate;
window.showAccessDenied = showAccessDenied;
