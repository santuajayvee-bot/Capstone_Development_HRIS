'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260706103000_system_health_history-up.sql');
exports.down = db => runSqlFile(db, '20260706103000_system_health_history-down.sql');
exports._meta = { version: 1 };
