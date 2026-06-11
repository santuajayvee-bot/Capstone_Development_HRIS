/* ============================================================
   database/migrate-rbac-module.js
   Migration for Account Registration & RBAC Management Module.
   Adds access_level to roles table, encrypted_pii to employees,
   and ensures system_audit_log is properly configured.
   
   Run ONCE:  node -r dotenv/config database/migrate-rbac-module.js
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function migrateRBACModule() {
  const conn = await pool.getConnection();
  try {
    console.log('🔄 Running RBAC Module Migration...\n');

    // ── 1. Add access_level column to roles table ──────────────
    try {
      await conn.execute(`
        ALTER TABLE roles 
        ADD COLUMN access_level VARCHAR(20) NULL AFTER label
      `);
      console.log('  ✅ Added access_level column to roles table');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('  ⚠️  access_level column already exists in roles');
      } else {
        throw e;
      }
    }

    // ── 2. Set access levels for existing roles ────────────────
    const roleDefinitions = [
      { name: 'employee',        label: 'Employee (Level 1)',             level: 'Level 1' },
      { name: 'hr_admin',        label: 'HR Manager (Level 2)',           level: 'Level 2' },
      { name: 'payroll_officer', label: 'Payroll Officer (Level 2)',      level: 'Level 2' },
      { name: 'hr_manager',      label: 'HR Manager (Level 2)',           level: 'Level 2' },
      { name: 'payroll_manager', label: 'Payroll Manager (Level 3)',      level: 'Level 3' },
      { name: 'system_admin',    label: 'System Administrator (Level 4)', level: 'Level 4' },
    ];
    for (const role of roleDefinitions) {
      await conn.execute(
        `INSERT INTO roles (name, label, access_level)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE label = VALUES(label), access_level = VALUES(access_level)`,
        [role.name, role.label, role.level]
      );
    }
    await conn.execute(
      `UPDATE users
          SET role_id = (SELECT id FROM roles WHERE name = 'hr_manager' LIMIT 1)
        WHERE username = 'hr.admin'`
    );
    console.log('  Updated hr.admin account to HR Manager role');

    const roleLevels = [
      { name: 'employee',        level: 'Level 1' },
      { name: 'hr_admin',        level: 'Level 2' },
      { name: 'payroll_officer', level: 'Level 2' },
      { name: 'hr_manager',      level: 'Level 2' },
      { name: 'payroll_manager', level: 'Level 3' },
      { name: 'system_admin',    level: 'Level 4' },
      { name: 'admin',           level: 'Level 4' },
    ];

    for (const rl of roleLevels) {
      const [result] = await conn.execute(
        'UPDATE roles SET access_level = ? WHERE name = ?',
        [rl.level, rl.name]
      );
      if (result.affectedRows > 0) {
        console.log(`  ✅ Set ${rl.name} → ${rl.level}`);
      }
    }

    // ── 3. Add encrypted_pii column to employees ───────────────
    try {
      await conn.execute(`
        ALTER TABLE employees 
        ADD COLUMN encrypted_pii TEXT NULL AFTER bank_account
      `);
      console.log('  ✅ Added encrypted_pii column to employees table');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('  ⚠️  encrypted_pii column already exists in employees');
      } else {
        throw e;
      }
    }

    // ── 4. Ensure system_audit_log has target_employee_id ──────
    try {
      await conn.execute(`
        ALTER TABLE system_audit_log 
        ADD COLUMN target_employee_id INT NULL AFTER employee_id
      `);
      console.log('  ✅ Added target_employee_id column to system_audit_log');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('  ⚠️  target_employee_id column already exists in system_audit_log');
      } else {
        throw e;
      }
    }

    // ── 5. Ensure system_audit_log has module column ───────────
    try {
      await conn.execute(`
        ALTER TABLE system_audit_log 
        ADD COLUMN module VARCHAR(50) NULL DEFAULT 'RBAC' AFTER action_performed
      `);
      console.log('  ✅ Added module column to system_audit_log');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('  ⚠️  module column already exists in system_audit_log');
      } else {
        throw e;
      }
    }

    // ── 6. Add index for fast audit lookups ─────────────────────
    try {
      await conn.execute(`
        CREATE INDEX idx_audit_module_timestamp 
        ON system_audit_log (module, timestamp)
      `);
      console.log('  ✅ Created index idx_audit_module_timestamp');
    } catch (e) {
      if (e.code === 'ER_DUP_KEYNAME') {
        console.log('  ⚠️  Index idx_audit_module_timestamp already exists');
      } else {
        throw e;
      }
    }

    // ── 7. Verify final state ──────────────────────────────────
    const [roles] = await conn.execute(
      'SELECT id, name, label, access_level FROM roles ORDER BY id'
    );
    console.log('\n📋 Final Role Structure:');
    console.log('─'.repeat(60));
    for (const r of roles) {
      console.log(`  ID: ${r.id} | ${r.name.padEnd(18)} | ${(r.label || '').padEnd(30)} | ${r.access_level || 'N/A'}`);
    }
    console.log('─'.repeat(60));

    console.log('\n✅ RBAC Module Migration completed successfully.\n');

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    console.error(err);
  } finally {
    conn.release();
    process.exit(0);
  }
}

migrateRBACModule();
