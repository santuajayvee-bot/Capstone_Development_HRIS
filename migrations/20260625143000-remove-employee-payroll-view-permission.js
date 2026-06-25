const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260625143000_remove_employee_payroll_view_permission-up.sql');
exports.down = db => runSqlFile(db, '20260625143000_remove_employee_payroll_view_permission-down.sql');
