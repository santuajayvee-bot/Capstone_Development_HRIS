'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.DB_USER ||= 'test';
process.env.DB_PASSWORD ||= 'test-only';
process.env.DB_NAME ||= 'test';
process.env.JWT_SECRET ||= 'performance-questionnaire-v2-test-secret-that-is-long-enough';

const questionnaire = require('../server/config/performance-questionnaire');
const performance = require('../server/performance-management');
const { encryptColumnValue, decryptColumnValue } = require('../server/data-protection');

const cycle = { questionnaire_version: 'v2', competency_weight: 70, goal_weight: 30 };
const office = questionnaire.resolvePerformanceQuestionnaire({
  employee: { department_name: 'Administration', position: 'Administrative Assistant', employee_level: 'Rank and File', wage_type: 'Monthly' },
  cycle,
});
const production = questionnaire.resolvePerformanceQuestionnaire({
  employee: { department_name: 'Production', position: 'Machine Operator', employee_level: 'Rank and File', wage_type: 'Per Piece' },
  cycle,
});
const logistics = questionnaire.resolvePerformanceQuestionnaire({
  employee: { department_name: 'Logistics', position: 'Driver', employee_level: 'Rank and File', wage_type: 'Per Trip' },
  cycle,
});
const supervisor = questionnaire.resolvePerformanceQuestionnaire({
  employee: { department_name: 'Production', position: 'Production Supervisor', employee_level: 'Supervisor', wage_type: 'Per Piece' },
  cycle,
});
const hr = questionnaire.resolvePerformanceQuestionnaire({
  employee: { department_name: 'HR', position: 'HR Staff', employee_level: 'Rank and File', wage_type: 'Monthly' },
  cycle,
});
const legacy = questionnaire.resolvePerformanceQuestionnaire({ cycle: { questionnaire_version: 'v1' } });

assert.strictEqual(questionnaire.PERFORMANCE_CORE_CRITERIA.length, 9);
assert.strictEqual(questionnaire.PERFORMANCE_CORE_CRITERIA.reduce((total, item) => total + item.indicators.length, 0), 36);
assert.strictEqual(legacy.criteria.length, 5);
assert.strictEqual(legacy.criteria.reduce((total, item) => total + item.indicators.length, 0), 20);
assert.strictEqual(office.criteria.some(item => item.key === 'production_operations'), false);
assert.strictEqual(office.criteria.some(item => item.key === 'logistics_delivery'), false);
assert.strictEqual(production.criteria.some(item => item.key === 'production_operations'), true);
assert.strictEqual(production.criteria.some(item => item.key === 'logistics_delivery'), false);
assert.strictEqual(logistics.criteria.some(item => item.key === 'logistics_delivery'), true);
assert.strictEqual(logistics.criteria.some(item => item.key === 'production_operations'), false);
assert.strictEqual(supervisor.criteria.some(item => item.key === 'leadership_management'), true);
assert.strictEqual(hr.criteria.some(item => item.key === 'human_resources'), true);
assert.strictEqual(office.criteria.reduce((total, item) => total + item.indicators.length, 0), 42);
assert.strictEqual(supervisor.criteria.reduce((total, item) => total + item.indicators.length, 0), 50);
assert.strictEqual(questionnaire.validatePerformanceQuestionnaire(office), true);

for (const selected of [office, production, logistics, supervisor]) {
  const criterionKeys = selected.criteria.map(item => item.key);
  assert.strictEqual(new Set(criterionKeys).size, criterionKeys.length, 'criterion keys must be unique');
  for (const item of selected.criteria) {
    const indicatorKeys = item.indicators.map(indicator => indicator.key);
    assert.strictEqual(new Set(indicatorKeys).size, indicatorKeys.length, `${item.key} indicator keys must be unique`);
  }
  assert.strictEqual(Math.round(selected.criteria.reduce((sum, item) => sum + item.weight, 0) * 100) / 100, 100);
}

