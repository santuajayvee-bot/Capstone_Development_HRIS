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

const APP_ROUTE_MAP = {
  '/dashboard': { page: 'dashboard' },
  '/employees': { page: 'employees' },
  '/attendance': { page: 'attendance' },
  '/leave': { page: 'leave' },
  '/payroll': { page: 'payroll' },
  '/salary-calculation': { page: 'payroll', params: { payrollTab: 'salary' } },
  '/reports': { page: 'reports' },
  '/settings': { page: 'self-service' },
  '/organization-setup': { page: 'organization-setup' },
  '/register': { page: 'register' },
  '/employee-profile': { page: 'employee-profile' },
  '/requests': { page: 'requests' },
  '/onboarding': { page: 'onboarding' },
  '/blockchain': { page: 'blockchain' },
  '/system-admin': { page: 'system-admin' },
  '/my-profile': { page: 'self-service' },
};

function normalizeAppPath(path = window.location.pathname) {
  const cleanPath = String(path || '/')
    .split('?')[0]
    .split('#')[0]
    .replace(/\/+$/g, '');
  return cleanPath || '/';
}

function defaultRouteForUser(user = null) {
  return '/dashboard';
}

function resolveAppRoute(path = window.location.pathname) {
  const normalizedPath = normalizeAppPath(path);
  const user = typeof getUser === 'function' ? getUser() : null;

  if (normalizedPath === '/' || normalizedPath === '/index.html') {
    return { path: defaultRouteForUser(user), page: user && typeof isEmployeeRole === 'function' && isEmployeeRole(user.role) ? 'employee-dashboard' : 'dashboard', params: user && typeof isEmployeeRole === 'function' && isEmployeeRole(user.role) ? { employeeTab: 'overview' } : {} };
  }

  if (normalizedPath === '/login') {
    return { path: '/login', public: true };
  }

  if (normalizedPath === '/dashboard' && user && typeof isEmployeeRole === 'function' && isEmployeeRole(user.role)) {
    return { path: '/dashboard', page: 'employee-dashboard', params: { employeeTab: 'overview' } };
  }

  if (normalizedPath === '/payslips') {
    if (user && typeof isEmployeeRole === 'function' && isEmployeeRole(user.role)) {
      return { path: '/payslips', page: 'employee-dashboard', params: { employeeTab: 'payslips' } };
    }
    return { path: '/payslips', page: 'payroll', params: { payrollTab: 'records' } };
  }

  const route = APP_ROUTE_MAP[normalizedPath];
  return route ? { path: normalizedPath, ...route, params: { ...(route.params || {}) } } : null;
}

function routeForPage(pageId, params = null) {
  const routeParams = params || {};
  if (pageId === 'dashboard') return '/dashboard';
  if (pageId === 'employee-dashboard') {
    return routeParams.employeeTab === 'payslips' ? '/payslips' : '/dashboard';
  }
  if (pageId === 'payroll') {
    if (routeParams.payrollTab === 'salary') return '/salary-calculation';
    if (routeParams.payrollTab === 'records' || routeParams.payrollTab === 'payslips') return '/payslips';
    return '/payroll';
  }
  const match = Object.entries(APP_ROUTE_MAP).find(([, route]) => route.page === pageId && !route.params);
  return match ? match[0] : `/${pageId}`;
}

function setAppPath(path, replace = false) {
  const targetPath = normalizeAppPath(path);
  const currentPath = normalizeAppPath();
  if (targetPath === currentPath) return;
  const method = replace ? 'replaceState' : 'pushState';
  window.history[method]({ path: targetPath }, '', targetPath);
}

function syncRouteForPage(pageId, params = null, replace = false) {
  setAppPath(routeForPage(pageId, params), replace);
}

function showLoginRoute(replace = true) {
  const app = document.getElementById('app');
  const login = document.getElementById('login-screen');
  if (app) app.style.display = 'none';
  if (login) login.style.display = 'flex';
  setAppPath('/login', replace);
}

function showApplicationShell(user = null) {
  const app = document.getElementById('app');
  const login = document.getElementById('login-screen');
  if (login) login.style.display = 'none';
  if (app) app.style.display = 'block';
  if (user && typeof buildSidebar === 'function') {
    const navItems = document.getElementById('nav-items');
    if (!navItems?.children.length) buildSidebar(user);
  }
}

function applyRoutePageState(pageId, params = null) {
  const routeParams = params || {};
  if (pageId === 'payroll' && routeParams.payrollTab && typeof switchPayrollTab === 'function') {
    switchPayrollTab(routeParams.payrollTab, { skipRouteUpdate: true });
  }
}

