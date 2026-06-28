const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260628112000_performance_logs-up.sql');
exports.down = db => runSqlFile(db, '20260628112000_performance_logs-down.sql');
