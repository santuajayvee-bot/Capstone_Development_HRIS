const fs = require('fs');
const path = require('path');

function runSqlFile(db, fileName) {
  const filePath = path.join(__dirname, 'sqls', fileName);
  const sql = fs.readFileSync(filePath, 'utf8');
  return db.runSql(sql);
}

exports.up = db => runSqlFile(db, '20260704062000_ensure_mfa_challenge_schema-up.sql');
exports.down = db => runSqlFile(db, '20260704062000_ensure_mfa_challenge_schema-down.sql');
