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

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS leave_types (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(120) NOT NULL UNIQUE,
        code VARCHAR(30) NULL UNIQUE,
        category ENUM('Company','Statutory') NOT NULL DEFAULT 'Company',
        description TEXT NULL,
        max_allowed_days DECIMAL(8,2) NOT NULL DEFAULT 0,
        is_paid TINYINT(1) NOT NULL DEFAULT 1,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        requires_attachment TINYINT(1) NOT NULL DEFAULT 0,
        allow_unpaid_extension TINYINT(1) NOT NULL DEFAULT 0,
        max_extension_days DECIMAL(8,2) NOT NULL DEFAULT 0,
        female_only TINYINT(1) NOT NULL DEFAULT 0,
        male_only TINYINT(1) NOT NULL DEFAULT 0,
        married_only TINYINT(1) NOT NULL DEFAULT 0,
        solo_parent_required TINYINT(1) NOT NULL DEFAULT 0,
        medical_certificate_required TINYINT(1) NOT NULL DEFAULT 0,
        legal_document_required TINYINT(1) NOT NULL DEFAULT 0,
        minimum_service_months INT NOT NULL DEFAULT 0,
        future_conditions JSON NULL,
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_leave_types_category (category),
        INDEX idx_leave_types_active (is_active)
      )
    `);

    const defaults = [
      ['Vacation Leave', 'VL', 'Company', 'Company vacation leave.', 15, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ['Sick Leave', 'SL', 'Company', 'Company sick leave.', 10, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ['Emergency Leave', 'EL', 'Company', 'Company emergency leave.', 5, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ['Maternity Leave', 'MAT', 'Statutory', '105 paid days with optional 30 unpaid extension.', 105, 1, 1, 1, 1, 30, 1, 0, 0, 0, 1, 0, 0],
      ['Paternity Leave', 'PAT', 'Statutory', '7 paid days for married male employees.', 7, 1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0],
      ['Solo Parent Leave', 'SPL', 'Statutory', '7 paid days per year for qualified solo parents.', 7, 1, 1, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0],
      ['Magna Carta for Women Leave', 'MCW', 'Statutory', '60 paid days with medical certification.', 60, 1, 1, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0],
      ['VAWC Leave', 'VAWC', 'Statutory', '10 paid days requiring legal or government-issued documents.', 10, 1, 1, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0]
    ];

    for (const row of defaults) {
      await connection.execute(`
        INSERT INTO leave_types
          (name, code, category, description, max_allowed_days, is_paid, is_active,
           requires_attachment, allow_unpaid_extension, max_extension_days,
           female_only, male_only, married_only, solo_parent_required,
           medical_certificate_required, legal_document_required, minimum_service_months)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          category = VALUES(category),
          description = VALUES(description),
          max_allowed_days = VALUES(max_allowed_days),
          updated_at = CURRENT_TIMESTAMP
      `, row);
    }

    await ensureColumn(connection, 'leave_requests', 'leave_type_id', 'INT NULL');
    await ensureColumn(connection, 'leave_requests', 'leave_category', "ENUM('Company','Statutory') NULL");
    await ensureColumn(connection, 'leave_requests', 'submitted_by', 'INT NULL');
    await ensureColumn(connection, 'leave_requests', 'approval_date', 'DATETIME NULL');
    await ensureColumn(connection, 'leave_requests', 'approval_remarks', 'TEXT NULL');

    await connection.execute(`
      ALTER TABLE leave_requests
      MODIFY status ENUM('Draft','Pending','Approved','Rejected','Denied','Cancelled') DEFAULT 'Pending'
    `);

    await connection.execute(`
      UPDATE leave_requests lr
      LEFT JOIN leave_types lt
        ON LOWER(lt.name) = LOWER(lr.type)
        OR (LOWER(lr.type) = 'vacation' AND lt.name = 'Vacation Leave')
        OR (LOWER(lr.type) = 'sick' AND lt.name = 'Sick Leave')
        OR (LOWER(lr.type) = 'emergency' AND lt.name = 'Emergency Leave')
      SET lr.leave_type_id = COALESCE(lr.leave_type_id, lt.id),
          lr.leave_category = COALESCE(lr.leave_category, lt.category),
          lr.submitted_by = COALESCE(lr.submitted_by, lr.filed_by)
      WHERE lt.id IS NOT NULL
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS leave_balances (
        id INT AUTO_INCREMENT PRIMARY KEY,
        employee_id INT NOT NULL,
        leave_type_id INT NULL,
        leave_type VARCHAR(120) NOT NULL,
        balance DECIMAL(8,2) NOT NULL DEFAULT 0,
        used DECIMAL(8,2) NOT NULL DEFAULT 0,
        year INT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_leave_balance (employee_id, leave_type, year),
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
      )
    `);
    await ensureColumn(connection, 'leave_balances', 'leave_type_id', 'INT NULL');
    await connection.execute(`ALTER TABLE leave_balances MODIFY leave_type VARCHAR(120) NOT NULL`);
    await connection.execute(`
      UPDATE leave_balances lb
      LEFT JOIN leave_types lt
        ON LOWER(lt.name) = LOWER(lb.leave_type)
        OR (LOWER(lb.leave_type) = 'vacation' AND lt.name = 'Vacation Leave')
        OR (LOWER(lb.leave_type) = 'sick' AND lt.name = 'Sick Leave')
        OR (LOWER(lb.leave_type) = 'emergency' AND lt.name = 'Emergency Leave')
      SET lb.leave_type_id = COALESCE(lb.leave_type_id, lt.id),
          lb.leave_type = COALESCE(lt.name, lb.leave_type)
      WHERE lt.id IS NOT NULL
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS leave_audit_trail (
        id INT AUTO_INCREMENT PRIMARY KEY,
        leave_request_id INT NULL,
        employee_id INT NULL,
        actor_user_id INT NULL,
        action VARCHAR(50) NOT NULL,
        remarks TEXT NULL,
        old_status VARCHAR(30) NULL,
        new_status VARCHAR(30) NULL,
        metadata JSON NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await ensureColumn(connection, 'leave_audit_trail', 'old_status', 'VARCHAR(30) NULL');
    await ensureColumn(connection, 'leave_audit_trail', 'new_status', 'VARCHAR(30) NULL');
    await ensureColumn(connection, 'leave_audit_trail', 'metadata', 'JSON NULL');

    await ensureColumn(connection, 'employees', 'solo_parent_status', 'TINYINT(1) NOT NULL DEFAULT 0');

    await connection.commit();
    console.log('Leave policy management migration complete.');
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('Leave policy management migration failed:', error);
  process.exit(1);
});
