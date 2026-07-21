const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DB_USER ||= 'test';
process.env.DB_PASSWORD ||= 'test-only';
process.env.DB_NAME ||= 'test';
process.env.JWT_SECRET ||= 'test-only-performance-jwt-secret-that-is-long-enough';

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const api = read('server/performance-management.js');
const server = read('server.js');
const middleware = read('server/middleware.js');
const ui = read('public/js/performance.js');
const authUi = read('public/js/auth.js');
const indexPage = read('public/index.html');
const mainCss = read('public/css/main.css');
const themeCss = read('public/css/theme-light.css');
const page = read('public/pages/performance.html');
const up = read('migrations/sqls/20260718110000_performance_management-up.sql');
const down = read('migrations/sqls/20260718110000_performance_management-down.sql');
const questionnaireConfig = read('server/config/performance-questionnaire.js');
const questionnaireMigration = read('migrations/sqls/20260721133000_performance_questionnaire_v2-up.sql');
const stride = read('docs/stride/performance-management-stride.md');
const moduleCode = read('services/backup/moduleCodeService.js');

assert(up.includes('CREATE TABLE IF NOT EXISTS performance_cycles'));
assert(up.includes('CREATE TABLE IF NOT EXISTS performance_reviews'));
assert(up.includes('goals_encrypted LONGTEXT') && up.includes('reviewer_feedback_encrypted LONGTEXT'));
assert(up.includes('indicator_ratings_encrypted LONGTEXT'));
assert(up.includes("status ENUM('ASSIGNED', 'FINALIZED')"));
assert(!up.includes('self_quality') && !up.includes('reviewer_quality') && !up.includes('acknowledgement_comments_encrypted'));
assert(up.includes('integrity_hash CHAR(64)'));
assert(up.includes('UNIQUE KEY uq_performance_review_cycle_employee'));
assert(up.includes('FOREIGN KEY (employee_id) REFERENCES employees(Employee_ID)'));
assert(down.indexOf('DROP TABLE IF EXISTS performance_reviews') < down.indexOf('DROP TABLE IF EXISTS performance_cycles'));

assert(api.includes("const { verifyPassword } = require('../services/passwordService');"));
assert(api.includes('router.use(requireAuth, requirePerformanceAccess)'));
assert(api.includes("return sourceRole(req) === 'hr_manager'"));
assert(api.includes("return sourceRole(req) === 'employee'"));
assert(api.includes('requirePerformanceManager'));
assert(api.includes("pr.employee_id = ? AND pr.status = 'FINALIZED'"));
assert(api.includes("DATE_FORMAT(pc.review_period_start, '%Y-%m-%d')"));
assert(api.includes('blocked_performance_review_idor_attempt'));
assert(api.includes('blocked_performance_parameter_tampering'));
assert(api.includes('PERFORMANCE_VERSION_CONFLICT'));
assert(api.includes("module: 'PERFORMANCE_SECURITY'"));
assert(api.includes("'FINALIZE_PERFORMANCE_REVIEW'"));
assert(api.includes("'REOPEN_PERFORMANCE_REVIEW'"));
assert(!api.includes('/self-assessment') && !api.includes('/acknowledge'));
assert(api.includes('parseIndicatorRatings') && api.includes('calculateEvaluationScore'));
assert(api.includes("router.get('/questionnaire', requirePerformanceManager"));
assert(api.includes('questionnaire_snapshot_encrypted') && api.includes('criteria_evidence_encrypted'));
assert(api.includes('calculateGoalScore') && api.includes('calculateFinalWeightedScore'));
assert(api.includes("'PERFORMANCE_PARAMETER_TAMPERING'"));
assert(api.includes('Complete all indicator ratings before finalization.'));
assert(api.includes("router.get('/departments', requirePerformanceManager"));
assert(api.includes("conditions.push('d.id = ?')") && api.includes('req.query.department_id'));
assert(api.includes("[10, 20, 50].includes(requestedPageSize)") && api.includes('total_pages: totalPages'));
assert(api.includes('encryptColumnValue') && api.includes('decryptColumnValue'));
assert(api.includes("crypto.createHash('sha256')"));
assert(api.includes("integrity_status: integrityStatus(row)"));
assert(api.includes('FOR UPDATE'));
assert(api.includes('function performanceStepUpFailure()'));
assert(api.includes("throw performanceStepUpFailure();"));
assert(!api.includes("new PerformanceError('Current password verification failed.', 401"));
assert(api.includes('availableSupportingDataTables') && api.includes('source_status: sourceStatus'));
assert(api.includes('payroll_production_outputs') && api.includes('payroll_production_pairs') && api.includes('piece_rate_output_shares'));
assert(api.includes('VERIFIED_OPERATIONAL_STATUSES') && api.includes('PROCESSED_OPERATIONAL_STATUSES'));
assert(!api.includes("FROM production_transactions\n        WHERE employee_id = ? AND transaction_date BETWEEN ? AND ?`"), 'Unverifiable legacy production rows must not be presented as verified evidence.');

