/* ============================================================
   Realtime attendance updates
   ============================================================ */

let attendanceRealtimeSocket = null;
let attendanceFallbackTimer = null;
let attendanceLastRealtimeAt = 0;

function currentPageId() {
  return window.ROUTE_PARAMS?.pageId || document.querySelector('.page.active')?.id?.replace(/^page-/, '') || 'dashboard';
}

function isPayrollRole(user) {
  return ['payroll_officer', 'payroll_manager'].includes(user?.role);
}

function isManagerRole(user) {
  return user?.role === 'manager';
}

function canUseAttendanceEvent(data) {
  const user = getUser?.();
  if (!user) return false;
  if (user.role === 'employee') return Number(data.employee_id) === Number(user.employeeId);
  if (isPayrollRole(user)) return data.payroll_ready || ['PAYROLL_READY', 'VALIDATED'].includes(String(data.attendance_status || '').toUpperCase());
  if (isManagerRole(user)) {
    const departmentId = user.employeeProfile?.department_id || user.employeeProfile?.departmentId;
    return !departmentId || Number(data.department_id) === Number(departmentId);
  }
  return ['hr_admin', 'hr_manager', 'admin', 'system_admin'].includes(user.role);
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
  console.log('[ATTENDANCE_REALTIME] STEP 8: Dashboard update started', { page, forceDashboard });

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

  console.log('[ATTENDANCE_REALTIME] STEP 8: Dashboard update completed', { page });
}

function handleAttendanceRealtimeEvent(data) {
  console.log('[ATTENDANCE_REALTIME] STEP 7: Frontend received event', data);
  if (!canUseAttendanceEvent(data)) return;
  attendanceLastRealtimeAt = Date.now();
  reloadAttendanceRealtimeSurfaces(true);
  attendanceRealtimeToast(`New biometric attendance recorded: ${data.employee_name || 'Employee'} ${String(data.scan_type || '').replace('_', ' ')}`);
}

function startAttendanceFallbackPolling() {
  if (attendanceFallbackTimer) return;
  attendanceFallbackTimer = window.setInterval(() => {
    const page = currentPageId();
    if (!['dashboard', 'attendance', 'payroll', 'employee-dashboard'].includes(page)) return;
    if (attendanceRealtimeSocket?.connected && Date.now() - attendanceLastRealtimeAt < 15000) return;
    reloadAttendanceRealtimeSurfaces(false);
  }, 10000);
}

function initAttendanceRealtime() {
  if (attendanceRealtimeSocket || typeof io !== 'function' || typeof getToken !== 'function') {
    startAttendanceFallbackPolling();
    return;
  }

  const token = getToken();
  if (!token) {
    startAttendanceFallbackPolling();
    return;
  }

  attendanceRealtimeSocket = io({
    auth: { token },
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000,
  });
  window.attendanceRealtimeSocket = attendanceRealtimeSocket;

  attendanceRealtimeSocket.on('connect', () => {
    attendanceLastRealtimeAt = Date.now();
  });
  attendanceRealtimeSocket.on('attendance:created', handleAttendanceRealtimeEvent);
  attendanceRealtimeSocket.on('disconnect', startAttendanceFallbackPolling);
  attendanceRealtimeSocket.on('connect_error', startAttendanceFallbackPolling);

  startAttendanceFallbackPolling();
}

window.initAttendanceRealtime = initAttendanceRealtime;
window.reloadAttendanceRealtimeSurfaces = reloadAttendanceRealtimeSurfaces;
