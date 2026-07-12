const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260708180000_repair_trusted_device_schema-up.sql');
exports.down = db => runSqlFile(db, '20260708180000_repair_trusted_device_schema-down.sql');
