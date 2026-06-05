const pool = require('../config/db');

async function migrate() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS form_drafts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        module_name VARCHAR(80) NOT NULL,
        form_name VARCHAR(120) NOT NULL,
        record_id VARCHAR(120) NULL,
        draft_data_json JSON NOT NULL,
        status ENUM('Active','Submitted','Discarded','Expired') NOT NULL DEFAULT 'Active',
        last_saved_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_form_draft_scope (user_id, module_name, form_name, record_id),
        INDEX idx_form_drafts_user_status (user_id, status),
        INDEX idx_form_drafts_expires (expires_at)
      )
    `);

    await connection.commit();
    console.log('Form drafts migration complete.');
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch(error => {
  console.error('Form drafts migration failed:', error);
  process.exit(1);
});
