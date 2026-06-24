const { runSqlFile } = require('./mysql-compatible-sql');

exports.up = db => runSqlFile(db, '20260623203000_payroll_processing_lifecycle-up.sql');
exports.down = db => runSqlFile(db, '20260623203000_payroll_processing_lifecycle-down.sql');
