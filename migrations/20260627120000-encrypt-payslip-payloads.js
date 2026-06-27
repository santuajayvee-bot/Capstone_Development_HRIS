const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260627120000_encrypt_payslip_payloads-up.sql');
exports.down = db => runSqlFile(db, '20260627120000_encrypt_payslip_payloads-down.sql');
