const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

require('dotenv').config();

const APPLY = process.argv.includes('--apply');
const APP_DB_USER = 'lgsv_app';
const MIGRATION_DB_USER = 'lgsv_migrator';
const APP_DB_HOSTS = ['localhost', '127.0.0.1'];
const ENV_PATH = path.join(__dirname, '..', '.env');

function replaceEnvValue(contents, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  return pattern.test(contents) ? contents.replace(pattern, line) : `${contents.trimEnd()}\n${line}\n`;
}

async function run() {
  let stage = 'initialization';
  if (process.env.NODE_ENV === 'production') {
    throw new Error('This local XAMPP hardening script cannot run in production.');
  }
  if (!APPLY) {
    console.log('Dry run only. Use --apply to configure the local database account.');
    return;
  }

  const database = String(process.env.DB_NAME || 'lgsv_hr_db').trim();
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error('DB_NAME contains unsupported characters.');
  if (!fs.existsSync(ENV_PATH)) throw new Error('.env file was not found.');

  const generatedPassword = crypto.randomBytes(36).toString('base64url');
  const generatedMigrationPassword = crypto.randomBytes(36).toString('base64url');
  const admin = await mysql.createConnection({
    host: '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: 'root',
    password: '',
    multipleStatements: false,
  });

  try {
    // XAMPP may currently be running with skip-grant-tables. Reloading grants
    // enables account-management statements before the secure restart.
    stage = 'reload existing grants';
    await admin.query('FLUSH PRIVILEGES');
    const escapedDatabase = admin.escapeId(database);
    const accounts = [
      { user: APP_DB_USER, password: generatedPassword, migration: false },
      { user: MIGRATION_DB_USER, password: generatedMigrationPassword, migration: true },
    ];
    for (const config of accounts) {
      for (const host of APP_DB_HOSTS) {
        stage = `remove existing ${config.user}@${host}`;
        const account = `${admin.escape(config.user)}@${admin.escape(host)}`;
        await admin.query(`DROP USER IF EXISTS ${account}`);
      }
      for (const host of APP_DB_HOSTS) {
        stage = `create ${config.user}@${host}`;
        const account = `${admin.escape(config.user)}@${admin.escape(host)}`;
        await admin.query(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${admin.escape(config.password)}`);
        stage = `grant database privileges to ${config.user}@${host}`;
        if (config.migration) {
          await admin.query(`GRANT ALL PRIVILEGES ON ${escapedDatabase}.* TO ${account}`);
        } else {
          await admin.query(
            `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES, `
            + `CREATE TEMPORARY TABLES, LOCK TABLES, EXECUTE, CREATE VIEW, SHOW VIEW, TRIGGER `
            + `ON ${escapedDatabase}.* TO ${account}`
          );
        }
      }
    }
    stage = 'activate application grants';
    await admin.query('FLUSH PRIVILEGES');
  } catch (error) {
    throw new Error(`${stage}: ${error.message}`);
  } finally {
    await admin.end();
  }

  const verification = await mysql.createConnection({
    host: '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: APP_DB_USER,
    password: generatedPassword,
    database,
  });
  try {
    await verification.execute('SELECT 1');
    await verification.execute('SELECT COUNT(*) AS count FROM users');
  } finally {
    await verification.end();
  }

  const migrationVerification = await mysql.createConnection({
    host: '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: MIGRATION_DB_USER,
    password: generatedMigrationPassword,
    database,
  });
  try {
    await migrationVerification.execute('SELECT 1');
  } finally {
    await migrationVerification.end();
  }

  let envContents = fs.readFileSync(ENV_PATH, 'utf8');
  envContents = replaceEnvValue(envContents, 'DB_HOST', '127.0.0.1');
  envContents = replaceEnvValue(envContents, 'DB_USER', APP_DB_USER);
  envContents = replaceEnvValue(envContents, 'DB_PASSWORD', generatedPassword);
  envContents = replaceEnvValue(envContents, 'MIGRATION_DB_USER', MIGRATION_DB_USER);
  envContents = replaceEnvValue(envContents, 'MIGRATION_DB_PASSWORD', generatedMigrationPassword);
  fs.writeFileSync(ENV_PATH, envContents, { encoding: 'utf8', mode: 0o600 });

  console.log(`PASS: ${APP_DB_USER} can access only the configured application database.`);
  console.log(`PASS: ${MIGRATION_DB_USER} is separated from the runtime application account.`);
  console.log('PASS: Generated database password was written only to the ignored .env file.');
}

run().catch(error => {
  console.error(`Local database security setup failed: ${error.message}`);
  process.exitCode = 1;
});
