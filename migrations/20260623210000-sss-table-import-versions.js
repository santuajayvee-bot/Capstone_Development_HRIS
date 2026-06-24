const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260623210000_sss_table_import_versions-up.sql');
exports.down = db => runSqlFile(db, '20260623210000_sss_table_import_versions-down.sql');
