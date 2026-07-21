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
  initializationPromise: null,
  photoRequestId: 0,
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

function performancePageIsActive() {
  return document.body?.dataset?.activePage === 'performance'
    || document.getElementById('page-performance')?.classList?.contains('active');
}

async function hydratePerformanceEmployeePhoto(review) {
  const target = document.getElementById('performance-review-photo');
  if (!target) return;
  revokePerformancePhoto();
  target.replaceChildren(document.createTextNode(performanceInitials(review.employee_name)));
  const employeeRecordId = Number(review.employee_record_id);
  if (!Number.isSafeInteger(employeeRecordId) || employeeRecordId <= 0) return;
  const photoRequestId = ++PERFORMANCE_STATE.photoRequestId;
  try {
    if (typeof apiFetch !== 'function') return;
    const response = await apiFetch(`/api/employees/${employeeRecordId}/photo`, { cache: 'no-store' });
    if (!response.ok) return;
    const blob = await response.blob();
    if (!String(blob.type || '').startsWith('image/')) return;
    const photoObjectUrl = URL.createObjectURL(blob);
    if (photoRequestId !== PERFORMANCE_STATE.photoRequestId || !performancePageIsActive()) {
      URL.revokeObjectURL(photoObjectUrl);
      return;
    }
    PERFORMANCE_STATE.photoObjectUrl = photoObjectUrl;
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
  if (typeof apiFetch !== 'function') throw new Error('Authenticated API helper is unavailable.');
  const response = await apiFetch(`/api/performance${path}`, { cache: 'no-store', ...options });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || 'Performance Management request failed.');
    error.code = payload.code || 'PERFORMANCE_REQUEST_FAILED';
    error.status = response.status;
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

function performanceQuestionnaireBadge(version) {
  const label = String(version || 'v1').trim().toUpperCase();
  return `<small class="performance-questionnaire-badge performance-questionnaire-${label.toLowerCase()}">${performanceEscape(label)}</small>`;
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

// Keep the manager-only controls aligned with the verified session role.  The
// performance page can render its tables after authentication finishes, so this
// runs both on page initialization and on every manager-only render path.
function syncPerformanceManagerControls() {
  const manager = performanceCanManage();
  const actions = document.getElementById('performance-manager-actions');
  if (actions) {
    actions.hidden = !manager;
    if (manager) actions.removeAttribute('hidden');
  }
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
  const cycleActionsHeading = document.getElementById('performance-cycle-actions-heading');
  if (cycleActionsHeading) cycleActionsHeading.hidden = !manager;
  return manager;
}

async function initPerformanceManagement() {
  if (PERFORMANCE_STATE.initializationPromise) return PERFORMANCE_STATE.initializationPromise;
  const manager = syncPerformanceManagerControls();
  PERFORMANCE_STATE.initialized = true;
  const initialization = Promise.all([
    loadPerformanceOverview(),
    loadPerformanceReviews(),
    manager ? loadPerformanceEmployees() : Promise.resolve(),
    manager ? loadPerformanceDepartments() : Promise.resolve(),
  ]).finally(() => {
    if (PERFORMANCE_STATE.initializationPromise === initialization) {
      PERFORMANCE_STATE.initializationPromise = null;
    }
  });
  PERFORMANCE_STATE.initializationPromise = initialization;
  return initialization;
}

async function loadPerformanceOverview() {
  try {
    const overview = await performanceApi('/overview');
    if (!performancePageIsActive()) return;
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
  const manager = syncPerformanceManagerControls();
  const body = document.getElementById('performance-cycles-body');
  const filter = document.getElementById('performance-cycle-filter');
  const assignment = document.getElementById('performance-assignment-cycle');
  if (filter) {
    const selected = filter.value;
    filter.innerHTML = '<option value="">All Cycles</option>' + cycles.map(cycle => `<option value="${Number(cycle.id)}">${performanceEscape(cycle.cycle_name)} [${performanceEscape(String(cycle.questionnaire_version || 'v1').toUpperCase())}]</option>`).join('');
    filter.value = selected;
  }
  if (assignment) {
    assignment.innerHTML = '<option value="">Select cycle</option>' + cycles
      .filter(cycle => ['DRAFT', 'ACTIVE'].includes(cycle.status))
      .map(cycle => `<option value="${Number(cycle.id)}">${performanceEscape(cycle.cycle_name)} [${performanceEscape(String(cycle.questionnaire_version || 'v1').toUpperCase())}] (${performanceEscape(cycle.status)})</option>`).join('');
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
      <td><strong>${performanceEscape(cycle.cycle_name)}</strong><div class="performance-cycle-version">${performanceQuestionnaireBadge(cycle.questionnaire_version)} <span>Competency ${Number(cycle.competency_weight || 100)}% · Goals ${Number(cycle.goal_weight || 0)}%</span></div></td>
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
    if (!performancePageIsActive()) return;
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
    if (!performancePageIsActive()) return;
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
    if (!performancePageIsActive()) return;
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
  syncPerformanceManagerControls();
  const body = document.getElementById('performance-reviews-body');
  if (!body) return;
  if (!PERFORMANCE_STATE.reviews.length) {
    body.innerHTML = '<tr><td colspan="8" class="performance-empty">No performance reviews found.</td></tr>';
    return;
  }
  body.innerHTML = PERFORMANCE_STATE.reviews.map(review => `<tr class="${['MISMATCH', 'MISSING'].includes(review.integrity_status) ? 'performance-integrity-row' : ''}">
    <td><div class="performance-employee"><strong>${performanceEscape(review.employee_name)}</strong><small>${performanceEscape(review.employee_code)}</small></div></td>
    <td>${performanceEscape(review.cycle_name)}<div class="performance-cycle-version">${performanceQuestionnaireBadge(review.questionnaire_version)}</div></td><td>${performanceEscape(review.department_name)}</td>
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
  const reviewVersion = PERFORMANCE_STATE.currentReview?.questionnaire_version;
  const legacyReview = containerId === 'performance-review-goals' && reviewVersion === 'v1';
  if (legacyReview) {
    row.classList.add('performance-goal-row-v1');
    row.innerHTML = `<div class="performance-goal-title"><input data-goal-title maxlength="160" placeholder="Goal" value="${performanceEscape(goal.title || '')}" ${editable ? '' : 'readonly'} />
      <input data-goal-target maxlength="500" placeholder="Goal KPI / measurable target" value="${performanceEscape(goal.target || '')}" ${editable ? '' : 'readonly'} /></div>
      <p class="performance-goal-legacy-note">This is a v1 review. It stores only the goal and measurable target. Create a new v2 cycle/review to use goal scoring, actual results, status, ratings, and evidence.</p>
      ${editable ? '<button type="button" class="performance-goal-remove" aria-label="Remove goal" title="Remove goal">&times;</button>' : ''}`;
    row.querySelector('.performance-goal-remove')?.addEventListener('click', () => row.remove());
    container.appendChild(row);
    return;
  }
  const disabled = editable ? '' : 'disabled';
  const option = (value, label, selected) => `<option value="${value}" ${selected === value ? 'selected' : ''}>${label}</option>`;
  row.innerHTML = `<div class="performance-goal-title"><input data-goal-title maxlength="160" placeholder="Goal title" value="${performanceEscape(goal.title || '')}" ${editable ? '' : 'readonly'} />
      <input data-goal-target maxlength="500" placeholder="Measurable target" value="${performanceEscape(goal.target || '')}" ${editable ? '' : 'readonly'} /></div>
    <div class="performance-goal-fields">
      <label>Unit<input data-goal-unit maxlength="80" value="${performanceEscape(goal.target_unit || '')}" ${editable ? '' : 'readonly'} /></label>
      <label>Measurement<select data-goal-measurement ${disabled}>${option('MANUAL', 'Manual', goal.measurement_type || 'MANUAL')}${option('COUNT', 'Count', goal.measurement_type)}${option('PERCENTAGE', 'Percentage', goal.measurement_type)}${option('CURRENCY', 'Currency', goal.measurement_type)}${option('HOURS', 'Hours', goal.measurement_type)}${option('DAYS', 'Days', goal.measurement_type)}${option('BINARY', 'Binary', goal.measurement_type)}${option('OTHER', 'Other', goal.measurement_type)}</select></label>
      <label>Direction<select data-goal-direction ${disabled}>${option('MANUAL', 'Manual', goal.measurement_direction || 'MANUAL')}${option('HIGHER_IS_BETTER', 'Higher is better', goal.measurement_direction)}${option('LOWER_IS_BETTER', 'Lower is better', goal.measurement_direction)}${option('BINARY', 'Binary', goal.measurement_direction)}</select></label>
      <label>Target value<input data-goal-target-value inputmode="decimal" maxlength="40" value="${performanceEscape(goal.target_value ?? '')}" ${editable ? '' : 'readonly'} /></label>
      <label>Actual result<input data-goal-actual-value inputmode="decimal" maxlength="40" value="${performanceEscape(goal.actual_value ?? '')}" ${editable ? '' : 'readonly'} /></label>
      <label>Achievement %<input data-goal-achievement inputmode="decimal" maxlength="8" value="${performanceEscape(goal.achievement_percentage ?? '')}" ${editable ? '' : 'readonly'} /></label>
      <label>Status<select data-goal-status ${disabled}>${['NOT_STARTED', 'IN_PROGRESS', 'PARTIALLY_ACHIEVED', 'ACHIEVED', 'EXCEEDED', 'NOT_APPLICABLE'].map(status => option(status, status.replace(/_/g, ' '), goal.status || 'NOT_STARTED')).join('')}</select></label>
      <label>Rating<select data-goal-rating ${disabled}><option value="">Not rated</option>${[4, 3, 2, 1].map(value => option(String(value), `${value} - ${performanceRatingLabel(value)}`, String(goal.rating ?? ''))).join('')}${option('NA', 'N/A', String(goal.rating ?? ''))}</select></label>
      <label>Weight %<input data-goal-weight inputmode="decimal" maxlength="6" value="${performanceEscape(goal.weight ?? '')}" ${editable ? '' : 'readonly'} /></label>
    </div>
    <label class="performance-goal-evidence">Evidence / remarks<textarea data-goal-evidence maxlength="2000" rows="2" ${editable ? '' : 'readonly'}>${performanceEscape(goal.evidence || '')}</textarea></label>
    <label class="performance-goal-na">N/A reason<textarea data-goal-na-reason maxlength="500" rows="2" ${editable ? '' : 'readonly'}>${performanceEscape(goal.na_reason || '')}</textarea></label>
    <label class="performance-goal-confirm"><input data-goal-confirmed type="checkbox" ${goal.evaluator_confirmed ? 'checked' : ''} ${disabled} /> Evaluator confirmed measured result</label>
    ${editable ? '<button type="button" class="performance-goal-remove" aria-label="Remove goal" title="Remove goal">&times;</button>' : ''}`;
  row.querySelector('.performance-goal-remove')?.addEventListener('click', () => { row.remove(); rebalancePerformanceGoalWeights(containerId); updatePerformanceRatingSummary(); });
  const syncMeasuredResult = () => {
    syncPerformanceGoalAchievement(row);
    updatePerformanceRatingSummary();
  };
  row.querySelector('[data-goal-target-value]')?.addEventListener('input', syncMeasuredResult);
  row.querySelector('[data-goal-actual-value]')?.addEventListener('input', syncMeasuredResult);
  row.querySelector('[data-goal-direction]')?.addEventListener('change', syncMeasuredResult);
  row.querySelectorAll('input, select, textarea').forEach(field => field.addEventListener('input', updatePerformanceRatingSummary));
  row.querySelectorAll('select').forEach(field => field.addEventListener('change', updatePerformanceRatingSummary));
  container.appendChild(row);
  syncPerformanceGoalAchievement(row);
  if (editable && !goal.weight) rebalancePerformanceGoalWeights(containerId);
}

function addPerformanceReviewGoalRow(goal = {}) {
  addPerformanceGoalRow('performance-review-goals', goal, true);
}

function suggestedPerformanceGoalAchievement(row) {
  const direction = row.querySelector('[data-goal-direction]')?.value;
  const target = Number(row.querySelector('[data-goal-target-value]')?.value);
  const actual = Number(row.querySelector('[data-goal-actual-value]')?.value);
  if (!Number.isFinite(target) || !Number.isFinite(actual) || target <= 0) return null;
  if (direction === 'HIGHER_IS_BETTER') return Number(((actual / target) * 100).toFixed(2));
  if (direction === 'LOWER_IS_BETTER') return actual <= 0 ? null : Number(((target / actual) * 100).toFixed(2));
  return null;
}

function syncPerformanceGoalAchievement(row) {
  const field = row.querySelector('[data-goal-achievement]');
  if (!field) return;
  const suggested = suggestedPerformanceGoalAchievement(row);
  if (suggested === null) {
    field.readOnly = false;
    field.removeAttribute('title');
    return;
  }
  field.value = suggested.toFixed(2);
  field.readOnly = true;
  field.title = 'Calculated from target value and actual result.';
}

function collectPerformanceGoals(containerId) {
  return [...document.querySelectorAll(`#${containerId} .performance-goal-row`)].map(row => ({
    title: row.querySelector('[data-goal-title]')?.value.trim() || '',
    target: row.querySelector('[data-goal-target]')?.value.trim() || '',
    target_unit: row.querySelector('[data-goal-unit]')?.value.trim() || '',
    measurement_type: row.querySelector('[data-goal-measurement]')?.value || 'MANUAL',
    measurement_direction: row.querySelector('[data-goal-direction]')?.value || 'MANUAL',
    target_value: row.querySelector('[data-goal-target-value]')?.value.trim() || '',
    actual_value: row.querySelector('[data-goal-actual-value]')?.value.trim() || '',
    achievement_percentage: row.querySelector('[data-goal-achievement]')?.value.trim() || '',
    status: row.querySelector('[data-goal-status]')?.value || 'NOT_STARTED',
    rating: row.querySelector('[data-goal-rating]')?.value || null,
    weight: row.querySelector('[data-goal-weight]')?.value.trim() || '',
    evidence: row.querySelector('[data-goal-evidence]')?.value.trim() || '',
    na_reason: row.querySelector('[data-goal-na-reason]')?.value.trim() || '',
    evaluator_confirmed: Boolean(row.querySelector('[data-goal-confirmed]')?.checked),
  })).filter(goal => goal.title || goal.target);
}

function rebalancePerformanceGoalWeights(containerId) {
  const rows = [...document.querySelectorAll(`#${containerId} .performance-goal-row`)];
  if (!rows.length) return;
  const weight = (100 / rows.length).toFixed(2);
  rows.forEach(row => {
    const field = row.querySelector('[data-goal-weight]');
    if (field) field.value = weight;
  });
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
      competency_weight: document.getElementById('performance-cycle-competency-weight').value,
      goal_weight: document.getElementById('performance-cycle-goal-weight').value,
    }) });
    closePerformanceModal('performance-cycle-modal');
    await loadPerformanceOverview();
    await performanceNotice('Appraisal cycle created as v2. Default weighting is 70% competency and 30% goals unless you changed it.', 'Cycle Created', 'success');
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
  const scale = PERFORMANCE_STATE.currentReview?.rating_scale || [];
  return scale.find(item => String(item.value) === String(value))?.label || ({ 4: 'Exceeds Expectations', 3: 'Meets Expectations', 2: 'Partially Meets Expectations', 1: 'Does Not Meet Expectations', NA: 'Not Applicable / Insufficient Evidence' })[value] || 'Not rated';
}

