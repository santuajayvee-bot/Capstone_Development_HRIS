const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260623203000_payroll_processing_lifecycle-up.sql');
exports.down = db => runSqlFile(db, '20260623203000_payroll_processing_lifecycle-down.sql');
