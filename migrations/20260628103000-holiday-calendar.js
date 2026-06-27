const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260628103000_holiday_calendar-up.sql');
exports.down = db => runSqlFile(db, '20260628103000_holiday_calendar-down.sql');
