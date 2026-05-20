require('dotenv').config();
const pool = require('./config/db');

async function fixHrAdmin() {
  try {
    // Check if there's any employee we can link to
    const [employees] = await pool.execute('SELECT id FROM employees LIMIT 1');
    if (employees.length === 0) {
      console.log('No employees found. Please create an employee first.');
      process.exit(1);
    }
    
    const empId = employees[0].id;
    console.log(`Linking hr.admin to employee ID: ${empId}...`);
    
    await pool.execute(
      'UPDATE users SET employee_id = ? WHERE username = ?',
      [empId, 'hr.admin']
    );
    
    console.log('✅ Successfully linked hr.admin to an employee record!');
    console.log('You should now be able to submit personal requests. Please log out and log back in to refresh your user session.');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    process.exit(0);
  }
}

fixHrAdmin();
