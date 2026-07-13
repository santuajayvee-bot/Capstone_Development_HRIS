'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260713090000_backup_recovery_operational_completeness-up.sql');
exports.down = db => runSqlFile(db, '20260713090000_backup_recovery_operational_completeness-down.sql');

