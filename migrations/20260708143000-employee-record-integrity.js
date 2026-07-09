'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260708143000_employee_record_integrity-up.sql');
exports.down = db => runSqlFile(db, '20260708143000_employee_record_integrity-down.sql');
exports._meta = { version: 1 };
