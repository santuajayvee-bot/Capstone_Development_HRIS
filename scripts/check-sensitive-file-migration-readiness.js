require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('../config/db');

function summarize(rows) {
  return rows.reduce((summary, row) => {
    const relative = String(row.file_path || '').replace(/^[/\\]+/, '').replace(/\\/g, '/');
    if (!relative.startsWith('uploads/')) {
      summary.external += 1;
      return summary;
    }
    const absolute = path.resolve(__dirname, '..', 'public', relative);
    if (fs.existsSync(absolute)) summary.existing += 1;
    else summary.missing += 1;
    return summary;
  }, { total: rows.length, existing: 0, missing: 0, external: 0 });
}

(async () => {
  const [documents] = await pool.query("SELECT id, file_path FROM documents WHERE file_path IS NOT NULL AND file_path <> ''");
  const [leaveRequests] = await pool.query("SELECT id, file_path FROM leave_requests WHERE file_path IS NOT NULL AND file_path <> ''");
  console.log(JSON.stringify({
    documents: summarize(documents),
    leave_requests: summarize(leaveRequests),
  }, null, 2));
  await pool.end();
})().catch(async error => {
  console.error(error.message);
  await pool.end().catch(() => {});
  process.exit(1);
});
