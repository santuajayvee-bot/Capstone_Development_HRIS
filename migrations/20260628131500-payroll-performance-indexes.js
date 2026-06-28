const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260628131500_payroll_performance_indexes-up.sql');
exports.down = db => runSqlFile(db, '20260628131500_payroll_performance_indexes-down.sql');
