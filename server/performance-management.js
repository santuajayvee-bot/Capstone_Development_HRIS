const crypto = require('crypto');
const express = require('express');

const pool = require('../config/db');
const { verifyPassword } = require('../services/passwordService');
const { requireAuth } = require('./middleware');
const { decryptColumnValue, encryptColumnValue } = require('./data-protection');
const { auditSecurityEvent } = require('./security-controls');

const router = express.Router();
const REVIEW_STATUSES = new Set(['ASSIGNED', 'FINALIZED']);
const CYCLE_STATUSES = new Set(['DRAFT', 'ACTIVE', 'CLOSED']);
const PERFORMANCE_CRITERIA = Object.freeze([
  {
    key: 'attendance_punctuality',
    label: 'Attendance and Punctuality',
    basis: 'Validated biometric attendance, tardiness, unexcused absences, and approved leave records.',
    indicators: [
      { key: 'reports_on_time', text: 'The employee regularly reports to work on time.' },
      { key: 'minimal_unexcused_absences', text: 'The employee has minimal unexcused absences.' },
      { key: 'proper_leave_filing', text: 'The employee properly files leave requests when needed.' },
      { key: 'follows_working_hours', text: 'The employee follows assigned working hours and attendance policies.' },
    ],
  },
  {
    key: 'work_output_productivity',
    label: 'Work Output / Productivity',
    basis: 'Verified task completion, production piece-rate logs, logistics trip logs, and approved output targets.',
    indicators: [
      { key: 'completes_work_on_time', text: 'The employee completes assigned work within the expected period.' },
      { key: 'meets_output_requirements', text: 'The employee meets expected production output or task requirements.' },
      { key: 'consistent_performance', text: 'The employee maintains consistent work performance during the evaluation period.' },
      { key: 'contributes_to_operations', text: 'The employee contributes effectively to assigned operational tasks.' },
    ],
  },
  {
    key: 'work_quality_accuracy',
    label: 'Work Quality / Accuracy',
    basis: 'Accepted output, documented errors, rework, supervisor reports, and approved quality standards.',
    indicators: [
      { key: 'minimal_errors', text: 'The employee performs tasks with minimal errors.' },
      { key: 'follows_procedures', text: 'The employee follows proper work procedures.' },
      { key: 'accurate_output', text: 'The employee produces accurate and acceptable work output.' },
      { key: 'minimal_rework', text: 'The employee requires minimal correction or rework.' },
    ],
  },
  {
    key: 'compliance_conduct',
    label: 'Compliance and Conduct',
    basis: 'Applicable 201-file records, incident notes, policy compliance, and documented HR observations.',
    indicators: [
      { key: 'follows_company_rules', text: 'The employee follows company rules and policies.' },
      { key: 'proper_workplace_behavior', text: 'The employee observes proper workplace behavior.' },
      { key: 'follows_safety_procedures', text: 'The employee complies with safety and operational procedures.' },
      { key: 'no_major_conduct_issues', text: 'The employee has no major disciplinary or conduct-related issues.' },
    ],
  },
  {
    key: 'reliability_responsibility',
    label: 'Reliability and Responsibility',
    basis: 'Task completion, attendance consistency, documented instructions, and HR or supervisor observations.',
    indicators: [
      { key: 'completes_assigned_tasks', text: 'The employee can be trusted to complete assigned tasks.' },
      { key: 'handles_duties_responsibly', text: 'The employee shows responsibility in handling work duties.' },
      { key: 'dependable_during_shifts', text: 'The employee is dependable during assigned shifts or work periods.' },
      { key: 'responds_to_instructions', text: 'The employee responds properly to instructions and work requirements.' },
    ],
  },
]);

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
  const rating = Number(value);
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
    throw new PerformanceError(`${field} must be a whole-number rating from 1 to 4.`);
  }
  return rating;
}

