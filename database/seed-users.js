/* ============================================================
   database/seed-users.js
   Generates bcrypt hashes and inserts real user accounts.
   Run ONCE after schema.sql:  node database/seed-users.js
   ============================================================ */

require('dotenv').config();
const pool   = require('../config/db');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

// Updated USERS array with plain text passwords and valid role_id
const USERS = [
  // System Administrator (Level 4) - role_id 1
  { username: 'sys.admin',       password: 'sys123admin', role_id: 1, employee_id: null },
  
  // HR Administrator (Level 2) - role_id 2
  { username: 'hr.admin',        password: 'hr123admin',  role_id: 2, employee_id: null },
  
  // Payroll staff
  { username: 'payroll.officer', password: 'officer123', role_id: 2, employee_id: 1    },
  { username: 'payroll.manager', password: 'manager123', role_id: 3, employee_id: 3    },
  
  // Regular employees - role_id 4
  { username: 'serjo.justine',   password: 'emp123',     role_id: 4, employee_id: 37   },
  { username: 'chris.brown',     password: 'emp123',     role_id: 4, employee_id: 11   },
  { username: 'lebron.james',    password: 'emp123',     role_id: 4, employee_id: 41   },
  // Admin (Level 1) - role_id 1
  { username: 'admin', password: 'admin', role_id: 1, employee_id: null },
];

async function seedUsers() {
  const conn = await pool.getConnection();
  try {
    console.log('🌱  Seeding users...\n');

    for (const u of USERS) {
      const hash = await bcrypt.hash(u.password, SALT_ROUNDS); // Re-enable password hashing

      await conn.execute(
        `INSERT INTO users (username, password_hash, role_id, employee_id)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role_id = VALUES(role_id), employee_id = VALUES(employee_id)`,
        [u.username, hash, u.role_id, u.employee_id]
      );

      console.log(`  ✅  ${u.username} (role_id: ${u.role_id}) — seeded`);
    }

    console.log('\n✅  All users seeded successfully.');
  } catch (err) {
    console.error('❌  Seed error:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

seedUsers();
