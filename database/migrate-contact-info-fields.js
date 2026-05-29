const pool = require('../config/db');

const COLUMNS = [
  ['work_email', 'VARCHAR(255) NULL'],
  ['mailing_address', 'TEXT NULL'],
  ['emergency_contact_relationship', 'VARCHAR(100) NULL'],
  ['emergency_contact_secondary_num', 'VARCHAR(50) NULL'],
  ['emergency_contact_email', 'VARCHAR(255) NULL'],
  ['emergency_contact_address', 'TEXT NULL']
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

    console.log('Contact info field migration complete.');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('Contact info migration failed:', error);
  process.exit(1);
});
