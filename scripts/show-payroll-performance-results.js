require('dotenv').config();
const mysql = require('mysql2/promise');

function argValue(name) {
  const prefix = `--${name}=`;
  const item = process.argv.find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

async function run() {
  const period = argValue('period') || process.env.PERFORMANCE_PAYROLL_PERIOD || '2026-07-W1';
  const limit = Math.max(1, Math.min(50, Number(argValue('limit') || 20)));
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  try {
    const [rows] = await connection.execute(
      `SELECT performance_log_id,
              operation_name,
              employees_processed,
              payroll_period,
              DATE_FORMAT(start_time, '%Y-%m-%d %H:%i:%s.%f') AS start_time,
              DATE_FORMAT(end_time, '%Y-%m-%d %H:%i:%s.%f') AS end_time,
              duration_ms,
              status,
              metadata_json
         FROM performance_logs
        WHERE operation_name = 'payroll_generation'
          AND (? = '' OR payroll_period = ?)
        ORDER BY performance_log_id DESC
        LIMIT ${limit}`,
      [period, period]
    );
    console.table(rows.map(row => ({
      id: row.performance_log_id,
      operation: row.operation_name,
      employees: row.employees_processed,
      period: row.payroll_period,
      duration_ms: row.duration_ms,
      status: row.status,
      start_time: row.start_time,
      end_time: row.end_time,
    })));
    for (const row of rows.slice().reverse()) {
      console.log(`Payroll generation completed for ${row.employees_processed} employees in ${row.duration_ms}ms.`);
    }
  } finally {
    await connection.end();
  }
}

run().catch(error => {
  console.error(`Failed to show payroll performance results: ${error.message}`);
  process.exitCode = 1;
});
