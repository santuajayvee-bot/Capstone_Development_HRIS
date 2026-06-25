const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260626101500_offboarding_document_attachments-up.sql');
exports.down = db => runSqlFile(db, '20260626101500_offboarding_document_attachments-down.sql');
