const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260703090000_calendar_based_proration_default-up.sql');
exports.down = db => runSqlFile(db, '20260703090000_calendar_based_proration_default-down.sql');
