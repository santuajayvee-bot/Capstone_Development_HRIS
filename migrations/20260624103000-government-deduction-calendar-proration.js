const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260624103000_government_deduction_calendar_proration-up.sql');
exports.down = db => runSqlFile(db, '20260624103000_government_deduction_calendar_proration-down.sql');
