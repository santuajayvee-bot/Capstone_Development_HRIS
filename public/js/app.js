/* ============================================================
   public/js/app.js — Router with RBAC route guard
   ============================================================ */

const PAGE_TITLES = {
  dashboard:  'Dashboard',
  employees:  'Employee Management',
  'organization-setup': 'Organization Setup',
  register:   'Register Employee',
  leave:      'Leave Management',
  requests:   'Requests',
  attendance: 'Attendance Tracking',
  payroll:    'Payroll',
  reports:    'Reports',
  onboarding: 'HR - Onboarding Management',
  blockchain: 'Blockchain',
  'system-admin': 'System Administration',
  'employee-dashboard': 'Employee Dashboard',
  'employee-profile': 'Employee Profile',
  'self-service': 'My Profile',
};

let topbarClockTimer = null;
const AUTO_TABLE_PAGE_SIZE = 10;
let autoTablePaginationId = 0;

function formatTopbarDateTime(date = new Date()) {
  return date.toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  });
}

function updateTopbarDateTime() {
  const dateEl = document.getElementById('page-date');
  if (dateEl) dateEl.textContent = formatTopbarDateTime();
}

function startTopbarClock() {
  if (topbarClockTimer) clearInterval(topbarClockTimer);
  updateTopbarDateTime();
  topbarClockTimer = setInterval(updateTopbarDateTime, 1000);
}

