'use strict';

// Performance questionnaire definitions are owned by the server. The browser
// receives an assigned-review snapshot and may submit only ratings and bounded
// narratives for the keys contained in that snapshot.
const QUESTIONNAIRE_VERSION = 'v2';
const MIN_NUMERIC_RATING_COVERAGE = 0.75;
const MIN_NUMERIC_RATINGS_PER_CRITERION = 2;

const PERFORMANCE_RATING_SCALE = Object.freeze([
  { value: 4, label: 'Exceeds Expectations', description: 'Consistently exceeds established requirements and produces documented results beyond normal job expectations.' },
  { value: 3, label: 'Meets Expectations', description: 'Consistently performs according to the established requirements for the position.' },
  { value: 2, label: 'Partially Meets Expectations', description: 'Sometimes meets requirements but needs improvement, coaching, or closer supervision.' },
  { value: 1, label: 'Does Not Meet Expectations', description: 'Consistently performs below established requirements or has documented serious deficiencies.' },
  { value: 'NA', label: 'Not Applicable / Insufficient Evidence', description: 'The indicator is not relevant to the role or there is insufficient evidence during the appraisal period.' },
]);

const PERFORMANCE_REVIEW_TYPES = Object.freeze(['REGULAR', 'PROBATIONARY', 'ANNUAL', 'SPECIAL']);

function defaultAnchors(text) {
  return {
    4: `Consistently exceeds expectations for: ${text}`,
    3: `Meets the normal expectations for: ${text}`,
    2: `Needs coaching or closer follow-up for: ${text}`,
    1: `Has documented and continuing deficiencies for: ${text}`,
  };
}

function indicator(key, text, anchors = null) {
  return Object.freeze({ key, text, anchors: anchors || defaultAnchors(text) });
}

function criterion(key, label, basis, entries) {
  return Object.freeze({ key, label, basis, indicators: Object.freeze(entries.map(entry => indicator(...entry))) });
}