assert(server.includes("app.use('/api/performance', PERFORMANCE_ROUTE_RATE_LIMIT)"));
assert(server.includes("app.use('/api/performance', performanceManagementRoutes)"));
assert(ui.includes('type="password"') === false, 'The password field belongs in the HTML partial, not injected markup.');
assert(page.includes('id="performance-step-up-password"') && page.includes('type="password"'));
assert(ui.includes('performanceEscape(review.employee_name)'));
assert(ui.includes("['MISMATCH', 'MISSING'].includes(review.integrity_status)"));
assert(ui.includes('performanceOutcomeNotice') && ui.includes('reassessment_due_date'));
assert(page.includes('Rating Guide') && page.includes('Passing score: 2.50'));
assert(page.includes('4</strong> Exceeds Expectations') && page.includes('1</strong> Does Not Meet'));
assert(page.includes('N/A</strong> Not Applicable / Insufficient Evidence'));
assert(page.includes('Behavioral Rating Guide') && page.includes('HR Remarks'));
assert(page.includes('performance-supporting-summary') && page.includes('Structured Development Plan'));
assert(!page.includes('Employee Comments') && !page.includes('Acknowledgement Comments'));
assert(authUi.includes("performance: new Set(['hr_admin', 'hr_manager', 'employee'])"));
assert(authUi.includes("hr_admin: 'hr_manager'") && authUi.includes("hr_manager: 'hr_manager'"));
assert(authUi.includes("manager: 'hr_manager'"));
assert(middleware.includes("require('./utils/role-normalization')"));
assert(ui.includes("return performanceRole() === 'hr_manager'"));
assert(!ui.includes('savePerformanceSelfAssessment') && !ui.includes('acknowledgePerformanceReview'));
assert(ui.includes('loadPerformanceDepartments') && ui.includes('renderPerformancePagination'));
assert(page.includes('id="performance-department-filter"') && page.includes('id="performance-pagination"'));
assert(page.includes('id="performance-review-photo"'));
assert(page.includes('id="performance-assignment-department"'));
assert(ui.includes('Verified / approved trips') && ui.includes('Paid / included in payroll'));
assert(ui.includes('Operational source is not configured. No value is shown.'));
assert(api.includes('e.id AS employee_record_id') && api.includes('employee_record_id: Number(row.employee_record_id)'));
assert(ui.includes('hydratePerformanceEmployeePhoto') && ui.includes('/photo`'));
assert(ui.includes("apiFetch(`/api/performance${path}`, { cache: 'no-store', ...options })"));
assert(ui.includes("apiFetch(`/api/employees/${employeeRecordId}/photo`, { cache: 'no-store' })"));
assert(!ui.includes('await fetch('), 'Performance must use the shared authenticated API helper for protected requests.');
assert(!ui.includes('Authorization: `Bearer'), 'Performance must not construct bearer headers itself.');
assert(ui.includes('error.status = response.status') && ui.includes("error.code = payload.code || 'PERFORMANCE_REQUEST_FAILED'"));
assert(ui.includes('initializationPromise'), 'Performance initialization must collapse concurrent navigation calls.');
assert(ui.includes('filterPerformanceAssignmentEmployees'));
assert(!ui.includes('const PERFORMANCE_CRITERIA ='), 'Frontend must render the backend-owned review questionnaire.');
assert(ui.includes('review.questionnaire?.criteria') && ui.includes('collectPerformanceNaReasons'));
assert(indexPage.includes('sidebar-collapse-toggle-icon') && indexPage.includes('&#8249;'));
assert(authUi.includes("icon.textContent = isCollapsed ? '\\u203a' : '\\u2039'"));
assert(themeCss.includes('overflow: visible !important;'));
assert(!mainCss.includes('.sidebar-collapse-toggle-icon::before'));
assert(moduleCode.includes('performance-management.js') && moduleCode.includes('public/js/performance.js'));
assert(questionnaireConfig.includes('PERFORMANCE_CORE_CRITERIA') && questionnaireConfig.includes('PERFORMANCE_ROLE_SECTIONS'));
assert(questionnaireConfig.includes('resolvePerformanceQuestionnaire') && questionnaireConfig.includes('validatePerformanceQuestionnaire'));
assert(questionnaireMigration.includes('questionnaire_snapshot_encrypted') && questionnaireMigration.includes('scoring_snapshot_encrypted'));

