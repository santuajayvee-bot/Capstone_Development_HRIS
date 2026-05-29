const pool = require('../config/db');

const COLUMNS = [
  ['education_school', 'VARCHAR(255) NULL'],
  ['education_attainment', 'VARCHAR(150) NULL'],
  ['education_units', 'VARCHAR(150) NULL'],
  ['education_year_graduated', 'VARCHAR(20) NULL'],
  ['education_jhs_school', 'VARCHAR(255) NULL'],
  ['education_jhs_attainment', 'VARCHAR(150) NULL'],
  ['education_jhs_from', 'VARCHAR(20) NULL'],
  ['education_jhs_to', 'VARCHAR(20) NULL'],
  ['education_jhs_year_graduated', 'VARCHAR(20) NULL'],
  ['education_shs_school', 'VARCHAR(255) NULL'],
  ['education_shs_attainment', 'VARCHAR(150) NULL'],
  ['education_shs_from', 'VARCHAR(20) NULL'],
  ['education_shs_to', 'VARCHAR(20) NULL'],
  ['education_shs_year_graduated', 'VARCHAR(20) NULL'],
  ['education_vocational_school', 'VARCHAR(255) NULL'],
  ['education_vocational_attainment', 'VARCHAR(150) NULL'],
  ['education_vocational_units', 'VARCHAR(150) NULL'],
  ['education_vocational_from', 'VARCHAR(20) NULL'],
  ['education_vocational_to', 'VARCHAR(20) NULL'],
  ['education_vocational_year_graduated', 'VARCHAR(20) NULL'],
  ['education_college_school', 'VARCHAR(255) NULL'],
  ['education_college_attainment', 'VARCHAR(150) NULL'],
  ['education_college_units', 'VARCHAR(150) NULL'],
  ['education_college_from', 'VARCHAR(20) NULL'],
  ['education_college_to', 'VARCHAR(20) NULL'],
  ['education_college_year_graduated', 'VARCHAR(20) NULL']
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

    console.log('Education field migration complete.');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('Education migration failed:', error);
  process.exit(1);
});