const PERFORMANCE_CORE_CRITERIA = Object.freeze([
  criterion('attendance_punctuality', 'Attendance and Punctuality', 'Validated attendance, approved leave, and documented schedule records.', [
    ['reports_to_schedule', 'Reports to work according to the assigned schedule.', {
      4: 'Consistently reports on time and demonstrates exemplary attendance discipline.',
      3: 'Generally reports on time with only minor and properly documented exceptions.',
      2: 'Has repeated tardiness or schedule issues that require coaching.',
      1: 'Frequently fails to follow the assigned schedule or has serious attendance violations.',
    }],
    ['maintains_punctuality', 'Maintains acceptable punctuality during the review period.'],
    ['follows_absence_reporting', 'Properly follows leave and absence-reporting procedures.'],
    ['follows_attendance_policy', 'Complies with working-hour, break, and attendance policies.'],
  ]),
  criterion('work_output_productivity', 'Work Output and Productivity', 'Verified completion records, approved output, and supervisor observations.', [
    ['completes_work_on_time', 'Completes assigned work within expected deadlines.'],
    ['meets_output_requirements', 'Meets established output or task requirements.'],
    ['maintains_productivity', 'Maintains consistent productivity throughout the review period.'],
    ['manages_workload', 'Prioritizes and manages assigned workload effectively.'],
  ]),
  criterion('work_quality_accuracy', 'Work Quality and Accuracy', 'Accepted output, quality records, corrections, and documented rework.', [
    ['accurate_acceptable_output', 'Produces accurate and acceptable work output.'],
    ['minimal_avoidable_errors', 'Performs duties with minimal avoidable errors.'],
    ['follows_quality_procedures', 'Follows approved work procedures and quality standards.'],
    ['minimal_rework', 'Requires minimal correction, rejection, or rework.'],
  ]),
  criterion('compliance_safety_conduct', 'Compliance, Safety, and Professional Conduct', 'Applicable policy, safety, incident, and conduct records.', [
    ['complies_with_policies', 'Complies with company policies and procedures.'],
    ['follows_safety_requirements', 'Follows applicable safety and operational requirements.'],
    ['professional_behavior', 'Demonstrates respectful and professional workplace behavior.'],
    ['acceptable_conduct_record', 'Maintains acceptable disciplinary and conduct records.'],
  ]),
  criterion('reliability_accountability', 'Reliability and Accountability', 'Assignment completion, shift records, follow-up records, and observations.', [
    ['completes_responsibilities', 'Completes assigned responsibilities as expected.'],
    ['dependable_during_work', 'Can be depended upon during assigned shifts or work periods.'],
    ['accepts_accountability', 'Accepts responsibility for actions, decisions, and work results.'],
    ['responds_to_follow_up', 'Responds appropriately to instructions and follow-up requirements.'],
  ]),
  criterion('communication_teamwork', 'Communication and Teamwork', 'Work coordination, records, and supervisor observations.', [
    ['communicates_clearly', 'Communicates work-related information clearly and promptly.'],
    ['cooperates_with_team', 'Cooperates effectively with coworkers and supervisors.'],
    ['shares_relevant_information', 'Shares relevant information needed by other teams or departments.'],
    ['handles_disagreements_professionally', 'Handles disagreements and workplace concerns professionally.'],
  ]),
  criterion('initiative_problem_solving', 'Initiative and Problem-Solving', 'Documented issue reports, improvement suggestions, and work observations.', [
    ['appropriate_initiative', 'Takes appropriate initiative without requiring constant supervision.'],
    ['reports_issues_promptly', 'Identifies and reports work-related issues promptly.'],
    ['applies_practical_solutions', 'Applies practical solutions to routine work problems.'],
    ['suggests_improvements', 'Suggests reasonable improvements to work processes.'],
  ]),
  criterion('adaptability_development', 'Adaptability and Continuous Development', 'Training, coaching, process-change, and work observations.', [
    ['adapts_to_change', 'Adapts appropriately to changes in schedules, duties, tools, or procedures.'],
    ['accepts_feedback', 'Accepts constructive feedback professionally.'],
    ['applies_learning', 'Applies knowledge gained from coaching or training.'],
    ['improves_job_knowledge', 'Demonstrates willingness to improve job-related knowledge and skills.'],
  ]),
  criterion('job_knowledge_technical_competence', 'Job Knowledge and Technical Competence', 'Position requirements, training records, and approved operating procedures.', [
    ['knows_assigned_duties', 'Demonstrates adequate knowledge of assigned duties.'],
    ['uses_required_tools', 'Correctly uses the tools, systems, machines, or equipment required for the position.'],
    ['understands_standards', 'Understands applicable job standards and operating procedures.'],
    ['appropriate_supervision', 'Performs routine duties with the appropriate level of supervision.'],
  ]),
]);