function performanceQuestionnaire() {
  return PERFORMANCE_STATE.currentReview?.questionnaire || { criteria: [], applicability: {}, score_weights: {} };
}

function performanceRatingControl(criterionKey, indicator, value, naReason, editable) {
  const indicatorKey = indicator.key;
  const indicatorText = indicator.text;
  if (!editable) {
    const label = value === null || value === undefined ? '-' : `${value === 'NA' ? 'N/A' : Number(value)} - ${performanceEscape(performanceRatingLabel(value))}`;
    return `<div class="performance-rating-control"><span class="performance-rating-readonly">${label}</span>${value === 'NA' ? `<small>N/A reason: ${performanceEscape(naReason || '-')}</small>` : ''}</div>`;
  }
  const scale = PERFORMANCE_STATE.currentReview?.rating_scale || [{ value: 4 }, { value: 3 }, { value: 2 }, { value: 1 }, { value: 'NA' }];
  return `<div class="performance-rating-control"><select id="performance-rating-${performanceEscape(criterionKey)}-${performanceEscape(indicatorKey)}" aria-label="${performanceEscape(indicatorText)} rating" onchange="updatePerformanceRatingSummary()">
    <option value="">Not rated</option>${scale.map(item => `<option value="${performanceEscape(item.value)}" ${String(value) === String(item.value) ? 'selected' : ''}>${performanceEscape(item.value === 'NA' ? 'N/A' : item.value)} - ${performanceEscape(item.label)}</option>`).join('')}
  </select><label class="performance-na-reason">N/A reason<textarea id="performance-na-${performanceEscape(criterionKey)}-${performanceEscape(indicatorKey)}" maxlength="500" rows="2" aria-label="${performanceEscape(indicatorText)} N/A reason" oninput="updatePerformanceRatingSummary()">${performanceEscape(naReason || '')}</textarea></label></div>`;
}

