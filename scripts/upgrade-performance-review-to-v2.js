'use strict';

// Controlled, one-review upgrade for an ASSIGNED v1 appraisal. This is not for
// finalized reviews. It preserves equivalent v1 ratings as a documented v2
// draft mapping and records an audit event without writing narrative values.
require('dotenv').config();

const pool = require('../config/db');
const { decryptColumnValue, encryptColumnValue } = require('../server/data-protection');
const { resolvePerformanceQuestionnaire } = require('../server/config/performance-questionnaire');

const LEGACY_INDICATOR_MAP = Object.freeze({
  attendance_punctuality: {
    reports_on_time: 'reports_to_schedule', minimal_unexcused_absences: 'maintains_punctuality',
    proper_leave_filing: 'follows_absence_reporting', follows_working_hours: 'follows_attendance_policy',
  },
  work_output_productivity: {
    completes_work_on_time: 'completes_work_on_time', meets_output_requirements: 'meets_output_requirements',
    consistent_performance: 'maintains_productivity', contributes_to_operations: 'manages_workload',
  },
  work_quality_accuracy: {
    minimal_errors: 'minimal_avoidable_errors', follows_procedures: 'follows_quality_procedures',
    accurate_output: 'accurate_acceptable_output', minimal_rework: 'minimal_rework',
  },
  compliance_conduct: {
    follows_company_rules: 'complies_with_policies', proper_workplace_behavior: 'professional_behavior',
    follows_safety_procedures: 'follows_safety_requirements', no_major_conduct_issues: 'acceptable_conduct_record',
  },
  reliability_responsibility: {
    completes_assigned_tasks: 'completes_responsibilities', handles_duties_responsibly: 'accepts_accountability',
    dependable_during_shifts: 'dependable_during_work', responds_to_instructions: 'responds_to_follow_up',
  },
});

function reviewIdFromArgs() {
  const flagIndex = process.argv.indexOf('--review-id');
  const candidate = flagIndex >= 0 ? process.argv[flagIndex + 1] : null;
  const reviewId = Number.parseInt(candidate, 10);
  if (!Number.isSafeInteger(reviewId) || reviewId <= 0) throw new Error('Use: node scripts/upgrade-performance-review-to-v2.js --review-id <assigned-v1-review-id>');
  return reviewId;
}

function decryptObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(decryptColumnValue(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function emptyRatings(questionnaire) {
  return Object.fromEntries(questionnaire.criteria.map(criterion => [
    criterion.key,
    Object.fromEntries(criterion.indicators.map(indicator => [indicator.key, null])),
  ]));
}

function mappedV2Ratings(legacy, questionnaire) {
  const ratings = emptyRatings(questionnaire);
  let mappedCount = 0;
  for (const [legacyCriterion, indicators] of Object.entries(LEGACY_INDICATOR_MAP)) {
    for (const [legacyIndicator, v2Indicator] of Object.entries(indicators)) {
      const value = legacy?.[legacyCriterion]?.[legacyIndicator];
      const targetCriterion = questionnaire.criteria.find(criterion => criterion.indicators.some(indicator => indicator.key === v2Indicator));
      if (targetCriterion && Number.isInteger(value) && value >= 1 && value <= 4) {
        ratings[targetCriterion.key][v2Indicator] = value;
        mappedCount += 1;
      }
    }
  }
  return { ratings, mappedCount };
}

async function insertAudit(connection, row, action, details) {
  await connection.execute(
    `INSERT INTO system_audit_log
       (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp)
     VALUES (?, NULL, ?, ?, 'PERFORMANCE', NULL, ?, 'system-migration', 'upgrade-performance-review-to-v2', NOW())`,
    [row.updated_by || row.reviewer_user_id, row.employee_id, action, JSON.stringify(details)]
  );
}

async function run() {
  const reviewId = reviewIdFromArgs();
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      `SELECT pr.*, pc.competency_weight, pc.goal_weight, e.position, e.employee_level,
              d.name AS department_name, wt.name AS wage_type
         FROM performance_reviews pr
         JOIN performance_cycles pc ON pc.id = pr.cycle_id
         JOIN employees e ON e.Employee_ID = pr.employee_id
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
        WHERE pr.id = ? FOR UPDATE`,
      [reviewId]
    );
    const row = rows[0];
    if (!row) throw new Error(`Performance review #${reviewId} was not found.`);
    if (row.status !== 'ASSIGNED') throw new Error('Only an ASSIGNED review can be upgraded to v2. Finalized reviews are immutable.');
    if (String(row.questionnaire_version || 'v1').toLowerCase() !== 'v1') throw new Error('This review is already using v2.');

    const questionnaire = resolvePerformanceQuestionnaire({
      employee: {
        department_name: row.department_name,
        position: decryptColumnValue(row.position) || row.position,
        employee_level: decryptColumnValue(row.employee_level) || row.employee_level,
        wage_type: row.wage_type,
      },
      cycle: { questionnaire_version: 'v2', competency_weight: row.competency_weight, goal_weight: row.goal_weight },
    });
    const { ratings, mappedCount } = mappedV2Ratings(decryptObject(row.indicator_ratings_encrypted), questionnaire);
    await connection.execute(
      `UPDATE performance_reviews
          SET questionnaire_version='v2', questionnaire_snapshot_encrypted=?, indicator_ratings_encrypted=?,
              criteria_evidence_encrypted=NULL, criteria_remarks_encrypted=NULL,
              competency_score=NULL, goal_score=NULL, final_score=NULL, scoring_snapshot_encrypted=NULL,
              integrity_hash=NULL, finalized_at=NULL, version=version+1, updated_by=?
        WHERE id=?`,
      [encryptColumnValue(JSON.stringify(questionnaire)), encryptColumnValue(JSON.stringify(ratings)), row.updated_by || row.reviewer_user_id, reviewId]
    );
    const details = {
      review_id: reviewId, from_questionnaire_version: 'v1', to_questionnaire_version: 'v2',
      mapped_legacy_ratings: mappedCount, preserved_goals: Boolean(row.goals_encrypted),
      role_section: questionnaire.classification?.role_section || null,
      leadership: Boolean(questionnaire.classification?.supervisory_responsibility),
      reason: 'Owner-approved upgrade of assigned review',
    };
    await insertAudit(connection, row, 'MIGRATE_PERFORMANCE_REVIEW_TO_V2', details);
    await insertAudit(connection, row, 'PERFORMANCE_QUESTIONNAIRE_VERSION_SELECTED', { review_id: reviewId, questionnaire_version: 'v2', source: 'controlled_v1_upgrade' });
    await connection.commit();
    console.log(JSON.stringify({ review_id: reviewId, questionnaire_version: 'v2', mapped_legacy_ratings: mappedCount, criteria: questionnaire.criteria.length, indicators: questionnaire.criteria.reduce((total, item) => total + item.indicators.length, 0), role_section: questionnaire.classification?.role_section || null }));
  } catch (error) {
    await connection.rollback().catch(() => {});
    throw error;
  } finally {
    connection.release();
  }
}

run()
  .catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => pool.end());