const PERFORMANCE_ROLE_SECTIONS = Object.freeze({
  production: criterion('production_operations', 'Production / Operator Competencies', 'Verified production output, quality, safety, and approved piece-rate records.', [
    ['meets_production_targets', 'Meets verified production-output targets.'],
    ['operates_tools_properly', 'Operates assigned machinery or tools according to procedure.'],
    ['minimizes_waste_downtime', 'Minimizes material waste, rejected output, and avoidable downtime.'],
    ['maintains_production_standards', 'Maintains required production and safety standards.'],
    ['reports_equipment_issues', 'Reports equipment defects or production issues promptly.'],
    ['records_production_output', 'Correctly records piece-rate or production output where applicable.'],
  ]),
  logistics: criterion('logistics_delivery', 'Logistics / Delivery Competencies', 'Verified trip, delivery, route, cargo, and approved logistics records.', [
    ['completes_trips_on_schedule', 'Completes verified trips or deliveries within expected schedules.'],
    ['accurate_logistics_records', 'Maintains accuracy of trip, delivery, and logistics records.'],
    ['follows_route_vehicle_safety', 'Follows route, vehicle, cargo, and safety procedures.'],
    ['reports_delays_incidents', 'Reports delays, incidents, or discrepancies promptly.'],
    ['handles_documents_deliveries', 'Properly handles assigned documents, materials, or deliveries.'],
    ['maintains_trip_turnaround', 'Maintains acceptable trip completion and turnaround performance.'],
  ]),
  office: criterion('office_administration', 'Office / Administrative Competencies', 'Approved transaction records, service requests, and administrative work outputs.', [
    ['accurate_transactions', 'Processes assigned documents or transactions accurately.'],
    ['responds_to_requests', 'Responds to internal requests within expected timelines.'],
    ['maintains_records', 'Maintains organized and complete records.'],
    ['uses_information_systems', 'Uses assigned information systems correctly.'],
    ['protects_confidential_information', 'Protects confidential company and employee information.'],
    ['coordinates_departments', 'Coordinates effectively with relevant departments.'],
  ]),
  hr: criterion('human_resources', 'Human Resources Competencies', 'Authorized HR records, lifecycle work, and audited HR transactions.', [
    ['accurate_employee_records', 'Maintains accurate and complete employee records.'],
    ['timely_hr_transactions', 'Processes employee concerns and HR transactions on time.'],
    ['consistent_hr_policy', 'Applies HR policies consistently.'],
    ['protects_employee_privacy', 'Protects employee privacy and confidential information.'],
    ['accurate_lifecycle_tasks', 'Completes onboarding, leave, attendance, or lifecycle tasks accurately.'],
    ['maintains_hr_auditability', 'Maintains proper documentation and auditability of HR actions.'],
  ]),
  payroll: criterion('payroll_accuracy', 'Payroll Competencies', 'Approved payroll records, discrepancy records, and audit evidence.', [
    ['accurate_payroll_records', 'Maintains accuracy of payroll computations and records.'],
    ['timely_payroll_activities', 'Processes assigned payroll activities within deadlines.'],
    ['resolves_payroll_discrepancies', 'Resolves payroll discrepancies promptly.'],
    ['applies_verified_payroll_data', 'Correctly applies approved attendance, production, logistics, and deduction data.'],
    ['protects_payroll_confidentiality', 'Protects confidential salary and payroll information.'],
    ['maintains_payroll_audit_records', 'Maintains complete approval and audit records.'],
  ]),
  it: criterion('information_technology', 'Information Technology Competencies', 'Authorized service, change, incident, and security records.', [
    ['responds_to_incidents', 'Responds to assigned incidents and support concerns within expected time.'],
    ['maintains_operational_readiness', 'Maintains system availability and operational readiness.'],
    ['follows_security_change_process', 'Follows approved security and change-management procedures.'],
    ['documents_changes_resolutions', 'Properly documents system changes, incidents, and resolutions.'],
    ['protects_privileged_credentials', 'Protects privileged credentials and confidential system information.'],
    ['escalates_technical_risks', 'Escalates unresolved technical or security issues appropriately.'],
  ]),
  leadership: criterion('leadership_management', 'Leadership and Management Competencies', 'Team assignment, coaching, follow-up, and operational accountability records.', [
    ['assigns_duties_effectively', 'Assigns duties based on team responsibilities and capacity.'],
    ['sets_clear_expectations', 'Provides clear instructions and expectations.'],
    ['monitors_team_performance', 'Monitors team performance and follows up on deficiencies.'],
    ['provides_coaching', 'Provides constructive coaching and feedback.'],
    ['makes_timely_decisions', 'Makes reasonable and timely work-related decisions.'],
    ['handles_conflicts_professionally', 'Handles workplace conflicts professionally.'],
    ['manages_resources', 'Manages available people, time, and resources effectively.'],
    ['accountable_for_team_results', 'Accepts accountability for team performance and operational outcomes.'],
  ]),
});

