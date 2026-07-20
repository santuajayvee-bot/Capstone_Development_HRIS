'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260718110000_performance_management-up.sql');
exports.down = db => runSqlFile(db, '20260718110000_performance_management-down.sql');
