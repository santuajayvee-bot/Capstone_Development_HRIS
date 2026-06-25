const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260626103000_add_employee_updated_at-up.sql');
exports.down = db => runSqlFile(db, '20260626103000_add_employee_updated_at-down.sql');
