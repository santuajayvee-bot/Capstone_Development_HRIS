const fs = require('fs');
const path = require('path');

function runSqlFile(db, filename) {
  const sql = fs.readFileSync(path.join(__dirname, 'sqls', filename), 'utf8');
  const statements = sql
    .split(/;\s*(?:\r?\n|$)/)
    .map(statement => statement.trim())
    .filter(Boolean);

  return statements.reduce((chain, statement) => (
    chain.then(() => db.runSql(statement))
  ), Promise.resolve());
}

exports.up = db => runSqlFile(db, '20260624102000_deduction_proration_mode-up.sql');
exports.down = db => runSqlFile(db, '20260624102000_deduction_proration_mode-down.sql');
