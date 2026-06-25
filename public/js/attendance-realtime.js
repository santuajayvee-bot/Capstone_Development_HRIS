/* ============================================================
   AJAX attendance refresh
   ============================================================ */

let attendanceAjaxRefreshTimer = null;
let attendanceAjaxRefreshing = false;
let attendanceRealtimeListenerReady = false;
let attendanceBroadcastChannel = null;
const ATTENDANCE_AJAX_REFRESH_MS = 5000;
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

async function reloadAttendanceRealtimeSurfaces(forceDashboard = true) {
  const page = currentPageId();
  if (attendanceAjaxRefreshing) return;
  attendanceAjaxRefreshing = true;

  try {
    if (page === 'dashboard' && typeof loadDashboard === 'function') {
      await loadDashboard({ force: forceDashboard });
    }

    if (page === 'attendance') {
      if (typeof loadClockStatus === 'function') loadClockStatus();
      if (typeof loadBiometricAttendanceStatus === 'function') loadBiometricAttendanceStatus();
      if (typeof loadOverviewStats === 'function') loadOverviewStats();
      if (typeof loadMySummary === 'function') loadMySummary();
      if (typeof loadAttRecords === 'function') loadAttRecords();
      if (typeof loadBiometricEvents === 'function') loadBiometricEvents();
      if (typeof loadBiometricExceptions === 'function') loadBiometricExceptions();
    }

    if (page === 'payroll' && typeof loadPayrollRecords === 'function') {
      loadPayrollRecords();
    }

    if (page === 'employee-dashboard' && typeof initEmployeeDashboard === 'function') {
      initEmployeeDashboard();
    }
  } finally {
    attendanceAjaxRefreshing = false;
  }
}

function handleAttendanceScanNotification(payload = {}) {
  if (payload.type && payload.type !== 'attendance-scan') return;
  const scan = payload.data || payload;
  const action = String(scan.action || scan.attendance_type || 'scan').replace(/_/g, ' ').toLowerCase();
  attendanceRealtimeToast(`Attendance ${action} received. Refreshing records...`);
  reloadAttendanceRealtimeSurfaces(true);
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
    if (!document.hidden) reloadAttendanceRealtimeSurfaces(false);
  });
}

function startAttendanceAjaxRefresh() {
  if (attendanceAjaxRefreshTimer) return;
  attendanceAjaxRefreshTimer = window.setInterval(() => {
    if (document.hidden) return;
    const page = currentPageId();
    if (!['dashboard', 'attendance', 'payroll', 'employee-dashboard'].includes(page)) return;
    reloadAttendanceRealtimeSurfaces(false);
  }, ATTENDANCE_AJAX_REFRESH_MS);
}

function stopAttendanceAjaxRefresh() {
  if (!attendanceAjaxRefreshTimer) return;
  window.clearInterval(attendanceAjaxRefreshTimer);
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