function handleAppRoute(options = {}) {
  const user = typeof getUser === 'function' ? getUser() : null;
  const loggedIn = typeof isLoggedIn === 'function' ? isLoggedIn() : !!user;
  let route = resolveAppRoute(window.location.pathname);
  const currentPath = normalizeAppPath();

  if (!route) {
    const fallbackPath = loggedIn ? defaultRouteForUser(user) : '/login';
    setAppPath(fallbackPath, true);
    route = resolveAppRoute(fallbackPath);
  }

  if (route?.public) {
    if (loggedIn) {
      setAppPath(defaultRouteForUser(user), true);
      handleAppRoute({ replace: true });
      return;
    }
    showLoginRoute(true);
    return;
  }

  if (!loggedIn) {
    if (currentPath !== '/login') sessionStorage.setItem('vp_pending_route', currentPath);
    showLoginRoute(true);
    return;
  }

  if (typeof requiresDpaGate === 'function' && requiresDpaGate(user)) {
    if (typeof showDpaAgreementGate === 'function') {
      showDpaAgreementGate({
        afterAccept: () => handleAppRoute({ replace: true }),
      });
    }
    return;
  }

  if (user?.mustChangePassword || user?.forcePasswordChange) {
    route = { path: '/settings', page: 'self-service', params: { forcePasswordChange: true } };
    setAppPath('/settings', true);
  }

  showApplicationShell(user);
  if (!route?.page) return;

  if (typeof canAccess === 'function' && !canAccess(route.page)) {
    showAccessDenied();
    return;
  }

  if (route.path && route.path !== currentPath) setAppPath(route.path, true);
  navigate(route.page, null, { ...(route.params || {}), skipRouteUpdate: true });
}

let topbarClockTimer = null;
const AUTO_TABLE_PAGE_SIZE = 10;
let autoTablePaginationId = 0;
const LGSV_TIME_ZONE = 'Asia/Manila';

function parseLgsvDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const text = String(value).trim();
  const mysqlDateTime = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/);
  const date = new Date(mysqlDateTime ? `${mysqlDateTime[1]}T${mysqlDateTime[2]}+08:00` : value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatPhilippineDateTime(value = new Date(), options = {}) {
  const date = parseLgsvDateTime(value);
  if (!date) return options.fallback || '-';
  const formatted = date.toLocaleString(options.locale || 'en-PH', {
    timeZone: LGSV_TIME_ZONE,
    dateStyle: options.dateStyle || 'medium',
    timeStyle: options.timeStyle || 'medium',
    hour12: options.hour12 ?? true,
  });
  return options.includeSuffix === false ? formatted : `${formatted} PHT`;
}

window.LGSV_TIME_ZONE = LGSV_TIME_ZONE;
window.formatPhilippineDateTime = formatPhilippineDateTime;

function formatTopbarDateTime(date = new Date()) {
  return date.toLocaleString('en-US', {
    timeZone: LGSV_TIME_ZONE,
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
        if (row.classList.contains('table-empty')
          || cell.classList.contains('table-empty')
          || Number(cell.colSpan || 1) > 1) {
          delete cell.dataset.label;
          return;
        }
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
  const paginationAnchor = table.closest('.table-wrap, .sysadmin-table-wrapper, .audit-trail-table-wrap') || table;
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
  let summary = controls.querySelector('[data-pagination-summary]');
  let previousButton = controls.querySelector('[data-page-action="prev"]');
  let pageLabel = controls.querySelector('[data-pagination-page]');
  let nextButton = controls.querySelector('[data-page-action="next"]');

  // Keep the same button nodes between observer passes. Replacing the markup
  // repeatedly can discard a hover/click in progress and make paging stutter.
  if (!summary || !previousButton || !pageLabel || !nextButton) {
    controls.innerHTML = `
      <span data-pagination-summary></span>
      <div class="table-pagination-actions">
        <button class="btn btn-outline btn-sm" type="button" data-page-action="prev">Previous</button>
        <span data-pagination-page></span>
        <button class="btn btn-outline btn-sm" type="button" data-page-action="next">Next</button>
      </div>
    `;
    summary = controls.querySelector('[data-pagination-summary]');
    previousButton = controls.querySelector('[data-page-action="prev"]');
    pageLabel = controls.querySelector('[data-pagination-page]');
    nextButton = controls.querySelector('[data-page-action="next"]');
  }

  const summaryText = `Showing ${start + 1}-${Math.min(end, rows.length)} of ${rows.length}`;
  const pageText = `Page ${currentPage} of ${totalPages}`;
  if (summary.textContent !== summaryText) summary.textContent = summaryText;
  if (pageLabel.textContent !== pageText) pageLabel.textContent = pageText;
  previousButton.disabled = currentPage <= 1;
  nextButton.disabled = currentPage >= totalPages;
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
  const routeParams = { ...(params || {}) };
  const skipRouteUpdate = routeParams.skipRouteUpdate === true;
  delete routeParams.skipRouteUpdate;

  const user = typeof getUser === 'function' ? getUser() : null;
  if (typeof applyUserRoleToDocument === 'function') applyUserRoleToDocument(user);
  if ((user?.mustChangePassword || user?.forcePasswordChange) && pageId !== 'self-service') {
    pageId = 'self-service';
    navEl = null;
    routeParams.forcePasswordChange = true;
  }

  // Role guard — check permission before switching
  if (!canAccess(pageId)) {
    showAccessDenied();
    return;
  }

  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  const target = document.getElementById('page-' + pageId);
  if (target) target.classList.add('active');
  document.body.dataset.activePage = pageId;
  const pageBody = document.querySelector('.page-body');
  if (pageBody) {
    pageBody.scrollTop = 0;
    requestAnimationFrame(() => { pageBody.scrollTop = 0; });
  }
  window.scrollTo(0, 0);

  const titleEl = document.getElementById('page-title');
  if (titleEl) {
    const isEmployeeUser = typeof isEmployeeRole === 'function' ? isEmployeeRole(user?.role) : user?.role === 'employee';
    const employeeTitles = {
      'employee-dashboard:overview': 'My Dashboard',
      'employee-dashboard:201file': 'My Profile',
      'employee-dashboard:payslips': 'My Payslips',
      'employee-dashboard:settings': 'My Info',
      attendance: 'My Attendance',
      leave: 'My Leave',
      'self-service': 'My Profile',
      requests: 'My Requests',
    };
    const titleKey = routeParams.employeeTab ? `${pageId}:${routeParams.employeeTab}` : pageId;
    titleEl.textContent = isEmployeeUser && employeeTitles[titleKey]
      ? employeeTitles[titleKey]
      : PAGE_TITLES[pageId] || pageId;
  }

  const navKey = routeParams.employeeTab ? `${pageId}:${routeParams.employeeTab}` : pageId;

  if (navEl) {
    document.querySelectorAll('.nav-item, .employee-bottom-nav-item').forEach(n => n.classList.remove('active'));
    navEl.classList.add('active');
  } else {
    document.querySelectorAll('.nav-item, .employee-bottom-nav-item').forEach(n => {
      n.classList.toggle('active', (n.dataset.navKey || n.dataset.page) === navKey);
    });
  }
  document.querySelectorAll('.nav-item, .employee-bottom-nav-item').forEach(n => {
    if (n !== navEl) n.classList.toggle('active', (n.dataset.navKey || n.dataset.page) === navKey);
  });
  if (typeof closeMobileSidebar === 'function') closeMobileSidebar();

  window.ROUTE_PARAMS = { pageId, ...routeParams };
  if (!skipRouteUpdate) syncRouteForPage(pageId, routeParams);

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

  if (pageId === 'blockchain' && typeof initBlockchainPage === 'function') {
    initBlockchainPage();
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
    requestAnimationFrame(() => applyRoutePageState(pageId, routeParams));
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
    loadEmployeeProfilePage(routeParams || {});
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
window.routeForPage = routeForPage;
window.resolveAppRoute = resolveAppRoute;
window.syncRouteForPage = syncRouteForPage;
window.handleAppRoute = handleAppRoute;
window.showLoginRoute = showLoginRoute;

document.addEventListener('partialsLoaded', () => {
  enhanceResponsiveTables();
  updateTopbarDateTime();
  if (window.ROUTE_PARAMS?.pageId) {
    applyRoutePageState(window.ROUTE_PARAMS.pageId, window.ROUTE_PARAMS);
  }
});

document.addEventListener('DOMContentLoaded', () => {
  startTopbarClock();
  window.addEventListener('popstate', () => handleAppRoute({ fromPopState: true }));
  setTimeout(() => handleAppRoute({ replace: true }), 0);

  const pageBody = document.querySelector('.page-body');
  if (!pageBody) return;
  let tableEnhanceTimer = null;
  new MutationObserver(() => {
    clearTimeout(tableEnhanceTimer);
    tableEnhanceTimer = setTimeout(() => enhanceResponsiveTables(pageBody), 120);
  }).observe(pageBody, { childList: true, subtree: true });
});
