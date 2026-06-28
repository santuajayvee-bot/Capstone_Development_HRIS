const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260628194500_piece_rate_four_decimal_precision-up.sql');
exports.down = db => runSqlFile(db, '20260628194500_piece_rate_four_decimal_precision-down.sql');
