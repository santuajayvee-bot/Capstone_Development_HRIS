const mysql = require('mysql2/promise');
require('dotenv').config();

const TARGET_WORKER_IDS = [11, 47];
const W4_START = '2026-06-22';
const W4_CUTOFF = '2026-06-27';

function money(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function addDays(dateText, days) {
  const [year, month, day] = dateText.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

async function main() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'lgsv_hr_db',
    timezone: '+08:00',
  });

  await connection.beginTransaction();
  try {
    const [existing] = await connection.execute(
      `
      SELECT pp.*, DATE_FORMAT(pp.production_date, '%Y-%m-%d') AS local_date
        FROM payroll_production_pairs pp
       WHERE (pp.worker1_employee_id IN (?, ?) OR pp.worker2_employee_id IN (?, ?))
         AND pp.production_date BETWEEN ? AND ?
       ORDER BY pp.production_date, pp.id
      `,
      [TARGET_WORKER_IDS[0], TARGET_WORKER_IDS[1], TARGET_WORKER_IDS[0], TARGET_WORKER_IDS[1], W4_START, W4_CUTOFF]
    );

    if (!existing.length) {
      throw new Error('No W4 source rows found for the target per-piece pair.');
    }

    const dates = [...new Set(existing.map(row => row.local_date))].sort();
    const latestDate = dates[dates.length - 1];
    const templateRows = existing.filter(row => row.local_date === latestDate);
    const created = [];

    for (let date = addDays(latestDate, 1); date <= W4_CUTOFF; date = addDays(date, 1)) {
      const [alreadyHasDate] = await connection.execute(
        `
        SELECT id
          FROM payroll_production_pairs
         WHERE production_date = ?
           AND (
             (worker1_employee_id = ? AND worker2_employee_id = ?)
             OR (worker1_employee_id = ? AND worker2_employee_id = ?)
           )
         LIMIT 1
        `,
        [date, TARGET_WORKER_IDS[0], TARGET_WORKER_IDS[1], TARGET_WORKER_IDS[1], TARGET_WORKER_IDS[0]]
      );
      if (alreadyHasDate.length) continue;

      for (const row of templateRows) {
        let snapshot = {};
        try {
          snapshot = JSON.parse(row.rule_snapshot || '{}');
        } catch (_) {
          snapshot = { raw_snapshot: row.rule_snapshot || null };
        }
        delete snapshot.salary_calculation_id;
        snapshot.source_ready_backfill = {
          reason: 'Fill missing W4 per-piece output through Monday-Saturday cutoff',
          cloned_from_pair_id: row.id,
          cloned_from_date: latestDate,
          target_date: date,
          generated_by: 'scripts/fill-w4-per-piece-cutoff-source.js',
        };

        const productionValue = money(Number(row.quantity_produced || 0) * Number(row.piece_rate || 0));
        const worker1Earnings = money(productionValue * (Number(row.worker1_share || 0) / 100));
        const worker2Earnings = money(productionValue * (Number(row.worker2_share || 0) / 100));
        const [result] = await connection.execute(
          `
          INSERT INTO payroll_production_pairs
            (production_date, payroll_period, worker1_employee_id, worker2_employee_id,
             pairing_type, product_type, product_category, sew_type_code, size_range,
             quantity_produced, piece_rate, production_value, worker1_share, worker2_share,
             worker1_earnings, worker2_earnings, rule_snapshot, status, payroll_run_id,
             approved_by, approved_at, paid_at, updated_by, created_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Payroll Ready', NULL, ?, NOW(), NULL, ?, ?)
          `,
          [
            date,
            row.payroll_period || date.slice(0, 7),
            row.worker1_employee_id,
            row.worker2_employee_id,
            row.pairing_type,
            row.product_type,
            row.product_category,
            row.sew_type_code,
            row.size_range,
            row.quantity_produced,
            row.piece_rate,
            productionValue,
            row.worker1_share,
            row.worker2_share,
            worker1Earnings,
            worker2Earnings,
            JSON.stringify(snapshot),
            row.approved_by || row.created_by || null,
            row.updated_by || row.created_by || null,
            row.created_by || null,
          ]
        );
        created.push({
          id: result.insertId,
          date,
          cloned_from: row.id,
          product_type: row.product_type,
          size_range: row.size_range,
          quantity: row.quantity_produced,
          production_value: productionValue,
          worker1_earnings: worker1Earnings,
          worker2_earnings: worker2Earnings,
        });
      }
    }

    await connection.commit();
    console.log(JSON.stringify({
      latestDate,
      cutoffEnd: W4_CUTOFF,
      templateCount: templateRows.length,
      createdCount: created.length,
      created,
    }, null, 2));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    await connection.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
