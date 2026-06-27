const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260625193000_payroll_attendance_configurations-up.sql');
exports.down = db => runSqlFile(db, '20260625193000_payroll_attendance_configurations-down.sql');