for (const threat of ['Spoofing', 'Tampering', 'Repudiation', 'Information Disclosure', 'Denial of Service', 'Elevation of Privilege']) {
  assert(stride.includes(`| ${threat} |`), `STRIDE evidence is missing ${threat}.`);
}

const {
  calculateIntegrityHash,
  calculateEvaluationScore,
  PERFORMANCE_CRITERIA,
  performanceOutcome,
  performanceStepUpFailure,
  parseIndicatorRatings,
  combineSupportingRows,
  VERIFIED_OPERATIONAL_STATUSES,
} = require('../server/performance-management');
assert.deepStrictEqual(VERIFIED_OPERATIONAL_STATUSES, ['Approved', 'Payroll Ready', 'Included in Payroll', 'Paid']);
assert.deepStrictEqual(
  combineSupportingRows([{ verified_records: '2', output_quantity: '15', verified_amount: '120.50' }, { verified_records: 1, output_quantity: null, verified_amount: 40 }], ['verified_records', 'output_quantity', 'verified_amount']),
  { verified_records: 3, output_quantity: 15, verified_amount: 160.5 }
);
const indicatorRatings = Object.fromEntries(PERFORMANCE_CRITERIA.map((criterion, criterionIndex) => [
  criterion.key,
  Object.fromEntries(criterion.indicators.map(indicator => [indicator.key, [4, 3, 4, 3, 3][criterionIndex]])),
]));
const finalized = {
  id: 9,
  cycle_id: 3,
  employee_id: 101,
  reviewer_user_id: 7,
  indicator_ratings_encrypted: 'encrypted-ratings', final_score: '3.40', goals_encrypted: 'encrypted-goals',
  reviewer_feedback_encrypted: 'encrypted-feedback', development_plan_encrypted: 'encrypted-plan',
};
const originalHash = calculateIntegrityHash(finalized);
assert.strictEqual(originalHash.length, 64);
assert.strictEqual(calculateIntegrityHash({ ...finalized }), originalHash);
assert.notStrictEqual(calculateIntegrityHash({ ...finalized, indicator_ratings_encrypted: 'tampered-ratings' }), originalHash);
assert.notStrictEqual(calculateIntegrityHash({ ...finalized, reviewer_feedback_encrypted: 'tampered' }), originalHash);

assert.strictEqual(PERFORMANCE_CRITERIA.length, 5);
assert(PERFORMANCE_CRITERIA.every(criterion => criterion.indicators.length === 4));
assert.deepStrictEqual(parseIndicatorRatings(indicatorRatings), indicatorRatings);
assert.strictEqual(calculateEvaluationScore(indicatorRatings).overall_score, 3.4);
assert.strictEqual(calculateEvaluationScore(indicatorRatings).complete, true);
assert.strictEqual(calculateEvaluationScore({}).complete, false);
assert.throws(() => parseIndicatorRatings({ unexpected: {} }), /unsupported criteria/);
assert.throws(() => parseIndicatorRatings(Object.fromEntries(PERFORMANCE_CRITERIA.map(criterion => [criterion.key, Object.fromEntries(criterion.indicators.map(indicator => [indicator.key, 5]))]))), /1 to 4/);
assert.strictEqual(performanceOutcome(3.75).code, 'EXCELLENT');
assert.strictEqual(performanceOutcome(null).code, 'PENDING');
assert.strictEqual(performanceOutcome(3.00).code, 'SATISFACTORY');
assert.strictEqual(performanceOutcome(2.00).code, 'NEEDS_IMPROVEMENT');
assert.strictEqual(performanceOutcome(1.25).code, 'UNSATISFACTORY');
assert.strictEqual(performanceOutcome(2.00, '2026-07-01').requires_reassessment, true);
assert.strictEqual(performanceOutcome(1.25).hr_case_review_required, true);
assert.strictEqual(performanceOutcome(2.49).passed, false);
assert.strictEqual(performanceOutcome(2.50).passed, true);
const stepUpFailure = performanceStepUpFailure();
assert.strictEqual(stepUpFailure.statusCode, 403);
assert.strictEqual(stepUpFailure.code, 'PERFORMANCE_STEP_UP_FAILED');

console.log('Performance Management STRIDE and security controls: PASS');
