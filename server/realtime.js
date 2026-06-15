const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const JWT_SECRET = process.env.JWT_SECRET;

let io = null;

function getEmployeeDepartmentId(user) {
  return user?.employeeProfile?.department_id || user?.employeeProfile?.departmentId || null;
}

function initRealtime(server) {
  io = new Server(server, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) return next(new Error('Authentication required.'));
      socket.user = jwt.verify(token, JWT_SECRET);
      next();
    } catch (_err) {
      next(new Error('Invalid session.'));
    }
  });

  io.on('connection', socket => {
    const user = socket.user || {};
    if (user.role) socket.join(`role:${user.role}`);
    if (user.employeeId) socket.join(`employee:${user.employeeId}`);

    const departmentId = getEmployeeDepartmentId(user);
    if (departmentId) socket.join(`department:${departmentId}`);

    socket.emit('realtime:ready', {
      connected: true,
      role: user.role || null,
      employee_id: user.employeeId || null,
    });
  });

  return io;
}

function emitToRoom(room, event, payload) {
  if (!io) return;
  io.to(room).emit(event, payload);
}

function emitAttendanceCreated(payload) {
  if (!io || !payload) return;

  const safePayload = {
    employee_id: payload.employee_id,
    employee_name: payload.employee_name,
    employee_code: payload.employee_code,
    department_id: payload.department_id || null,
    scan_type: payload.scan_type,
    scan_time: payload.scan_time,
    attendance_status: payload.attendance_status,
    payroll_ready: !!payload.payroll_ready,
    device_id: payload.device_id,
  };

  emitToRoom('role:hr_admin', 'attendance:created', safePayload);
  emitToRoom('role:hr_manager', 'attendance:created', safePayload);
  emitToRoom('role:admin', 'attendance:created', safePayload);
  emitToRoom('role:system_admin', 'attendance:created', safePayload);

  if (safePayload.payroll_ready) {
    emitToRoom('role:payroll_officer', 'attendance:created', safePayload);
    emitToRoom('role:payroll_manager', 'attendance:created', safePayload);
  }

  if (safePayload.employee_id) {
    emitToRoom(`employee:${safePayload.employee_id}`, 'attendance:created', safePayload);
  }

  if (safePayload.department_id) {
    emitToRoom(`department:${safePayload.department_id}`, 'attendance:created', safePayload);
  }
}

module.exports = {
  emitAttendanceCreated,
  initRealtime,
};
