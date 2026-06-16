/* ============================================================
   Migration: Employee ID Configuration
   - Keeps employees.id as the internal auto-increment key
   - Enforces employee_code as the visible unique Employee ID
   - Adds configurable prefix/sequence settings
   ============================================================ */

const pool = require('../config/db');

async function main() {
  const connection = await pool.getConnection();
  try {
    console.log('Starting employee ID configuration migration...');

    const [employeeCodeColumn] = await connection.execute("SHOW COLUMNS FROM employees LIKE 'employee_code'");
    if (!employeeCodeColumn.length) {
      await connection.execute('ALTER TABLE employees ADD COLUMN employee_code VARCHAR(20) NULL AFTER id');
      console.log('Added employees.employee_code');
    }

    const [duplicates] = await connection.execute(`
      SELECT employee_code, COUNT(*) AS total
        FROM employees
       WHERE employee_code IS NOT NULL AND employee_code <> ''
       GROUP BY employee_code
      HAVING COUNT(*) > 1
       LIMIT 5
    `);

    if (duplicates.length) {
      console.warn('Skipped unique index because duplicate employee_code values exist:');
      console.warn(duplicates);
    } else {
      const [indexes] = await connection.execute(`
        SELECT COUNT(*) AS total
          FROM INFORMATION_SCHEMA.STATISTICS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME = 'employees'
           AND INDEX_NAME = 'uq_employees_employee_code'
      `);
      if (!Number(indexes[0]?.total || 0)) {
        await connection.execute('CREATE UNIQUE INDEX uq_employees_employee_code ON employees (employee_code)');
        console.log('Created unique index uq_employees_employee_code');
      }
    }

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS employee_id_config (
        id TINYINT PRIMARY KEY DEFAULT 1,
        prefix VARCHAR(12) NOT NULL DEFAULT 'EMP',
        starting_number INT NOT NULL DEFAULT 1,
        number_padding TINYINT NOT NULL DEFAULT 6,
        current_sequence INT NOT NULL DEFAULT 0,
        auto_generate_enabled TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    const [configRows] = await connection.execute('SELECT COUNT(*) AS total FROM employee_id_config WHERE id = 1');
    if (!Number(configRows[0]?.total || 0)) {
      const [onboardingTables] = await connection.execute("SHOW TABLES LIKE 'onboarding_applicant'");
      const [codeRows] = onboardingTables.length
        ? await connection.execute(
            `SELECT employee_code FROM employees WHERE employee_code LIKE 'EMP%'
             UNION ALL
             SELECT intended_employee_code AS employee_code
               FROM onboarding_applicant
              WHERE deleted_at IS NULL
                AND intended_employee_code IS NOT NULL
                AND intended_employee_code LIKE 'EMP%'`
          )
        : await connection.execute("SELECT employee_code FROM employees WHERE employee_code LIKE 'EMP%'");
      const maxSequence = codeRows.reduce((max, row) => {
        const match = String(row.employee_code || '').match(/^EMP0*(\d+)$/i);
        return Math.max(max, match ? Number(match[1]) : 0);
      }, 0);
      await connection.execute(
        `INSERT INTO employee_id_config
           (id, prefix, starting_number, number_padding, current_sequence, auto_generate_enabled)
         VALUES (1, 'EMP', 1, 6, ?, 1)`,
        [maxSequence]
      );
      console.log('Seeded employee_id_config');
    }

    console.log('Employee ID configuration migration completed.');
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error('Employee ID configuration migration failed:', error);
  process.exit(1);
});
