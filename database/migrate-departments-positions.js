const pool = require('../config/db');

const DEFAULT_DEPARTMENTS = ['HR', 'Accounting', 'Production', 'Logistics', 'Personnel'];
const DEFAULT_POSITIONS = {
  HR: ['HR Officer', 'HR Manager', 'Recruitment Officer', 'HR Assistant'],
  Accounting: ['Finance Manager', 'Accounting Staff', 'Payroll Officer', 'Bookkeeper'],
  Production: ['Assembly Worker', 'Machine Operator', 'Quality Inspector', 'Production Supervisor'],
  Logistics: ['Deliver Driver', 'Delivery Helper', 'Warehouse Staff', 'Logistics Coordinator'],
  Personnel: ['Personnel Officer', 'Personnel Assistant', 'Admin Staff'],
};

async function run() {
  const [departmentColumns] = await pool.execute("SHOW COLUMNS FROM departments LIKE 'is_active'");
  if (!departmentColumns.length) {
    await pool.execute('ALTER TABLE departments ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1');
  }

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS positions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      department_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_positions_department_name (department_id, name),
      CONSTRAINT fk_positions_department
        FOREIGN KEY (department_id) REFERENCES departments(id)
        ON DELETE CASCADE
    )
  `);

  for (const departmentName of DEFAULT_DEPARTMENTS) {
    await pool.execute(
      'INSERT IGNORE INTO departments (name) VALUES (?)',
      [departmentName]
    );
  }

  const [departments] = await pool.execute('SELECT id, name FROM departments');
  const departmentMap = new Map(departments.map(dept => [dept.name, dept.id]));

  for (const [departmentName, positions] of Object.entries(DEFAULT_POSITIONS)) {
    const departmentId = departmentMap.get(departmentName);
    if (!departmentId) continue;
    for (const positionName of positions) {
      await pool.execute(
        'INSERT IGNORE INTO positions (department_id, name) VALUES (?, ?)',
        [departmentId, positionName]
      );
    }
  }

  console.log('Departments and positions migration completed.');
  process.exit(0);
}

run().catch(error => {
  console.error('Departments and positions migration failed:', error);
  process.exit(1);
});
