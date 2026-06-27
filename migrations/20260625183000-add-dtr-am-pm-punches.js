const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260625183000_add_dtr_am_pm_punches-up.sql');
exports.down = db => runSqlFile(db, '20260625183000_add_dtr_am_pm_punches-down.sql');
