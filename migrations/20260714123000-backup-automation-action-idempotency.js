'use strict';

const { runSqlFile } = require('../database/mysql-compatible-migration');

exports.up = db => runSqlFile(db, '20260714123000_backup_automation_action_idempotency-up.sql');
exports.down = db => runSqlFile(db, '20260714123000_backup_automation_action_idempotency-down.sql');
