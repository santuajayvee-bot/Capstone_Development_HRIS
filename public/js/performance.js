const PERFORMANCE_CRITERIA = [
  {
    key: 'attendance_punctuality', label: 'Attendance and Punctuality',
    basis: 'Biometric attendance, tardiness, unexcused absences, and approved leave records.',
    indicators: [
      ['reports_on_time', 'The employee regularly reports to work on time.'],
      ['minimal_unexcused_absences', 'The employee has minimal unexcused absences.'],
      ['proper_leave_filing', 'The employee properly files leave requests when needed.'],
      ['follows_working_hours', 'The employee follows assigned working hours and attendance policies.'],
    ],
  },
  {
    key: 'work_output_productivity', label: 'Work Output / Productivity',
    basis: 'Verified task completion, production piece-rate logs, logistics trip logs, and approved output targets.',
    indicators: [
      ['completes_work_on_time', 'The employee completes assigned work within the expected period.'],
      ['meets_output_requirements', 'The employee meets expected production output or task requirements.'],
      ['consistent_performance', 'The employee maintains consistent work performance during the evaluation period.'],
      ['contributes_to_operations', 'The employee contributes effectively to assigned operational tasks.'],
    ],
  },
  {
    key: 'work_quality_accuracy', label: 'Work Quality / Accuracy',
    basis: 'Accepted output, documented errors, rework, supervisor reports, and approved quality standards.',
    indicators: [
      ['minimal_errors', 'The employee performs tasks with minimal errors.'],
      ['follows_procedures', 'The employee follows proper work procedures.'],
      ['accurate_output', 'The employee produces accurate and acceptable work output.'],
      ['minimal_rework', 'The employee requires minimal correction or rework.'],
    ],
  },
  {
    key: 'compliance_conduct', label: 'Compliance and Conduct',
    basis: 'Applicable 201-file records, incident notes, policy compliance, and documented HR observations.',
    indicators: [
      ['follows_company_rules', 'The employee follows company rules and policies.'],
      ['proper_workplace_behavior', 'The employee observes proper workplace behavior.'],
      ['follows_safety_procedures', 'The employee complies with safety and operational procedures.'],
      ['no_major_conduct_issues', 'The employee has no major disciplinary or conduct-related issues.'],
    ],
  },
  {
    key: 'reliability_responsibility', label: 'Reliability and Responsibility',
    basis: 'Task completion, attendance consistency, documented instructions, and HR or supervisor observations.',
    indicators: [
      ['completes_assigned_tasks', 'The employee can be trusted to complete assigned tasks.'],
      ['handles_duties_responsibly', 'The employee shows responsibility in handling work duties.'],
      ['dependable_during_shifts', 'The employee is dependable during assigned shifts or work periods.'],
      ['responds_to_instructions', 'The employee responds properly to instructions and work requirements.'],
    ],
  },
];

let PERFORMANCE_STATE = {
  overview: null,
  reviews: [],
  employees: [],
  departments: [],
  pagination: { page: 1, page_size: 10, total_items: 0, total_pages: 1 },
  photoObjectUrl: null,
  currentReview: null,
  stepUpResolve: null,
  initialized: false,
};

function performanceUser() {
  return typeof getUser === 'function' ? (getUser() || {}) : {};
}

function performanceRole() {
  return typeof normalizeClientRole === 'function'
    ? normalizeClientRole(performanceUser().role)
    : String(performanceUser().role || '').toLowerCase();
}

function performanceCanManage() {
  return performanceRole() === 'hr_manager';
}

function performanceEscape(value) {
  return window.LgsvSecurity?.escapeHTML
    ? window.LgsvSecurity.escapeHTML(value)
    : String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function performanceDate(value) {
  if (!value) return '-';
  const text = String(value).slice(0, 10);
  const date = new Date(`${text}T00:00:00+08:00`);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' });
}

function performanceInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '--';
  return `${parts[0][0] || ''}${parts.length > 1 ? parts[parts.length - 1][0] || '' : ''}`.toUpperCase();
}

function revokePerformancePhoto() {
  if (PERFORMANCE_STATE.photoObjectUrl) URL.revokeObjectURL(PERFORMANCE_STATE.photoObjectUrl);
  PERFORMANCE_STATE.photoObjectUrl = null;
}

