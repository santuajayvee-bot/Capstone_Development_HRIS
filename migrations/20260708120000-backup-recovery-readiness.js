'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260708120000_backup_recovery_readiness-up.sql');
exports.down = db => runSqlFile(db, '20260708120000_backup_recovery_readiness-down.sql');
exports._meta = { version: 1 };
