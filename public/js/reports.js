/* ============================================================
   public/js/reports.js — ERP Report Library
   ============================================================ */

const REPORT_PAGE_SIZE = 12;
const reportState = {
  reports: [],
  filtered: [],
  page: 1,
  selectedReport: null,
  favorites: new Set(JSON.parse(localStorage.getItem('lgsv_report_favorites') || '[]')),
  bound: false,
  catalogLoaded: false,
  dependenciesLoaded: false
};

document.addEventListener('DOMContentLoaded', () => {
  initReportLibrary();
});

document.addEventListener('partialsLoaded', () => {
  initReportLibrary();
});

const reportObserver = new MutationObserver(() => {
  const page = document.getElementById('page-reports');
  if (page && page.classList.contains('active')) initReportLibrary();
});

const reportsPage = document.getElementById('page-reports');
if (reportsPage) reportObserver.observe(reportsPage, { attributes: true, attributeFilter: ['class'] });

async function initReportLibrary() {
  if (!document.getElementById('report-library-body') || !document.getElementById('report-search')) {
    return;
  }

  if (!reportState.bound) {
    setDefaultReportDates();
    bindReportEvents();
    reportState.bound = true;
  }

  if (reportState.catalogLoaded) {
    renderReportLibrary();
    return;
  }

  await Promise.all([loadReportDependencies(), loadReportCatalog()]);
}

function setDefaultReportDates() {
  const from = document.getElementById('report-date-from');
  const to = document.getElementById('report-date-to');
  if (!from || !to || from.value) return;
  const today = new Date();
  const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);
  from.value = firstDay.toISOString().slice(0, 10);
  to.value = today.toISOString().slice(0, 10);
}

function bindReportEvents() {
  [
    'report-search',
    'report-category',
    'report-payroll-period',
    'report-department',
    'report-wage-type',
    'report-employee',
    'report-date-from',
    'report-date-to',
    'report-status'
  ].forEach(id => {
    const el = document.getElementById(id);
    if (!el || el.dataset.reportBound === 'true') return;
    el.addEventListener(id === 'report-search' ? 'input' : 'change', applyReportFilters);
    el.dataset.reportBound = 'true';
  });

  const searchBtn = document.getElementById('report-search-btn');
  if (searchBtn && searchBtn.dataset.reportBound !== 'true') {
    searchBtn.addEventListener('click', applyReportFilters);
    searchBtn.dataset.reportBound = 'true';
  }

  const resetBtn = document.getElementById('report-reset-btn');
  if (resetBtn && resetBtn.dataset.reportBound !== 'true') {
    resetBtn.addEventListener('click', resetReportFilters);
    resetBtn.dataset.reportBound = 'true';
  }

  const prev = document.getElementById('report-prev-page');
  if (prev && prev.dataset.reportBound !== 'true') {
    prev.addEventListener('click', () => {
      if (reportState.page > 1) {
        reportState.page -= 1;
        renderReportLibrary();
      }
    });
    prev.dataset.reportBound = 'true';
  }

  const next = document.getElementById('report-next-page');
  if (next && next.dataset.reportBound !== 'true') {
    next.addEventListener('click', () => {
      const totalPages = Math.max(1, Math.ceil(reportState.filtered.length / REPORT_PAGE_SIZE));
      if (reportState.page < totalPages) {
        reportState.page += 1;
        renderReportLibrary();
      }
    });
    next.dataset.reportBound = 'true';
  }

  const confirm = document.getElementById('report-generate-confirm');
  if (confirm && confirm.dataset.reportBound !== 'true') {
    confirm.addEventListener('click', generateSelectedReport);
    confirm.dataset.reportBound = 'true';
  }

  if (document.body.dataset.reportDatePickerBound !== 'true') {
    document.addEventListener('click', () => setTimeout(syncReportDatePickerSpace, 0), true);
    document.addEventListener('change', () => setTimeout(syncReportDatePickerSpace, 0), true);
    document.body.dataset.reportDatePickerBound = 'true';
  }
}

function syncReportDatePickerSpace() {
  const grid = document.querySelector('#page-reports .report-filter-grid');
  if (!grid) return;
  grid.classList.toggle('date-picker-open', !!grid.querySelector('.lgsv-date-field.open'));
}

