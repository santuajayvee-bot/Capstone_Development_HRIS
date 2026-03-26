/* ============================================================
   database/seed-users.js
   Generates bcrypt hashes and inserts real user accounts.
   Run ONCE after schema.sql:  node database/seed-users.js
   ============================================================ */

require('dotenv').config();
const bcrypt = require('bcrypt');
const pool   = require('../config/db');

const SALT_ROUNDS = 10;

const USERS = [
  { username: 'admin',           password: 'admin123',   role_id: 1, employee_id: null },
  { username: 'payroll.officer', password: 'officer123', role_id: 2, employee_id: 1    },
  { username: 'payroll.manager', password: 'manager123', role_id: 3, employee_id: 3    },
  { username: 'serjo.justine',   password: 'emp123',     role_id: 4, employee_id: 1    },
  { username: 'chris.brown',     password: 'emp123',     role_id: 4, employee_id: 2    },
  { username: 'lebron.james',    password: 'emp123',     role_id: 4, employee_id: 3    },
];

async function seedUsers() {
  const conn = await pool.getConnection();
  try {
    console.log('🌱  Seeding users...\n');

    for (const u of USERS) {
      const hash = await bcrypt.hash(u.password, SALT_ROUNDS);

      await conn.execute(
        `INSERT INTO users (username, password_hash, role_id, employee_id)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
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
