const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260625170000_sync_employee_profile_photo_links-up.sql');
exports.down = db => runSqlFile(db, '20260625170000_sync_employee_profile_photo_links-down.sql');