async function loadReportCatalog() {
  try {
    const res = await apiFetch('/api/reports/library');
    if (!res || !res.ok) {
      const errorText = await readReportError(res);
      throw new Error(errorText || 'Unable to load report library.');
    }
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error('Reports API is not available on the running server. Restart npm start.');
    }
    const data = await res.json();
    reportState.reports = Array.isArray(data.reports) ? data.reports : [];
    reportState.catalogLoaded = true;
    populateReportCategories(reportState.reports);
    applyReportFilters();
  } catch (err) {
    console.error('Report library failed:', err);
    const body = document.getElementById('report-library-body');
    const count = document.getElementById('report-library-count');
    if (count) count.textContent = 'Report library unavailable';
    if (body) {
      body.innerHTML = `
        <tr>
          <td colspan="6">
            <div class="report-empty-state">
              <div>${escapeHtml(err.message || 'Unable to load reports.')}</div>
              <button class="btn btn-primary btn-sm" type="button" onclick="retryReportLibrary()">Retry</button>
            </div>
          </td>
        </tr>
      `;
    }
  }
}

async function readReportError(res) {
  if (!res) return 'Reports API did not respond.';
  try {
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      return data.error || data.message || `Reports API returned HTTP ${res.status}.`;
    }
    const text = await res.text();
    if (text.includes('<!DOCTYPE html')) return 'Reports API route was not found on the running server. Restart npm start.';
    return text.slice(0, 160) || `Reports API returned HTTP ${res.status}.`;
  } catch (_) {
    return `Reports API returned HTTP ${res.status}.`;
  }
}

function retryReportLibrary() {
  reportState.catalogLoaded = false;
  loadReportCatalog();
}

async function loadReportDependencies() {
  if (reportState.dependenciesLoaded) return;
  await Promise.all([
    fillSelectFromApi('report-employee', '/api/employees', emp => ({
      value: emp.id,
      label: `${emp.employee_code || emp.id} - ${[emp.first_name, emp.last_name].filter(Boolean).join(' ')}`
    }), 'All employees'),
    fillSelectFromApi('report-payroll-period', '/api/payroll/runs', run => ({
      value: run.month_year || run.id,
      label: run.month_year || `Run ${run.id}`
    }), 'All periods'),
    fillSelectFromApi('report-department', '/api/employee-setup', setup => {
      return (setup.departments || []).map(dept => ({ value: dept.name, label: dept.name }));
    }, 'All'),
    fillSelectFromApi('report-wage-type', '/api/payroll/wage-types', type => ({
      value: type.name,
      label: type.name
    }), 'All')
  ]);
  reportState.dependenciesLoaded = true;
}

async function fillSelectFromApi(id, url, mapper, allLabel) {
  const select = document.getElementById(id);
  if (!select || select.dataset.loaded === 'true') return;
  try {
    const res = await apiFetch(url);
    if (!res || !res.ok) return;
    const data = await res.json();
    let options;
    if (url === '/api/employee-setup') {
      options = mapper(data);
    } else {
      options = (Array.isArray(data) ? data : []).map(mapper);
    }
    select.innerHTML = `<option value="all">${escapeHtml(allLabel)}</option>` +
      options.map(option => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('');
    select.dataset.loaded = 'true';
  } catch (err) {
    console.warn(`Unable to load ${id}:`, err.message);
  }
}

function populateReportCategories(reports) {
  const select = document.getElementById('report-category');
  if (!select) return;
  const categories = [...new Set(reports.map(report => report.category))].sort();
  select.innerHTML = '<option value="all">All</option>' +
    categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
}

function applyReportFilters() {
  const query = valueOf('report-search').toLowerCase();
  const category = valueOf('report-category');
  reportState.filtered = reportState.reports
    .filter(report => category === 'all' || report.category === category)
    .filter(report => !query || `${report.name} ${report.description}`.toLowerCase().includes(query))
    .sort((a, b) => {
      const favDelta = Number(reportState.favorites.has(b.id)) - Number(reportState.favorites.has(a.id));
      return favDelta || a.category.localeCompare(b.category) || a.name.localeCompare(b.name);
    });
  reportState.page = 1;
  renderReportLibrary();
}

function resetReportFilters() {
  ['report-search', 'report-date-from', 'report-date-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  ['report-category', 'report-payroll-period', 'report-department', 'report-wage-type', 'report-employee', 'report-status'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = 'all';
  });
  setDefaultReportDates();
  applyReportFilters();
}