async function hydratePerformanceEmployeePhoto(review) {
  const target = document.getElementById('performance-review-photo');
  if (!target) return;
  revokePerformancePhoto();
  target.replaceChildren(document.createTextNode(performanceInitials(review.employee_name)));
  const employeeRecordId = Number(review.employee_record_id);
  if (!Number.isSafeInteger(employeeRecordId) || employeeRecordId <= 0) return;
  try {
    const response = await fetch(`/api/employees/${employeeRecordId}/photo`, {
      headers: { Authorization: `Bearer ${typeof getToken === 'function' ? getToken() : ''}` },
    });
    if (!response.ok) return;
    const blob = await response.blob();
    if (!String(blob.type || '').startsWith('image/')) return;
    PERFORMANCE_STATE.photoObjectUrl = URL.createObjectURL(blob);
    const image = document.createElement('img');
    image.src = PERFORMANCE_STATE.photoObjectUrl;
    image.alt = `${review.employee_name} profile picture`;
    target.replaceChildren(image);
  } catch (_error) {
    target.replaceChildren(document.createTextNode(performanceInitials(review.employee_name)));
  }
}

async function performanceNotice(message, title = 'Performance Management', type = 'info') {
  if (typeof showAlert === 'function') return showAlert(message, title, type);
  return alert(message);
}

async function performanceConfirm(message, title = 'Confirm Action', confirmText = 'Continue') {
  if (typeof showConfirm === 'function') return showConfirm(message, title, confirmText, 'Cancel');
  return confirm(message);
}

