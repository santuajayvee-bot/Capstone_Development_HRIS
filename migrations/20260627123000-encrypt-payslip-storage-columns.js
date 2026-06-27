const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260627123000_encrypt_payslip_storage_columns-up.sql');
exports.down = db => runSqlFile(db, '20260627123000_encrypt_payslip_storage_columns-down.sql');
