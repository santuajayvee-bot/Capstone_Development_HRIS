const mysql = require('mysql2/promise');
require('dotenv').config();

async function addEmployees() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'lgsv_hr_db'
  });

  const employees = [
    { code: 'EMP-1011', first: 'Jayvee', last: 'Santua', email: 'jayvee.santua@example.com', dept: 3, pos: 'Sewing Machine Operator' },
    { code: 'EMP-1012', first: 'Lander', last: 'Leander', email: 'lander.leander@example.com', dept: 4, pos: 'Delivery Driver' },
    { code: 'EMP-1013', first: 'Ruzzel', last: 'Gania', email: 'ruzzel.gania@example.com', dept: 3, pos: 'Quality Control Inspector' },
    { code: 'EMP-1014', first: 'Serjo', last: 'Verino', email: 'serjo.verino@example.com', dept: 5, pos: 'General Staff' },
  ];

  try {
    for (const emp of employees) {
      const [result] = await connection.execute(
        `INSERT IGNORE INTO employees (employee_code, first_name, last_name, email, department_id, position, employment_type, status)
         VALUES (?, ?, ?, ?, ?, ?, 'Full-time', 'Active')`,
        [emp.code, emp.first, emp.last, emp.email, emp.dept, emp.pos]
      );
      if (result.insertId) {
        console.log(`✅ Successfully added ${emp.first} ${emp.last} as ${emp.pos}`);
      } else {
        console.log(`⚠️ ${emp.first} ${emp.last} might already exist or failed to insert.`);
      }
    }
  } catch(e) {
    console.error('Error inserting employees:', e.message);
  } finally {
    await connection.end();
  }
}

addEmployees();
