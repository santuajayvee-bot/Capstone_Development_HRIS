const pool = require('../config/db');
const mysql = require('mysql2/promise');

function check(label, passed, detail) {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${label}: ${detail}`);
  return passed;
}

async function run() {
  const results = [];
  const configuredUser = String(process.env.DB_USER || '').trim();
  const migrationUser = String(process.env.MIGRATION_DB_USER || '').trim();
  results.push(check('Application DB account', configuredUser && configuredUser.toLowerCase() !== 'root', configuredUser || 'not configured'));
  results.push(check(
    'Separate migration DB account',
    migrationUser && migrationUser !== configuredUser
      && Boolean(process.env.MIGRATION_DB_PASSWORD)
      && process.env.MIGRATION_DB_PASSWORD !== process.env.DB_PASSWORD,
    migrationUser || 'not configured'
  ));
  results.push(check(
    'AES-256 key configuration',
    /^[a-f0-9]{64}$/i.test(String(process.env.AES_ENCRYPTION_KEY || '')),
    'requires exactly 64 hexadecimal characters'
  ));
  results.push(check(
    'JWT secret configuration',
    String(process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || '').length >= 32
      && !/replace-with/i.test(String(process.env.JWT_ACCESS_SECRET || process.env.JWT_SECRET || '')),
    'requires a non-placeholder secret of at least 32 characters'
  ));

  const [[identity]] = await pool.execute('SELECT CURRENT_USER() AS current_identity, USER() AS session_identity');
  let grants = [];
  try {
    [grants] = await pool.execute('SHOW GRANTS');
  } catch (error) {
    results.push(check('MySQL grant enforcement', false, error.message));
  }
  if (grants.length) {
    results.push(check(
      'MySQL grant enforcement',
      !String(identity.current_identity || '').startsWith('@'),
      identity.current_identity || 'unknown identity'
    ));
    const grantStatements = grants.flatMap(row => Object.values(row)).map(value => String(value).toUpperCase());
    const hasGlobalAdministrativeGrant = grantStatements.some(statement => (
      statement.includes(' ON *.* ')
      && !statement.startsWith('GRANT USAGE ON *.* ')
    ));
    results.push(check(
      'No global administrative grant',
      !hasGlobalAdministrativeGrant,
      'application account must be limited to the application database'
    ));
  }

  if (migrationUser && process.env.MIGRATION_DB_PASSWORD) {
    try {
      const migrationConnection = await mysql.createConnection({
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 3306),
        user: migrationUser,
        password: process.env.MIGRATION_DB_PASSWORD,
        database: process.env.DB_NAME,
      });
      try {
        const [migrationGrants] = await migrationConnection.query('SHOW GRANTS');
        const statements = migrationGrants.flatMap(row => Object.values(row)).map(value => String(value).toUpperCase());
        const hasDatabaseGrant = statements.some(statement => statement.includes(` ON \`${String(process.env.DB_NAME || '').toUpperCase()}\`.* `));
        const hasGlobalGrant = statements.some(statement => statement.includes(' ON *.* ') && !statement.startsWith('GRANT USAGE ON *.* '));
        results.push(check(
          'Migration account database scope',
          hasDatabaseGrant && !hasGlobalGrant,
          'DDL access is limited to the application database'
        ));
      } finally {
        await migrationConnection.end();
      }
    } catch (error) {
      results.push(check('Migration account database scope', false, error.message));
    }
  }

  const [[hashes]] = await pool.execute(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN password_hash LIKE '$argon2id$%' THEN 1 ELSE 0 END) AS argon2id_count
      FROM users
  `);
  results.push(check(
    'Argon2id password storage',
    Number(hashes.total) === Number(hashes.argon2id_count),
    `${hashes.argon2id_count}/${hashes.total} user hashes use Argon2id`
  ));

  if (process.env.NODE_ENV === 'production') {
    results.push(check('RDS TLS enabled', process.env.DB_SSL === 'true', `DB_SSL=${process.env.DB_SSL || 'unset'}`));
    results.push(check(
      'RDS certificate verification',
      process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false',
      `DB_SSL_REJECT_UNAUTHORIZED=${process.env.DB_SSL_REJECT_UNAUTHORIZED || 'true'}`
    ));
  } else {
    console.log('INFO RDS TLS checks run when NODE_ENV=production.');
  }
  console.log('INFO AWS RDS automated-backup retention and snapshot evidence must be verified in the AWS console.');

  if (results.some(result => !result)) process.exitCode = 1;
}

run()
  .catch(error => {
    console.error(`Database security verification failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
