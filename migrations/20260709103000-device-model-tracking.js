const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260709103000_device_model_tracking-up.sql');
exports.down = db => runSqlFile(db, '20260709103000_device_model_tracking-down.sql');
