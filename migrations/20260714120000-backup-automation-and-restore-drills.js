'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260714120000_backup_automation_and_restore_drills-up.sql');
exports.down = db => runSqlFile(db, '20260714120000_backup_automation_and_restore_drills-down.sql');
