'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260705143000_system_health_checks-up.sql');
exports.down = db => runSqlFile(db, '20260705143000_system_health_checks-down.sql');
exports._meta = { version: 1 };
