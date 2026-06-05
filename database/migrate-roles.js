/* ============================================================
   database/migrate-roles.js
   Migrates roles table to include HR Admin, HR Manager, and System Admin.
   Run once to update role definitions.
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function migrateRoles() {
  const conn = await pool.getConnection();
  try {
    console.log('🔄 Migrating roles...\n');

    // Update existing roles (keep backwards compatibility for any existing users)
    await conn.execute("UPDATE roles SET name='employee', label='Employee (Level 1)' WHERE name='employee'");
    console.log('   ✅ Updated role: Employee (Level 1)');

    // Delete any old admin role if it exists (cascade should be safe now)
    try {
      await conn.execute("DELETE FROM roles WHERE name IN ('admin', 'old_admin')");
      console.log('   ✅ Removed legacy admin role');
    } catch (e) {
      // Might not exist, that's okay
    }

    // Ensure new roles exist
    const roles = [
      { name: 'employee', label: 'Employee (Level 1)' },
      { name: 'hr_admin', label: 'HR Admin (Level 2)' },
      { name: 'hr_manager', label: 'HR Manager (Level 3)' },
      { name: 'payroll_officer', label: 'Payroll Officer (Level 2)' },
      { name: 'payroll_manager', label: 'Payroll Manager (Level 3)' },
      { name: 'system_admin', label: 'System Administrator (Level 4)' },
    ];

    for (const role of roles) {
      try {
        // Try to update first
        const [result] = await conn.execute(
          `UPDATE roles SET label=? WHERE name=?`,
          [role.label, role.name]
        );
        if (result.affectedRows === 0) {
          // If no rows affected, insert instead
          await conn.execute(
            `INSERT INTO roles (name, label) VALUES (?, ?)`,
            [role.name, role.label]
          );
          console.log(`   ✅ Created role: ${role.label}`);
        } else {
          console.log(`   ✅ Updated role: ${role.label}`);
        }
      } catch (e) {
        console.log(`   ⚠️  Role ${role.name} already exists`);
      }
    }

    console.log('\n✅ Role migration completed successfully.');
    await conn.execute(
      `UPDATE users
          SET role_id = (SELECT id FROM roles WHERE name = 'hr_manager' LIMIT 1)
        WHERE username = 'hr.admin'`
    );
    console.log('   Updated hr.admin account to HR Manager role');

    console.log('\nNew Role Structure:');
    console.log('  Level 1: employee');
    console.log('  Level 2: hr_admin, payroll_officer');
    console.log('  Level 3: hr_manager, payroll_manager');
    console.log('  Level 4: system_admin\n');

  } catch (err) {
    console.error('❌ Migration error:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

migrateRoles();
