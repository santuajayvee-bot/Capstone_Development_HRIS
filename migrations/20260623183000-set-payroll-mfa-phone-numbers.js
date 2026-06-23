'use strict';

const fs = require('fs');
const path = require('path');

function runSqlFile(db, fileName) {
  const sql = fs.readFileSync(path.join(__dirname, 'sqls', fileName), 'utf8');
  const statements = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map(statement => statement.trim())
    .filter(Boolean);

  return statements.reduce((chain, statement) => chain.then(() => db.runSql(statement)), Promise.resolve());
}

exports.up = db => runSqlFile(db, '20260623183000_set_payroll_mfa_phone_numbers-up.sql');
exports.down = db => runSqlFile(db, '20260623183000_set_payroll_mfa_phone_numbers-down.sql');
exports._meta = { version: 1 };
