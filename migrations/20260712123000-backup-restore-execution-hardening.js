'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260712123000_backup_restore_execution_hardening-up.sql');
exports.down = db => runSqlFile(db, '20260712123000_backup_restore_execution_hardening-down.sql');
exports._meta = { version: 1 };
