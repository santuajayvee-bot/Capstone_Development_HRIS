'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260707093000_leave_four_eyes_approval-up.sql');
exports.down = db => runSqlFile(db, '20260707093000_leave_four_eyes_approval-down.sql');
exports._meta = { version: 1 };
