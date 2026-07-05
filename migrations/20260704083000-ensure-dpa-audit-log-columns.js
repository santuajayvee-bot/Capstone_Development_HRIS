const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260704083000_ensure_dpa_audit_log_columns-up.sql');
exports.down = db => runSqlFile(db, '20260704083000_ensure_dpa_audit_log_columns-down.sql');
