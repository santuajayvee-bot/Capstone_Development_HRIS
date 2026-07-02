const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260702172000_attendance_overtime_review-up.sql');
exports.down = db => runSqlFile(db, '20260702172000_attendance_overtime_review-down.sql');
