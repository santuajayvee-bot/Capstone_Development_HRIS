const fs = require('fs');
const path = require('path');

function runSqlFile(db, filename) {
  const sql = fs.readFileSync(path.join(__dirname, 'sqls', filename), 'utf8');
  return db.runSql(sql);
}

exports.up = db => runSqlFile(db, '20260623164500_expand_offboarding_clearance_workflow-up.sql');
exports.down = db => runSqlFile(db, '20260623164500_expand_offboarding_clearance_workflow-down.sql');
