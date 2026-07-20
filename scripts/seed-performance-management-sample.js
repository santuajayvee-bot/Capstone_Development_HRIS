'use strict';

require('dotenv').config();

const pool = require('../config/db');
const { encryptColumnValue } = require('../server/data-protection');
const {
  calculateEvaluationScore,
  calculateIntegrityHash,
  PERFORMANCE_CRITERIA,
} = require('../server/performance-management');

const ACTIVE_CYCLE = {
  name: '2026 Midyear Performance Review',
  start: '2026-01-01',
  end: '2026-06-30',
  due: '2026-07-31',
  status: 'ACTIVE',
  description: 'Midyear employee performance and development review.',
};

const CLOSED_CYCLE = {
  name: '2025 Annual Performance Review',
  start: '2025-01-01',
  end: '2025-12-31',
  due: '2026-01-31',
  status: 'CLOSED',
  description: 'Completed annual employee performance review.',
};

function encrypted(value) {
  return value ? encryptColumnValue(value) : null;
}

function encryptedGoals(index, department) {
  const departmentLabel = department || 'assigned department';
  return encrypted(JSON.stringify([
    {
      title: 'Improve output consistency',
      target: `Meet the approved quality and productivity standard for ${departmentLabel}.`,
    },
    {
      title: 'Strengthen attendance reliability',
      target: 'Maintain complete attendance records and minimize avoidable tardiness.',
    },
    {
      title: index % 2 === 0 ? 'Support team coordination' : 'Complete skills development',
      target: index % 2 === 0
        ? 'Participate in weekly coordination and complete assigned handoffs on time.'
        : 'Complete one role-related coaching or training activity before the next review.',
    },
  ]));
}

function reviewTemplate(status, index, department) {
  const sampleCriterionProfiles = {
    2: [4, 4, 4, 3, 4],
    3: [3, 3, 3, 3, 3],
    6: [2, 2, 2, 3, 2],
    7: [1, 1, 2, 1, 1],
    10: [4, 3, 4, 3, 3],
    11: [4, 4, 4, 4, 4],
    12: [3, 3, 3, 3, 3],
    13: [2, 2, 2, 2, 2],
  };
  const criterionRatings = sampleCriterionProfiles[index] || [3, 3, 3, 3, 3];
  const indicatorRatings = Object.fromEntries(PERFORMANCE_CRITERIA.map((criterion, criterionIndex) => [
    criterion.key,
    Object.fromEntries(criterion.indicators.map((indicator, indicatorIndex) => [
      indicator.key,
      Math.max(1, Math.min(4, criterionRatings[criterionIndex] - (indicatorIndex === 3 && index % 2 ? 1 : 0))),
    ])),
  ]));
  const hasEvaluation = status === 'FINALIZED';
  const finalScore = hasEvaluation ? calculateEvaluationScore(indicatorRatings).overall_score.toFixed(2) : null;

  return {
    status,
    indicatorRatings,
    indicatorRatingsEncrypted: encrypted(JSON.stringify(indicatorRatings)),
    finalScore,
    goals: encryptedGoals(index, department),
    feedback: encrypted('Official HR remarks: performance was assessed using documented attendance, productivity, work quality, conduct, and reliability records.'),
    developmentPlan: encrypted('HR recommendation: continue role-focused coaching, review progress monthly, and document agreed improvement actions for the next cycle.'),
  };
}