// Original reviews retain this questionnaire exactly. It is intentionally
// separate from v2 so finalized historical integrity hashes remain valid.
const PERFORMANCE_V1_CRITERIA = Object.freeze([
  criterion('attendance_punctuality', 'Attendance and Punctuality', 'Validated biometric attendance, tardiness, unexcused absences, and approved leave records.', [
    ['reports_on_time', 'The employee regularly reports to work on time.'], ['minimal_unexcused_absences', 'The employee has minimal unexcused absences.'], ['proper_leave_filing', 'The employee properly files leave requests when needed.'], ['follows_working_hours', 'The employee follows assigned working hours and attendance policies.'],
  ]),
  criterion('work_output_productivity', 'Work Output / Productivity', 'Verified task completion, production piece-rate logs, logistics trip logs, and approved output targets.', [
    ['completes_work_on_time', 'The employee completes assigned work within the expected period.'], ['meets_output_requirements', 'The employee meets expected production output or task requirements.'], ['consistent_performance', 'The employee maintains consistent work performance during the evaluation period.'], ['contributes_to_operations', 'The employee contributes effectively to assigned operational tasks.'],
  ]),
  criterion('work_quality_accuracy', 'Work Quality / Accuracy', 'Accepted output, documented errors, rework, supervisor reports, and approved quality standards.', [
    ['minimal_errors', 'The employee performs tasks with minimal errors.'], ['follows_procedures', 'The employee follows proper work procedures.'], ['accurate_output', 'The employee produces accurate and acceptable work output.'], ['minimal_rework', 'The employee requires minimal correction or rework.'],
  ]),
  criterion('compliance_conduct', 'Compliance and Conduct', 'Applicable 201-file records, incident notes, policy compliance, and documented HR observations.', [
    ['follows_company_rules', 'The employee follows company rules and policies.'], ['proper_workplace_behavior', 'The employee observes proper workplace behavior.'], ['follows_safety_procedures', 'The employee follows applicable safety and operational requirements.'], ['no_major_conduct_issues', 'The employee has no major disciplinary and conduct issues.'],
  ]),
  criterion('reliability_responsibility', 'Reliability and Responsibility', 'Task completion, attendance consistency, documented instructions, and HR or supervisor observations.', [
    ['completes_assigned_tasks', 'The employee can be trusted to complete assigned tasks.'], ['handles_duties_responsibly', 'The employee shows responsibility in handling work duties.'], ['dependable_during_shifts', 'The employee is dependable during assigned shifts or work periods.'], ['responds_to_instructions', 'The employee responds properly to instructions and work requirements.'],
  ]),
]);

function normalizedText(value) {
  return String(value || '').trim().toLowerCase();
}

function hasAny(value, terms) {
  const text = normalizedText(value);
  return terms.some(term => text.includes(term));
}

