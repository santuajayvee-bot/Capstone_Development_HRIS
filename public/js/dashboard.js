/* ============================================================
   DASHBOARD.JS - Role-aware dashboard renderer
   ============================================================ */

let dashboardLoading = false;
let dashboardLoadedAt = 0;
const DASHBOARD_CLIENT_CACHE_MS = 10000;

function dashEscape(value) {
  if (value === null || value === undefined || value === '') return '-';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function dashBadge(value) {
  const text = dashEscape(value);
  const key = String(value || '').toLowerCase();
  let cls = 'badge';
  if (key.includes('active') || key.includes('approved') || key.includes('present') || key.includes('paid')) cls += ' badge-green';
  else if (key.includes('pending') || key.includes('draft') || key.includes('submitted')) cls += ' badge-yellow';
  else if (key.includes('reject') || key.includes('denied') || key.includes('absent') || key.includes('late')) cls += ' badge-red';
  return `<span class="${cls}">${text}</span>`;
}

function renderDashboardEmpty(target, message) {
  if (target) target.innerHTML = `<div class="dashboard-empty">${dashEscape(message)}</div>`;
}

async function loadDashboard(options = {}) {
  const force = options === true || options.force === true;
  if (dashboardLoading) return;
  const root = document.getElementById('dashboard-root');
  if (!root) return;
  if (!force && Date.now() - dashboardLoadedAt < DASHBOARD_CLIENT_CACHE_MS) return;

  dashboardLoading = true;
  try {
    const response = await apiFetch(force ? '/api/dashboard?refresh=1' : '/api/dashboard');
    if (!response || !response.ok) {
      const error = await response?.json?.().catch(() => ({}));
      throw new Error(error?.error || 'Failed to load dashboard.');
    }
    const data = await response.json();
    renderDashboard(data);
    dashboardLoadedAt = Date.now();
  } catch (error) {
    const main = document.getElementById('dashboard-main');
    renderDashboardEmpty(main, error.message);
  } finally {
    dashboardLoading = false;
  }
}

function renderDashboard(data) {
  const title = document.getElementById('dashboard-title');
  const subtitle = document.getElementById('dashboard-subtitle');
  const role = document.getElementById('dashboard-role');

  if (title) title.textContent = data.welcome || 'Dashboard';
  if (subtitle) subtitle.textContent = data.subtitle || 'Here are the items that need your attention.';
  if (role) role.textContent = data.roleLabel || data.role || 'Role';

  renderDashboardStats(data.stats || []);
  renderDashboardTables(data.tables || []);
  renderDashboardActions(data.actions || []);
  renderDashboardList('dashboard-notifications', data.notifications || [], 'No notifications.');
  renderDashboardList('dashboard-tasks', data.pendingTasks || [], 'No pending tasks.');
  renderDashboardList('dashboard-activities', data.recentActivities || [], 'No recent activities.');
}

function renderDashboardStats(stats) {
  const container = document.getElementById('dashboard-stats');
  if (!container) return;
  if (!stats.length) {
    renderDashboardEmpty(container, 'No statistics available.');
    return;
  }

  container.innerHTML = stats.map(item => `
    <div class="stat-card">
      <div class="stat-label">${dashEscape(item.label)}</div>
      <div class="stat-val">${dashEscape(item.value)}</div>
      <div class="stat-sub">${dashEscape(item.sub || '')}</div>
    </div>
  `).join('');
}

function renderDashboardTables(tables) {
  const container = document.getElementById('dashboard-main');
  if (!container) return;
  if (!tables.length) {
    renderDashboardEmpty(container, 'No dashboard tables available.');
    return;
  }

  container.innerHTML = tables.map(table => `
    <section class="card dashboard-panel">
      <div class="dashboard-panel-title">${dashEscape(table.title)}</div>
      <div class="dashboard-table-wrap">
        <table class="dashboard-table">
          <thead>
            <tr>${(table.columns || []).map(column => `<th>${dashEscape(column)}</th>`).join('')}</tr>
          </thead>
          <tbody>
            ${renderDashboardTableRows(table)}
          </tbody>
        </table>
      </div>
    </section>
  `).join('');
}

function renderDashboardTableRows(table) {
  const rows = table.rows || [];
  if (!rows.length) {
    return `<tr><td colspan="${Math.max((table.columns || []).length, 1)}" class="dashboard-empty">No records found.</td></tr>`;
  }

  return rows.map(row => `
    <tr>
      ${row.map((cell, index) => {
        const column = String((table.columns || [])[index] || '').toLowerCase();
        const content = column.includes('status') ? dashBadge(cell) : dashEscape(cell);
        return `<td>${content}</td>`;
      }).join('')}
    </tr>
  `).join('');
}

function renderDashboardActions(actions) {
  const container = document.getElementById('dashboard-actions');
  if (!container) return;
  if (!actions.length) {
    renderDashboardEmpty(container, 'No quick actions available.');
    return;
  }

  container.innerHTML = actions
    .filter(item => !item.page || canAccess(item.page))
    .map(item => `
      <button class="dashboard-action-btn" type="button" data-dashboard-page="${dashEscape(item.page || 'dashboard')}">
        <span>${dashEscape(item.label)}</span>
        <small>${dashEscape(item.sub || '')}</small>
      </button>
    `).join('');

  if (!container.innerHTML.trim()) {
    renderDashboardEmpty(container, 'No quick actions available.');
    return;
  }

  container.querySelectorAll('[data-dashboard-page]').forEach(button => {
    button.addEventListener('click', () => {
      const page = button.getAttribute('data-dashboard-page') || 'dashboard';
      const navItem = Array.from(document.querySelectorAll('[data-page]'))
        .find(item => item.getAttribute('data-page') === page);
      navigate(page, navItem || null);
    });
  });
}

function renderDashboardList(elementId, items, emptyText) {
  const container = document.getElementById(elementId);
  if (!container) return;
  if (!items.length) {
    renderDashboardEmpty(container, emptyText);
    return;
  }

  container.innerHTML = items.map(item => `
    <div class="dashboard-list-item">
      <strong>${dashEscape(item.title || 'Update')}</strong>
      <span>${dashEscape(item.message || '')}</span>
      <small>${dashEscape(item.date || '')}</small>
    </div>
  `).join('');
}

window.loadDashboard = loadDashboard;
