/* ============================================================
   database/seed-onboarding.js
   Seeds sample onboarding data for testing.
   ============================================================ */

require('dotenv').config();
const pool = require('../config/db');

async function seedOnboarding() {
  const conn = await pool.getConnection();
  try {
    console.log('🌱 Seeding Onboarding Data...\n');

    // 1. Ensure onboarding_status column exists in employees
    try {
      await conn.execute("ALTER TABLE employees ADD COLUMN onboarding_status ENUM('active', 'completed', 'none') DEFAULT 'none'");
      console.log('   ✅ Added onboarding_status to employees');
    } catch (e) {}

    // 2. Get some employees to manage
    const [employees] = await conn.execute("SELECT id, first_name FROM employees LIMIT 5");
    if (employees.length === 0) {
      console.log('   ⚠️ No employees found to seed onboarding for.');
      return;
    }

    // Set them to active onboarding
    for (const emp of employees) {
      await conn.execute("UPDATE employees SET onboarding_status = 'active' WHERE id = ?", [emp.id]);
    }

    // Clear existing data to avoid duplicates
    await conn.execute("DELETE FROM onboarding_tasks");
    await conn.execute("DELETE FROM onboarding_documents");
    await conn.execute("DELETE FROM onboarding_learning");
    await conn.execute("DELETE FROM onboarding_feedback");

    // 3. Seed some tasks (Workflows)
    const tasks = [
      { name: 'Submit Tax Forms (W-4)', desc: 'Required for payroll setup.', role: 'Employee', offset: 1, status: 'pending' },
      { name: 'IT Equipment Handover', desc: 'Laptop, monitor, and accessories.', role: 'IT', offset: 2, status: 'in_progress' },
      { name: 'Signed Employment Contract', desc: 'Digital signature required.', role: 'HR', offset: -1, status: 'pending' }, // Overdue
      { name: 'Health Benefits Enrollment', desc: 'Select medical and dental plans.', role: 'Employee', offset: 3, status: 'pending' },
      { name: 'Office Security Orientation', desc: 'ID badge and building access.', role: 'HR', offset: 0, status: 'completed' }
    ];

    console.log('   📦 Seeding tasks...');
    for (const emp of employees) {
      for (const t of tasks) {
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + t.offset);
        await conn.execute(`
          INSERT INTO onboarding_tasks (employee_id, task_name, description, assignee_role, due_date, status)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [emp.id, t.name, t.desc, t.role, dueDate, t.status]);
      }
    }

    // 4. Seed some documents
    console.log('   📂 Seeding documents...');
    for (const emp of employees) {
      await conn.execute(`
        INSERT INTO onboarding_documents (employee_id, document_name, document_type, status)
        VALUES (?, 'NDA Agreement', 'nda', 'approved'),
               (?, 'Employment Contract', 'contract', 'pending'),
               (?, 'Tax Declaration Form', 'tax', 'submitted')
      `, [emp.id, emp.id, emp.id]);
    }

    // 5. Seed some learning modules
    console.log('   🎓 Seeding learning modules...');
    const modules = [
      { name: 'Company Culture 101', progress: 100, status: 'completed' },
      { name: 'HR Policies & Code of Conduct', progress: 45, status: 'in_progress' },
      { name: 'Safety Training', progress: 0, status: 'not_started' }
    ];
    for (const emp of employees) {
      for (const m of modules) {
        await conn.execute(`
          INSERT INTO onboarding_learning (employee_id, module_name, progress, status)
          VALUES (?, ?, ?, ?)
        `, [emp.id, m.name, m.progress, m.status]);
      }
    }

    // 6. Seed some feedback
    console.log('   ⭐ Seeding feedback...');
    for (const emp of employees) {
      await conn.execute(`
        INSERT INTO onboarding_feedback (employee_id, rating, comments)
        VALUES (?, ?, ?)
      `, [emp.id, 5, 'Great onboarding experience! Everything was ready for me.']);
    }

    console.log('\n✅ Onboarding data seeded successfully.');

  } catch (err) {
    console.error('❌ Seeding error:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

seedOnboarding();
