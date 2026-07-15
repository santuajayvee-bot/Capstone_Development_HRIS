'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260714130000_adaptive_single_admin_backup_approval-up.sql');
exports.down = db => runSqlFile(db, '20260714130000_adaptive_single_admin_backup_approval-down.sql');
