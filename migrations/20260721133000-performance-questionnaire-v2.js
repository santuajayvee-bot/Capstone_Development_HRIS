'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260721133000_performance_questionnaire_v2-up.sql');
exports.down = db => runSqlFile(db, '20260721133000_performance_questionnaire_v2-down.sql');
