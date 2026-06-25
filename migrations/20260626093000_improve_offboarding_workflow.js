const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260626093000_improve_offboarding_workflow-up.sql');
exports.down = db => runSqlFile(db, '20260626093000_improve_offboarding_workflow-down.sql');
