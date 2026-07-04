'use strict';

const fs = require('fs');
const path = require('path');

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if ((char === '\'' || char === '"' || char === '`') && sql[index - 1] !== '\\') {
      quote = quote === char ? null : quote || char;
    }
    if (!quote && char === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

function runSqlFile(db, fileName) {
  const sql = fs.readFileSync(path.join(__dirname, 'sqls', fileName), 'utf8');
  return splitSqlStatements(sql).reduce(
    (chain, statement) => chain.then(() => db.runSql(statement)),
    Promise.resolve()
  );
}

exports.up = db => runSqlFile(db, '20260704093000_add_totp_mfa_enrollment-up.sql');
exports.down = db => runSqlFile(db, '20260704093000_add_totp_mfa_enrollment-down.sql');
exports._meta = { version: 1 };