function parseIndicatorRatings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PerformanceError('Indicator ratings must be provided as an object.');
  }
  const allowedCriteria = new Set(PERFORMANCE_CRITERIA.map(criterion => criterion.key));
  if (Object.keys(value).some(key => !allowedCriteria.has(key))) {
    throw new PerformanceError('Indicator ratings contain unsupported criteria.', 403, 'PERFORMANCE_PARAMETER_TAMPERING');
  }
  return Object.fromEntries(PERFORMANCE_CRITERIA.map(criterion => {
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

function decryptIndicatorRatings(value) {
  const plaintext = safeDecrypt(value);
  if (!plaintext || plaintext.startsWith('[Protected')) return {};
  try {
    return parseIndicatorRatings(JSON.parse(plaintext));
  } catch (_error) {
    return {};
  }
}

function calculateEvaluationScore(ratings) {
  const criteriaAverages = {};
  let complete = true;
  for (const criterion of PERFORMANCE_CRITERIA) {
    const values = criterion.indicators.map(indicator => Number(ratings?.[criterion.key]?.[indicator.key]));
    if (values.some(value => !Number.isInteger(value) || value < 1 || value > 4)) {
      criteriaAverages[criterion.key] = null;
      complete = false;
      continue;
    }
    criteriaAverages[criterion.key] = Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
  }
  const averages = Object.values(criteriaAverages);
  const overall = complete
    ? Number((averages.reduce((sum, value) => sum + value, 0) / averages.length).toFixed(2))
    : null;
  return { criteria_averages: criteriaAverages, overall_score: overall, complete };
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

function parseGoals(value) {
  if (value === undefined || value === null || value === '') return null;
  if (!Array.isArray(value)) throw new PerformanceError('Goals must be a list.');
  if (value.length > 8) throw new PerformanceError('A review can contain at most 8 goals.');
  const goals = value.map((goal, index) => ({
    title: cleanText(goal?.title, 160, `Goal ${index + 1} title`, { required: true }),
    target: cleanText(goal?.target, 500, `Goal ${index + 1} target`, { required: true }),
  }));
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

function integrityPayload(row) {
  return {
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
  const ratings = includeNarratives ? decryptIndicatorRatings(row.indicator_ratings_encrypted) : null;
  const evaluation = ratings ? calculateEvaluationScore(ratings) : null;
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
    final_score: computedFinalScore,
    outcome: performanceOutcome(computedFinalScore, row.finalized_at),
    criteria: PERFORMANCE_CRITERIA,
    criteria_averages: evaluation?.criteria_averages || {},
    version: row.version,
    finalized_at: row.finalized_at,
    integrity_status: integrityStatus(row),
  };
  if (includeNarratives) {
    response.indicator_ratings = ratings;
    response.goals = decryptGoals(row.goals_encrypted);
    response.reviewer_feedback = safeDecrypt(row.reviewer_feedback_encrypted);
    response.development_plan = safeDecrypt(row.development_plan_encrypted);
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
         d.id AS department_id,
         u.username AS reviewer_name
    FROM performance_reviews pr
    JOIN performance_cycles pc ON pc.id = pr.cycle_id
    JOIN employees e ON e.Employee_ID = pr.employee_id
    LEFT JOIN departments d ON d.id = e.department_id
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

router.get('/eligible-employees', requirePerformanceManager, async (_req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT e.id AS employee_record_id, e.Employee_ID AS employee_id, e.employee_code, e.first_name, e.middle_name,
              e.last_name, e.suffix, e.position, d.id AS department_id, d.name AS department_name
         FROM employees e
         LEFT JOIN departments d ON d.id = e.department_id
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
    rejectUnexpectedFields(req, new Set(['cycle_name', 'review_period_start', 'review_period_end', 'due_date', 'description']));
    const cycleName = cleanText(req.body.cycle_name, 160, 'Cycle name', { required: true });
    const start = dateOnly(req.body.review_period_start, 'Review period start');
    const end = dateOnly(req.body.review_period_end, 'Review period end');
    const due = dateOnly(req.body.due_date, 'Due date');
    if (start > end) throw new PerformanceError('Review period end must be on or after the start date.');
    if (due < end) throw new PerformanceError('Due date must be on or after the review period end.');
    const [result] = await pool.execute(
      `INSERT INTO performance_cycles
         (cycle_name, review_period_start, review_period_end, due_date, description_encrypted, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [cycleName, start, end, due, encryptedOptional(req.body.description, 2000, 'Description'), req.user.id, req.user.id]
    );
    await audit(pool, req, 'CREATE_PERFORMANCE_CYCLE', null, null, { cycle_id: result.insertId, status: 'DRAFT' });
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
    const [cycles] = await pool.execute("SELECT id, status FROM performance_cycles WHERE id = ? AND status IN ('DRAFT','ACTIVE') LIMIT 1", [cycleId]);
    if (!cycles.length) throw new PerformanceError('Select an available draft or active cycle.', 409);
    const [employees] = await pool.execute("SELECT Employee_ID FROM employees WHERE Employee_ID = ? AND LOWER(COALESCE(status, 'active')) = 'active' LIMIT 1", [employeeId]);
    if (!employees.length) throw new PerformanceError('Active employee not found.', 404);
    const [result] = await pool.execute(
      `INSERT INTO performance_reviews
         (cycle_id, employee_id, reviewer_user_id, goals_encrypted, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [cycleId, employeeId, req.user.id, parseGoals(req.body.goals), req.user.id, req.user.id]
    );
    await audit(pool, req, 'ASSIGN_PERFORMANCE_REVIEW', result.insertId, employeeId, { cycle_id: cycleId, status: 'ASSIGNED' });
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
    rejectUnexpectedFields(req, new Set(['ratings', 'feedback', 'development_plan', 'goals', 'version']));
    const reviewId = positiveId(req.params.reviewId, 'Review ID');
    const version = positiveId(req.body.version, 'Review version');
    const ratings = parseIndicatorRatings(req.body.ratings);
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const row = await loadReview(connection, reviewId, { forUpdate: true });
    if (row.status !== 'ASSIGNED') throw new PerformanceError('Finalized reviews cannot be edited.', 409);
    if (Number(row.version) !== version) throw new PerformanceError('This review was updated elsewhere. Refresh and try again.', 409, 'PERFORMANCE_VERSION_CONFLICT');
    const goalsEncrypted = req.body.goals === undefined ? row.goals_encrypted : parseGoals(req.body.goals);
    await connection.execute(
      `UPDATE performance_reviews
          SET indicator_ratings_encrypted=?, reviewer_feedback_encrypted=?, development_plan_encrypted=?,
              goals_encrypted=?, reviewer_user_id=?,
              version=version+1, updated_by=?
        WHERE id=? AND version=?`,
      [encryptColumnValue(JSON.stringify(ratings)), encryptedOptional(req.body.feedback, 5000, 'HR remarks'), encryptedOptional(req.body.development_plan, 5000, 'Recommendation'), goalsEncrypted, req.user.id, req.user.id, reviewId, version]
    );
    await audit(connection, req, 'SAVE_PERFORMANCE_EVALUATION', reviewId, row.employee_id, { status: row.status });
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
    const evaluation = calculateEvaluationScore(decryptIndicatorRatings(row.indicator_ratings_encrypted));
    if (!evaluation.complete) throw new PerformanceError('Complete all indicator ratings before finalization.');
    if (!row.reviewer_feedback_encrypted || !row.development_plan_encrypted) {
      throw new PerformanceError('Reviewer feedback and development plan are required before finalization.');
    }
    const finalScore = evaluation.overall_score.toFixed(2);
    await connection.execute(
      `UPDATE performance_reviews
          SET final_score=?, status='FINALIZED', finalized_at=NOW(), integrity_hash=NULL,
              version=version+1, updated_by=?
        WHERE id=? AND version=?`,
      [finalScore, req.user.id, reviewId, version]
    );
    row = await loadReview(connection, reviewId, { forUpdate: true });
    const integrityHash = calculateIntegrityHash(row);
    await connection.execute('UPDATE performance_reviews SET integrity_hash = ? WHERE id = ?', [integrityHash, reviewId]);
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
          SET status='ASSIGNED', final_score=NULL,
              integrity_hash=NULL, finalized_at=NULL, reopened_at=NOW(), reopened_by=?,
              reopen_reason_encrypted=?, version=version+1, updated_by=?
        WHERE id=? AND version=?`,
      [req.user.id, encryptColumnValue(reason), req.user.id, reviewId, version]
    );
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
module.exports.performanceOutcome = performanceOutcome;
module.exports.parseIndicatorRatings = parseIndicatorRatings;
module.exports.performanceStepUpFailure = performanceStepUpFailure;
