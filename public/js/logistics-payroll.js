/* Trip-based logistics payroll UI. Financial values are calculated server-side. */
(function logisticsPayrollModule() {
  const state = { truckTypes: [], locations: [], rates: [], employees: [], ratesPage: 1, ratesPageSize: 10 };

  const money = value => `PHP ${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const today = () => window.LGSVDatePicker?.todayValue?.() || (() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  })();
  const currentMonth = () => today().slice(0, 7);

  const currentUser = () => (typeof getUser === 'function' ? getUser() : null) || {};
  const currentRole = () => {
    const user = currentUser();
    const rawRole = user.role || user.roleName || user.role_label || user.roleLabel || '';
    if (typeof normalizeClientRole === 'function') return normalizeClientRole(rawRole);
    return String(rawRole).trim().toLowerCase().replace(/[\s-]+/g, '_');
  };
  const logisticsConfigurationRoles = new Set(['payroll_officer', 'payroll_manager', 'hr_manager', 'hr_admin']);
  const hasPermission = permission => Array.isArray(currentUser().permissions)
    && currentUser().permissions.includes(permission);
  const canConfigureLogistics = () => logisticsConfigurationRoles.has(currentRole())
    || hasPermission('payroll.settings.manage');

  async function request(url, options) {
    const response = await apiFetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The logistics request could not be completed.');
    return data;
  }

  function showMessage(message, type = 'success') {
    if (typeof showAlert === 'function') return showAlert(message, type === 'success' ? 'Saved' : 'Error', type);
    window.alert(message);
    return Promise.resolve();
  }

  async function confirmAction(message, title = 'Confirm') {
    if (typeof showConfirm === 'function') return showConfirm(message, title, 'Continue', 'Cancel');
    return window.confirm(message);
  }

  function applyLogisticsRoleAccess() {
    document.querySelectorAll('[data-logistics-configure-only]').forEach(element => {
      element.style.display = canConfigureLogistics() ? '' : 'none';
    });
  }

  function setDefaultDates() {
    const tripDate = document.getElementById('delivery-trip-date');
    if (tripDate && !tripDate.value) tripDate.value = today();
    const rateDate = document.querySelector('#logistics-rate-form [name="effective_date"]');
    if (rateDate && !rateDate.value) rateDate.value = today();
    const registryPeriod = document.getElementById('swr-fxr-period');
    if (registryPeriod && !registryPeriod.value) registryPeriod.value = document.getElementById('payroll-filter-month')?.value || currentMonth();
  }

  function fillSelect(id, rows, valueKey, textBuilder, placeholder) {
    const select = document.getElementById(id);
    if (!select) return;
    const selected = select.value;
    select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>${rows.map(row => `<option value="${Number(row[valueKey])}">${escapeHtml(textBuilder(row))}</option>`).join('')}`;
    if ([...select.options].some(option => option.value === selected)) select.value = selected;
  }

  function populateSelectors() {
    const activeTrucks = state.truckTypes.filter(row => Number(row.is_active) === 1);
    const activeLocations = state.locations.filter(row => Number(row.is_active) === 1);
    fillSelect('logistics-rate-truck-type', activeTrucks, 'id', row => row.name, 'Select truck type');
    fillSelect('logistics-rate-location', activeLocations, 'id', row => `${row.location_category} - ${row.name}`, 'Select location');
    fillSelect('delivery-trip-truck-type', activeTrucks, 'id', row => row.name, 'Select truck type');
    fillSelect('delivery-trip-location', activeLocations, 'id', row => `${row.location_category} - ${row.name}`, 'Select location');
    fillSelect('delivery-trip-employee', state.employees, 'id', row => `${row.employee_code || '-'} - ${row.employee_name || [row.last_name, row.first_name].filter(Boolean).join(', ')} (${row.position || 'No position'})`, 'Select employee');
  }

  function actionButton(label, action, id, kind = 'outline') {
    return `<button class="btn btn-${kind} btn-sm" type="button" data-logistics-action="${escapeHtml(action)}" data-logistics-id="${Number(id)}">${escapeHtml(label)}</button>`;
  }

  function renderTruckTypes() {
    const target = document.getElementById('logistics-truck-types-grid');
    if (!target) return;
    target.innerHTML = `<table data-no-pagination="1"><thead><tr><th>Truck Type</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead><tbody>${state.truckTypes.map(row => `
      <tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.description || '-')}</td><td>${Number(row.is_active) ? '<span class="status-badge active">Active</span>' : '<span class="status-badge inactive">Inactive</span>'}</td><td class="button-row">${actionButton('Edit', 'editTruckType', row.id)} ${Number(row.is_active) ? actionButton('Deactivate', 'deactivateTruckType', row.id) : ''}</td></tr>
    `).join('') || '<tr><td colspan="4">No truck types configured.</td></tr>'}</tbody></table>`;
  }

  function renderLocations() {
    const target = document.getElementById('logistics-locations-grid');
    if (!target) return;
    target.innerHTML = `<table data-no-pagination="1"><thead><tr><th>Category</th><th>Specific Location</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead><tbody>${state.locations.map(row => `
      <tr><td>${escapeHtml(row.location_category)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.description || '-')}</td><td>${Number(row.is_active) ? '<span class="status-badge active">Active</span>' : '<span class="status-badge inactive">Inactive</span>'}</td><td class="button-row">${actionButton('Edit', 'editLocation', row.id)} ${Number(row.is_active) ? actionButton('Deactivate', 'deactivateLocation', row.id) : ''}</td></tr>
    `).join('') || '<tr><td colspan="5">No logistics locations configured.</td></tr>'}</tbody></table>`;
  }

  function renderRates() {
    const target = document.getElementById('logistics-rates-grid');
    if (!target) return;
    const totalRows = state.rates.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / state.ratesPageSize));
    state.ratesPage = Math.min(Math.max(Number(state.ratesPage || 1), 1), totalPages);
    const start = (state.ratesPage - 1) * state.ratesPageSize;
    const end = Math.min(start + state.ratesPageSize, totalRows);
    const pageRows = state.rates.slice(start, end);

    target.innerHTML = `<table data-no-pagination="1"><thead><tr><th>Truck</th><th>Location</th><th>Trip</th><th>Role</th><th>Trip Rate</th><th>Additional</th><th>Multiplier</th><th>Trip Pay</th><th>Rule</th><th>Status</th><th>Actions</th></tr></thead><tbody>${pageRows.map(row => `
      <tr><td>${escapeHtml(row.truck_type)}</td><td>${escapeHtml(row.location_category)} - ${escapeHtml(row.location_name)}</td><td>${escapeHtml(row.trip_type)}</td><td>${escapeHtml(row.role)}</td><td>${money(row.base_rate)}</td><td>${money(row.additional_rate)}</td><td>${Number(row.multiplier || 1).toFixed(2)}x</td><td>${money((Number(row.base_rate) * Number(row.multiplier)) + Number(row.additional_rate))}</td><td>${escapeHtml(row.special_rule_description || '-')}</td><td>${row.status === 'Active' ? '<span class="status-badge active">Active</span>' : '<span class="status-badge inactive">Inactive</span>'}</td><td class="button-row">${actionButton('Edit', 'editRate', row.id)} ${row.status === 'Active' ? actionButton('Deactivate', 'deactivateRate', row.id) : ''}</td></tr>
    `).join('') || '<tr><td colspan="11">No logistics rates configured.</td></tr>'}</tbody></table>`;

    const tableWrap = target.closest('.table-wrap');
    const existingPager = tableWrap?.nextElementSibling;
    if (existingPager?.classList.contains('logistics-rates-pagination')) existingPager.remove();
    if (!tableWrap || totalRows <= state.ratesPageSize) return;

    const pager = document.createElement('div');
    pager.className = 'table-pagination table-pagination-auto logistics-rates-pagination';
    pager.innerHTML = `
      <span>Showing ${start + 1}-${end} of ${totalRows}</span>
      <div class="table-pagination-actions">
        <button class="btn btn-outline btn-sm" type="button" onclick="changeLogisticsRatesPage(-1)" ${state.ratesPage <= 1 ? 'disabled' : ''}>Previous</button>
        <span>Page ${state.ratesPage} of ${totalPages}</span>
        <button class="btn btn-outline btn-sm" type="button" onclick="changeLogisticsRatesPage(1)" ${state.ratesPage >= totalPages ? 'disabled' : ''}>Next</button>
      </div>
    `;
    tableWrap.insertAdjacentElement('afterend', pager);
  }

  function changeLogisticsRatesPage(direction) {
    const totalPages = Math.max(1, Math.ceil(state.rates.length / state.ratesPageSize));
    state.ratesPage = Math.min(Math.max(Number(state.ratesPage || 1) + Number(direction || 0), 1), totalPages);
    renderRates();
  }

  async function loadLogisticsPayrollModule() {
    applyLogisticsRoleAccess();
    setDefaultDates();
    try {
      const [truckTypes, locations, rates, employees] = await Promise.all([
        request('/api/payroll/logistics/truck-types?include_inactive=1'),
        request('/api/payroll/logistics/locations?include_inactive=1'),
        request('/api/payroll/logistics/rates?include_inactive=1'),
        request('/api/payroll/logistics/employees')
      ]);
      state.truckTypes = truckTypes;
      state.locations = locations;
      state.rates = rates;
      state.employees = employees;
      populateSelectors();
      renderTruckTypes();
      renderLocations();
      renderRates();
      await refreshTripPreview();
    } catch (error) {
      const target = document.getElementById('logistics-rates-grid');
      if (target) target.innerHTML = `<div class="payroll-form-status error">${escapeHtml(error.message)}</div>`;
    }
  }

  function getTripFormPayload(status) {
    const form = document.getElementById('delivery-trip-form');
    if (!form) throw new Error('Delivery trip form is unavailable.');
    const data = Object.fromEntries(new FormData(form).entries());
    data.status = status;
    return { form, data };
  }

  async function saveDeliveryTrip(event, status = 'Draft') {
    if (event) event.preventDefault();
    try {
      const { form, data } = getTripFormPayload(status);
      const existingTripId = Number(data.id || 0);
      await request(existingTripId ? `/api/payroll/logistics/trips/${existingTripId}` : '/api/payroll/logistics/trips', {
        method: existingTripId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      if (existingTripId && status === 'Payroll Ready') {
        await request(`/api/payroll/logistics/trips/${existingTripId}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      }
      form.reset();
      const tripDate = document.getElementById('delivery-trip-date');
      if (tripDate) tripDate.value = today();
      await loadLogisticsPayrollModule();
      await showMessage(status === 'Payroll Ready' ? 'Delivery trip encoded and marked Payroll Ready.' : 'Delivery trip saved as draft.');
    } catch (error) { await showMessage(error.message, 'error'); }
  }

  async function submitDeliveryTripForm() { await saveDeliveryTrip(null, 'Payroll Ready'); }

  async function refreshTripPreview() {
    const truck = document.getElementById('delivery-trip-truck-type')?.value;
    const location = document.getElementById('delivery-trip-location')?.value;
    const tripType = document.getElementById('delivery-trip-type')?.value;
    const role = document.getElementById('delivery-trip-role')?.value;
    const tripDate = document.getElementById('delivery-trip-date')?.value;
    const quantity = Math.max(1, Number(document.querySelector('#delivery-trip-form [name="output_quantity"]')?.value || 1));
    const rateLabel = document.getElementById('delivery-trip-rate-preview');
    const payLabel = document.getElementById('delivery-trip-pay-preview');
    if (!truck || !location || !tripType || !role || !tripDate) return;
    try {
      const params = new URLSearchParams({ truck_type_id: truck, location_id: location, trip_type: tripType, role, trip_date: tripDate });
      const rate = await request(`/api/payroll/logistics/rates/preview?${params}`);
      if (rateLabel) rateLabel.textContent = `(${money(rate.base_rate)} x ${Number(rate.multiplier).toFixed(2)}) + ${money(rate.additional_rate)}${rate.special_rule_description ? ` - ${rate.special_rule_description}` : ''}`;
      if (payLabel) payLabel.textContent = money(Number(rate.total_trip_pay || 0) * quantity);
    } catch (error) {
      if (rateLabel) rateLabel.textContent = error.message;
      if (payLabel) payLabel.textContent = money(0);
    }
  }

  async function saveLogisticsTruckType(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await request(data.id ? `/api/payroll/logistics/truck-types/${Number(data.id)}` : '/api/payroll/logistics/truck-types', {
        method: data.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      form.reset();
      await loadLogisticsPayrollModule();
      await showMessage('Truck type saved.');
    } catch (error) { await showMessage(error.message, 'error'); }
  }

  async function saveLogisticsLocation(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await request(data.id ? `/api/payroll/logistics/locations/${Number(data.id)}` : '/api/payroll/logistics/locations', {
        method: data.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      form.reset();
      await loadLogisticsPayrollModule();
      await showMessage('Logistics location saved.');
    } catch (error) { await showMessage(error.message, 'error'); }
  }

  async function saveLogisticsRate(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      await request(data.id ? `/api/payroll/logistics/rates/${Number(data.id)}` : '/api/payroll/logistics/rates', {
        method: data.id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      form.reset();
      const rateDate = document.querySelector('#logistics-rate-form [name="effective_date"]');
      const additionalRate = document.querySelector('#logistics-rate-form [name="additional_rate"]');
      const multiplier = document.querySelector('#logistics-rate-form [name="multiplier"]');
      if (rateDate) rateDate.value = today();
      if (additionalRate) additionalRate.value = '0';
      if (multiplier) multiplier.value = '1';
      await loadLogisticsPayrollModule();
      await showMessage('Logistics rate saved.');
    } catch (error) { await showMessage(error.message, 'error'); }
  }

  function editLogisticsTruckType(id) {
    const row = state.truckTypes.find(item => Number(item.id) === Number(id));
    const form = document.getElementById('logistics-truck-type-form');
    if (!row || !form) return;
    form.elements.id.value = row.id;
    form.elements.name.value = row.name;
    form.elements.description.value = row.description || '';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function editLogisticsLocation(id) {
    const row = state.locations.find(item => Number(item.id) === Number(id));
    const form = document.getElementById('logistics-location-form');
    if (!row || !form) return;
    form.elements.id.value = row.id;
    form.elements.location_category.value = row.location_category;
    form.elements.name.value = row.name;
    form.elements.description.value = row.description || '';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function editLogisticsRate(id) {
    const row = state.rates.find(item => Number(item.id) === Number(id));
    const form = document.getElementById('logistics-rate-form');
    if (!row || !form) return;
    form.elements.id.value = row.id;
    form.elements.truck_type_id.value = row.truck_type_id;
    form.elements.location_id.value = row.location_id;
    form.elements.trip_type.value = row.trip_type;
    form.elements.role.value = row.role;
    form.elements.base_rate.value = row.base_rate;
    form.elements.additional_rate.value = row.additional_rate;
    form.elements.multiplier.value = row.multiplier;
    form.elements.effective_date.value = String(row.effective_date).slice(0, 10);
    form.elements.status.value = row.status;
    form.elements.special_rule_description.value = row.special_rule_description || '';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function deactivateLogisticsTruckType(id) {
    if (!(await confirmAction('Deactivate this truck type? Existing trip history remains unchanged.', 'Deactivate Truck Type'))) return;
    try {
      const result = await request(`/api/payroll/logistics/truck-types/${Number(id)}`, { method: 'DELETE' });
      await loadLogisticsPayrollModule();
      await showMessage(result.message || 'Truck type deactivated.');
    } catch (error) { await showMessage(error.message, 'error'); }
  }

  async function deactivateLogisticsLocation(id) {
    if (!(await confirmAction('Deactivate this location? Existing trip history remains unchanged.', 'Deactivate Location'))) return;
    try {
      const result = await request(`/api/payroll/logistics/locations/${Number(id)}`, { method: 'DELETE' });
      await loadLogisticsPayrollModule();
      await showMessage(result.message || 'Logistics location deactivated.');
    } catch (error) { await showMessage(error.message, 'error'); }
  }

  async function deactivateLogisticsRate(id) {
    if (!(await confirmAction('Deactivate this rate? Existing trip history remains unchanged.', 'Deactivate Logistics Rate'))) return;
    try {
      const result = await request(`/api/payroll/logistics/rates/${Number(id)}`, { method: 'DELETE' });
      await loadLogisticsPayrollModule();
      await showMessage(result.message || 'Logistics rate deactivated.');
    } catch (error) { await showMessage(error.message, 'error'); }
  }

  async function handleLogisticsActionClick(event) {
    const button = event.target.closest('[data-logistics-action]');
    if (!button || !document.getElementById('payroll-tab-logistics')?.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();

    const id = Number(button.dataset.logisticsId);
    const action = button.dataset.logisticsAction;
    if (!Number.isInteger(id) || id <= 0) return;

    button.disabled = true;
    try {
      if (action === 'editTruckType') return editLogisticsTruckType(id);
      if (action === 'editLocation') return editLogisticsLocation(id);
      if (action === 'editRate') return editLogisticsRate(id);
      if (action === 'deactivateTruckType') return await deactivateLogisticsTruckType(id);
      if (action === 'deactivateLocation') return await deactivateLogisticsLocation(id);
      if (action === 'deactivateRate') return await deactivateLogisticsRate(id);
    } finally {
      button.disabled = false;
    }
  }

  function registryCell(record) {
    if (!record) return '<td></td><td></td><td></td><td></td>';
    return `<td>${escapeHtml(record.agency || 'Direct')}</td><td>${Number(record.no_of_days || 0)}</td><td>${escapeHtml(record.employee)}</td><td>${money(record.payroll_amount)}</td>`;
  }

  function renderSwrFxrRegistry(result) {
    const target = document.getElementById('swr-fxr-registry');
    if (!target) return;
    target.innerHTML = `<div class="swr-fxr-sheet">
      <div class="swr-fxr-heading"><strong>MARULAS INDUSTRIAL CORPORATION</strong><span>SWR-FXR-SUM PAYROLL REGISTRY</span><span>PAYROLL PERIOD: ${escapeHtml(result.payroll_period || '')}</span></div>
      <div class="table-wrap"><table class="swr-fxr-table"><thead><tr><th rowspan="2">#</th><th colspan="4">SEWER</th><th colspan="4">FIXER</th><th rowspan="2">TOTAL</th><th rowspan="2">PARTNER INFORMATION</th></tr><tr><th>Agency</th><th>No. of Days</th><th>Sewer</th><th>Amount</th><th>Agency</th><th>No. of Days</th><th>Fixer</th><th>Amount</th></tr></thead><tbody>${result.rows.map(row => `<tr><td>${row.line_number}</td>${registryCell(row.sewer)}${registryCell(row.fixer)}<td>${money(row.combined_amount)}</td><td>${escapeHtml(row.partner_information || 'Sewer + Fixer (55% / 45%)')}</td></tr>`).join('') || '<tr><td colspan="11">No Sewer/Fixer production payroll entries in this period.</td></tr>'}</tbody><tfoot><tr><th colspan="4">SEWER TOTAL</th><th>${money(result.totals?.sewer_share)}</th><th colspan="3">FIXER TOTAL</th><th>${money(result.totals?.fixer_share)}</th><th>GRAND TOTAL<br>${money(result.totals?.combined_payroll)}</th><th></th></tr></tfoot></table></div>
      <div class="swr-fxr-agency-totals"><h3>Agency Totals</h3><table><thead><tr><th>Agency</th><th>Sewer</th><th>Fixer</th><th>Total</th></tr></thead><tbody>${result.agency_totals.map(row => `<tr><td>${escapeHtml(row.agency)}</td><td>${money(row.sewer_amount)}</td><td>${money(row.fixer_amount)}</td><td>${money(row.total_amount)}</td></tr>`).join('') || '<tr><td colspan="4">No agency totals.</td></tr>'}</tbody></table></div>
    </div>`;
  }

  function renderSwrFxrRegistryEmpty(message) {
    const target = document.getElementById('swr-fxr-registry');
    if (target) target.innerHTML = `<div class="payroll-empty-state">${escapeHtml(message)}</div>`;
  }

  async function prepareSwrFxrRegistry() {
    const periodInput = document.getElementById('swr-fxr-period');
    const hint = document.getElementById('swr-fxr-period-hint');
    if (!periodInput) return;

    if (!periodInput.dataset.swrFxrPeriodReady) {
      periodInput.dataset.swrFxrPeriodReady = '1';
      periodInput.addEventListener('change', () => {
        periodInput.dataset.swrFxrPeriodSelected = '1';
        renderSwrFxrRegistryEmpty('Select Generate Registry to create the payroll register for the selected period.');
      });
    }

    try {
      const result = await request('/api/payroll/swr-fxr-sum/periods');
      const periods = Array.isArray(result.periods) ? result.periods : [];
      if (!periodInput.dataset.swrFxrPeriodSelected && periods[0]?.payroll_period) {
        periodInput.value = periods[0].payroll_period;
      }
      if (hint) {
        hint.textContent = periods.length
          ? `Available Sewer/Fixer production periods: ${periods.map(row => row.payroll_period).join(', ')}.`
          : 'No Sewer/Fixer production pairs have been encoded yet.';
      }
    } catch (error) {
      if (hint) hint.textContent = 'Production periods could not be loaded.';
    }
  }

  async function generateSwrFxrRegistry() {
    const period = document.getElementById('swr-fxr-period')?.value || currentMonth();
    try {
      const summary = await request(`/api/payroll/swr-fxr-summary?month_year=${encodeURIComponent(period)}`);
      const agencyMap = new Map();
      const result = {
        payroll_period: summary.payroll_period,
        rows: (summary.rows || []).map((row, index) => {
          const agency = agencyMap.get(row.agency) || { agency: row.agency, sewer_amount: 0, fixer_amount: 0, total_amount: 0 };
          agency.sewer_amount += Number(row.sewer_amount || 0);
          agency.fixer_amount += Number(row.fixer_amount || 0);
          agency.total_amount += Number(row.combined_total || 0);
          agencyMap.set(row.agency, agency);
          return {
            line_number: index + 1,
            sewer: { agency: row.agency, no_of_days: row.no_of_days, employee: row.sewer_employee, payroll_amount: row.sewer_amount },
            fixer: { agency: row.agency, no_of_days: row.no_of_days, employee: row.fixer_employee, payroll_amount: row.fixer_amount },
            combined_amount: row.combined_total,
            partner_information: row.partner_information
          };
        }),
        agency_totals: [...agencyMap.values()],
        totals: { sewer_share: summary.totals?.sewer_amount || 0, fixer_share: summary.totals?.fixer_amount || 0, combined_payroll: summary.totals?.combined_total || 0 }
      };
      renderSwrFxrRegistry(result);
      const hint = document.getElementById('swr-fxr-period-hint');
      if (hint) hint.textContent = `Registry generated from ${Number(result.rows.length || 0)} encoded Sewer/Fixer pair(s).`;
      return result;
    } catch (error) {
      renderSwrFxrRegistryEmpty(error.message);
      return null;
    }
  }

  function printSwrFxrRegistry() {
    const sheet = document.querySelector('#swr-fxr-registry .swr-fxr-sheet');
    if (!sheet) return showMessage('Generate the registry first.', 'error');
    const printWindow = window.open('', '_blank');
    if (!printWindow) return showMessage('Your browser blocked the print window.', 'error');
    try {
      printWindow.opener = null;
      printWindow.document.open();
      printWindow.document.write(`<!doctype html><html><head><title>SWR-FXR-SUM Payroll Registry</title><style>body{font-family:Arial,sans-serif;color:#111;padding:18px}table{width:100%;border-collapse:collapse;font-size:11px;margin:12px 0}th,td{border:1px solid #333;padding:5px;vertical-align:top}th{text-align:center;background:#f1f1f1}.swr-fxr-heading{text-align:center;display:grid;gap:4px;margin-bottom:12px}.swr-fxr-agency-totals{max-width:520px;margin-top:18px}@page{size:landscape;margin:10mm}</style></head><body>${sheet.outerHTML}</body></html>`);
      printWindow.document.close();
      window.setTimeout(() => {
        printWindow.focus();
        printWindow.print();
      }, 100);
    } catch (error) {
      printWindow.close();
      return showMessage('The payroll registry could not be prepared for printing.', 'error');
    }
  }

  function initialize() {
    applyLogisticsRoleAccess();
    setDefaultDates();
    ['delivery-trip-truck-type', 'delivery-trip-location', 'delivery-trip-date', 'delivery-trip-type', 'delivery-trip-role'].forEach(id => {
      const element = document.getElementById(id);
      if (!element || element.dataset.logisticsBound === '1') return;
      element.dataset.logisticsBound = '1';
      element.addEventListener('change', refreshTripPreview);
    });
    const quantity = document.querySelector('#delivery-trip-form [name="output_quantity"]');
    if (quantity && quantity.dataset.logisticsBound !== '1') {
      quantity.dataset.logisticsBound = '1';
      quantity.addEventListener('input', refreshTripPreview);
    }
  }

  document.addEventListener('click', handleLogisticsActionClick);
  document.addEventListener('partialsLoaded', initialize);
  if (document.readyState !== 'loading') initialize();

  Object.assign(window, {
    loadLogisticsPayrollModule, saveLogisticsTruckType, saveLogisticsLocation, saveLogisticsRate,
    saveDeliveryTrip, submitDeliveryTripForm, refreshTripPreview,
    editLogisticsTruckType, editLogisticsLocation, editLogisticsRate, deactivateLogisticsTruckType,
    deactivateLogisticsLocation, deactivateLogisticsRate,
    prepareSwrFxrRegistry, generateSwrFxrRegistry,
    changeLogisticsRatesPage, loadSwrFxrRegistry: generateSwrFxrRegistry, printSwrFxrRegistry
  });
})();
