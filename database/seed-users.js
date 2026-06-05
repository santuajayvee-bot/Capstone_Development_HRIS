/* ============================================================
   database/seed-users.js
   Generates bcrypt hashes and inserts real user accounts.
   Run once after schema setup: node database/seed-users.js
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

const USERS = [
  { username: 'sys.admin',       password: 'sys123admin', role: 'system_admin',    employee_id: null },
  { username: 'hr.admin',        password: 'hr123admin',  role: 'hr_manager',      employee_id: null },
  { username: 'payroll.officer', password: 'officer123',  role: 'payroll_officer', employee_id: 1 },
  { username: 'payroll.manager', password: 'manager123',  role: 'payroll_manager', employee_id: 3 },
  { username: 'serjo.justine',   password: 'emp123',      role: 'employee',        employee_id: 37 },
  { username: 'chris.brown',     password: 'emp123',      role: 'employee',        employee_id: 11 },
  { username: 'lebron.james',    password: 'emp123',      role: 'employee',        employee_id: 41 },
  { username: 'admin',           password: 'admin',       role: 'system_admin',    employee_id: null },
];

async function seedUsers() {
  const conn = await pool.getConnection();
  try {
    console.log('Seeding users...\n');

    const [roles] = await conn.execute('SELECT id, name FROM roles');
    const roleIdByName = new Map(roles.map(role => [role.name, role.id]));

    for (const user of USERS) {
      const roleId = roleIdByName.get(user.role);
      if (!roleId) throw new Error(`Missing role: ${user.role}. Run the role migration first.`);

      const hash = await bcrypt.hash(user.password, SALT_ROUNDS);
      await conn.execute(
        `INSERT INTO users (username, password_hash, role_id, employee_id)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           password_hash = VALUES(password_hash),
           role_id = VALUES(role_id),
           employee_id = VALUES(employee_id)`,
        [user.username, hash, roleId, user.employee_id]
      );

      console.log(`  ${user.username} (${user.role}) seeded`);
    }

    console.log('\nAll users seeded successfully.');
  } catch (err) {
    console.error('Seed error:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

seedUsers();