async function performanceApi(path, options = {}) {
  const token = typeof getToken === 'function' ? getToken() : null;
  const response = await fetch(`/api/performance${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Performance Management request failed.');
    error.code = payload.code;
    throw error;
  }
  return payload;
}

function performanceStatusLabel(status) {
  return ({
    ASSIGNED: 'In Progress',
    FINALIZED: 'Finalized',
  })[status] || status || '-';
}

function performanceStatusBadge(status) {
  return `<span class="performance-status performance-status-${String(status || '').toLowerCase().replace(/_/g, '-')}">${performanceEscape(performanceStatusLabel(status))}</span>`;
}

function performanceIntegrityBadge(status) {
  const label = ({ VERIFIED: 'Verified', MISMATCH: 'Mismatch', MISSING: 'Missing', NOT_FINALIZED: 'Pending' })[status] || status;
  return `<span class="performance-integrity performance-integrity-${String(status || '').toLowerCase().replace(/_/g, '-')}">${performanceEscape(label)}</span>`;
}

function performanceOutcomeClass(outcome) {
  return String(outcome?.code || 'pending').toLowerCase().replace(/_/g, '-');
}

function performanceOutcomeNotice(outcome) {
  if (!outcome || outcome.code === 'PENDING') return '';
  const reassessment = outcome.requires_reassessment && outcome.reassessment_due_date
    ? ` Reassessment due: ${performanceDate(outcome.reassessment_due_date)}.`
    : '';
  return `${outcome.notice || ''}${reassessment}`.trim();
}

async function initPerformanceManagement() {
  const manager = performanceCanManage();
  document.getElementById('performance-manager-actions')?.toggleAttribute('hidden', !manager);
  const search = document.getElementById('performance-search');
  if (search) search.hidden = !manager;
  const departmentFilter = document.getElementById('performance-department-filter');
  if (departmentFilter) departmentFilter.hidden = !manager;
  const pageCopy = document.getElementById('performance-page-copy');
  if (pageCopy) pageCopy.textContent = manager ? 'Employee appraisals and development plans' : 'My appraisals and development plans';
  const title = document.getElementById('performance-reviews-title');
  if (title) title.textContent = manager ? 'Performance Reviews' : 'My Performance Reviews';
  const copy = document.getElementById('performance-reviews-copy');
  if (copy) copy.textContent = manager ? 'Appraisal records by cycle and workflow status' : 'Your current and previous appraisal records';
  document.getElementById('performance-cycle-actions-heading')?.toggleAttribute('hidden', !manager);
  PERFORMANCE_STATE.initialized = true;
  await Promise.all([
    loadPerformanceOverview(),
    loadPerformanceReviews(),
    manager ? loadPerformanceEmployees() : Promise.resolve(),
    manager ? loadPerformanceDepartments() : Promise.resolve(),
  ]);
}

async function loadPerformanceOverview() {
  try {
    const overview = await performanceApi('/overview');
    PERFORMANCE_STATE.overview = overview;
    const summary = overview.summary || {};
    const values = {
      'performance-stat-total': summary.total,
      'performance-stat-progress': summary.in_progress,
      'performance-stat-finalized': summary.finalized,
      'performance-stat-passed': summary.passed,
      'performance-stat-follow-up': summary.needs_follow_up,
    };
    Object.entries(values).forEach(([id, value]) => {
      const element = document.getElementById(id);
      if (element) element.textContent = String(value || 0);
    });
    renderPerformanceCycles(overview.cycles || []);
  } catch (error) {
    document.getElementById('performance-cycles-body').innerHTML = `<tr><td colspan="6" class="performance-empty">${performanceEscape(error.message)}</td></tr>`;
  }
}

function renderPerformanceCycles(cycles) {
  const manager = performanceCanManage();
  const body = document.getElementById('performance-cycles-body');
  const filter = document.getElementById('performance-cycle-filter');
  const assignment = document.getElementById('performance-assignment-cycle');
  if (filter) {
    const selected = filter.value;
    filter.innerHTML = '<option value="">All Cycles</option>' + cycles.map(cycle => `<option value="${Number(cycle.id)}">${performanceEscape(cycle.cycle_name)}</option>`).join('');
    filter.value = selected;
  }
  if (assignment) {
    assignment.innerHTML = '<option value="">Select cycle</option>' + cycles
      .filter(cycle => ['DRAFT', 'ACTIVE'].includes(cycle.status))
      .map(cycle => `<option value="${Number(cycle.id)}">${performanceEscape(cycle.cycle_name)} (${performanceEscape(cycle.status)})</option>`).join('');
  }
  if (!body) return;
  if (!cycles.length) {
    body.innerHTML = '<tr><td colspan="6" class="performance-empty">No appraisal cycles yet.</td></tr>';
    return;
  }
  body.innerHTML = cycles.map(cycle => {
    const count = Number(cycle.review_count || 0);
    const finalized = Number(cycle.finalized_count || 0);
    const progress = count ? `${finalized} / ${count}` : '0 / 0';
    let action = '';
    if (manager && cycle.status === 'DRAFT') action = `<button class="performance-link-button" type="button" onclick="updatePerformanceCycleStatus(${Number(cycle.id)}, 'ACTIVE')">Activate</button>`;
    if (manager && cycle.status === 'ACTIVE') action = `<button class="performance-link-button" type="button" onclick="updatePerformanceCycleStatus(${Number(cycle.id)}, 'CLOSED')">Close</button>`;
    return `<tr>
      <td><strong>${performanceEscape(cycle.cycle_name)}</strong></td>
      <td>${performanceDate(cycle.review_period_start)} - ${performanceDate(cycle.review_period_end)}</td>
      <td>${performanceDate(cycle.due_date)}</td><td>${progress}</td>
      <td><span class="performance-status performance-status-${String(cycle.status).toLowerCase()}">${performanceEscape(cycle.status)}</span></td>
      <td${manager ? '' : ' hidden'}>${action || '-'}</td>
    </tr>`;
  }).join('');
}

async function loadPerformanceEmployees() {
  try {
    PERFORMANCE_STATE.employees = await performanceApi('/eligible-employees');
    renderPerformanceAssignmentDepartments();
    filterPerformanceAssignmentEmployees();
  } catch (error) {
    PERFORMANCE_STATE.employees = [];
    console.warn('[performance]', error.message);
  }
}

function renderPerformanceAssignmentDepartments() {
  const select = document.getElementById('performance-assignment-department');
  if (!select) return;
  const selected = select.value;
  const departments = [...new Map(PERFORMANCE_STATE.employees
    .filter(employee => employee.department_id)
    .map(employee => [Number(employee.department_id), employee.department_name || 'Unassigned'])).entries()]
    .sort((left, right) => left[1].localeCompare(right[1]));
  select.innerHTML = '<option value="">All Departments</option>' + departments.map(([id, name]) =>
    `<option value="${id}">${performanceEscape(name)}</option>`
  ).join('');
  select.value = selected;
}

function filterPerformanceAssignmentEmployees() {
  const departmentId = Number(document.getElementById('performance-assignment-department')?.value || 0);
  const select = document.getElementById('performance-assignment-employee');
  if (!select) return;
  const employees = departmentId
    ? PERFORMANCE_STATE.employees.filter(employee => Number(employee.department_id) === departmentId)
    : PERFORMANCE_STATE.employees;
  select.innerHTML = '<option value="">Select employee</option>' + employees.map(employee =>
    `<option value="${Number(employee.employee_id)}">${performanceEscape(employee.employee_code)} - ${performanceEscape(employee.employee_name)}</option>`
  ).join('');
}

async function loadPerformanceDepartments() {
  try {
    PERFORMANCE_STATE.departments = await performanceApi('/departments');
    const select = document.getElementById('performance-department-filter');
    if (!select) return;
    const selected = select.value;
    select.innerHTML = '<option value="">All Departments</option>' + PERFORMANCE_STATE.departments.map(department =>
      `<option value="${Number(department.id)}">${performanceEscape(department.name)}</option>`
    ).join('');
    select.value = selected;
  } catch (error) {
    PERFORMANCE_STATE.departments = [];
    console.warn('[performance]', error.message);
  }
}

async function loadPerformanceReviews() {
  const params = new URLSearchParams();
  const cycle = document.getElementById('performance-cycle-filter')?.value;
  const department = document.getElementById('performance-department-filter')?.value;
  const status = document.getElementById('performance-status-filter')?.value;
  const search = document.getElementById('performance-search')?.value.trim();
  const pageSize = Number(document.getElementById('performance-page-size')?.value || PERFORMANCE_STATE.pagination.page_size || 10);
  if (cycle) params.set('cycle_id', cycle);
  if (department && performanceCanManage()) params.set('department_id', department);
  if (status) params.set('status', status);
  if (search && performanceCanManage()) params.set('search', search);
  params.set('page', String(PERFORMANCE_STATE.pagination.page || 1));
  params.set('page_size', String(pageSize));
  const body = document.getElementById('performance-reviews-body');
  if (body) body.innerHTML = '<tr><td colspan="8" class="performance-empty">Loading reviews...</td></tr>';
  try {
    const payload = await performanceApi(`/reviews?${params}`);
    PERFORMANCE_STATE.reviews = Array.isArray(payload) ? payload : (payload.items || []);
    PERFORMANCE_STATE.pagination = payload.pagination || { page: 1, page_size: pageSize, total_items: PERFORMANCE_STATE.reviews.length, total_pages: 1 };
    renderPerformanceReviews();
    renderPerformancePagination();
  } catch (error) {
    if (body) body.innerHTML = `<tr><td colspan="8" class="performance-empty">${performanceEscape(error.message)}</td></tr>`;
    document.getElementById('performance-pagination')?.setAttribute('hidden', '');
  }
}

function resetPerformanceReviewPage() {
  PERFORMANCE_STATE.pagination.page = 1;
  return loadPerformanceReviews();
}

function changePerformanceReviewPage(direction) {
  const current = Number(PERFORMANCE_STATE.pagination.page || 1);
  const total = Number(PERFORMANCE_STATE.pagination.total_pages || 1);
  const next = Math.min(total, Math.max(1, current + Number(direction || 0)));
  if (next === current) return;
  PERFORMANCE_STATE.pagination.page = next;
  loadPerformanceReviews();
}

function renderPerformancePagination() {
  const pagination = PERFORMANCE_STATE.pagination;
  const container = document.getElementById('performance-pagination');
  if (!container) return;
  const totalItems = Number(pagination.total_items || 0);
  const page = Number(pagination.page || 1);
  const pageSize = Number(pagination.page_size || 10);
  const totalPages = Number(pagination.total_pages || 1);
  container.toggleAttribute('hidden', totalItems === 0);
  const start = totalItems ? ((page - 1) * pageSize) + 1 : 0;
  const end = Math.min(totalItems, page * pageSize);
  document.getElementById('performance-pagination-summary').textContent = `${start}-${end} of ${totalItems} evaluations`;
  document.getElementById('performance-pagination-page').textContent = `Page ${page} of ${totalPages}`;
  document.getElementById('performance-page-previous').disabled = page <= 1;
  document.getElementById('performance-page-next').disabled = page >= totalPages;
}

function renderPerformanceReviews() {
  const body = document.getElementById('performance-reviews-body');
  if (!body) return;
  if (!PERFORMANCE_STATE.reviews.length) {
    body.innerHTML = '<tr><td colspan="8" class="performance-empty">No performance reviews found.</td></tr>';
    return;
  }
  body.innerHTML = PERFORMANCE_STATE.reviews.map(review => `<tr class="${['MISMATCH', 'MISSING'].includes(review.integrity_status) ? 'performance-integrity-row' : ''}">
    <td><div class="performance-employee"><strong>${performanceEscape(review.employee_name)}</strong><small>${performanceEscape(review.employee_code)}</small></div></td>
    <td>${performanceEscape(review.cycle_name)}</td><td>${performanceEscape(review.department_name)}</td>
    <td>${performanceDate(review.due_date)}</td><td>${review.final_score === null ? '-' : `<div class="performance-score"><strong>${Number(review.final_score).toFixed(2)}</strong><small class="performance-outcome-${performanceOutcomeClass(review.outcome)}">${performanceEscape(review.outcome?.label || '')}</small></div>`}</td>
    <td>${performanceIntegrityBadge(review.integrity_status)}</td><td>${performanceStatusBadge(review.status)}</td>
    <td><button class="performance-link-button" type="button" onclick="openPerformanceReview(${Number(review.id)})">Open</button></td>
  </tr>`).join('');
}

function openPerformanceCycleModal() {
  document.getElementById('performance-cycle-form')?.reset();
  document.getElementById('performance-cycle-modal')?.removeAttribute('hidden');
  setTimeout(() => document.getElementById('performance-cycle-name')?.focus(), 30);
}

function openPerformanceAssignmentModal() {
  if (!PERFORMANCE_STATE.overview?.cycles?.some(cycle => ['DRAFT', 'ACTIVE'].includes(cycle.status))) {
    return performanceNotice('Create an appraisal cycle before assigning a review.', 'No Available Cycle', 'warning');
  }
  document.getElementById('performance-assignment-form')?.reset();
  renderPerformanceAssignmentDepartments();
  filterPerformanceAssignmentEmployees();
  const goals = document.getElementById('performance-assignment-goals');
  if (goals) goals.innerHTML = '';
  addPerformanceGoalRow();
  document.getElementById('performance-assignment-modal')?.removeAttribute('hidden');
}

function closePerformanceModal(id) {
  if (id === 'performance-review-modal') revokePerformancePhoto();
  document.getElementById(id)?.setAttribute('hidden', '');
}

function addPerformanceGoalRow(containerId = 'performance-assignment-goals', goal = {}, editable = true) {
  const container = document.getElementById(containerId);
  if (!container || container.children.length >= 8) return;
  const row = document.createElement('div');
  row.className = 'performance-goal-row';
  row.innerHTML = `<input data-goal-title maxlength="160" placeholder="Goal" value="${performanceEscape(goal.title || '')}" ${editable ? '' : 'readonly'} />
    <input data-goal-target maxlength="500" placeholder="Measurable target" value="${performanceEscape(goal.target || '')}" ${editable ? '' : 'readonly'} />
    ${editable ? '<button type="button" class="performance-goal-remove" aria-label="Remove goal" title="Remove goal">&times;</button>' : '<span></span>'}`;
  row.querySelector('.performance-goal-remove')?.addEventListener('click', () => row.remove());
  container.appendChild(row);
}

function addPerformanceReviewGoalRow(goal = {}) {
  addPerformanceGoalRow('performance-review-goals', goal, true);
}

function collectPerformanceGoals(containerId) {
  return [...document.querySelectorAll(`#${containerId} .performance-goal-row`)].map(row => ({
    title: row.querySelector('[data-goal-title]')?.value.trim() || '',
    target: row.querySelector('[data-goal-target]')?.value.trim() || '',
  })).filter(goal => goal.title || goal.target);
}

