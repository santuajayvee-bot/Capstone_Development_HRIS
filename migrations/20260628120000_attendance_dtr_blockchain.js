const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260628120000_attendance_dtr_blockchain-up.sql');
exports.down = db => runSqlFile(db, '20260628120000_attendance_dtr_blockchain-down.sql');
