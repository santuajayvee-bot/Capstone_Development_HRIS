const crypto = require('crypto');
const express = require('express');

const pool = require('../config/db');
const { verifyPassword } = require('../services/passwordService');
const { requireAuth } = require('./middleware');
const { decryptColumnValue, encryptColumnValue } = require('./data-protection');
const { auditSecurityEvent } = require('./security-controls');
const {
  PERFORMANCE_V1_CRITERIA: PERFORMANCE_CRITERIA,
  PERFORMANCE_RATING_SCALE,
  resolvePerformanceQuestionnaire,
  validatePerformanceQuestionnaire,
} = require('./config/performance-questionnaire');

const router = express.Router();
const REVIEW_STATUSES = new Set(['ASSIGNED', 'FINALIZED']);
const CYCLE_STATUSES = new Set(['DRAFT', 'ACTIVE', 'CLOSED']);
class PerformanceError extends Error {
  constructor(message, statusCode = 400, code = 'PERFORMANCE_REQUEST_INVALID') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

function performanceStepUpFailure() {
  // A failed current-password proof blocks only this protected operation. It
  // is not proof that the primary JWT session is invalid, so it must not use
  // the 401 status that apiFetch correctly handles by clearing authentication.
  return new PerformanceError('Current password verification failed.', 403, 'PERFORMANCE_STEP_UP_FAILED');
}

function cleanText(value, maxLength, field, { required = false } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw new PerformanceError(`${field} is required.`);
  if (text.length > maxLength) throw new PerformanceError(`${field} is too long.`);
  return text;
}

function positiveId(value, field = 'ID') {
  const id = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(id) || id <= 0) throw new PerformanceError(`${field} is invalid.`);
  return id;
}

function dateOnly(value, field) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new PerformanceError(`${field} must be a valid date.`);
  }
  return text;
}

function sourceRole(req) {
  return String(req.user?.sourceRole || '').trim().toLowerCase();
}

function isPerformanceManager(req) {
  return sourceRole(req) === 'hr_manager';
}

function isRegularEmployee(req) {
  return sourceRole(req) === 'employee';
}

function denyPerformanceAccess(req, res, requiredRole) {
  auditSecurityEvent(req, {
    action: 'blocked_unauthorized_performance_access',
    module: 'PERFORMANCE_SECURITY',
    targetTable: req.originalUrl || null,
    newValue: { required_role: requiredRole, actual_role: sourceRole(req) || 'unknown' },
    result: 'blocked',
  }).catch(() => {});
  return res.status(403).json({ error: 'Access denied.' });
}

function requirePerformanceAccess(req, res, next) {
  if (isPerformanceManager(req) || isRegularEmployee(req)) return next();
  return denyPerformanceAccess(req, res, 'hr_manager or employee');
}

function requirePerformanceManager(req, res, next) {
  if (isPerformanceManager(req)) return next();
  return denyPerformanceAccess(req, res, 'hr_manager');
}

function currentEmployeeReference(req) {
  return Number(req.user?.Employee_ID || req.user?.employeeId || 0);
}

function requestIp(req) {
  return req.headers?.['x-forwarded-for']?.split(',')[0]?.trim()
    || req.socket?.remoteAddress
    || req.ip
    || 'unknown';
}

function safeDecrypt(value) {
  if (!value) return '';
  try {
    return decryptColumnValue(value) || '';
  } catch (_error) {
    return '[Protected value unavailable]';
  }
}

function encryptedOptional(value, maxLength, field) {
  const text = cleanText(value, maxLength, field);
  return text ? encryptColumnValue(text) : null;
}

function employeeDisplayName(row) {
  return [row.first_name, row.middle_name, row.last_name, row.suffix]
    .map(safeDecrypt)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim() || `Employee ${row.employee_code || row.employee_id}`;
}

function parseIndicatorRating(value, field) {
  if (value === null || value === undefined || value === '') return null;
  if (String(value).trim().toUpperCase() === 'NA') return 'NA';
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
    throw new PerformanceError(`${field} must be a whole-number rating from 1 to 4 or N/A.`);
  }
  return rating;
}

function questionnaireCriteria(questionnaire) {
  return Array.isArray(questionnaire?.criteria) ? questionnaire.criteria : PERFORMANCE_CRITERIA;
}

function parseIndicatorRatings(value, questionnaire = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PerformanceError('Indicator ratings must be provided as an object.');
  }
  const criteria = questionnaireCriteria(questionnaire);
  const allowedCriteria = new Set(criteria.map(criterion => criterion.key));
  if (Object.keys(value).some(key => !allowedCriteria.has(key))) {
    throw new PerformanceError('Indicator ratings contain unsupported criteria.', 403, 'PERFORMANCE_PARAMETER_TAMPERING');
  }
  return Object.fromEntries(criteria.map(criterion => {
    const source = value[criterion.key] || {};
    if (typeof source !== 'object' || Array.isArray(source)) {
      throw new PerformanceError(`${criterion.label} ratings are invalid.`);
    }
    const allowedIndicators = new Set(criterion.indicators.map(indicator => indicator.key));
    if (Object.keys(source).some(key => !allowedIndicators.has(key))) {
      throw new PerformanceError(`${criterion.label} contains unsupported indicators.`, 403, 'PERFORMANCE_PARAMETER_TAMPERING');
    }
    return [criterion.key, Object.fromEntries(criterion.indicators.map(indicator => [
      indicator.key,
      parseIndicatorRating(source[indicator.key], `${criterion.label}: ${indicator.text}`),
    ]))];
  }));
}

function parseCriterionTextMap(value, questionnaire, field, maxLength) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new PerformanceError(`${field} must be an object.`);
  const criteria = questionnaireCriteria(questionnaire);
  const allowed = new Set(criteria.map(criterion => criterion.key));
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new PerformanceError(`${field} contains unsupported criteria.`, 403, 'PERFORMANCE_PARAMETER_TAMPERING');
  }
  return Object.fromEntries(criteria.map(criterion => [
    criterion.key,
    cleanText(value[criterion.key], maxLength, `${criterion.label} ${field}`),
  ]).filter(([, text]) => text));
}

