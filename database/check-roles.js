require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const pool = require(require('path').join(__dirname, '..', 'config', 'db'));

async function checkRoles() {
  const conn = await pool.getConnection();
  try {
    const [roles] = await conn.execute('SELECT id, name, label FROM roles ORDER BY id');
    console.log('\n=== Current Roles in Database ===');
    roles.forEach(r => {
      console.log(`ID ${r.id}: ${r.name.padEnd(20)} => ${r.label}`);
    });
    
    console.log('\n=== Current Users and Their Roles ===');
    const [users] = await conn.execute(`
      SELECT u.id, u.username, u.role_id, r.name, r.label
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      ORDER BY u.username
    `);
    users.forEach(u => {
      console.log(`${u.username.padEnd(20)} (role_id ${u.role_id}) => ${u.name?.padEnd(20) || 'NULL'} | ${u.label || 'NULL'}`);
    });
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    conn.release();
    process.exit(0);
  }
}

checkRoles();
