const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260706123000_trusted_devices-up.sql');
exports.down = db => runSqlFile(db, '20260706123000_trusted_devices-down.sql');
