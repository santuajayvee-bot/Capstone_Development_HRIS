'use strict';

const fs = require('fs');
const path = require('path');

function runSqlFile(db, fileName) {
  const sql = fs.readFileSync(path.join(__dirname, 'sqls', fileName), 'utf8');
  return db.runSql(sql);
}

exports.up = db => runSqlFile(db, '20260627180000_repair_201_file_access_audit-up.sql');
exports.down = db => runSqlFile(db, '20260627180000_repair_201_file_access_audit-down.sql');

exports._meta = { version: 1 };