async function submitPerformanceCycle(event) {
  event.preventDefault();
  try {
    await performanceApi('/cycles', { method: 'POST', body: JSON.stringify({
      cycle_name: document.getElementById('performance-cycle-name').value,
      review_period_start: document.getElementById('performance-cycle-start').value,
      review_period_end: document.getElementById('performance-cycle-end').value,
      due_date: document.getElementById('performance-cycle-due').value,
      description: document.getElementById('performance-cycle-description').value,
    }) });
    closePerformanceModal('performance-cycle-modal');
    await loadPerformanceOverview();
    await performanceNotice('Appraisal cycle created.', 'Cycle Created', 'success');
  } catch (error) {
    await performanceNotice(error.message, 'Could Not Create Cycle', 'error');
  }
}

async function submitPerformanceAssignment(event) {
  event.preventDefault();
  try {
    await performanceApi('/reviews', { method: 'POST', body: JSON.stringify({
      cycle_id: Number(document.getElementById('performance-assignment-cycle').value),
      employee_id: Number(document.getElementById('performance-assignment-employee').value),
      goals: collectPerformanceGoals('performance-assignment-goals'),
    }) });
    closePerformanceModal('performance-assignment-modal');
    PERFORMANCE_STATE.pagination.page = 1;
    await Promise.all([loadPerformanceOverview(), loadPerformanceReviews()]);
    await performanceNotice('Performance review assigned.', 'Review Assigned', 'success');
  } catch (error) {
    await performanceNotice(error.message, 'Could Not Assign Review', 'error');
  }
}

