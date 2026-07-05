'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260705130000_system_admin_support_tools-up.sql');
exports.down = db => runSqlFile(db, '20260705130000_system_admin_support_tools-down.sql');
exports._meta = { version: 1 };
