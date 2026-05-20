/* ============================================================
   database/migrate-employee-module.js
   Migration for Employee Actor Module — Secure-by-Design
   
   Adds:
   1. blockchain_hashes table (SHA-256 payslip integrity)
   2. login_attempts / locked_until columns (Spoofing mitigation)
   3. Indexes for performance
   
   Run ONCE:  node -r dotenv/config database/migrate-employee-module.js
   ============================================================ */

require('dotenv').config();
const crypto = require('crypto');
const pool   = require('../config/db');

async function migrateEmployeeModule() {
  const conn = await pool.getConnection();
  try {
    console.log('🔄 Running Employee Actor Module Migration...\n');

    // ── 1. Create blockchain_hashes table ────────────────────────
    // Stores SHA-256 hashes of payslip records for integrity verification.
    // Simulates the Hyperledger Fabric immutable ledger off-chain.
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS blockchain_hashes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        record_type VARCHAR(50) NOT NULL DEFAULT 'payslip',
        record_id INT NOT NULL,
        sha256_hash VARCHAR(64) NOT NULL,
        previous_hash VARCHAR(64) NULL,
        block_number INT NOT NULL,
        nonce INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY unique_record (record_type, record_id),
        KEY idx_record_lookup (record_type, record_id),
        KEY idx_block_number (block_number)
      )
    `);
    console.log('  ✅ Created blockchain_hashes table');

    // ── 2. Add login lockout columns to users table ─────────────
    // Spoofing mitigation: lock after 5 failed attempts
    try {
      await conn.execute(`ALTER TABLE users ADD COLUMN login_attempts INT DEFAULT 0 AFTER is_active`);
      console.log('  ✅ Added login_attempts column to users');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('  ⚠️  login_attempts column already exists');
      } else throw e;
    }

    try {
      await conn.execute(`ALTER TABLE users ADD COLUMN locked_until TIMESTAMP NULL AFTER login_attempts`);
      console.log('  ✅ Added locked_until column to users');
    } catch (e) {
      if (e.code === 'ER_DUP_FIELDNAME') {
        console.log('  ⚠️  locked_until column already exists');
      } else throw e;
    }

    // ── 3. Seed blockchain hashes for existing payslips ─────────
    const [payslips] = await conn.execute(`
      SELECT ps.id, ps.employee_id, ps.wage_type_id, ps.total_earning,
             ps.total_deduction, ps.net_pay, ps.status, ps.payroll_run_id
      FROM payslips ps
      WHERE ps.id NOT IN (SELECT record_id FROM blockchain_hashes WHERE record_type = 'payslip')
    `);

    if (payslips.length > 0) {
      console.log(`\n  📦 Hashing ${payslips.length} existing payslips for blockchain ledger...`);

      // Get the latest block number
      const [lastBlock] = await conn.execute(
        'SELECT COALESCE(MAX(block_number), 0) AS last_block FROM blockchain_hashes'
      );
      let blockNumber = lastBlock[0].last_block;
      let previousHash = '0'.repeat(64); // Genesis block previous hash

      // Get previous hash if chain exists
      if (blockNumber > 0) {
        const [prevRow] = await conn.execute(
          'SELECT sha256_hash FROM blockchain_hashes WHERE block_number = ?',
          [blockNumber]
        );
        if (prevRow.length > 0) previousHash = prevRow[0].sha256_hash;
      }

      for (const ps of payslips) {
        blockNumber++;
        const payload = JSON.stringify({
          id: ps.id,
          employee_id: ps.employee_id,
          wage_type_id: ps.wage_type_id,
          total_earning: ps.total_earning,
          total_deduction: ps.total_deduction,
          net_pay: ps.net_pay,
          payroll_run_id: ps.payroll_run_id,
          status: ps.status,
        });

        const hash = crypto.createHash('sha256').update(payload + previousHash).digest('hex');

        await conn.execute(
          `INSERT INTO blockchain_hashes (record_type, record_id, sha256_hash, previous_hash, block_number)
           VALUES ('payslip', ?, ?, ?, ?)`,
          [ps.id, hash, previousHash, blockNumber]
        );

        console.log(`    Block #${blockNumber}: Payslip ID ${ps.id} → ${hash.substring(0, 16)}...`);
        previousHash = hash;
      }
    } else {
      console.log('  ℹ️  No unhashed payslips found — blockchain ledger is current.');
    }

    // ── 4. Final verification ───────────────────────────────────
    const [hashCount] = await conn.execute('SELECT COUNT(*) AS total FROM blockchain_hashes');
    const [userCols] = await conn.execute(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
      AND COLUMN_NAME IN ('login_attempts', 'locked_until')
    `);

    console.log('\n📋 Migration Summary:');
    console.log('─'.repeat(50));
    console.log(`  Blockchain hashes:  ${hashCount[0].total} records`);
    console.log(`  User lockout cols:  ${userCols.length}/2 present`);
    console.log('─'.repeat(50));
    console.log('\n✅ Employee Actor Module Migration completed.\n');

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    console.error(err);
  } finally {
    conn.release();
    process.exit(0);
  }
}

migrateEmployeeModule();
