/* Apply the trip-based logistics migration against the database in .env.
   Usage: node database/migrate-logistics-trip-payroll.js [up|down] */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

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
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

async function run() {
  const direction = String(process.argv[2] || 'up').toLowerCase() === 'down' ? 'down' : 'up';
  const fileName = `20260620123000_logistics_trip_payroll-${direction}.sql`;
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'sqls', fileName), 'utf8');
  const connection = await pool.getConnection();
  try {
    for (const statement of splitSqlStatements(sql)) await connection.query(statement);
    console.log(`Logistics trip payroll migration ${direction} complete.`);
  } finally {
    connection.release();
    await pool.end();
  }
}

run().catch(error => {
  console.error('Logistics trip payroll migration failed:', error.message);
  process.exitCode = 1;
});