function parseNaReasons(value, ratings, questionnaire) {
  if (value === undefined || value === null || value === '') value = {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new PerformanceError('N/A reasons must be an object.');
  const criteria = questionnaireCriteria(questionnaire);
  const allowedCriteria = new Set(criteria.map(criterion => criterion.key));
  if (Object.keys(value).some(key => !allowedCriteria.has(key))) {
    throw new PerformanceError('N/A reasons contain unsupported criteria.', 403, 'PERFORMANCE_PARAMETER_TAMPERING');
  }
  const result = {};
  for (const criterion of criteria) {
    const source = value[criterion.key] || {};
    if (typeof source !== 'object' || Array.isArray(source)) throw new PerformanceError(`${criterion.label} N/A reasons are invalid.`);
    const indicatorKeys = new Set(criterion.indicators.map(indicator => indicator.key));
    if (Object.keys(source).some(key => !indicatorKeys.has(key))) {
      throw new PerformanceError(`${criterion.label} N/A reasons contain unsupported indicators.`, 403, 'PERFORMANCE_PARAMETER_TAMPERING');
    }
    for (const question of criterion.indicators) {
      const rating = ratings?.[criterion.key]?.[question.key];
      const reason = cleanText(source[question.key], 500, `${criterion.label}: ${question.text} N/A reason`);
      if (rating === 'NA' && !reason) throw new PerformanceError(`An N/A reason is required for ${criterion.label}: ${question.text}.`);
      if (reason && rating !== 'NA') throw new PerformanceError(`N/A reason is not allowed unless ${criterion.label}: ${question.text} is N/A.`, 403, 'PERFORMANCE_PARAMETER_TAMPERING');
      if (reason) {
        result[criterion.key] ||= {};
        result[criterion.key][question.key] = reason;
      }
    }
  }
  return result;
}

function decryptJson(value, fallback = {}) {
  const plaintext = safeDecrypt(value);
  if (!plaintext || plaintext.startsWith('[Protected')) return fallback;
  try {
    return JSON.parse(plaintext);
  } catch (_error) {
    return fallback;
  }
}

function decryptIndicatorRatings(value, questionnaire = null) {
  try {
    return parseIndicatorRatings(decryptJson(value, {}), questionnaire);
  } catch (_error) {
    return {};
  }
}

function calculateEvaluationScore(ratings, questionnaire = null) {
  const criteria = questionnaireCriteria(questionnaire);
  const applicability = questionnaire?.applicability || { minimum_numeric_coverage: 1, minimum_numeric_ratings_per_criterion: 4 };
  const criteriaAverages = {};
  let complete = true;
  let totalIndicators = 0;
  let numericIndicators = 0;
  let naIndicators = 0;
  let weightedScore = 0;
  for (const criterion of criteria) {
    const values = criterion.indicators.map(indicator => ratings?.[criterion.key]?.[indicator.key]);
    const numeric = values.filter(value => Number.isInteger(value) && value >= 1 && value <= 4);
    totalIndicators += values.length;
    numericIndicators += numeric.length;
    naIndicators += values.filter(value => value === 'NA').length;
    if (numeric.length < Number(applicability.minimum_numeric_ratings_per_criterion || 1)) {
      criteriaAverages[criterion.key] = null;
      complete = false;
      continue;
    }
    const average = Number((numeric.reduce((sum, value) => sum + value, 0) / numeric.length).toFixed(2));
    criteriaAverages[criterion.key] = average;
    const criterionWeight = Number.isFinite(Number(criterion.weight)) ? Number(criterion.weight) : (100 / criteria.length);
    weightedScore += average * (criterionWeight / 100);
  }
  const coverage = totalIndicators ? numericIndicators / totalIndicators : 0;
  if (coverage < Number(applicability.minimum_numeric_coverage || 1)) complete = false;
  const overall = complete ? Number(weightedScore.toFixed(2)) : null;
  return { criteria_averages: criteriaAverages, overall_score: overall, complete, total_indicators: totalIndicators, numeric_indicators: numericIndicators, na_indicators: naIndicators, numeric_coverage: Number(coverage.toFixed(4)) };
}

function reassessmentDate(finalizedAt, days) {
  if (!finalizedAt || !days) return null;
  const date = new Date(finalizedAt);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function performanceOutcome(score, finalizedAt = null) {
  if (score === null || score === undefined || score === '') {
    return {
      code: 'PENDING', label: 'Pending Evaluation', classification: 'PENDING',
      notice: 'The final performance outcome will appear after HR finalization.',
      passed: null, requires_reassessment: false, reassessment_due_date: null,
      improvement_plan_required: false, hr_case_review_required: false,
    };
  }
  const value = Number(score);
  if (!Number.isFinite(value)) {
    return {
      code: 'PENDING', label: 'Pending Evaluation', classification: 'PENDING',
      notice: 'The final performance outcome will appear after HR finalization.',
      passed: null, requires_reassessment: false, reassessment_due_date: null,
      improvement_plan_required: false, hr_case_review_required: false,
    };
  }

  let policy;
  if (value >= 3.5) {
    policy = ['EXCELLENT', 'Excellent', 'PASSED', 'Performance consistently exceeds the expected standards. HR may consider recognition and development opportunities.', 0, false, false];
  } else if (value >= 2.5) {
    policy = ['SATISFACTORY', 'Satisfactory', 'PASSED', 'Performance meets the expected standards. Continue regular coaching and the next scheduled evaluation.', 0, false, false];
  } else if (value >= 1.5) {
    policy = ['NEEDS_IMPROVEMENT', 'Needs Improvement', 'REASSESSMENT', 'A documented performance improvement plan and follow-up assessment within 60 days are required.', 60, true, false];
  } else {
    policy = ['UNSATISFACTORY', 'Unsatisfactory', 'HR_CASE_REVIEW', 'A formal improvement plan, reassessment within 30 days, and HR case review are required. This rating does not automatically terminate employment.', 30, true, true];
  }

  return {
    code: policy[0],
    label: policy[1],
    classification: policy[2],
    notice: policy[3],
    passed: value >= 2.5,
    requires_reassessment: policy[4] > 0,
    reassessment_due_date: reassessmentDate(finalizedAt, policy[4]),
    improvement_plan_required: policy[5],
    hr_case_review_required: policy[6],
  };
}

const GOAL_STATUSES = new Set(['NOT_STARTED', 'IN_PROGRESS', 'PARTIALLY_ACHIEVED', 'ACHIEVED', 'EXCEEDED', 'NOT_APPLICABLE']);
const GOAL_DIRECTIONS = new Set(['HIGHER_IS_BETTER', 'LOWER_IS_BETTER', 'BINARY', 'MANUAL']);
const GOAL_MEASUREMENT_TYPES = new Set(['COUNT', 'PERCENTAGE', 'CURRENCY', 'HOURS', 'DAYS', 'BINARY', 'MANUAL', 'OTHER']);

function decimalText(value, field, { required = false } = {}) {
  const text = cleanText(value, 40, field, { required });
  if (!text) return null;
  if (!/^-?\d+(?:\.\d{1,4})?$/.test(text)) throw new PerformanceError(`${field} must be a valid number.`);
  return text;
}

function parseScoreWeights(competencyWeight = 70, goalWeight = 30) {
  const competency = Number(competencyWeight);
  const goals = Number(goalWeight);
  if (!Number.isFinite(competency) || !Number.isFinite(goals) || competency < 0 || goals < 0 || competency > 100 || goals > 100 || Math.abs((competency + goals) - 100) > 0.001) {
    throw new PerformanceError('Competency and goal weights must be valid and total 100.');
  }
  return { competency_weight: Number(competency.toFixed(2)), goal_weight: Number(goals.toFixed(2)) };
}

function parseGoals(value, { version = 'v1', goalWeight = 0, finalization = false } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (!Array.isArray(value)) throw new PerformanceError('Goals must be a list.');
  if (value.length > 8) throw new PerformanceError('A review can contain at most 8 goals.');
  if (version === 'v2' && finalization && Number(goalWeight) > 0 && !value.length) {
    throw new PerformanceError('At least one measurable goal is required for this review.');
  }
  const goals = value.map((goal, index) => {
    if (version === 'v1') return {
      title: cleanText(goal?.title, 160, `Goal ${index + 1} title`, { required: true }),
      target: cleanText(goal?.target, 500, `Goal ${index + 1} target`, { required: true }),
    };
    const allowedFields = new Set(['title', 'target', 'target_unit', 'measurement_type', 'measurement_direction', 'target_value', 'actual_value', 'achievement_percentage', 'status', 'rating', 'weight', 'evidence', 'na_reason', 'evaluator_confirmed']);
    if (!goal || typeof goal !== 'object' || Array.isArray(goal) || Object.keys(goal).some(key => !allowedFields.has(key))) {
      throw new PerformanceError(`Goal ${index + 1} contains unsupported fields.`, 403, 'PERFORMANCE_PARAMETER_TAMPERING');
    }
    const measurementType = String(goal?.measurement_type || 'MANUAL').trim().toUpperCase();
    const direction = String(goal?.measurement_direction || 'MANUAL').trim().toUpperCase();
    const status = String(goal?.status || 'NOT_STARTED').trim().toUpperCase();
    if (!GOAL_MEASUREMENT_TYPES.has(measurementType) || !GOAL_DIRECTIONS.has(direction) || !GOAL_STATUSES.has(status)) {
      throw new PerformanceError(`Goal ${index + 1} has an invalid measurement or status.`);
    }
    const rating = parseIndicatorRating(goal?.rating, `Goal ${index + 1} rating`);
    const weight = Number(goal?.weight);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) throw new PerformanceError(`Goal ${index + 1} weight must be greater than 0 and no more than 100.`);
    const naReason = cleanText(goal?.na_reason, 500, `Goal ${index + 1} N/A reason`);
    if (status === 'NOT_APPLICABLE' || rating === 'NA') {
      if (!naReason) throw new PerformanceError(`Goal ${index + 1} requires an N/A reason.`);
    } else if (naReason) {
      throw new PerformanceError(`Goal ${index + 1} N/A reason is only allowed for Not Applicable goals.`, 403, 'PERFORMANCE_PARAMETER_TAMPERING');
    }
    const targetValue = decimalText(goal?.target_value, `Goal ${index + 1} target value`);
    const actualValue = decimalText(goal?.actual_value, `Goal ${index + 1} actual value`);
    const percentage = goal?.achievement_percentage === '' || goal?.achievement_percentage === null || goal?.achievement_percentage === undefined
      ? null : Number(goal.achievement_percentage);
    if (percentage !== null && (!Number.isFinite(percentage) || percentage < 0 || percentage > 1000)) throw new PerformanceError(`Goal ${index + 1} achievement percentage is invalid.`);
    const measured = targetValue !== null && actualValue !== null && direction !== 'MANUAL';
    if (finalization && measured && !Boolean(goal?.evaluator_confirmed)) throw new PerformanceError(`Goal ${index + 1} numeric result must be confirmed by the evaluator.`);
    return {
      title: cleanText(goal?.title, 160, `Goal ${index + 1} title`, { required: true }),
      target: cleanText(goal?.target, 500, `Goal ${index + 1} measurable target`, { required: true }),
      target_unit: cleanText(goal?.target_unit, 80, `Goal ${index + 1} target unit`),
      measurement_type: measurementType, measurement_direction: direction,
      target_value: targetValue, actual_value: actualValue,
      achievement_percentage: percentage === null ? null : Number(percentage.toFixed(2)),
      status, rating, weight: Number(weight.toFixed(2)),
      evidence: cleanText(goal?.evidence, 2000, `Goal ${index + 1} evidence`),
      na_reason: naReason || null, evaluator_confirmed: Boolean(goal?.evaluator_confirmed),
    };
  });
  if (version === 'v2' && goals.length) {
    const totalWeight = goals.reduce((sum, goal) => sum + Number(goal.weight || 0), 0);
    if (Math.abs(totalWeight - 100) > 0.01) throw new PerformanceError('Goal weights must total 100.');
  }
  return goals.length ? encryptColumnValue(JSON.stringify(goals)) : null;
}

function decryptGoals(value) {
  const plaintext = safeDecrypt(value);
  if (!plaintext || plaintext.startsWith('[Protected')) return [];
  try {
    const goals = JSON.parse(plaintext);
    return Array.isArray(goals) ? goals : [];
  } catch (_error) {
    return [];
  }
}

function suggestedGoalAchievement(goal) {
  const target = Number(goal?.target_value);
  const actual = Number(goal?.actual_value);
  if (!Number.isFinite(target) || !Number.isFinite(actual) || target <= 0) return null;
  if (goal.measurement_direction === 'HIGHER_IS_BETTER') return Number(((actual / target) * 100).toFixed(2));
  if (goal.measurement_direction === 'LOWER_IS_BETTER') return actual <= 0 ? null : Number(((target / actual) * 100).toFixed(2));
  return null;
}

function calculateGoalScore(goals, goalWeight = 0) {
  if (Number(goalWeight) === 0) return { score: null, complete: true, applicable_weight: 0, rated_goals: 0 };
  if (!Array.isArray(goals) || !goals.length) return { score: null, complete: false, applicable_weight: 0, rated_goals: 0 };
  const applicable = goals.filter(goal => goal.rating !== 'NA' && goal.status !== 'NOT_APPLICABLE');
  if (!applicable.length) return { score: null, complete: false, applicable_weight: 0, rated_goals: 0 };
  if (applicable.some(goal => !Number.isInteger(goal.rating) || goal.rating < 1 || goal.rating > 4)) return { score: null, complete: false, applicable_weight: 0, rated_goals: 0 };
  const applicableWeight = applicable.reduce((sum, goal) => sum + Number(goal.weight || 0), 0);
  if (applicableWeight <= 0) return { score: null, complete: false, applicable_weight: 0, rated_goals: 0 };
  const score = applicable.reduce((sum, goal) => sum + (Number(goal.rating) * Number(goal.weight || 0)), 0) / applicableWeight;
  return { score: Number(score.toFixed(2)), complete: true, applicable_weight: Number(applicableWeight.toFixed(2)), rated_goals: applicable.length };
}

function validateGoalsForFinalization(goals, goalWeight = 0) {
  if (Number(goalWeight) === 0) return;
  if (!Array.isArray(goals) || !goals.length) throw new PerformanceError('At least one measurable goal is required for this review.');
  for (const [index, goal] of goals.entries()) {
    const measured = goal?.target_value !== null && goal?.target_value !== undefined && goal?.target_value !== ''
      && goal?.actual_value !== null && goal?.actual_value !== undefined && goal?.actual_value !== ''
      && goal?.measurement_direction !== 'MANUAL';
    if (measured && !goal.evaluator_confirmed) throw new PerformanceError(`Goal ${index + 1} numeric result must be confirmed by the evaluator.`);
    if ((goal.status === 'NOT_APPLICABLE' || goal.rating === 'NA') && !String(goal.na_reason || '').trim()) {
      throw new PerformanceError(`Goal ${index + 1} requires an N/A reason.`);
    }
  }
}

function rejectUnexpectedFields(req, allowed) {
  const unexpected = Object.keys(req.body || {}).filter(field => !allowed.has(field));
  if (!unexpected.length) return;
  auditSecurityEvent(req, {
    action: 'blocked_performance_parameter_tampering',
    module: 'PERFORMANCE_SECURITY',
    targetTable: 'performance_reviews',
    newValue: { fields: unexpected, path: req.originalUrl },
    result: 'blocked',
  }).catch(() => {});
  throw new PerformanceError('Request contains unsupported fields.', 403, 'PERFORMANCE_PARAMETER_TAMPERING');
}

async function audit(executor, req, action, reviewId = null, targetEmployeeId = null, details = {}) {
  await executor.execute(
    `INSERT INTO system_audit_log
       (user_id, employee_id, target_employee_id, action_performed, module, old_value, new_value, ip_address, user_agent, timestamp)
     VALUES (?, ?, ?, ?, 'PERFORMANCE', NULL, ?, ?, ?, NOW())`,
    [
      req.user?.id || 0,
      req.user?.employeeId || null,
      targetEmployeeId || null,
      action,
      JSON.stringify({ review_id: reviewId, ...details }),
      requestIp(req),
      String(req.headers?.['user-agent'] || 'unknown').slice(0, 500),
    ]
  );
}

async function verifyStepUpPassword(req) {
  const password = String(req.body?.currentPassword || '');
  if (!password) return false;
  const [rows] = await pool.execute('SELECT password_hash FROM users WHERE id = ? AND is_active = 1 LIMIT 1', [req.user.id]);
  return rows.length ? verifyPassword(rows[0].password_hash, password) : false;
}

function encryptedJson(value) {
  return value && Object.keys(value).length ? encryptColumnValue(JSON.stringify(value)) : null;
}

function reviewQuestionnaire(row) {
  if (String(row.questionnaire_version || 'v1').toLowerCase() !== 'v2') {
    return resolvePerformanceQuestionnaire({ cycle: { questionnaire_version: 'v1' } });
  }
  const snapshot = decryptJson(row.questionnaire_snapshot_encrypted, null);
  try {
    validatePerformanceQuestionnaire(snapshot);
  } catch (_error) {
    throw new PerformanceError('The assigned questionnaire snapshot is unavailable.', 409, 'PERFORMANCE_QUESTIONNAIRE_SNAPSHOT_INVALID');
  }
  return snapshot;
}

function parseDevelopmentPlan(value, questionnaireVersion) {
  if (String(questionnaireVersion || 'v1') !== 'v2') return encryptedOptional(value, 5000, 'Recommendation');
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new PerformanceError('Development plan must be structured.');
  const allowed = new Set(['summary', 'performance_gap', 'required_action', 'responsible_person', 'target_date', 'follow_up_date', 'expected_outcome']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new PerformanceError('Development plan contains unsupported fields.', 403, 'PERFORMANCE_PARAMETER_TAMPERING');
  const targetDate = value.target_date ? dateOnly(value.target_date, 'Development plan target date') : '';
  const followUpDate = value.follow_up_date ? dateOnly(value.follow_up_date, 'Development plan follow-up date') : '';
  if (targetDate && followUpDate && followUpDate < targetDate) throw new PerformanceError('Development plan follow-up date must be on or after the target date.');
  const plan = {
    summary: cleanText(value.summary, 2000, 'Development recommendation'),
    performance_gap: cleanText(value.performance_gap, 1500, 'Performance gap'),
    required_action: cleanText(value.required_action, 1500, 'Required action'),
    responsible_person: cleanText(value.responsible_person, 160, 'Responsible person'),
    target_date: targetDate || null,
    follow_up_date: followUpDate || null,
    expected_outcome: cleanText(value.expected_outcome, 1500, 'Expected outcome'),
  };
  return Object.values(plan).some(Boolean) ? encryptColumnValue(JSON.stringify(plan)) : null;
}

function decryptDevelopmentPlan(value, questionnaireVersion) {
  const plaintext = safeDecrypt(value);
  if (!plaintext || plaintext.startsWith('[Protected')) return String(questionnaireVersion || 'v1') === 'v2' ? {} : '';
  if (String(questionnaireVersion || 'v1') !== 'v2') return plaintext;
  try {
    const plan = JSON.parse(plaintext);
    return plan && typeof plan === 'object' && !Array.isArray(plan) ? plan : { summary: plaintext };
  } catch (_error) {
    return { summary: plaintext };
  }
}

function requireStructuredDevelopmentPlan(plan) {
  const required = ['performance_gap', 'required_action', 'responsible_person', 'target_date', 'follow_up_date', 'expected_outcome'];
  if (!plan || typeof plan !== 'object' || required.some(key => !String(plan[key] || '').trim())) {
    throw new PerformanceError('A structured development plan is required for a below-standard performance result.');
  }
}

function validateFinalizationEvidence(row, questionnaire, evaluation) {
  if (questionnaire.version !== 'v2') return;
  const naReasons = decryptJson(row.criteria_evidence_encrypted, {}).__na_reasons || {};
  const evidence = decryptJson(row.criteria_evidence_encrypted, {}).__evidence || {};
  const remarks = decryptJson(row.criteria_remarks_encrypted, {});
  for (const criterion of questionnaireCriteria(questionnaire)) {
    const ratings = criterion.indicators.map(indicator => row.__ratings?.[criterion.key]?.[indicator.key]);
    const hasNa = ratings.includes('NA');
    const hasLowRating = ratings.some(value => Number(value) === 1 || Number(value) === 2);
    const allExceeds = ratings.length > 0 && ratings.every(value => Number(value) === 4);
    if (hasNa) {
      for (const indicator of criterion.indicators) {
        if (row.__ratings?.[criterion.key]?.[indicator.key] === 'NA' && !String(naReasons?.[criterion.key]?.[indicator.key] || '').trim()) {
          throw new PerformanceError(`An N/A reason is required for ${criterion.label}.`);
        }
      }
    }
    if ((hasNa || hasLowRating || Number(evaluation.criteria_averages?.[criterion.key]) < 2.5) && !String(remarks?.[criterion.key] || '').trim()) {
      throw new PerformanceError(`Evaluator remarks are required for ${criterion.label}.`);
    }
    if (allExceeds && !String(evidence?.[criterion.key] || '').trim()) {
      throw new PerformanceError(`Evidence is required when all ${criterion.label} indicators exceed expectations.`);
    }
  }
}

function calculateFinalWeightedScore(competencyScore, goalScore, questionnaire) {
  const competencyWeight = Number(questionnaire.score_weights?.competency_weight || 0);
  const goalWeight = Number(questionnaire.score_weights?.goal_weight || 0);
  if (!Number.isFinite(competencyScore)) throw new PerformanceError('Complete the competency evaluation before finalization.');
  if (goalWeight === 0) return Number(competencyScore.toFixed(2));
  if (!Number.isFinite(goalScore)) throw new PerformanceError('Complete the goal evaluation before finalization.');
  return Number(((competencyScore * (competencyWeight / 100)) + (goalScore * (goalWeight / 100))).toFixed(2));
}

function integrityPayload(row) {
  // Preserve the exact v1 field set and order. Existing finalized reviews were
  // hashed before v2 columns existed; adding null fields would falsely mark
  // those historical records as altered after this migration.
  const v1Payload = {
    review_id: String(row.id),
    cycle_id: String(row.cycle_id),
    employee_id: String(row.employee_id),
    reviewer_user_id: String(row.reviewer_user_id),
    indicator_ratings_encrypted: row.indicator_ratings_encrypted || null,
    final_score: row.final_score === null ? null : Number(row.final_score).toFixed(2),
    goals_encrypted: row.goals_encrypted || null,
    reviewer_feedback_encrypted: row.reviewer_feedback_encrypted || null,
    development_plan_encrypted: row.development_plan_encrypted || null,
  };
  if (String(row.questionnaire_version || 'v1').toLowerCase() !== 'v2') return v1Payload;
  return {
    ...v1Payload,
    questionnaire_version: 'v2',
    questionnaire_snapshot_encrypted: row.questionnaire_snapshot_encrypted || null,
    criteria_evidence_encrypted: row.criteria_evidence_encrypted || null,
    criteria_remarks_encrypted: row.criteria_remarks_encrypted || null,
    competency_score: row.competency_score === null ? null : Number(row.competency_score).toFixed(2),
    goal_score: row.goal_score === null ? null : Number(row.goal_score).toFixed(2),
    scoring_snapshot_encrypted: row.scoring_snapshot_encrypted || null,
  };
}

function calculateIntegrityHash(row) {
  return crypto.createHash('sha256').update(JSON.stringify(integrityPayload(row))).digest('hex');
}

function integrityStatus(row) {
  if (row.status !== 'FINALIZED') return 'NOT_FINALIZED';
  if (!/^[a-f0-9]{64}$/i.test(String(row.integrity_hash || ''))) return 'MISSING';
  const actual = calculateIntegrityHash(row);
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(row.integrity_hash, 'hex'))
    ? 'VERIFIED'
    : 'MISMATCH';
}

function reviewResponse(row, { includeNarratives = true } = {}) {
  const questionnaire = reviewQuestionnaire(row);
  const ratings = includeNarratives ? decryptIndicatorRatings(row.indicator_ratings_encrypted, questionnaire) : null;
  const evaluation = ratings ? calculateEvaluationScore(ratings, questionnaire) : null;
  const goals = includeNarratives ? decryptGoals(row.goals_encrypted) : [];
  const goalEvaluation = includeNarratives ? calculateGoalScore(goals, questionnaire.score_weights?.goal_weight) : null;
  const computedFinalScore = row.status === 'FINALIZED' && row.final_score !== null
    ? Number(row.final_score)
    : null;
  const response = {
    id: row.id,
    cycle_id: row.cycle_id,
    cycle_name: row.cycle_name,
    cycle_status: row.cycle_status,
    review_period_start: row.review_period_start,
    review_period_end: row.review_period_end,
    due_date: row.due_date,
    employee_id: row.employee_id,
    employee_record_id: Number(row.employee_record_id),
    employee_code: row.employee_code,
    employee_name: employeeDisplayName(row),
    department_id: row.department_id ? Number(row.department_id) : null,
    department_name: row.department_name || 'Unassigned',
    position: safeDecrypt(row.position) || row.position || 'Unassigned',
    reviewer_user_id: row.reviewer_user_id,
    reviewer_name: row.reviewer_name || 'HR Reviewer',
    status: row.status,
    questionnaire_version: questionnaire.version,
    questionnaire,
    rating_scale: questionnaire.rating_scale || PERFORMANCE_RATING_SCALE,
    final_score: computedFinalScore,
    competency_score: row.competency_score === null || row.competency_score === undefined ? null : Number(row.competency_score),
    goal_score: row.goal_score === null || row.goal_score === undefined ? null : Number(row.goal_score),
    outcome: performanceOutcome(computedFinalScore, row.finalized_at),
    criteria: questionnaire.criteria,
    criteria_averages: evaluation?.criteria_averages || {},
    score_preview: evaluation ? {
      competency_score: evaluation.overall_score,
      goal_score: goalEvaluation?.score ?? null,
      competency_weight: Number(questionnaire.score_weights?.competency_weight || 0),
      goal_weight: Number(questionnaire.score_weights?.goal_weight || 0),
      final_score: evaluation.complete && goalEvaluation?.complete
        ? calculateFinalWeightedScore(evaluation.overall_score, goalEvaluation.score, questionnaire)
        : null,
      numeric_coverage: evaluation.numeric_coverage,
      numeric_indicators: evaluation.numeric_indicators,
      total_indicators: evaluation.total_indicators,
      na_indicators: evaluation.na_indicators,
    } : null,
    version: row.version,
    finalized_at: row.finalized_at,
    integrity_status: integrityStatus(row),
  };
  if (includeNarratives) {
    const narrativeEnvelope = decryptJson(row.criteria_evidence_encrypted, {});
    response.indicator_ratings = ratings;
    response.na_reasons = narrativeEnvelope.__na_reasons || {};
    response.criteria_evidence = narrativeEnvelope.__evidence || {};
    response.criteria_remarks = decryptJson(row.criteria_remarks_encrypted, {});
    response.goals = goals.map(goal => ({ ...goal, suggested_achievement_percentage: suggestedGoalAchievement(goal) }));
    response.reviewer_feedback = safeDecrypt(row.reviewer_feedback_encrypted);
    response.development_plan = decryptDevelopmentPlan(row.development_plan_encrypted, questionnaire.version);
  }
  return response;
}

const REVIEW_SELECT = `
  SELECT pr.*, pc.cycle_name, pc.status AS cycle_status,
         DATE_FORMAT(pc.review_period_start, '%Y-%m-%d') AS review_period_start,
         DATE_FORMAT(pc.review_period_end, '%Y-%m-%d') AS review_period_end,
         DATE_FORMAT(pc.due_date, '%Y-%m-%d') AS due_date,
         e.id AS employee_record_id, e.employee_code, e.first_name,
         e.middle_name, e.last_name, e.suffix, e.position, d.name AS department_name,
         d.id AS department_id, e.employee_level, wt.name AS wage_type,
         u.username AS reviewer_name
    FROM performance_reviews pr
    JOIN performance_cycles pc ON pc.id = pr.cycle_id
    JOIN employees e ON e.Employee_ID = pr.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
    LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
    LEFT JOIN users u ON u.id = pr.reviewer_user_id`;

async function loadReview(executor, reviewId, { forUpdate = false } = {}) {
  const [rows] = await executor.execute(`${REVIEW_SELECT} WHERE pr.id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [reviewId]);
  if (!rows.length) throw new PerformanceError('Performance review not found.', 404, 'PERFORMANCE_REVIEW_NOT_FOUND');
  return rows[0];
}

function enforceReviewAccess(req, row) {
  if (isPerformanceManager(req)) return;
  if (Number(row.employee_id) !== currentEmployeeReference(req) || row.status !== 'FINALIZED') {
    auditSecurityEvent(req, {
      action: 'blocked_performance_review_idor_attempt',
      module: 'PERFORMANCE_SECURITY',
      targetTable: 'performance_reviews',
      targetRecord: row.id,
      newValue: { requested_employee_id: row.employee_id, authenticated_employee_id: currentEmployeeReference(req) },
      result: 'blocked',
    }).catch(() => {});
    throw new PerformanceError('Only your own finalized performance evaluations are available.', 403, 'PERFORMANCE_SELF_SCOPE_REQUIRED');
  }
}

function errorResponse(res, error) {
  const status = Number(error?.statusCode) || 500;
  if (status >= 500) console.error('[performance-management]', error);
  return res.status(status).json({
    error: status >= 500 ? 'Performance Management is temporarily unavailable.' : error.message,
    code: error.code || 'PERFORMANCE_REQUEST_FAILED',
  });
}

router.use(requireAuth, requirePerformanceAccess);

router.get('/overview', async (req, res) => {
  try {
    const employeeId = currentEmployeeReference(req);
    const manager = isPerformanceManager(req);
    const scope = manager ? '' : " WHERE employee_id = ? AND status = 'FINALIZED'";
    const params = manager ? [] : [employeeId];
    const [summaryRows] = await pool.execute(
      `SELECT COUNT(*) AS total,
              SUM(status = 'ASSIGNED') AS in_progress,
              SUM(status = 'FINALIZED') AS finalized,
              SUM(status = 'FINALIZED' AND final_score >= 2.50) AS passed,
              SUM(status = 'FINALIZED' AND final_score < 2.50) AS needs_follow_up
         FROM performance_reviews${scope}`,
      params
    );
    const cycleJoin = manager
      ? 'LEFT JOIN performance_reviews pr ON pr.cycle_id = pc.id'
      : "JOIN performance_reviews pr ON pr.cycle_id = pc.id AND pr.employee_id = ? AND pr.status = 'FINALIZED'";
    const [cycles] = await pool.execute(
      `SELECT pc.id, pc.cycle_name,
              DATE_FORMAT(pc.review_period_start, '%Y-%m-%d') AS review_period_start,
              DATE_FORMAT(pc.review_period_end, '%Y-%m-%d') AS review_period_end,
              DATE_FORMAT(pc.due_date, '%Y-%m-%d') AS due_date,
              pc.status, pc.created_at,
              COUNT(pr.id) AS review_count,
              SUM(pr.status = 'FINALIZED') AS finalized_count
         FROM performance_cycles pc
         ${cycleJoin}
        GROUP BY pc.id
        ORDER BY pc.review_period_start DESC, pc.id DESC
        LIMIT 50`,
      manager ? [] : [employeeId]
    );
    return res.json({
      summary: Object.fromEntries(Object.entries(summaryRows[0] || {}).map(([key, value]) => [key, Number(value || 0)])),
      cycles: cycles.map(row => ({ ...row, review_count: Number(row.review_count || 0), finalized_count: Number(row.finalized_count || 0) })),
      can_manage: manager,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get('/questionnaire', requirePerformanceManager, async (req, res) => {
  try {
    const employeeId = positiveId(req.query.employee_id, 'Employee ID');
    const cycleId = req.query.cycle_id ? positiveId(req.query.cycle_id, 'Cycle ID') : null;
    const [employees] = await pool.execute(
      `SELECT e.Employee_ID, e.position, e.employee_level, d.name AS department_name, wt.name AS wage_type
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
        WHERE e.Employee_ID = ? AND LOWER(COALESCE(e.status, 'active')) = 'active' LIMIT 1`,
      [employeeId]
    );
    if (!employees.length) throw new PerformanceError('Active employee not found.', 404);
    let cycle = { questionnaire_version: 'v2', competency_weight: 70, goal_weight: 30 };
    if (cycleId) {
      const [cycles] = await pool.execute('SELECT id, questionnaire_version, competency_weight, goal_weight FROM performance_cycles WHERE id = ? LIMIT 1', [cycleId]);
      if (!cycles.length) throw new PerformanceError('Performance cycle not found.', 404);
      cycle = cycles[0];
    }
    const questionnaire = resolvePerformanceQuestionnaire({
      employee: {
        ...employees[0],
        position: safeDecrypt(employees[0].position) || employees[0].position,
        employee_level: safeDecrypt(employees[0].employee_level) || employees[0].employee_level,
      },
      cycle,
    });
    return res.json({ questionnaire });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get('/eligible-employees', requirePerformanceManager, async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT e.id AS employee_record_id, e.Employee_ID AS employee_id, e.employee_code, e.first_name, e.middle_name,
              e.last_name, e.suffix, e.position, e.employee_level, wt.name AS wage_type, d.id AS department_id, d.name AS department_name
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
        WHERE LOWER(COALESCE(e.status, 'active')) = 'active'
        ORDER BY e.employee_code ASC
        LIMIT 1000`
    );
    return res.json(rows.map(row => ({
      employee_id: row.employee_id,
      employee_record_id: Number(row.employee_record_id),
      employee_code: row.employee_code,
      employee_name: employeeDisplayName(row),
      department_id: row.department_id ? Number(row.department_id) : null,
      department_name: row.department_name || 'Unassigned',
      position: safeDecrypt(row.position) || row.position || 'Unassigned',
      employee_level: safeDecrypt(row.employee_level) || row.employee_level || '',
      wage_type: row.wage_type || '',
    })));
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get('/departments', requirePerformanceManager, async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT DISTINCT d.id, d.name
         FROM departments d
         JOIN employees e ON e.department_id = d.id
         JOIN performance_reviews pr ON pr.employee_id = e.Employee_ID
        ORDER BY d.name ASC
        LIMIT 500`
    );
    return res.json(rows.map(row => ({ id: Number(row.id), name: row.name })));
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/cycles', requirePerformanceManager, async (req, res) => {
  try {
    rejectUnexpectedFields(req, new Set(['cycle_name', 'review_period_start', 'review_period_end', 'due_date', 'description', 'competency_weight', 'goal_weight']));
    const cycleName = cleanText(req.body.cycle_name, 160, 'Cycle name', { required: true });
    const start = dateOnly(req.body.review_period_start, 'Review period start');
    const end = dateOnly(req.body.review_period_end, 'Review period end');
    const due = dateOnly(req.body.due_date, 'Due date');
    if (start > end) throw new PerformanceError('Review period end must be on or after the start date.');
    if (due < end) throw new PerformanceError('Due date must be on or after the review period end.');
    const weights = parseScoreWeights(req.body.competency_weight ?? 70, req.body.goal_weight ?? 30);
    const [result] = await pool.execute(
      `INSERT INTO performance_cycles
         (cycle_name, review_period_start, review_period_end, due_date, description_encrypted, questionnaire_version, competency_weight, goal_weight, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, 'v2', ?, ?, ?, ?)`,
      [cycleName, start, end, due, encryptedOptional(req.body.description, 2000, 'Description'), weights.competency_weight, weights.goal_weight, req.user.id, req.user.id]
    );
    await audit(pool, req, 'CREATE_PERFORMANCE_CYCLE', null, null, { cycle_id: result.insertId, status: 'DRAFT', questionnaire_version: 'v2', ...weights });
    return res.status(201).json({ id: result.insertId, message: 'Performance cycle created as draft.' });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.patch('/cycles/:cycleId/status', requirePerformanceManager, async (req, res) => {
  try {
    rejectUnexpectedFields(req, new Set(['status']));
    const cycleId = positiveId(req.params.cycleId, 'Cycle ID');
    const status = String(req.body.status || '').trim().toUpperCase();
    if (!CYCLE_STATUSES.has(status)) throw new PerformanceError('Cycle status is invalid.');
    const [result] = await pool.execute('UPDATE performance_cycles SET status = ?, updated_by = ? WHERE id = ?', [status, req.user.id, cycleId]);
    if (!result.affectedRows) throw new PerformanceError('Performance cycle not found.', 404);
    await audit(pool, req, 'UPDATE_PERFORMANCE_CYCLE_STATUS', null, null, { cycle_id: cycleId, status });
    return res.json({ message: `Performance cycle marked ${status.toLowerCase()}.` });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/reviews', requirePerformanceManager, async (req, res) => {
  try {
    rejectUnexpectedFields(req, new Set(['cycle_id', 'employee_id', 'goals']));
    const cycleId = positiveId(req.body.cycle_id, 'Cycle ID');
    const employeeId = positiveId(req.body.employee_id, 'Employee ID');
    const [cycles] = await pool.execute("SELECT id, status, questionnaire_version, competency_weight, goal_weight FROM performance_cycles WHERE id = ? AND status IN ('DRAFT','ACTIVE') LIMIT 1", [cycleId]);
    if (!cycles.length) throw new PerformanceError('Select an available draft or active cycle.', 409);
    const [employees] = await pool.execute(
      `SELECT e.Employee_ID, e.position, e.employee_level, d.name AS department_name, wt.name AS wage_type
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
         LEFT JOIN wage_types wt ON wt.id = e.wage_type_id
        WHERE e.Employee_ID = ? AND LOWER(COALESCE(e.status, 'active')) = 'active' LIMIT 1`,
      [employeeId]
    );
    if (!employees.length) throw new PerformanceError('Active employee not found.', 404);
    const cycle = cycles[0];
    const questionnaire = resolvePerformanceQuestionnaire({
      employee: {
        ...employees[0],
        position: safeDecrypt(employees[0].position) || employees[0].position,
        employee_level: safeDecrypt(employees[0].employee_level) || employees[0].employee_level,
      },
      cycle,
    });
    const questionnaireVersion = questionnaire.version;
    const [result] = await pool.execute(
      `INSERT INTO performance_reviews
         (cycle_id, employee_id, reviewer_user_id, questionnaire_version, questionnaire_snapshot_encrypted, goals_encrypted, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [cycleId, employeeId, req.user.id, questionnaireVersion,
        questionnaireVersion === 'v2' ? encryptColumnValue(JSON.stringify(questionnaire)) : null,
        parseGoals(req.body.goals, { version: questionnaireVersion, goalWeight: questionnaire.score_weights.goal_weight }), req.user.id, req.user.id]
    );
    await audit(pool, req, 'QUESTIONNAIRE_ASSIGNED', result.insertId, employeeId, {
      cycle_id: cycleId, questionnaire_version: questionnaireVersion,
      role_section: questionnaire.classification?.role_section || null,
      leadership: Boolean(questionnaire.classification?.supervisory_responsibility),
    });
    await audit(pool, req, 'PERFORMANCE_QUESTIONNAIRE_VERSION_SELECTED', result.insertId, employeeId, { questionnaire_version: questionnaireVersion });
    await audit(pool, req, 'ASSIGN_PERFORMANCE_REVIEW', result.insertId, employeeId, { cycle_id: cycleId, status: 'ASSIGNED', questionnaire_version: questionnaireVersion });
    return res.status(201).json({ id: result.insertId, message: 'Employee assigned to the performance cycle.' });
  } catch (error) {
    if (error?.code === 'ER_DUP_ENTRY') return errorResponse(res, new PerformanceError('This employee is already assigned to the cycle.', 409));
    return errorResponse(res, error);
  }
});

