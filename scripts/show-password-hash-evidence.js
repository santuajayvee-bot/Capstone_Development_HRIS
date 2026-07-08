require('dotenv').config();

const mysql = require('mysql2/promise');

const TABLE_CANDIDATES = [
  {
    table: 'users',
    idColumns: ['id', 'User_ID', 'user_id'],
    usernameColumns: ['username', 'Username', 'email', 'Email'],
    hashColumns: ['password_hash', 'Password_Hash'],
  },
  {
    table: 'employees',
    idColumns: ['Employee_ID', 'employee_id', 'id'],
    usernameColumns: ['Username', 'username', 'Email', 'email', 'Employee_Code'],
    hashColumns: ['Password_Hash', 'password_hash'],
  },
];

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured in .env`);
  return value;
}

function pickColumn(columns, candidates) {
  return candidates.find(column => columns.has(column));
}

function escapeId(identifier) {
  return `\`${String(identifier).replace(/`/g, '``')}\``;
}

async function getColumns(connection, database, table) {
  const [rows] = await connection.execute(
    `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
        AND TABLE_NAME = ?`,
    [database, table]
  );
  return new Set(rows.map(row => row.COLUMN_NAME));
}

async function showPasswordHashEvidence() {
  const database = requiredEnv('DB_NAME');
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    user: requiredEnv('DB_USER'),
    password: requiredEnv('DB_PASSWORD'),
    database,
  });

  try {
    console.log(`Database: ${database}`);
    console.log('Showing password hash evidence only. Plaintext passwords must never be visible.\n');

    let found = false;

    for (const candidate of TABLE_CANDIDATES) {
      const columns = await getColumns(connection, database, candidate.table);
      if (!columns.size) continue;

      const idColumn = pickColumn(columns, candidate.idColumns);
      const usernameColumn = pickColumn(columns, candidate.usernameColumns);
      const hashColumn = pickColumn(columns, candidate.hashColumns);
      if (!hashColumn) continue;

      const selectId = idColumn ? escapeId(idColumn) : 'NULL';
      const selectUsername = usernameColumn ? escapeId(usernameColumn) : 'NULL';
      const selectHash = escapeId(hashColumn);
      const [rows] = await connection.query(
        `SELECT
            ${selectId} AS record_id,
            ${selectUsername} AS username,
            LEFT(${selectHash}, 30) AS password_hash_sample,
            ${selectHash} LIKE '$argon2id$%' AS is_argon2id
           FROM ${escapeId(candidate.table)}
          WHERE ${selectHash} IS NOT NULL
          LIMIT 10`
      );

      if (!rows.length) continue;
      found = true;
      console.log(`Table: ${candidate.table}`);
      console.table(rows);
    }

    if (!found) {
      console.log('No password hash rows found in users or employees.');
    }
  } finally {
    await connection.end();
  }
}

showPasswordHashEvidence().catch(error => {
  console.error(`Password hash evidence check failed: ${error.message}`);
  process.exit(1);
});