window.renderActionDotsIcon = function renderActionDotsIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="action-dots-icon bi bi-three-dots-vertical" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <path d="M9.5 13a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0m0-5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0"/>
  </svg>`;
};

function enhanceResponsiveTables(root = document) {
  root.querySelectorAll('table').forEach(table => {
    const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
    if (!headers.length) return;
    if (table.dataset.responsiveReady !== '1') {
      table.dataset.responsiveReady = '1';
      table.classList.add(headers.length <= 7 ? 'responsive-card-table' : 'responsive-scroll-table');
    }
    table.querySelectorAll('tbody tr').forEach(row => {
      [...row.children].forEach((cell, index) => {
        if (!cell.dataset.label) cell.dataset.label = headers[index] || '';
      });
    });
    enhanceTablePagination(table);
  });
}

function shouldAutoPaginateTable(table) {
  if (!table || table.dataset.noPagination === '1' || table.closest('[data-no-pagination="1"]')) return false;
  if (table.closest('.salary-form, .payroll-breakdown-modal, .modal, .swal2-container')) return false;
  if (table.classList.contains('payroll-simple-table')
    || table.classList.contains('payroll-breakdown-table')
    || table.classList.contains('salary-summary-table')
    || table.classList.contains('salary-work-table')) return false;
  const tbody = table.tBodies?.[0];
  if (!tbody) return false;
  const rows = [...tbody.rows].filter(row => !row.classList.contains('table-empty'));
  if (rows.length <= Number(table.dataset.pageSize || AUTO_TABLE_PAGE_SIZE)) return false;
  return true;
}

function enhanceTablePagination(table) {
  const tbody = table.tBodies?.[0];
  if (!tbody) return;
  const pageSize = Number(table.dataset.pageSize || AUTO_TABLE_PAGE_SIZE);
  const paginationAnchor = table.closest('.table-wrap') || table;
  const inlinePagination = table.nextElementSibling;
  const anchoredPagination = paginationAnchor.nextElementSibling;
  let rows = [...tbody.rows].filter(row => !row.classList.contains('table-empty'));
  const hasOnlyEmptyRow = rows.length === 1 && rows[0].children.length <= 1;
  if (!shouldAutoPaginateTable(table) || hasOnlyEmptyRow) {
    rows.forEach(row => { row.hidden = false; });
    if (inlinePagination?.classList.contains('table-pagination') && inlinePagination.dataset.autoPagination === '1') inlinePagination.remove();
    if (anchoredPagination?.classList.contains('table-pagination') && anchoredPagination.dataset.autoPagination === '1') anchoredPagination.remove();
    table.dataset.paginationReady = '0';
    return;
  }

  if (!table.dataset.paginationId) {
    table.dataset.paginationId = `auto-table-${++autoTablePaginationId}`;
  }
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  let currentPage = Math.min(Math.max(Number(table.dataset.paginationPage || 1), 1), totalPages);
  table.dataset.paginationPage = String(currentPage);

  const start = (currentPage - 1) * pageSize;
  const end = start + pageSize;
  rows.forEach((row, index) => { row.hidden = index < start || index >= end; });

  if (inlinePagination?.classList.contains('table-pagination') && inlinePagination.dataset.autoPagination === '1') {
    inlinePagination.remove();
  }

  let controls = paginationAnchor.nextElementSibling;
  if (!controls?.classList.contains('table-pagination')) {
    controls = document.createElement('div');
    controls.className = 'table-pagination table-pagination-auto';
    paginationAnchor.insertAdjacentElement('afterend', controls);
  }
  controls.classList.add('table-pagination-auto');
  controls.dataset.autoPagination = '1';
  controls.dataset.for = table.dataset.paginationId;
  controls.__paginationTable = table;
  controls.innerHTML = `
    <span>Showing ${start + 1}-${Math.min(end, rows.length)} of ${rows.length}</span>
    <div class="table-pagination-actions">
      <button class="btn btn-outline btn-sm" type="button" data-page-action="prev" ${currentPage <= 1 ? 'disabled' : ''}>Previous</button>
      <span>Page ${currentPage} of ${totalPages}</span>
      <button class="btn btn-outline btn-sm" type="button" data-page-action="next" ${currentPage >= totalPages ? 'disabled' : ''}>Next</button>
    </div>
  `;
  if (controls.dataset.paginationBound !== '1') {
    controls.addEventListener('click', event => {
      const button = event.target.closest('[data-page-action]');
      if (!button || button.disabled) return;
      event.preventDefault();
      event.stopPropagation();

      const paginatedTable = controls.__paginationTable;
      if (!paginatedTable) return;
      const liveRows = [...(paginatedTable.tBodies?.[0]?.rows || [])].filter(row => !row.classList.contains('table-empty'));
      const livePageSize = Number(paginatedTable.dataset.pageSize || AUTO_TABLE_PAGE_SIZE);
      const liveTotalPages = Math.max(1, Math.ceil(liveRows.length / livePageSize));
      const livePage = Math.min(Math.max(Number(paginatedTable.dataset.paginationPage || 1), 1), liveTotalPages);
      const direction = button.dataset.pageAction === 'next' ? 1 : -1;
      paginatedTable.dataset.paginationPage = String(Math.min(Math.max(livePage + direction, 1), liveTotalPages));
      enhanceTablePagination(paginatedTable);
    });
    controls.dataset.paginationBound = '1';
  }
}

function navigate(pageId, navEl, params = null) {
  const user = typeof getUser === 'function' ? getUser() : null;
  if ((user?.mustChangePassword || user?.forcePasswordChange) && pageId !== 'self-service') {
    pageId = 'self-service';
    navEl = null;
    params = { ...(params || {}), forcePasswordChange: true };
  }

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
    document.querySelectorAll('.nav-item, .employee-bottom-nav-item').forEach(n => n.classList.remove('active'));
    navEl.classList.add('active');
  } else {
    document.querySelectorAll('.nav-item, .employee-bottom-nav-item').forEach(n => {
      n.classList.toggle('active', n.dataset.page === pageId);
    });
  }
  document.querySelectorAll('.nav-item, .employee-bottom-nav-item').forEach(n => {
    if (n !== navEl) n.classList.toggle('active', n.dataset.page === pageId);
  });
  if (typeof closeMobileSidebar === 'function') closeMobileSidebar();

  window.ROUTE_PARAMS = { pageId, ...(params || {}) };

  if (pageId === 'dashboard' && typeof loadDashboard === 'function') {
    loadDashboard();
  }

  if (pageId === 'employees' && typeof initializeEmployeePage === 'function') {
    initializeEmployeePage();
  }

  if (pageId === 'organization-setup' && typeof initializeOrganizationSetupPage === 'function') {
    initializeOrganizationSetupPage();
  }
  
  // When navigating to register, load employee data if editing
  if (pageId === 'register' && typeof initializeRegisterPage === 'function') {
    initializeRegisterPage();
  } else if (pageId === 'register' && typeof loadEmployeeData === 'function') {
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

  if (pageId === 'self-service' && typeof initSelfServiceProfile === 'function') {
    initSelfServiceProfile();
  }

  requestAnimationFrame(() => enhanceResponsiveTables(document.getElementById('page-' + pageId) || document));
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
window.enhanceResponsiveTables = enhanceResponsiveTables;
window.startTopbarClock = startTopbarClock;

document.addEventListener('partialsLoaded', () => {
  enhanceResponsiveTables();
  updateTopbarDateTime();
});

document.addEventListener('DOMContentLoaded', () => {
  startTopbarClock();

  const pageBody = document.querySelector('.page-body');
  if (!pageBody) return;
  let tableEnhanceTimer = null;
  new MutationObserver(() => {
    clearTimeout(tableEnhanceTimer);
    tableEnhanceTimer = setTimeout(() => enhanceResponsiveTables(pageBody), 120);
  }).observe(pageBody, { childList: true, subtree: true });
});
