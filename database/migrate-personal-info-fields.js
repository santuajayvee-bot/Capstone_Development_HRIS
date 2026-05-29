const pool = require('../config/db');

const COLUMNS = [
  ['blood_type', 'VARCHAR(10) NULL'],
  ['religion', 'VARCHAR(100) NULL'],
  ['place_of_birth', 'VARCHAR(255) NULL'],
  ['current_address', 'TEXT NULL']
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

    console.log('Personal info field migration complete.');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('Personal info migration failed:', error);
  process.exit(1);
});