function calculateClientPerformanceScore(ratings, questionnaire = performanceQuestionnaire()) {
  const criteriaAverages = {};
  const criteria = questionnaire.criteria || [];
  const minPerCriterion = Number(questionnaire.applicability?.minimum_numeric_ratings_per_criterion || 4);
  const minCoverage = Number(questionnaire.applicability?.minimum_numeric_coverage || 1);
  let complete = true;
  let total = 0;
  let numericTotal = 0;
  let naTotal = 0;
  let weighted = 0;
  criteria.forEach(criterion => {
    const values = criterion.indicators.map(indicator => ratings?.[criterion.key]?.[indicator.key]);
    const numeric = values.map(Number).filter(value => Number.isInteger(value) && value >= 1 && value <= 4);
    total += values.length;
    numericTotal += numeric.length;
    naTotal += values.filter(value => value === 'NA').length;
    if (numeric.length < minPerCriterion) {
      criteriaAverages[criterion.key] = null;
      complete = false;
      return;
    }
    const average = Number((numeric.reduce((sum, value) => sum + value, 0) / numeric.length).toFixed(2));
    criteriaAverages[criterion.key] = average;
    weighted += average * (Number(criterion.weight || 0) / 100);
  });
  const coverage = total ? numericTotal / total : 0;
  if (coverage < minCoverage) complete = false;
  const competency = complete ? Number(weighted.toFixed(2)) : null;
  const goals = collectPerformanceGoals('performance-review-goals');
  const applicableGoals = goals.filter(goal => goal.rating !== 'NA' && goal.status !== 'NOT_APPLICABLE');
  const goalWeight = Number(questionnaire.score_weights?.goal_weight || 0);
  const goalComplete = goalWeight === 0 || (applicableGoals.length > 0 && applicableGoals.every(goal => Number.isInteger(Number(goal.rating)) && Number(goal.rating) >= 1 && Number(goal.rating) <= 4));
  const applicableWeight = applicableGoals.reduce((sum, goal) => sum + Number(goal.weight || 0), 0);
  const goalScore = goalComplete && goalWeight > 0 && applicableWeight > 0
    ? Number((applicableGoals.reduce((sum, goal) => sum + (Number(goal.rating) * Number(goal.weight || 0)), 0) / applicableWeight).toFixed(2))
    : null;
  const finalScore = competency !== null && (goalWeight === 0 || goalScore !== null)
    ? Number(((competency * (Number(questionnaire.score_weights?.competency_weight || 0) / 100)) + ((goalScore || 0) * (goalWeight / 100))).toFixed(2))
    : null;
  return {
    criteriaAverages,
    competency,
    goalScore,
    finalScore,
    coverage,
    numericTotal,
    total,
    naTotal,
    complete,
  };
}

