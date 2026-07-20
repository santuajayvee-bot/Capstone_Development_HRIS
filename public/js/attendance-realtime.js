/* ============================================================
   AJAX attendance refresh
   ============================================================ */

let attendanceAjaxRefreshTimer = null;
let attendanceAjaxRefreshing = false;
let attendanceRealtimeListenerReady = false;
let attendanceBroadcastChannel = null;
let attendanceLastRealtimeRefreshAt = 0;
const ATTENDANCE_FAST_REFRESH_MS = 1500;
const ATTENDANCE_BACKGROUND_REFRESH_MS = 5000;
const ATTENDANCE_MIN_REFRESH_GAP_MS = 700;
const ATTENDANCE_SCAN_CHANNEL = 'lgsv-attendance-scan';

function currentPageId() {
  return window.ROUTE_PARAMS?.pageId || document.querySelector('.page.active')?.id?.replace(/^page-/, '') || 'dashboard';
}

function isPayrollRole(user) {
  return ['payroll_officer', 'payroll_manager'].includes(user?.role);
}

function isManagerRole(user) {
  return user?.role === 'manager';
}

function attendanceRealtimeToast(message) {
  let host = document.getElementById('realtime-toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'realtime-toast-host';
    document.body.appendChild(host);
  }

  const toast = document.createElement('div');
  toast.className = 'realtime-toast';
  toast.textContent = message;
  host.appendChild(toast);
  window.setTimeout(() => toast.classList.add('show'), 10);
  window.setTimeout(() => {
    toast.classList.remove('show');
    window.setTimeout(() => toast.remove(), 180);
  }, 3200);
}

function attendanceRefreshDelayForPage(page) {
  return ['dashboard', 'attendance', 'employee-dashboard'].includes(page)
    ? ATTENDANCE_FAST_REFRESH_MS
    : ATTENDANCE_BACKGROUND_REFRESH_MS;
}

async function reloadAttendanceRealtimeSurfaces(forceDashboard = true, options = {}) {
  const page = currentPageId();
  if (attendanceAjaxRefreshing) return;
  if (!options.force) {
    const elapsed = Date.now() - attendanceLastRealtimeRefreshAt;
    if (elapsed < ATTENDANCE_MIN_REFRESH_GAP_MS) return;
  }
  attendanceAjaxRefreshing = true;
  attendanceLastRealtimeRefreshAt = Date.now();

  try {
    const refreshTasks = [];

    if (page === 'dashboard' && typeof loadDashboard === 'function') {
      refreshTasks.push(loadDashboard({ force: forceDashboard }));
    }

    if (page === 'attendance') {
      if (typeof loadClockStatus === 'function') refreshTasks.push(loadClockStatus());
      if (typeof loadBiometricAttendanceStatus === 'function') refreshTasks.push(loadBiometricAttendanceStatus());
      if (typeof loadOverviewStats === 'function') refreshTasks.push(loadOverviewStats());
      if (typeof loadMySummary === 'function') refreshTasks.push(loadMySummary());
      const recordMenuOpen = typeof hasOpenAttendanceActionMenu === 'function' && hasOpenAttendanceActionMenu();
      if (typeof loadAttRecords === 'function' && !recordMenuOpen) refreshTasks.push(loadAttRecords());
      if (typeof loadBiometricEvents === 'function') refreshTasks.push(loadBiometricEvents());
      if (typeof loadBiometricExceptions === 'function') refreshTasks.push(loadBiometricExceptions());
    }

    if (page === 'payroll' && typeof loadPayrollRecords === 'function') {
      refreshTasks.push(loadPayrollRecords());
    }

    if (page === 'employee-dashboard' && typeof initEmployeeDashboard === 'function') {
      refreshTasks.push(initEmployeeDashboard());
    }

    await Promise.allSettled(refreshTasks);
  } finally {
    attendanceAjaxRefreshing = false;
  }
}

function handleAttendanceScanNotification(payload = {}) {
  if (payload.type && payload.type !== 'attendance-scan') return;
  const scan = payload.data || payload;
  const action = String(scan.action || scan.attendance_type || 'scan').replace(/_/g, ' ').toLowerCase();
  attendanceRealtimeToast(`Attendance ${action} received. Refreshing records...`);
  reloadAttendanceRealtimeSurfaces(true, { force: true });
}

function startAttendanceRealtimeListeners() {
  if (attendanceRealtimeListenerReady) return;
  attendanceRealtimeListenerReady = true;

  if ('BroadcastChannel' in window) {
    attendanceBroadcastChannel = new BroadcastChannel(ATTENDANCE_SCAN_CHANNEL);
    attendanceBroadcastChannel.onmessage = event => handleAttendanceScanNotification(event.data || {});
  }

  window.addEventListener('storage', event => {
    if (event.key !== ATTENDANCE_SCAN_CHANNEL || !event.newValue) return;
    try {
      handleAttendanceScanNotification(JSON.parse(event.newValue));
    } catch (_) {
      handleAttendanceScanNotification({});
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reloadAttendanceRealtimeSurfaces(false, { force: true });
  });
}

function startAttendanceAjaxRefresh() {
  if (attendanceAjaxRefreshTimer) return;
  const tick = () => {
    const page = currentPageId();
    const delay = attendanceRefreshDelayForPage(page);

    if (!document.hidden && ['dashboard', 'attendance', 'payroll', 'employee-dashboard'].includes(page)) {
      reloadAttendanceRealtimeSurfaces(false);
    }

    attendanceAjaxRefreshTimer = window.setTimeout(tick, delay);
  };

  attendanceAjaxRefreshTimer = window.setTimeout(() => {
    reloadAttendanceRealtimeSurfaces(false, { force: true });
    tick();
  }, 250);
}

function stopAttendanceAjaxRefresh() {
  if (!attendanceAjaxRefreshTimer) return;
  window.clearTimeout(attendanceAjaxRefreshTimer);
  attendanceAjaxRefreshTimer = null;
}

function initAttendanceRealtime() {
  startAttendanceRealtimeListeners();
  startAttendanceAjaxRefresh();
}

window.initAttendanceRealtime = initAttendanceRealtime;
window.reloadAttendanceRealtimeSurfaces = reloadAttendanceRealtimeSurfaces;
window.startAttendanceAjaxRefresh = startAttendanceAjaxRefresh;
window.stopAttendanceAjaxRefresh = stopAttendanceAjaxRefresh;
