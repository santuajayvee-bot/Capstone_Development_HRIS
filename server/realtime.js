/* ============================================================
   server/realtime.js
   AJAX polling compatibility layer.

   Attendance dashboards now refresh through authenticated AJAX
   polling on the frontend. Routes may still call this function
   after saving attendance, but no WebSocket event is emitted.
   ============================================================ */

function emitAttendanceCreated(_payload) {
  return false;
}

module.exports = {
  emitAttendanceCreated,
};
