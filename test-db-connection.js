const mysql = require('mysql2/promise');
require('dotenv').config();

(async () => {
  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'lgsv_hr_db',
    });

    console.log('✅ Successfully connected to MySQL database:', process.env.DB_NAME);
    await connection.end();
  } catch (error) {
    console.error('❌ MySQL connection test failed:', error.message);
  }
})();