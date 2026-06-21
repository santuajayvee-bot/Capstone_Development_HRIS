'use strict';

const fs = require('fs');
const path = require('path');

function runSqlFile(db, fileName) {
  const sql = fs.readFileSync(path.join(__dirname, 'sqls', fileName), 'utf8');
  const statements = sql.split(/;\s*(?:\r?\n|$)/).map(value => value.trim()).filter(Boolean);
  return statements.reduce((chain, statement) => chain.then(() => db.runSql(statement)), Promise.resolve());
}

exports.up = db => runSqlFile(db, '20260621110000_piece_rate_daily_output_registry-up.sql');
exports.down = db => runSqlFile(db, '20260621110000_piece_rate_daily_output_registry-down.sql');
exports._meta = { version: 1 };
