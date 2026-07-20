'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260720120000_session_token_binding-up.sql');
exports.down = db => runSqlFile(db, '20260720120000_session_token_binding-down.sql');