async function ensureCycle(connection, cycle, reviewerId) {
  const [existing] = await connection.execute(
    'SELECT id FROM performance_cycles WHERE cycle_name = ? ORDER BY id ASC LIMIT 1',
    [cycle.name]
  );
  if (existing.length) return { id: existing[0].id, created: false };

  const [result] = await connection.execute(
    `INSERT INTO performance_cycles
       (cycle_name, review_period_start, review_period_end, due_date, status,
        description_encrypted, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [cycle.name, cycle.start, cycle.end, cycle.due, cycle.status, encrypted(cycle.description), reviewerId, reviewerId]
  );
  return { id: result.insertId, created: true };
}

async function insertReview(connection, { cycleId, employee, reviewerId, status, index, refreshScores = false }) {
  const template = reviewTemplate(status, index, employee.department_name);
  const [existing] = await connection.execute(
    'SELECT id, status FROM performance_reviews WHERE cycle_id = ? AND employee_id = ? LIMIT 1',
    [cycleId, employee.Employee_ID]
  );
  if (existing.length) {
    if (refreshScores) {
      const [rows] = await connection.execute('SELECT * FROM performance_reviews WHERE id = ? LIMIT 1', [existing[0].id]);
      const refreshed = { ...rows[0] };
      const ratingTemplate = reviewTemplate(existing[0].status, index, employee.department_name);
      refreshed.indicator_ratings_encrypted = ratingTemplate.indicatorRatingsEncrypted;
      refreshed.reviewer_feedback_encrypted = ratingTemplate.feedback;
      refreshed.development_plan_encrypted = ratingTemplate.developmentPlan;
      refreshed.final_score = ratingTemplate.finalScore;
      const integrityHash = existing[0].status === 'FINALIZED' ? calculateIntegrityHash(refreshed) : null;
      await connection.execute(
        `UPDATE performance_reviews
            SET indicator_ratings_encrypted=?, reviewer_feedback_encrypted=?,
                development_plan_encrypted=?, final_score=?, integrity_hash=?
          WHERE id=?`,
        [ratingTemplate.indicatorRatingsEncrypted, ratingTemplate.feedback, ratingTemplate.developmentPlan, ratingTemplate.finalScore, integrityHash, existing[0].id]
      );
    }
    return { id: existing[0].id, status: existing[0].status, created: false };
  }

  const finalizedAt = status === 'FINALIZED'
    ? new Date('2026-07-12T14:00:00+08:00')
    : null;

  const [result] = await connection.execute(
    `INSERT INTO performance_reviews
       (cycle_id, employee_id, reviewer_user_id, status,
        indicator_ratings_encrypted, final_score, goals_encrypted, reviewer_feedback_encrypted,
        development_plan_encrypted, finalized_at, version, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      cycleId,
      employee.Employee_ID,
      reviewerId,
      status,
      template.indicatorRatingsEncrypted,
      template.finalScore,
      template.goals,
      template.feedback,
      template.developmentPlan,
      finalizedAt,
      reviewerId,
      reviewerId,
    ]
  );

  if (status === 'FINALIZED') {
    const [rows] = await connection.execute('SELECT * FROM performance_reviews WHERE id = ? LIMIT 1', [result.insertId]);
    await connection.execute(
      'UPDATE performance_reviews SET integrity_hash = ? WHERE id = ?',
      [calculateIntegrityHash(rows[0]), result.insertId]
    );
  }

  return { id: result.insertId, status, created: true };
}

async function main() {
  const refreshScores = process.argv.includes('--refresh-scores');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [reviewers] = await connection.execute(
      `SELECT u.id, u.username
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE r.name = 'hr_manager' AND u.is_active = 1
        ORDER BY u.id ASC
        LIMIT 1`
    );
    if (!reviewers.length) throw new Error('No active HR Manager reviewer account was found.');
    const reviewer = reviewers[0];

    const [employees] = await connection.execute(
      `SELECT e.Employee_ID, e.employee_code, d.name AS department_name
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
        WHERE LOWER(COALESCE(e.status, 'active')) = 'active'
          AND e.Employee_ID IS NOT NULL
          AND e.employee_code REGEXP '^EMP[0-9]'
          AND COALESCE(d.name, '') NOT LIKE 'TEST%'
        ORDER BY e.id ASC
        LIMIT 8`
    );
    if (employees.length < 4) throw new Error('At least four active regular employees are required for the sample.');

    const activeCycle = await ensureCycle(connection, ACTIVE_CYCLE, reviewer.id);
    const closedCycle = await ensureCycle(connection, CLOSED_CYCLE, reviewer.id);
    const activeStatuses = ['ASSIGNED', 'ASSIGNED', 'FINALIZED', 'FINALIZED', 'ASSIGNED', 'ASSIGNED', 'FINALIZED', 'FINALIZED'];
    const createdReviews = [];

    for (let index = 0; index < employees.length; index += 1) {
      createdReviews.push(await insertReview(connection, {
        cycleId: activeCycle.id,
        employee: employees[index],
        reviewerId: reviewer.id,
        status: activeStatuses[index],
        index,
        refreshScores,
      }));
    }

    for (let index = 0; index < Math.min(employees.length, 4); index += 1) {
      createdReviews.push(await insertReview(connection, {
        cycleId: closedCycle.id,
        employee: employees[index],
        reviewerId: reviewer.id,
        status: 'FINALIZED',
        index: index + 10,
        refreshScores,
      }));
    }

    const createdCount = createdReviews.filter(review => review.created).length;
    if (activeCycle.created || closedCycle.created || createdCount > 0) {
      await connection.execute(
        `INSERT INTO system_audit_log
           (user_id, employee_id, action_performed, module, new_value, ip_address, user_agent, timestamp)
         VALUES (?, NULL, 'SEED_PERFORMANCE_SAMPLE_DATA', 'PERFORMANCE', ?, 'local-seed', 'seed-performance-management-sample.js', NOW())`,
        [reviewer.id, JSON.stringify({ active_cycle_id: activeCycle.id, closed_cycle_id: closedCycle.id, created_reviews: createdCount })]
      );
    }

    await connection.commit();
    console.log(JSON.stringify({
      reviewer: reviewer.username,
      cycles: [
        { id: activeCycle.id, name: ACTIVE_CYCLE.name, created: activeCycle.created },
        { id: closedCycle.id, name: CLOSED_CYCLE.name, created: closedCycle.created },
      ],
      selected_employees: employees.map(employee => employee.employee_code),
      created_reviews: createdCount,
      existing_reviews_preserved: createdReviews.length - createdCount,
      sample_scores_refreshed: refreshScores,
    }, null, 2));
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(`[performance-seed] ${error.message}`);
  process.exitCode = 1;
});
