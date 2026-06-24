const { runSqlFile } = require('./mysql-compatible-sql');

exports.up = db => runSqlFile(db, '20260624102000_deduction_proration_mode-up.sql');
exports.down = db => runSqlFile(db, '20260624102000_deduction_proration_mode-down.sql');
