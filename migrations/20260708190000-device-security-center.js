const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260708190000_device_security_center-up.sql');
exports.down = db => runSqlFile(db, '20260708190000_device_security_center-down.sql');