function resolveEmployeeClassification(employee = {}) {
  const department = String(employee.department_name || employee.department || '').trim();
  const position = String(employee.position || '').trim();
  const employeeLevel = String(employee.employee_level || employee.level || '').trim();
  const wageType = String(employee.wage_type || employee.wage_type_name || '').trim();
  const combined = [department, position, employeeLevel, wageType, employee.job_category].join(' ');
  let roleSection = null;
  if (hasAny(combined, ['human resources', ' hr ', 'hr admin', 'hr manager'])) roleSection = 'hr';
  else if (hasAny(combined, ['payroll', 'compensation'])) roleSection = 'payroll';
  else if (hasAny(combined, ['information technology', ' it ', 'it staff', 'developer', 'technical support', 'system administrator'])) roleSection = 'it';
  else if (hasAny(combined, ['logistics', 'driver', 'helper', 'dispatcher', 'per trip', 'per-trip'])) roleSection = 'logistics';
  else if (hasAny(combined, ['production', 'operator', 'sewing', 'per piece', 'per-piece'])) roleSection = 'production';
  else if (hasAny(combined, ['office', 'administration', 'administrative', 'clerical', 'secretary'])) roleSection = 'office';
  const leadership = hasAny([employeeLevel, position].join(' '), ['supervisor', 'manager', 'executive']);
  return Object.freeze({
    department, position, employee_level: employeeLevel, wage_type: wageType,
    job_category: roleSection || 'general', role_section: roleSection,
    supervisory_responsibility: leadership,
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function withWeights(criteria, section, allocation) {
  const weight = Number((allocation / criteria.length).toFixed(6));
  return criteria.map(item => ({ ...clone(item), section, weight }));
}

function v1Questionnaire() {
  return {
    version: 'v1', rating_scale_version: 'v1', rating_scale: PERFORMANCE_RATING_SCALE.filter(item => item.value !== 'NA'),
    criteria: withWeights(PERFORMANCE_V1_CRITERIA, 'core', 100), classification: { job_category: 'historical' },
    applicability: { minimum_numeric_coverage: 1, minimum_numeric_ratings_per_criterion: 4, na_supported: false },
    score_weights: { competency_weight: 100, goal_weight: 0, sections: { core: 100 } },
  };
}

function resolvePerformanceQuestionnaire({ employee = {}, cycle = {} } = {}) {
  if (String(cycle.questionnaire_version || '').toLowerCase() === 'v1') return v1Questionnaire();
  const classification = resolveEmployeeClassification(employee);
  const sections = ['core'];
  if (classification.role_section) sections.push('role');
  if (classification.supervisory_responsibility) sections.push('leadership');
  const allocations = sections.length === 3
    ? { core: 50, role: 25, leadership: 25 }
    : sections.length === 2 && classification.role_section
      ? { core: 70, role: 30 }
      : sections.length === 2
        ? { core: 75, leadership: 25 }
        : { core: 100 };
  const criteria = [
    ...withWeights(PERFORMANCE_CORE_CRITERIA, 'core', allocations.core),
    ...(classification.role_section ? withWeights([PERFORMANCE_ROLE_SECTIONS[classification.role_section]], 'role', allocations.role) : []),
    ...(classification.supervisory_responsibility ? withWeights([PERFORMANCE_ROLE_SECTIONS.leadership], 'leadership', allocations.leadership) : []),
  ];
  const questionnaire = {
    version: QUESTIONNAIRE_VERSION,
    rating_scale_version: QUESTIONNAIRE_VERSION,
    rating_scale: clone(PERFORMANCE_RATING_SCALE),
    criteria,
    classification,
    applicability: {
      minimum_numeric_coverage: MIN_NUMERIC_RATING_COVERAGE,
      minimum_numeric_ratings_per_criterion: MIN_NUMERIC_RATINGS_PER_CRITERION,
      na_supported: true,
    },
    score_weights: {
      competency_weight: Number(cycle.competency_weight ?? 70),
      goal_weight: Number(cycle.goal_weight ?? 30),
      sections: allocations,
    },
  };
  validatePerformanceQuestionnaire(questionnaire);
  return questionnaire;
}

function validatePerformanceQuestionnaire(questionnaire) {
  if (!questionnaire || !Array.isArray(questionnaire.criteria) || !questionnaire.criteria.length || questionnaire.criteria.length > 12) {
    throw new Error('Performance questionnaire criteria are invalid.');
  }
  const criterionKeys = new Set();
  let weight = 0;
  let indicators = 0;
  for (const item of questionnaire.criteria) {
    if (!item?.key || criterionKeys.has(item.key) || !Array.isArray(item.indicators) || item.indicators.length < 1 || item.indicators.length > 8) {
      throw new Error('Performance questionnaire contains an invalid criterion.');
    }
    criterionKeys.add(item.key);
    const indicatorKeys = new Set();
    for (const question of item.indicators) {
      if (!question?.key || !question.text || indicatorKeys.has(question.key)) throw new Error('Performance questionnaire contains an invalid indicator.');
      indicatorKeys.add(question.key);
      indicators += 1;
    }
    weight += Number(item.weight || 0);
  }
  if (indicators > 56 || Math.abs(weight - 100) > 0.001) throw new Error('Performance questionnaire weights are invalid.');
  const competencyWeight = Number(questionnaire.score_weights?.competency_weight);
  const goalWeight = Number(questionnaire.score_weights?.goal_weight);
  if (competencyWeight < 0 || goalWeight < 0 || Math.abs((competencyWeight + goalWeight) - 100) > 0.001) {
    throw new Error('Performance score weights must total 100.');
  }
  return true;
}

module.exports = {
  QUESTIONNAIRE_VERSION,
  PERFORMANCE_CORE_CRITERIA,
  PERFORMANCE_ROLE_SECTIONS,
  PERFORMANCE_RATING_SCALE,
  PERFORMANCE_REVIEW_TYPES,
  PERFORMANCE_V1_CRITERIA,
  MIN_NUMERIC_RATING_COVERAGE,
  MIN_NUMERIC_RATINGS_PER_CRITERION,
  resolveEmployeeClassification,
  resolvePerformanceQuestionnaire,
  validatePerformanceQuestionnaire,
};