function renderReportLibrary() {
  const body = document.getElementById('report-library-body');
  const count = document.getElementById('report-library-count');
  const pageLabel = document.getElementById('report-page-label');
  const prev = document.getElementById('report-prev-page');
  const next = document.getElementById('report-next-page');
  if (!body) return;

  const total = reportState.filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / REPORT_PAGE_SIZE));
  reportState.page = Math.min(reportState.page, totalPages);
  const start = (reportState.page - 1) * REPORT_PAGE_SIZE;
  const rows = reportState.filtered.slice(start, start + REPORT_PAGE_SIZE);

  if (count) count.textContent = `${total} report${total === 1 ? '' : 's'} available`;
  if (pageLabel) pageLabel.textContent = `Page ${reportState.page} of ${totalPages}`;
  if (prev) prev.disabled = reportState.page <= 1;
  if (next) next.disabled = reportState.page >= totalPages;

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6">No reports match the selected filters.</td></tr>';
    return;
  }

  body.innerHTML = rows.map(report => `
    <tr>
      <td>
        <button class="report-star ${reportState.favorites.has(report.id) ? 'active' : ''}" type="button" onclick="toggleReportFavorite('${escapeAttr(report.id)}')" title="Favorite">
          ${reportState.favorites.has(report.id) ? '&#9733;' : '&#9734;'}
        </button>
      </td>
      <td>${escapeHtml(report.name)}</td>
      <td><span class="badge badge-neutral">${escapeHtml(report.category)}</span></td>
      <td>${escapeHtml(report.description)}</td>
      <td>${report.formats.map(format => escapeHtml(format.toUpperCase())).join(' | ')}</td>
      <td><button class="btn btn-primary btn-sm" type="button" onclick="openReportGenerateModal('${escapeAttr(report.id)}')">Generate</button></td>
    </tr>
  `).join('');
}

function toggleReportFavorite(reportId) {
  if (reportState.favorites.has(reportId)) reportState.favorites.delete(reportId);
  else reportState.favorites.add(reportId);
  localStorage.setItem('lgsv_report_favorites', JSON.stringify([...reportState.favorites]));
  applyReportFilters();
}

function openReportGenerateModal(reportId) {
  const report = reportState.reports.find(item => item.id === reportId);
  if (!report) return;
  reportState.selectedReport = report;
  document.getElementById('reportGenerateTitle').textContent = report.name;
  document.getElementById('reportGenerateDescription').textContent = report.description;
  document.getElementById('report-export-format').innerHTML = report.formats
    .map(format => `<option value="${escapeHtml(format)}">${escapeHtml(format.toUpperCase())}</option>`)
    .join('');
  const modalEl = document.getElementById('reportGenerateModal');
  if (window.bootstrap && modalEl) {
    bootstrap.Modal.getOrCreateInstance(modalEl).show();
  } else if (modalEl) {
    modalEl.style.display = 'block';
  }
}

async function generateSelectedReport() {
  const report = reportState.selectedReport;
  const format = valueOf('report-export-format') || 'pdf';
  if (!report) return;

  const button = document.getElementById('report-generate-confirm');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Generating...';

  try {
    const query = new URLSearchParams(reportFilterPayload());
    const res = await apiFetch(`/api/reports/${encodeURIComponent(report.id)}.${encodeURIComponent(format)}?${query.toString()}`);
    if (!res || !res.ok) {
      const error = await safeJson(res);
      throw new Error(error?.error || 'Report generation failed.');
    }
    const blob = await res.blob();
    const disposition = res.headers.get('content-disposition') || '';
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    const filename = filenameMatch ? filenameMatch[1] : `${report.id}.${format === 'excel' ? 'xlsx' : format}`;
    downloadBlob(blob, filename);
    closeReportGenerateModal();
  } catch (err) {
    console.error('Report generation failed:', err);
    alert(err.message || 'Unable to generate report.');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function reportFilterPayload() {
  return {
    date_from: valueOf('report-date-from'),
    date_to: valueOf('report-date-to'),
    payroll_period: valueOf('report-payroll-period'),
    employee_id: valueOf('report-employee'),
    department: valueOf('report-department'),
    wage_type: valueOf('report-wage-type'),
    status: valueOf('report-status')
  };
}

function closeReportGenerateModal() {
  const modalEl = document.getElementById('reportGenerateModal');
  if (window.bootstrap && modalEl) bootstrap.Modal.getOrCreateInstance(modalEl).hide();
  else if (modalEl) modalEl.style.display = 'none';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function safeJson(res) {
  try {
    return await res.json();
  } catch (_) {
    return null;
  }
}

function valueOf(id) {
  const el = document.getElementById(id);
  return el ? String(el.value || '').trim() : '';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

window.toggleReportFavorite = toggleReportFavorite;
window.openReportGenerateModal = openReportGenerateModal;
window.retryReportLibrary = retryReportLibrary;
