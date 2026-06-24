const { runSqlFile } = require('./mysql-compatible-sql');

exports.up = db => runSqlFile(db, '20260623195000_expand_deduction_configuration-up.sql');
exports.down = db => runSqlFile(db, '20260623195000_expand_deduction_configuration-down.sql');