const fullRatings = Object.fromEntries(office.criteria.map(item => [
  item.key,
  Object.fromEntries(item.indicators.map(indicator => [indicator.key, 3])),
]));
fullRatings.attendance_punctuality.reports_to_schedule = 'NA';
const naReasons = performance.parseNaReasons({ attendance_punctuality: { reports_to_schedule: 'No scheduled shift fell inside the review period.' } }, fullRatings, office);
assert.strictEqual(naReasons.attendance_punctuality.reports_to_schedule.length > 0, true);
assert.throws(() => performance.parseNaReasons({}, fullRatings, office), /N\/A reason is required/);
const scored = performance.calculateEvaluationScore(fullRatings, office);
assert.strictEqual(scored.complete, true);
assert.strictEqual(scored.na_indicators, 1);
assert.strictEqual(scored.criteria_averages.attendance_punctuality, 3);
assert.strictEqual(scored.overall_score, 3);
assert.throws(() => performance.parseIndicatorRatings({ unsupported: {} }, office), /unsupported criteria/);
assert.throws(() => performance.parseIndicatorRatings({ ...fullRatings, attendance_punctuality: { unsupported: 4 } }, office), /unsupported indicators/);

const encryptedNaReasons = encryptColumnValue(JSON.stringify(naReasons));
assert(!encryptedNaReasons.includes('No scheduled shift'));
assert.strictEqual(JSON.parse(decryptColumnValue(encryptedNaReasons)).attendance_punctuality.reports_to_schedule, 'No scheduled shift fell inside the review period.');

const goals = [
  { rating: 3, status: 'ACHIEVED', weight: 60, measurement_direction: 'HIGHER_IS_BETTER', target_value: '100', actual_value: '110' },
  { rating: 4, status: 'EXCEEDED', weight: 40, measurement_direction: 'LOWER_IS_BETTER', target_value: '2', actual_value: '1' },
];
const goalScore = performance.calculateGoalScore(goals, 30);
assert.strictEqual(goalScore.complete, true);
assert.strictEqual(goalScore.score, 3.4);
assert.strictEqual(performance.suggestedGoalAchievement(goals[0]), 110);
assert.strictEqual(performance.suggestedGoalAchievement(goals[1]), 200);
const canonicalMeasuredGoals = JSON.parse(decryptColumnValue(performance.parseGoals([{
  title: 'Production target', target: 'Produce 2,000 pieces', target_value: '2000', actual_value: '1800',
  achievement_percentage: '1', measurement_type: 'COUNT', measurement_direction: 'HIGHER_IS_BETTER',
  status: 'IN_PROGRESS', rating: 2, weight: 100, evaluator_confirmed: true,
}], { version: 'v2', goalWeight: 30 })));
assert.strictEqual(canonicalMeasuredGoals[0].achievement_percentage, 90, 'Measured achievement must be derived from target and actual values.');
assert.throws(() => performance.validateGoalsForFinalization(goals, 30), /must be confirmed/);
goals.forEach(goal => { goal.evaluator_confirmed = true; });
assert.doesNotThrow(() => performance.validateGoalsForFinalization(goals, 30));
assert.strictEqual(performance.calculateFinalWeightedScore(3.25, 3.50, { score_weights: { competency_weight: 70, goal_weight: 30 } }), 3.33);
assert.throws(() => performance.parseScoreWeights(80, 30), /total 100/);
assert.deepStrictEqual(performance.parseScoreWeights(100, 0), { competency_weight: 100, goal_weight: 0 });

const migrationUp = fs.readFileSync(path.join(__dirname, '..', 'migrations/sqls/20260721133000_performance_questionnaire_v2-up.sql'), 'utf8');
const migrationDown = fs.readFileSync(path.join(__dirname, '..', 'migrations/sqls/20260721133000_performance_questionnaire_v2-down.sql'), 'utf8');
assert(migrationUp.includes('questionnaire_snapshot_encrypted') && migrationUp.includes('competency_weight') && migrationUp.includes('goal_weight'));
assert(migrationDown.includes('WARNING: This rollback permanently removes v2 questionnaire snapshots'));
const frontend = fs.readFileSync(path.join(__dirname, '..', 'public/js/performance.js'), 'utf8');
assert(!frontend.includes('const PERFORMANCE_CRITERIA ='), 'The browser must not define its own questionnaire.');
assert(frontend.includes('review.questionnaire?.criteria') && frontend.includes('criteria_evidence'));
assert(frontend.includes('function syncPerformanceManagerControls()'), 'Manager controls must be re-synchronized after the page renders.');
assert(frontend.includes("actions.removeAttribute('hidden')"), 'Manager action buttons must be explicitly restored for a verified manager session.');

console.log('Performance questionnaire v2 tests: PASS');
