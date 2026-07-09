'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260708100000_leave_balance_integrity-up.sql');
exports.down = db => runSqlFile(db, '20260708100000_leave_balance_integrity-down.sql');
exports._meta = { version: 1 };
