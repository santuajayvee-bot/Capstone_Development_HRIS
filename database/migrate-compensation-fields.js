const pool = require('../config/db');

const COLUMNS = [
  ['salary_grade', 'VARCHAR(100) NULL'],
  ['allowances', 'DECIMAL(12,2) NULL'],
  ['payroll_schedule', 'VARCHAR(100) NULL']
];

async function columnExists(connection, columnName) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'employees'
       AND COLUMN_NAME = ?`,
    [columnName]
  );

  return rows[0].count > 0;
}

async function migrate() {
  const connection = await pool.getConnection();

  try {
    for (const [columnName, definition] of COLUMNS) {
      if (await columnExists(connection, columnName)) {
        console.log(`Skipped employees.${columnName}; already exists.`);
        continue;
      }

      await connection.query(`ALTER TABLE employees ADD COLUMN ${columnName} ${definition}`);
      console.log(`Added employees.${columnName}.`);
    }

    console.log('Compensation field migration complete.');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('Compensation migration failed:', error);
  process.exit(1);
});
