const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260629123000_payroll_recalculation_adjustments-up.sql');
exports.down = db => runSqlFile(db, '20260629123000_payroll_recalculation_adjustments-down.sql');
