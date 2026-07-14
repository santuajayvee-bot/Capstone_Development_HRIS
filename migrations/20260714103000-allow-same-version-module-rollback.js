'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260714103000_allow_same_version_module_rollback-up.sql');
exports.down = db => runSqlFile(db, '20260714103000_allow_same_version_module_rollback-down.sql');
