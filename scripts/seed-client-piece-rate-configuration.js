'use strict';

require('dotenv').config();

const assert = require('assert/strict');
const pool = require('../config/db');

const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const EFFECTIVE_DATE = String(process.env.CLIENT_PIECE_RATE_EFFECTIVE_DATE || '2026-05-25').trim();

const PIECE_RATE_MATRIX = Object.freeze({
  UL: Object.freeze({
    '14-19': '0.1300',
    '20-23': '0.1500',
    '24-26': '0.1625',
    '27-29': '0.1773',
  }),
  HT: Object.freeze({
    '14-19': '0.2786',
    '20-23': '0.3000',
    '24-26': '0.3250',
  }),
  HL: Object.freeze({
    '14-19': '0.3900',
    '20-23': '0.4335',
    '24-26': '0.4335',
  }),
  AL: Object.freeze({
    '14-19': '0.3900',
    '20-23': '0.3900',
    '24-26': '0.4334',
  }),
  DF: Object.freeze({
    '14-19': '0.4334',
    '20-23': '0.4334',
    '24-26': '0.4334',
  }),
});

function assertLocalOnly() {
  const nodeEnv = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
  const host = String(process.env.DB_HOST || 'localhost').trim().toLowerCase();

  assert.notEqual(nodeEnv, 'production', 'Client piece-rate seeding is blocked in production.');
  assert.ok(
    LOCAL_DATABASE_HOSTS.has(host),
    `Client piece-rate seeding is localhost-only; refusing database host ${host}.`
  );
  assert.match(EFFECTIVE_DATE, /^\d{4}-\d{2}-\d{2}$/, 'Effective date must use YYYY-MM-DD.');
}

function matrixRows() {
  return Object.entries(PIECE_RATE_MATRIX).flatMap(([sewType, ranges]) => (
    Object.entries(ranges).map(([sizeRange, pieceRate]) => ({
      sew_type: sewType,
      size_range: sizeRange,
      piece_rate: pieceRate,
    }))
  ));
}

async function activateSewTypes(connection) {
  await connection.execute('UPDATE payroll_sew_types SET is_active = 0 WHERE is_active <> 0');
  for (const sewType of Object.keys(PIECE_RATE_MATRIX)) {
    await connection.execute(
      `INSERT INTO payroll_sew_types (code, description, effective_date, is_active)
       VALUES (?, ?, ?, 1)
       ON DUPLICATE KEY UPDATE
         description = VALUES(description),
         is_active = 1,
         updated_at = CURRENT_TIMESTAMP`,
      [sewType, `${sewType} sewing operation`, EFFECTIVE_DATE]
    );
  }
}

async function activateSizeRanges(connection) {
  const sizeRanges = [...new Set(matrixRows().map(row => row.size_range))];
  await connection.execute('UPDATE payroll_size_ranges SET is_active = 0 WHERE is_active <> 0');
  for (const sizeRange of sizeRanges) {
    await connection.execute(
      `INSERT INTO payroll_size_ranges (size_range, description, is_active)
       VALUES (?, ?, 1)
       ON DUPLICATE KEY UPDATE
         description = VALUES(description),
         is_active = 1,
         updated_at = CURRENT_TIMESTAMP`,
      [sizeRange, `Size range ${sizeRange}`]
    );
  }
}

