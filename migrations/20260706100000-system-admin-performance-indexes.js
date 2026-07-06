'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260706100000_system_admin_performance_indexes-up.sql');
exports.down = db => runSqlFile(db, '20260706100000_system_admin_performance_indexes-down.sql');
exports._meta = { version: 1 };
