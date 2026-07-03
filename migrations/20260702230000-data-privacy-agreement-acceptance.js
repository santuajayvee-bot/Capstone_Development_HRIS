const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260702230000_data_privacy_agreement_acceptance-up.sql');
exports.down = db => runSqlFile(db, '20260702230000_data_privacy_agreement_acceptance-down.sql');