async function activatePieceRates(connection) {
  await connection.execute('UPDATE payroll_piece_rates SET is_active = 0 WHERE is_active <> 0');

  for (const row of matrixRows()) {
    const [existing] = await connection.execute(
      `SELECT id
         FROM payroll_piece_rates
        WHERE COALESCE(sew_type_code, product_type) = ?
          AND COALESCE(size_range, product_category, '') = ?
          AND effective_date = ?
        ORDER BY id DESC
        LIMIT 1`,
      [row.sew_type, row.size_range, EFFECTIVE_DATE]
    );

    if (existing[0]) {
      await connection.execute(
        `UPDATE payroll_piece_rates
            SET product_type = ?, product_category = ?, sew_type_code = ?, size_range = ?,
                piece_rate = ?, effective_date = ?, is_active = 1,
                updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
        [
          row.sew_type,
          row.size_range,
          row.sew_type,
          row.size_range,
          row.piece_rate,
          EFFECTIVE_DATE,
          existing[0].id,
        ]
      );
    } else {
      await connection.execute(
        `INSERT INTO payroll_piece_rates
           (product_type, product_category, sew_type_code, size_range,
            piece_rate, effective_date, is_active)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        [
          row.sew_type,
          row.size_range,
          row.sew_type,
          row.size_range,
          row.piece_rate,
          EFFECTIVE_DATE,
        ]
      );
    }
  }
}

async function activateProductionSplit(connection) {
  await connection.execute('UPDATE payroll_production_split_configs SET is_active = 0 WHERE is_active <> 0');
  const [existing] = await connection.execute(
    `SELECT id
       FROM payroll_production_split_configs
      WHERE split_name = 'SEWING'
      ORDER BY id DESC
      LIMIT 1`
  );
  if (existing[0]) {
    await connection.execute(
      `UPDATE payroll_production_split_configs
          SET sewer_percentage = 55.00, fixer_percentage = 45.00,
              effective_date = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`,
      [EFFECTIVE_DATE, existing[0].id]
    );
    return;
  }
  await connection.execute(
    `INSERT INTO payroll_production_split_configs
       (split_name, sewer_percentage, fixer_percentage, effective_date, is_active)
     VALUES ('SEWING', 55.00, 45.00, ?, 1)`,
    [EFFECTIVE_DATE]
  );
}

async function verifyConfiguration(connection) {
  const [rows] = await connection.execute(
    `SELECT COALESCE(sew_type_code, product_type) AS sew_type,
            COALESCE(size_range, product_category) AS size_range,
            CAST(piece_rate AS CHAR) AS piece_rate,
            DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date
       FROM payroll_piece_rates
      WHERE is_active = 1
      ORDER BY FIELD(COALESCE(sew_type_code, product_type), 'UL', 'HT', 'HL', 'AL', 'DF'),
               FIELD(COALESCE(size_range, product_category), '14-19', '20-23', '24-26', '27-29')`
  );

  const expected = matrixRows();
  assert.equal(rows.length, expected.length, 'Active piece-rate row count does not match the client matrix.');

  for (const expectedRow of expected) {
    const actual = rows.find(row => (
      row.sew_type === expectedRow.sew_type && row.size_range === expectedRow.size_range
    ));
    assert.ok(actual, `Missing ${expectedRow.sew_type} / ${expectedRow.size_range}.`);
    assert.equal(Number(actual.piece_rate).toFixed(4), expectedRow.piece_rate);
    assert.equal(actual.effective_date, EFFECTIVE_DATE);
  }

  const [splits] = await connection.execute(
    `SELECT sewer_percentage, fixer_percentage, DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date
       FROM payroll_production_split_configs
      WHERE is_active = 1`
  );
  assert.equal(splits.length, 1, 'Exactly one production split configuration must be active.');
  assert.equal(Number(splits[0].sewer_percentage), 55);
  assert.equal(Number(splits[0].fixer_percentage), 45);
  assert.equal(splits[0].effective_date, EFFECTIVE_DATE);

  return rows.map(row => ({
    ...row,
    piece_rate: Number(row.piece_rate).toFixed(4),
  }));
}

async function main() {
  assertLocalOnly();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await activateSewTypes(connection);
    await activateSizeRanges(connection);
    await activatePieceRates(connection);
    await activateProductionSplit(connection);
    const rows = await verifyConfiguration(connection);
    await connection.commit();

    console.log(`Local client piece-rate configuration applied effective ${EFFECTIVE_DATE}.`);
    console.table(rows);
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