function collectPerformanceRatings() {
  return Object.fromEntries(performanceQuestionnaire().criteria.map(criterion => [
    criterion.key,
    Object.fromEntries(criterion.indicators.map(indicator => [
      indicator.key,
      document.getElementById(`performance-rating-${criterion.key}-${indicator.key}`)?.value || null,
    ])),
  ]));
}

function collectPerformanceNaReasons() {
  return Object.fromEntries(performanceQuestionnaire().criteria.map(criterion => [
    criterion.key,
    Object.fromEntries(criterion.indicators.map(indicator => [
      indicator.key,
      document.getElementById(`performance-na-${criterion.key}-${indicator.key}`)?.value.trim() || '',
    ]).filter(([, value]) => value)),
  ]).filter(([, values]) => Object.keys(values).length));
}

function collectPerformanceCriterionText(kind) {
  return Object.fromEntries(performanceQuestionnaire().criteria.map(criterion => [
    criterion.key,
    document.getElementById(`performance-${kind}-${criterion.key}`)?.value.trim() || '',
  ]).filter(([, value]) => value));
}

function updatePerformanceRatingSummary() {
  const summary = document.getElementById('performance-rating-summary');
  if (!summary) return;
  const review = PERFORMANCE_STATE.currentReview;
  const editable = performanceCanManage() && review?.status === 'ASSIGNED';
  const ratings = editable ? collectPerformanceRatings() : (review?.indicator_ratings || {});
  const result = calculateClientPerformanceScore(ratings, review?.questionnaire);
  (review?.questionnaire?.criteria || []).forEach(criterion => {
    const value = result.criteriaAverages[criterion.key];
    const element = document.querySelector(`[data-criterion-average="${criterion.key}"]`);
    if (element) element.textContent = value === null ? '-' : value.toFixed(2);
  });
  const weights = review?.questionnaire?.score_weights || {};
  const goalHint = Number(weights.goal_weight || 0) > 0
    ? '<small class="performance-goal-score-hint">Goal score is the weighted average of the 1–4 goal ratings. Achievement % is calculated automatically for Higher/Lower measurable goals; select an HR Rating to include the goal in the score.</small>'
    : '';
  summary.innerHTML = `<div class="performance-completion"><span>Rated ${result.numericTotal}/${result.total} (${Math.round(result.coverage * 100)}%)</span><span>N/A: ${result.naTotal}</span><span>Required coverage: ${Math.round(Number(review?.questionnaire?.applicability?.minimum_numeric_coverage || 1) * 100)}%</span></div>
    <div>${(review?.questionnaire?.criteria || []).map(criterion => `<span>${performanceEscape(criterion.label)} <strong>${result.criteriaAverages[criterion.key] === null ? '-' : result.criteriaAverages[criterion.key].toFixed(2)}</strong></span>`).join('')}</div>
    <p>Competency <strong>${result.competency === null ? 'Incomplete' : result.competency.toFixed(2)}</strong> <small>(${Number(weights.competency_weight || 0)}%)</small> &nbsp; Goals <strong>${Number(weights.goal_weight || 0) === 0 ? 'N/A' : result.goalScore === null ? 'Incomplete — select a rating' : result.goalScore.toFixed(2)}</strong> <small>(${Number(weights.goal_weight || 0)}%)</small> &nbsp; Final <strong>${result.finalScore === null ? 'Incomplete' : result.finalScore.toFixed(2)}</strong></p>${goalHint}`;
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
    <div><small>Status</small><strong>${performanceEscape(performanceStatusLabel(review.status))}</strong></div>
    <div><small>Questionnaire</small><strong>${performanceEscape(review.questionnaire_version || 'v1').toUpperCase()}</strong></div>`;
  document.getElementById('performance-rating-guide').innerHTML = (review.rating_scale || []).map(item =>
    `<div><strong>${performanceEscape(item.value === 'NA' ? 'N/A' : item.value)} — ${performanceEscape(item.label)}</strong><span>${performanceEscape(item.description || '')}</span></div>`
  ).join('');
  document.getElementById('performance-rating-grid').innerHTML = (review.questionnaire?.criteria || []).map(criterion => {
    const average = review.criteria_averages?.[criterion.key];
    const sectionLabel = ({ core: 'Core competency', role: 'Role-specific competency', leadership: 'Leadership competency' })[criterion.section] || 'Competency';
    return `<details class="performance-criterion" open>
      <summary class="performance-criterion-heading"><div><span class="performance-section-badge">${performanceEscape(sectionLabel)}</span><h4>${performanceEscape(criterion.label)}</h4><p>${performanceEscape(criterion.basis)}</p></div><span>Weight ${Number(criterion.weight || 0).toFixed(2)}% · Average <strong data-criterion-average="${performanceEscape(criterion.key)}">${average === null || average === undefined ? '-' : Number(average).toFixed(2)}</strong></span></summary>
      ${criterion.indicators.map(indicator => `<div class="performance-rating-row">
        <div><span>${performanceEscape(indicator.text)}</span><details class="performance-anchor"><summary>Behavioral guide</summary><ul>${[4, 3, 2, 1].map(rating => `<li><strong>${rating}</strong> ${performanceEscape(indicator.anchors?.[rating] || '')}</li>`).join('')}</ul></details></div>
        ${performanceRatingControl(criterion.key, indicator, review.indicator_ratings?.[criterion.key]?.[indicator.key], review.na_reasons?.[criterion.key]?.[indicator.key], reviewerEditable)}
      </div>`).join('')}
      <div class="performance-criterion-narratives"><label>Evidence or reference<textarea id="performance-evidence-${performanceEscape(criterion.key)}" maxlength="2000" rows="3" ${reviewerEditable ? '' : 'readonly'}>${performanceEscape(review.criteria_evidence?.[criterion.key] || '')}</textarea></label>
      <label>Evaluator remarks<textarea id="performance-remarks-${performanceEscape(criterion.key)}" maxlength="2000" rows="3" ${reviewerEditable ? '' : 'readonly'}>${performanceEscape(review.criteria_remarks?.[criterion.key] || '')}</textarea></label></div>
    </details>`;
  }).join('');
  const goals = document.getElementById('performance-review-goals');
  goals.innerHTML = '';
  (review.goals || []).forEach(goal => addPerformanceGoalRow('performance-review-goals', goal, reviewerEditable));
  if (!(review.goals || []).length && reviewerEditable) addPerformanceReviewGoalRow();
  document.getElementById('performance-review-add-goal').hidden = !reviewerEditable;
  const feedback = document.getElementById('performance-reviewer-feedback');
  feedback.value = review.reviewer_feedback || '';
  feedback.readOnly = !reviewerEditable;
  const plan = typeof review.development_plan === 'object' && review.development_plan ? review.development_plan : { summary: review.development_plan || '' };
  const planFields = {
    summary: 'performance-development-summary', performance_gap: 'performance-development-gap', required_action: 'performance-development-action',
    responsible_person: 'performance-development-owner', target_date: 'performance-development-target-date', follow_up_date: 'performance-development-follow-up-date', expected_outcome: 'performance-development-outcome',
  };
  Object.entries(planFields).forEach(([key, id]) => {
    const field = document.getElementById(id);
    if (!field) return;
    field.value = plan[key] || '';
    field.readOnly = !reviewerEditable;
    field.disabled = !reviewerEditable && field.tagName === 'SELECT';
  });
  document.getElementById('performance-development-structured')?.toggleAttribute('hidden', review.questionnaire_version !== 'v2');
  document.getElementById('performance-supporting-summary')?.toggleAttribute('hidden', !manager);
  if (manager) loadPerformanceSupportingSummary(review.id);
  updatePerformanceRatingSummary();
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

function collectPerformanceDevelopmentPlan() {
  const ids = {
    summary: 'performance-development-summary', performance_gap: 'performance-development-gap', required_action: 'performance-development-action',
    responsible_person: 'performance-development-owner', target_date: 'performance-development-target-date', follow_up_date: 'performance-development-follow-up-date', expected_outcome: 'performance-development-outcome',
  };
  const plan = Object.fromEntries(Object.entries(ids).map(([key, id]) => [key, document.getElementById(id)?.value.trim() || '']));
  return PERFORMANCE_STATE.currentReview?.questionnaire_version === 'v2' ? plan : plan.summary;
}

async function loadPerformanceSupportingSummary(reviewId) {
  const target = document.getElementById('performance-supporting-summary');
  if (!target) return;
  target.innerHTML = '<p>Loading read-only supporting data…</p>';
  try {
    const summary = await performanceApi(`/reviews/${reviewId}/supporting-summary`);
    if (Number(PERFORMANCE_STATE.currentReview?.id) !== Number(reviewId)) return;
    const stat = (label, value) => `<span><small>${performanceEscape(label)}</small><strong>${performanceEscape(value)}</strong></span>`;
    const unavailable = '<p class="performance-supporting-unavailable">Operational source is not configured. No value is shown.</p>';
    const section = (title, available, content) => `<section><h5>${performanceEscape(title)}</h5>${available === false ? unavailable : content}</section>`;
    target.innerHTML = `<div class="performance-supporting-heading"><strong>Supporting data (read-only)</strong><small>As of ${performanceEscape(performanceDate(summary.as_of))}</small></div>
      <div class="performance-supporting-grid">${section('Attendance', summary.source_status?.attendance, `${stat('Recorded days', summary.attendance?.recorded_days || 0)}${stat('Days present', summary.attendance?.days_present || 0)}${stat('Absences', summary.attendance?.absences || 0)}${stat('Tardiness', `${summary.attendance?.tardiness_count || 0} (${summary.attendance?.tardiness_minutes || 0} min)`)}`)}
      ${section('Production', summary.source_status?.production, `${stat('Verified records', summary.production?.verified_records || 0)}${stat('Output quantity', summary.production?.output_quantity || 0)}${stat('Verified value', summary.production?.verified_amount || 0)}`)}
      ${section('Logistics', summary.source_status?.logistics, `${stat('Verified / approved trips', summary.logistics?.verified_trips || 0)}${stat('Paid / included in payroll', summary.logistics?.processed_trips || 0)}${stat('Documented exceptions', summary.logistics?.documented_exceptions || 0)}`)}</div>`;
  } catch (error) {
    target.innerHTML = `<p>${performanceEscape(error.message)}</p>`;
  }
}

async function savePerformanceEvaluation({ silent = false } = {}) {
  const review = PERFORMANCE_STATE.currentReview;
  if (!review) return false;
  try {
    const result = await performanceApi(`/reviews/${review.id}/evaluation`, { method: 'PUT', body: JSON.stringify({
      ratings: collectPerformanceRatings(),
      na_reasons: collectPerformanceNaReasons(),
      criteria_evidence: collectPerformanceCriterionText('evidence'),
      criteria_remarks: collectPerformanceCriterionText('remarks'),
      feedback: document.getElementById('performance-reviewer-feedback').value,
      development_plan: collectPerformanceDevelopmentPlan(),
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
    if (error.code === 'PERFORMANCE_VERSION_CONFLICT') {
      await performanceNotice('This review was updated in another session. Your latest entries were not saved. Close and reopen the review before entering the values again.', 'Reload Review Required', 'warning');
      return false;
    }
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
