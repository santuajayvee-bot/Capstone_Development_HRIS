const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260623195000_expand_deduction_configuration-up.sql');
exports.down = db => runSqlFile(db, '20260623195000_expand_deduction_configuration-down.sql');