async function updatePerformanceCycleStatus(cycleId, status) {
  const confirmed = await performanceConfirm(`Mark this appraisal cycle as ${status.toLowerCase()}?`, 'Update Cycle', status === 'ACTIVE' ? 'Activate' : 'Close Cycle');
  if (!confirmed) return;
  try {
    await performanceApi(`/cycles/${cycleId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
    await Promise.all([loadPerformanceOverview(), loadPerformanceReviews()]);
  } catch (error) {
    await performanceNotice(error.message, 'Could Not Update Cycle', 'error');
  }
}

function performanceRatingLabel(value) {
  return ({ 4: 'Excellent', 3: 'Satisfactory', 2: 'Needs Improvement', 1: 'Unsatisfactory' })[Number(value)] || 'Not rated';
}

function performanceRatingControl(criterionKey, indicatorKey, indicatorText, value, editable) {
  if (!editable) {
    return `<span class="performance-rating-readonly">${value === null || value === undefined ? '-' : `${Number(value)} - ${performanceEscape(performanceRatingLabel(value))}`}</span>`;
  }
  return `<select id="performance-rating-${performanceEscape(criterionKey)}-${performanceEscape(indicatorKey)}" aria-label="${performanceEscape(indicatorText)} rating" onchange="updatePerformanceRatingSummary()">
    <option value="">Not rated</option>${[4, 3, 2, 1].map(rating => `<option value="${rating}" ${Number(value) === rating ? 'selected' : ''}>${rating} - ${performanceEscape(performanceRatingLabel(rating))}</option>`).join('')}
  </select>`;
}

function calculateClientPerformanceScore(ratings) {
  const criteriaAverages = {};
  let complete = true;
  PERFORMANCE_CRITERIA.forEach(criterion => {
    const values = criterion.indicators.map(([indicatorKey]) => Number(ratings?.[criterion.key]?.[indicatorKey]));
    if (values.some(value => !Number.isInteger(value) || value < 1 || value > 4)) {
      criteriaAverages[criterion.key] = null;
      complete = false;
      return;
    }
    criteriaAverages[criterion.key] = Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
  });
  const averages = Object.values(criteriaAverages);
  return {
    criteriaAverages,
    overall: complete ? Number((averages.reduce((sum, value) => sum + value, 0) / averages.length).toFixed(2)) : null,
    complete,
  };
}

function collectPerformanceRatings() {
  return Object.fromEntries(PERFORMANCE_CRITERIA.map(criterion => [
    criterion.key,
    Object.fromEntries(criterion.indicators.map(([indicatorKey]) => [
      indicatorKey,
      document.getElementById(`performance-rating-${criterion.key}-${indicatorKey}`)?.value || null,
    ])),
  ]));
}

function updatePerformanceRatingSummary() {
  const summary = document.getElementById('performance-rating-summary');
  if (!summary) return;
  const review = PERFORMANCE_STATE.currentReview;
  const editable = performanceCanManage() && review?.status === 'ASSIGNED';
  const ratings = editable ? collectPerformanceRatings() : (review?.indicator_ratings || {});
  const result = calculateClientPerformanceScore(ratings);
  PERFORMANCE_CRITERIA.forEach(criterion => {
    const value = result.criteriaAverages[criterion.key];
    const element = document.querySelector(`[data-criterion-average="${criterion.key}"]`);
    if (element) element.textContent = value === null ? '-' : value.toFixed(2);
  });
  summary.innerHTML = `<div>${PERFORMANCE_CRITERIA.map(criterion => `<span>${performanceEscape(criterion.label)} <strong>${result.criteriaAverages[criterion.key] === null ? '-' : result.criteriaAverages[criterion.key].toFixed(2)}</strong></span>`).join('')}</div>
    <p>Overall Performance Rating <strong>${result.overall === null ? 'Incomplete' : result.overall.toFixed(2)}</strong></p>`;
}

async function openPerformanceReview(reviewId) {
  try {
    const review = await performanceApi(`/reviews/${reviewId}`);
    PERFORMANCE_STATE.currentReview = review;
    renderPerformanceReviewDialog(review);
    document.getElementById('performance-review-modal')?.removeAttribute('hidden');
    hydratePerformanceEmployeePhoto(review);
  } catch (error) {
    await performanceNotice(error.message, 'Could Not Open Review', 'error');
  }
}

function renderPerformanceReviewDialog(review) {
  const manager = performanceCanManage();
  const reviewerEditable = manager && review.status === 'ASSIGNED';
  document.getElementById('performance-review-dialog-title').textContent = review.employee_name;
  document.getElementById('performance-review-dialog-subtitle').textContent = `${review.employee_code} | ${review.cycle_name}`;
  const alert = document.getElementById('performance-integrity-alert');
  const failedIntegrity = ['MISMATCH', 'MISSING'].includes(review.integrity_status);
  alert.toggleAttribute('hidden', !failedIntegrity);
  if (failedIntegrity) alert.textContent = 'Integrity verification failed. This finalized evaluation may have been altered. Contact HR or the System Administrator.';
  const outcomeAlert = document.getElementById('performance-outcome-alert');
  const hasOutcome = review.outcome && review.outcome.code !== 'PENDING' && !failedIntegrity;
  outcomeAlert.toggleAttribute('hidden', !hasOutcome);
  outcomeAlert.className = `performance-outcome-alert performance-outcome-alert-${performanceOutcomeClass(review.outcome)}`;
  if (hasOutcome) {
    outcomeAlert.innerHTML = `<div><strong>${performanceEscape(review.outcome.label)}</strong><span>Final score: ${Number(review.final_score).toFixed(2)}</span></div><p>${performanceEscape(performanceOutcomeNotice(review.outcome))}</p>`;
  }
  document.getElementById('performance-review-meta').innerHTML = `
    <div><small>Department</small><strong>${performanceEscape(review.department_name)}</strong></div>
    <div><small>Position</small><strong>${performanceEscape(review.position)}</strong></div>
    <div><small>Due Date</small><strong>${performanceDate(review.due_date)}</strong></div>
    <div><small>Status</small><strong>${performanceEscape(performanceStatusLabel(review.status))}</strong></div>`;
  document.getElementById('performance-rating-grid').innerHTML = PERFORMANCE_CRITERIA.map(criterion => {
    const average = review.criteria_averages?.[criterion.key];
    return `<section class="performance-criterion">
      <div class="performance-criterion-heading"><div><h4>${performanceEscape(criterion.label)}</h4><p>${performanceEscape(criterion.basis)}</p></div><span>Average <strong data-criterion-average="${performanceEscape(criterion.key)}">${average === null || average === undefined ? '-' : Number(average).toFixed(2)}</strong></span></div>
      ${criterion.indicators.map(([indicatorKey, indicatorText]) => `<div class="performance-rating-row">
        <span>${performanceEscape(indicatorText)}</span>
        ${performanceRatingControl(criterion.key, indicatorKey, indicatorText, review.indicator_ratings?.[criterion.key]?.[indicatorKey], reviewerEditable)}
      </div>`).join('')}
    </section>`;
  }).join('');
  updatePerformanceRatingSummary();
  const goals = document.getElementById('performance-review-goals');
  goals.innerHTML = '';
  (review.goals || []).forEach(goal => addPerformanceGoalRow('performance-review-goals', goal, reviewerEditable));
  if (!(review.goals || []).length && reviewerEditable) addPerformanceReviewGoalRow();
  document.getElementById('performance-review-add-goal').hidden = !reviewerEditable;
  const feedback = document.getElementById('performance-reviewer-feedback');
  feedback.value = review.reviewer_feedback || '';
  feedback.readOnly = !reviewerEditable;
  const plan = document.getElementById('performance-development-plan');
  plan.value = review.development_plan || '';
  plan.readOnly = !reviewerEditable;
  renderPerformanceReviewActions(review, { manager, reviewerEditable });
}

function renderPerformanceReviewActions(review, context) {
  const actions = document.getElementById('performance-review-actions');
  const buttons = ['<button type="button" class="btn btn-outline" onclick="closePerformanceModal(\'performance-review-modal\')">Close</button>'];
  if (context.reviewerEditable) {
    buttons.push('<button type="button" class="btn btn-outline" onclick="savePerformanceEvaluation()">Save Evaluation</button>');
    buttons.push('<button type="button" class="btn btn-primary" onclick="finalizePerformanceReview()">Finalize Review</button>');
  }
  if (context.manager && review.status === 'FINALIZED') {
    buttons.push('<button type="button" class="btn btn-outline" onclick="reopenPerformanceReview()">Reopen Review</button>');
  }
  actions.innerHTML = buttons.join('');
}

async function refreshCurrentPerformanceReview() {
  const id = PERFORMANCE_STATE.currentReview?.id;
  if (!id) return;
  PERFORMANCE_STATE.currentReview = await performanceApi(`/reviews/${id}`);
  renderPerformanceReviewDialog(PERFORMANCE_STATE.currentReview);
  await Promise.all([loadPerformanceOverview(), loadPerformanceReviews()]);
}

async function savePerformanceEvaluation({ silent = false } = {}) {
  const review = PERFORMANCE_STATE.currentReview;
  if (!review) return false;
  try {
    const result = await performanceApi(`/reviews/${review.id}/evaluation`, { method: 'PUT', body: JSON.stringify({
      ratings: collectPerformanceRatings(),
      feedback: document.getElementById('performance-reviewer-feedback').value,
      development_plan: document.getElementById('performance-development-plan').value,
      goals: collectPerformanceGoals('performance-review-goals'),
      version: review.version,
    }) });
    review.version = result.version;
    if (!silent) {
      await refreshCurrentPerformanceReview();
      await performanceNotice(result.message, 'Evaluation Saved', 'success');
    }
    return true;
  } catch (error) {
    await performanceNotice(error.message, 'Could Not Save Evaluation', 'error');
    return false;
  }
}

function requestPerformanceStepUp({ title, message, requireReason = false }) {
  const modal = document.getElementById('performance-step-up-modal');
  document.getElementById('performance-step-up-title').textContent = title;
  document.getElementById('performance-step-up-message').textContent = message;
  document.getElementById('performance-step-up-password').value = '';
  document.getElementById('performance-step-up-reason').value = '';
  document.getElementById('performance-step-up-reason-wrap').hidden = !requireReason;
  document.getElementById('performance-step-up-reason').required = requireReason;
  modal.removeAttribute('hidden');
  setTimeout(() => document.getElementById('performance-step-up-password')?.focus(), 30);
  return new Promise(resolve => { PERFORMANCE_STATE.stepUpResolve = resolve; });
}

function submitPerformanceStepUp(event) {
  event.preventDefault();
  const reasonRequired = !document.getElementById('performance-step-up-reason-wrap').hidden;
  const password = document.getElementById('performance-step-up-password').value;
  const reason = document.getElementById('performance-step-up-reason').value.trim();
  if (!password || (reasonRequired && !reason)) return;
  resolvePerformanceStepUp({ password, reason });
}

function resolvePerformanceStepUp(value) {
  closePerformanceModal('performance-step-up-modal');
  const resolver = PERFORMANCE_STATE.stepUpResolve;
  PERFORMANCE_STATE.stepUpResolve = null;
  if (resolver) resolver(value);
}

async function finalizePerformanceReview() {
  const review = PERFORMANCE_STATE.currentReview;
  if (!review) return;
  const saved = await savePerformanceEvaluation({ silent: true });
  if (!saved) return;
  const proof = await requestPerformanceStepUp({ title: 'Finalize Performance Review', message: 'Enter your current password to finalize and lock this evaluation.' });
  if (!proof) return;
  try {
    await performanceApi(`/reviews/${review.id}/finalize`, { method: 'POST', body: JSON.stringify({ currentPassword: proof.password, version: review.version }) });
    await refreshCurrentPerformanceReview();
    await performanceNotice('Performance review finalized.', 'Review Finalized', 'success');
  } catch (error) {
    await performanceNotice(error.message, 'Could Not Finalize Review', 'error');
  }
}

async function reopenPerformanceReview() {
  const review = PERFORMANCE_STATE.currentReview;
  if (!review) return;
  const proof = await requestPerformanceStepUp({ title: 'Reopen Performance Review', message: 'Enter your password and record the correction reason.', requireReason: true });
  if (!proof) return;
  try {
    await performanceApi(`/reviews/${review.id}/reopen`, { method: 'POST', body: JSON.stringify({ reason: proof.reason, currentPassword: proof.password, version: review.version }) });
    await refreshCurrentPerformanceReview();
    await performanceNotice('Performance review reopened.', 'Review Reopened', 'success');
  } catch (error) {
    await performanceNotice(error.message, 'Could Not Reopen Review', 'error');
  }
}

window.initPerformanceManagement = initPerformanceManagement;
window.loadPerformanceReviews = loadPerformanceReviews;
window.resetPerformanceReviewPage = resetPerformanceReviewPage;
window.changePerformanceReviewPage = changePerformanceReviewPage;
window.openPerformanceCycleModal = openPerformanceCycleModal;
window.openPerformanceAssignmentModal = openPerformanceAssignmentModal;
window.filterPerformanceAssignmentEmployees = filterPerformanceAssignmentEmployees;
window.closePerformanceModal = closePerformanceModal;
window.addPerformanceGoalRow = addPerformanceGoalRow;
window.addPerformanceReviewGoalRow = addPerformanceReviewGoalRow;
window.submitPerformanceCycle = submitPerformanceCycle;
window.submitPerformanceAssignment = submitPerformanceAssignment;
window.updatePerformanceCycleStatus = updatePerformanceCycleStatus;
window.openPerformanceReview = openPerformanceReview;
window.updatePerformanceRatingSummary = updatePerformanceRatingSummary;
window.savePerformanceEvaluation = savePerformanceEvaluation;
window.finalizePerformanceReview = finalizePerformanceReview;
window.reopenPerformanceReview = reopenPerformanceReview;
window.submitPerformanceStepUp = submitPerformanceStepUp;
window.resolvePerformanceStepUp = resolvePerformanceStepUp;