router.get('/reviews', async (req, res) => {
  try {
    const conditions = [];
    const params = [];
    const manager = isPerformanceManager(req);
    if (!manager) {
      conditions.push("pr.employee_id = ? AND pr.status = 'FINALIZED'");
      params.push(currentEmployeeReference(req));
    }
    if (req.query.cycle_id) {
      conditions.push('pr.cycle_id = ?');
      params.push(positiveId(req.query.cycle_id, 'Cycle ID'));
    }
    if (req.query.department_id && manager) {
      conditions.push('d.id = ?');
      params.push(positiveId(req.query.department_id, 'Department ID'));
    }
    if (req.query.status && manager) {
      const status = String(req.query.status).trim().toUpperCase();
      if (!REVIEW_STATUSES.has(status)) throw new PerformanceError('Review status is invalid.');
      conditions.push('pr.status = ?');
      params.push(status);
    }
    const search = manager && req.query.search
      ? cleanText(req.query.search, 80, 'Search').toLowerCase()
      : '';
    const requestedPage = req.query.page ? positiveId(req.query.page, 'Page') : 1;
    const requestedPageSize = req.query.page_size ? positiveId(req.query.page_size, 'Page size') : 10;
    if (![10, 20, 50].includes(requestedPageSize)) throw new PerformanceError('Page size must be 10, 20, or 50.');
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : '';
    const [rows] = await pool.execute(`${REVIEW_SELECT}${where} ORDER BY pc.review_period_start DESC, pr.updated_at DESC LIMIT 1000`, params);
    const reviews = rows.map(row => reviewResponse(row, { includeNarratives: false }));
    const filtered = search
      ? reviews.filter(review => `${review.employee_code} ${review.employee_name}`.toLowerCase().includes(search))
      : reviews;
    const totalItems = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalItems / requestedPageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * requestedPageSize;
    return res.json({
      items: filtered.slice(offset, offset + requestedPageSize),
      pagination: {
        page,
        page_size: requestedPageSize,
        total_items: totalItems,
        total_pages: totalPages,
      },
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get('/reviews/:reviewId/supporting-summary', requirePerformanceManager, async (req, res) => {
  try {
    const row = await loadReview(pool, positiveId(req.params.reviewId, 'Review ID'));
    const params = [row.employee_record_id, row.review_period_start, row.review_period_end];
    const [attendanceRows] = await pool.execute(
      `SELECT COUNT(*) AS recorded_days,
              SUM(time_in IS NOT NULL) AS days_present,
              SUM(COALESCE(status, '') = 'Absent') AS absences,
              SUM(COALESCE(late_minutes, 0) > 0) AS tardiness_count,
              SUM(COALESCE(late_minutes, 0)) AS tardiness_minutes,
              SUM(COALESCE(integrity_hash, '') <> '') AS integrity_recorded
         FROM attendance_log
        WHERE employee_id = ? AND date BETWEEN ? AND ?`,
      params
    );
    const [productionRows] = await pool.execute(
      `SELECT COUNT(*) AS approved_records, COALESCE(SUM(quantity), 0) AS output_quantity,
              COALESCE(SUM(amount), 0) AS approved_amount
         FROM production_transactions
        WHERE employee_id = ? AND transaction_date BETWEEN ? AND ?`,
      params
    ).catch(() => [[{}]]);
    const [logisticsRows] = await pool.execute(
      `SELECT COUNT(*) AS verified_trips,
              SUM(COALESCE(status, '') NOT IN ('Rejected', 'Cancelled', 'Deleted')) AS completed_or_approved,
              SUM(COALESCE(status, '') IN ('Rejected', 'Cancelled')) AS documented_exceptions
         FROM delivery_trips
        WHERE employee_id = ? AND trip_date BETWEEN ? AND ?`,
      params
    ).catch(() => [[{}]]);
    const normalize = source => Object.fromEntries(Object.entries(source || {}).map(([key, value]) => [key, Number(value || 0)]));
    return res.json({
      as_of: new Date().toISOString(),
      employee: {
        employee_id: row.employee_id,
        department: row.department_name || 'Unassigned',
        position: safeDecrypt(row.position) || row.position || 'Unassigned',
        employee_level: safeDecrypt(row.employee_level) || row.employee_level || '',
        wage_type: row.wage_type || '',
      },
      attendance: normalize(attendanceRows[0]),
      production: normalize(productionRows[0]),
      logistics: normalize(logisticsRows[0]),
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get('/reviews/:reviewId', async (req, res) => {
  try {
    const row = await loadReview(pool, positiveId(req.params.reviewId, 'Review ID'));
    enforceReviewAccess(req, row);
    return res.json(reviewResponse(row));
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.put('/reviews/:reviewId/evaluation', requirePerformanceManager, async (req, res) => {
  let connection;
  try {
    rejectUnexpectedFields(req, new Set(['ratings', 'na_reasons', 'criteria_evidence', 'criteria_remarks', 'feedback', 'development_plan', 'goals', 'version']));
    const reviewId = positiveId(req.params.reviewId, 'Review ID');
    const version = positiveId(req.body.version, 'Review version');
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const row = await loadReview(connection, reviewId, { forUpdate: true });
    if (row.status !== 'ASSIGNED') throw new PerformanceError('Finalized reviews cannot be edited.', 409);
    if (Number(row.version) !== version) throw new PerformanceError('This review was updated elsewhere. Refresh and try again.', 409, 'PERFORMANCE_VERSION_CONFLICT');
    const questionnaire = reviewQuestionnaire(row);
    const ratings = parseIndicatorRatings(req.body.ratings, questionnaire);
    const naReasons = parseNaReasons(req.body.na_reasons, ratings, questionnaire);
    const criteriaEvidence = parseCriterionTextMap(req.body.criteria_evidence, questionnaire, 'Evidence or reference', 2000);
    const criteriaRemarks = parseCriterionTextMap(req.body.criteria_remarks, questionnaire, 'Evaluator remarks', 2000);
    const goalsEncrypted = req.body.goals === undefined
      ? row.goals_encrypted
      : parseGoals(req.body.goals, { version: questionnaire.version, goalWeight: questionnaire.score_weights.goal_weight });
    const developmentPlan = parseDevelopmentPlan(req.body.development_plan, questionnaire.version);
    const narrativeEnvelope = questionnaire.version === 'v2'
      ? encryptedJson({ __na_reasons: naReasons, __evidence: criteriaEvidence })
      : null;
    await connection.execute(
      `UPDATE performance_reviews
          SET indicator_ratings_encrypted=?, criteria_evidence_encrypted=?, criteria_remarks_encrypted=?,
              reviewer_feedback_encrypted=?, development_plan_encrypted=?, goals_encrypted=?, reviewer_user_id=?,
              version=version+1, updated_by=?
        WHERE id=? AND version=?`,
      [encryptColumnValue(JSON.stringify(ratings)), narrativeEnvelope,
        questionnaire.version === 'v2' ? encryptedJson(criteriaRemarks) : null,
        encryptedOptional(req.body.feedback, 5000, 'HR remarks'), developmentPlan, goalsEncrypted,
        req.user.id, req.user.id, reviewId, version]
    );
    await audit(connection, req, 'PERFORMANCE_RATINGS_UPDATED', reviewId, row.employee_id, {
      questionnaire_version: questionnaire.version,
      numeric_ratings: Object.values(ratings).reduce((total, criterion) => total + Object.values(criterion).filter(Number.isInteger).length, 0),
      na_ratings: Object.values(ratings).reduce((total, criterion) => total + Object.values(criterion).filter(value => value === 'NA').length, 0),
    });
    if (Object.keys(criteriaEvidence).length || Object.keys(criteriaRemarks).length || Object.keys(naReasons).length) {
      await audit(connection, req, 'PERFORMANCE_CRITERION_EVIDENCE_UPDATED', reviewId, row.employee_id, {
        evidence_criteria: Object.keys(criteriaEvidence).length,
        remarks_criteria: Object.keys(criteriaRemarks).length,
        na_reasons_recorded: Object.values(naReasons).reduce((total, group) => total + Object.keys(group).length, 0),
      });
    }
    if (req.body.goals !== undefined) await audit(connection, req, 'PERFORMANCE_GOALS_UPDATED', reviewId, row.employee_id, { goal_count: decryptGoals(goalsEncrypted).length });
    await audit(connection, req, 'SAVE_PERFORMANCE_EVALUATION', reviewId, row.employee_id, { status: row.status, questionnaire_version: questionnaire.version });
    await connection.commit();
    return res.json({ message: 'Evaluation saved.', version: version + 1 });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    return errorResponse(res, error);
  } finally {
    connection?.release();
  }
});

router.post('/reviews/:reviewId/finalize', requirePerformanceManager, async (req, res) => {
  let connection;
  try {
    rejectUnexpectedFields(req, new Set(['currentPassword', 'version']));
    const verified = await verifyStepUpPassword(req);
    if (!verified) {
      await auditSecurityEvent(req, { action: 'performance_step_up_authentication_failed', module: 'PERFORMANCE_SECURITY', targetTable: 'performance_reviews', targetRecord: req.params.reviewId, result: 'blocked' });
      throw performanceStepUpFailure();
    }
    const reviewId = positiveId(req.params.reviewId, 'Review ID');
    const version = positiveId(req.body.version, 'Review version');
    connection = await pool.getConnection();
    await connection.beginTransaction();
    let row = await loadReview(connection, reviewId, { forUpdate: true });
    if (row.status !== 'ASSIGNED') throw new PerformanceError('Only an in-progress evaluation can be finalized.', 409);
    if (Number(row.version) !== version) throw new PerformanceError('This review was updated elsewhere. Refresh and try again.', 409, 'PERFORMANCE_VERSION_CONFLICT');
    const questionnaire = reviewQuestionnaire(row);
    const ratings = decryptIndicatorRatings(row.indicator_ratings_encrypted, questionnaire);
    const evaluation = calculateEvaluationScore(ratings, questionnaire);
    if (!evaluation.complete) {
      throw new PerformanceError(questionnaire.version === 'v2'
        ? 'Complete the required applicable ratings and minimum coverage before finalization.'
        : 'Complete all indicator ratings before finalization.');
    }
    row.__ratings = ratings;
    validateFinalizationEvidence(row, questionnaire, evaluation);
    if (!row.reviewer_feedback_encrypted || !row.development_plan_encrypted) {
      throw new PerformanceError('Reviewer feedback and recommendation or development plan are required before finalization.');
    }
    const developmentPlan = decryptDevelopmentPlan(row.development_plan_encrypted, questionnaire.version);
    if (questionnaire.version === 'v2' && !String(developmentPlan?.summary || '').trim()) {
      throw new PerformanceError('A development recommendation is required before finalization.');
    }
    const goals = decryptGoals(row.goals_encrypted);
    validateGoalsForFinalization(goals, questionnaire.score_weights?.goal_weight);
    const goalEvaluation = calculateGoalScore(goals, questionnaire.score_weights?.goal_weight);
    if (!goalEvaluation.complete) throw new PerformanceError('Complete the required goal ratings before finalization.');
    const finalScoreValue = calculateFinalWeightedScore(evaluation.overall_score, goalEvaluation.score, questionnaire);
    if (finalScoreValue < 2.5) requireStructuredDevelopmentPlan(developmentPlan);
    const finalScore = finalScoreValue.toFixed(2);
    const scoringSnapshot = encryptColumnValue(JSON.stringify({
      questionnaire_version: questionnaire.version,
      competency_score: evaluation.overall_score,
      goal_score: goalEvaluation.score,
      final_score: finalScoreValue,
      competency_weight: Number(questionnaire.score_weights?.competency_weight || 0),
      goal_weight: Number(questionnaire.score_weights?.goal_weight || 0),
      criteria_averages: evaluation.criteria_averages,
      numeric_coverage: evaluation.numeric_coverage,
      goal_applicable_weight: goalEvaluation.applicable_weight,
    }));
    await connection.execute(
      `UPDATE performance_reviews
          SET competency_score=?, goal_score=?, final_score=?, scoring_snapshot_encrypted=?,
              status='FINALIZED', finalized_at=NOW(), integrity_hash=NULL,
              version=version+1, updated_by=?
        WHERE id=? AND version=?`,
      [evaluation.overall_score, goalEvaluation.score, finalScore, scoringSnapshot, req.user.id, reviewId, version]
    );
    row = await loadReview(connection, reviewId, { forUpdate: true });
    const integrityHash = calculateIntegrityHash(row);
    await connection.execute('UPDATE performance_reviews SET integrity_hash = ? WHERE id = ?', [integrityHash, reviewId]);
    await audit(connection, req, 'PERFORMANCE_REVIEW_FINALIZED', reviewId, row.employee_id, {
      questionnaire_version: questionnaire.version, competency_score: evaluation.overall_score,
      goal_score: goalEvaluation.score, final_score: finalScore, integrity_hash: integrityHash, step_up_verified: true,
    });
    await audit(connection, req, 'FINALIZE_PERFORMANCE_REVIEW', reviewId, row.employee_id, { final_score: finalScore, integrity_hash: integrityHash, step_up_verified: true });
    await connection.commit();
    return res.json({ message: 'Performance review finalized and integrity-protected.', final_score: Number(finalScore), integrity_status: 'VERIFIED', version: version + 1 });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    return errorResponse(res, error);
  } finally {
    connection?.release();
  }
});

router.post('/reviews/:reviewId/reopen', requirePerformanceManager, async (req, res) => {
  let connection;
  try {
    rejectUnexpectedFields(req, new Set(['reason', 'currentPassword', 'version']));
    const reason = cleanText(req.body.reason, 1000, 'Reopen reason', { required: true });
    const verified = await verifyStepUpPassword(req);
    if (!verified) {
      await auditSecurityEvent(req, { action: 'performance_reopen_step_up_authentication_failed', module: 'PERFORMANCE_SECURITY', targetTable: 'performance_reviews', targetRecord: req.params.reviewId, result: 'blocked' });
      throw performanceStepUpFailure();
    }
    const reviewId = positiveId(req.params.reviewId, 'Review ID');
    const version = positiveId(req.body.version, 'Review version');
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const row = await loadReview(connection, reviewId, { forUpdate: true });
    if (row.status !== 'FINALIZED') throw new PerformanceError('Only finalized reviews can be reopened.', 409);
    if (Number(row.version) !== version) throw new PerformanceError('This review was updated elsewhere. Refresh and try again.', 409, 'PERFORMANCE_VERSION_CONFLICT');
    await connection.execute(
      `UPDATE performance_reviews
          SET status='ASSIGNED', competency_score=NULL, goal_score=NULL, final_score=NULL, scoring_snapshot_encrypted=NULL,
              integrity_hash=NULL, finalized_at=NULL, reopened_at=NOW(), reopened_by=?,
              reopen_reason_encrypted=?, version=version+1, updated_by=?
        WHERE id=? AND version=?`,
      [req.user.id, encryptColumnValue(reason), req.user.id, reviewId, version]
    );
    await audit(connection, req, 'PERFORMANCE_REVIEW_REOPENED', reviewId, row.employee_id, { questionnaire_version: row.questionnaire_version || 'v1', previous_status: row.status, reason_recorded: true, step_up_verified: true });
    await audit(connection, req, 'REOPEN_PERFORMANCE_REVIEW', reviewId, row.employee_id, { previous_status: row.status, reason_recorded: true, step_up_verified: true });
    await connection.commit();
    return res.json({ message: 'Performance review reopened with an audit trail.', version: version + 1 });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    return errorResponse(res, error);
  } finally {
    connection?.release();
  }
});

module.exports = router;
module.exports.calculateIntegrityHash = calculateIntegrityHash;
module.exports.integrityPayload = integrityPayload;
module.exports.PERFORMANCE_CRITERIA = PERFORMANCE_CRITERIA;
module.exports.calculateEvaluationScore = calculateEvaluationScore;
module.exports.calculateGoalScore = calculateGoalScore;
module.exports.calculateFinalWeightedScore = calculateFinalWeightedScore;
module.exports.performanceOutcome = performanceOutcome;
module.exports.parseIndicatorRatings = parseIndicatorRatings;
module.exports.parseNaReasons = parseNaReasons;
module.exports.parseGoals = parseGoals;
module.exports.suggestedGoalAchievement = suggestedGoalAchievement;
module.exports.parseScoreWeights = parseScoreWeights;
module.exports.validateGoalsForFinalization = validateGoalsForFinalization;
module.exports.performanceStepUpFailure = performanceStepUpFailure;
