const pool = require('../config/db');

async function columnExists(connection, table, column) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows.length > 0;
}

async function ensureColumn(connection, table, column, definition) {
  if (!(await columnExists(connection, table, column))) {
    await connection.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

async function migrate() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await ensureColumn(connection, 'employees', 'residential_address_lat', 'DECIMAL(10,7) NULL');
    await ensureColumn(connection, 'employees', 'residential_address_lng', 'DECIMAL(10,7) NULL');
    await ensureColumn(connection, 'employees', 'current_address_lat', 'DECIMAL(10,7) NULL');
    await ensureColumn(connection, 'employees', 'current_address_lng', 'DECIMAL(10,7) NULL');
    await ensureColumn(connection, 'employees', 'mailing_address_lat', 'DECIMAL(10,7) NULL');
    await ensureColumn(connection, 'employees', 'mailing_address_lng', 'DECIMAL(10,7) NULL');
    await ensureColumn(connection, 'employees', 'current_address_same_as_home', 'TINYINT(1) NOT NULL DEFAULT 0');
    await ensureColumn(connection, 'employees', 'mailing_address_same_as_home', 'TINYINT(1) NOT NULL DEFAULT 0');

    await connection.commit();
    console.log('Employee address geocoding migration complete.');
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('Employee address geocoding migration failed:', error);
  process.exit(1);
});
