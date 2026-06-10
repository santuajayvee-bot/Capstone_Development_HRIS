require('dotenv').config();
const pool = require('../config/db');

const columns = [
  ['residential_address_region', 'VARCHAR(120) NULL'],
  ['residential_address_province', 'VARCHAR(120) NULL'],
  ['residential_address_city_municipality', 'VARCHAR(160) NULL'],
  ['residential_address_barangay', 'VARCHAR(160) NULL'],
  ['residential_address_street_address', 'VARCHAR(255) NULL'],
  ['residential_address_full_address', 'TEXT NULL'],
  ['residential_address_place_id', 'VARCHAR(255) NULL'],
  ['current_address_region', 'VARCHAR(120) NULL'],
  ['current_address_province', 'VARCHAR(120) NULL'],
  ['current_address_city_municipality', 'VARCHAR(160) NULL'],
  ['current_address_barangay', 'VARCHAR(160) NULL'],
  ['current_address_street_address', 'VARCHAR(255) NULL'],
  ['current_address_full_address', 'TEXT NULL'],
  ['current_address_place_id', 'VARCHAR(255) NULL'],
  ['mailing_address_region', 'VARCHAR(120) NULL'],
  ['mailing_address_province', 'VARCHAR(120) NULL'],
  ['mailing_address_city_municipality', 'VARCHAR(160) NULL'],
  ['mailing_address_barangay', 'VARCHAR(160) NULL'],
  ['mailing_address_street_address', 'VARCHAR(255) NULL'],
  ['mailing_address_full_address', 'TEXT NULL'],
  ['mailing_address_place_id', 'VARCHAR(255) NULL']
];

async function ensureColumn(connection, table, column, definition) {
  const [rows] = await connection.execute(
    `SELECT COUNT(*) AS count
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND COLUMN_NAME = ?`,
    [table, column]
  );
  if (!Number(rows[0]?.count || 0)) {
    await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`Added ${table}.${column}`);
  }
}

async function run() {
  const connection = await pool.getConnection();
  try {
    for (const [column, definition] of columns) {
      await ensureColumn(connection, 'employees', column, definition);
    }
    console.log('Philippine address fields migration complete.');
  } finally {
    connection.release();
    await pool.end();
  }
}

run().catch(error => {
  console.error('Philippine address fields migration failed:', error);
  process.exit(1);
});
