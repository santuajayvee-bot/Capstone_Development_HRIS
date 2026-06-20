'use strict';

const fs = require('fs');
const path = require('path');

function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      current += char;
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      current += char;
      if (char === '*' && next === '/') {
        current += next;
        i += 1;
        blockComment = false;
      }
      continue;
    }
    if (!quote && char === '-' && next === '-') {
      current += char + next;
      i += 1;
      lineComment = true;
      continue;
    }
    if (!quote && char === '/' && next === '*') {
      current += char + next;
      i += 1;
      blockComment = true;
      continue;
    }
    if ((char === '\'' || char === '"' || char === '`') && sql[i - 1] !== '\\') {
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

exports.up = db => runSqlFile(db, '20260620123000_logistics_trip_payroll-up.sql');
exports.down = db => runSqlFile(db, '20260620123000_logistics_trip_payroll-down.sql');
exports._meta = { version: 1 };
