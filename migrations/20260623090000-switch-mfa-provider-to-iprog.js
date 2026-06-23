'use strict';

const fs = require('fs');
const path = require('path');

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      current += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (!quote && char === '-' && next === '-') {
      current += char + next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (!quote && char === '/' && next === '*') {
      current += char + next;
      index += 1;
      blockComment = true;
      continue;
    }
    if ((char === '\'' || char === '"' || char === '`') && sql[index - 1] !== '\\') {
      quote = quote === char ? null : quote || char;
      current += char;
      continue;
    }
    if (!quote && char === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      continue;
    }
    current += char;
  }

  const statement = current.trim();
  if (statement) statements.push(statement);
  return statements;
}

function runSqlFile(db, fileName) {
  const sql = fs.readFileSync(path.join(__dirname, 'sqls', fileName), 'utf8');
  return splitSqlStatements(sql).reduce((chain, statement) => chain.then(() => db.runSql(statement)), Promise.resolve());
}

exports.up = db => runSqlFile(db, '20260623090000_switch_mfa_provider_to_iprog-up.sql');
exports.down = db => runSqlFile(db, '20260623090000_switch_mfa_provider_to_iprog-down.sql');
exports._meta = { version: 1 };
