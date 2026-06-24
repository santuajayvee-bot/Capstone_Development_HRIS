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

exports.up = db => runSqlFile(db, '20260623210000_sss_table_import_versions-up.sql');
exports.down = db => runSqlFile(db, '20260623210000_sss_table_import_versions-down.sql');
