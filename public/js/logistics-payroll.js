/* Trip-based logistics payroll UI. All financial values are calculated server-side. */
(function logisticsPayrollModule() {
  const state = { truckTypes: [], locations: [], rates: [], employees: [], trips: [] };

  const money = value => `PHP ${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const today = () => new Date().toISOString().slice(0, 10);
  const currentMonth = () => new Date().toISOString().slice(0, 7);

  function periodRange(month) {
    const safeMonth = /^\d{4}-\d{2}$/.test(month || '') ? month : currentMonth();
    const [year, monthNumber] = safeMonth.split('-').map(Number);
    return { start: `${safeMonth}-01`, end: new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10) };
  }

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

  function setDefaultDates() {
    const tripDate = document.getElementById('delivery-trip-date');
    if (tripDate && !tripDate.value) tripDate.value = today();
    const tripQuantity = document.getElementById('delivery-trip-output-quantity');
    if (tripQuantity && !tripQuantity.value) tripQuantity.value = '1';
    const rateDate = document.querySelector('#logistics-rate-form [name="effective_date"]');
    if (rateDate && !rateDate.value) rateDate.value = today();
    const registryPeriod = document.getElementById('swr-fxr-period');
    if (registryPeriod && !registryPeriod.value) registryPeriod.value = document.getElementById('payroll-filter-month')?.value || currentMonth();
    const month = document.getElementById('payroll-filter-month')?.value || currentMonth();
    const range = periodRange(month);
    const summaryStart = document.getElementById('logistics-summary-start');
    const summaryEnd = document.getElementById('logistics-summary-end');
    if (summaryStart && !summaryStart.value) summaryStart.value = range.start;
    if (summaryEnd && !summaryEnd.value) summaryEnd.value = range.end;
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
    fillSelect('delivery-trip-truck-type', activeTrucks, 'id', row => row.name, 'Select truck type');
    fillSelect('logistics-rate-location', activeLocations, 'id', row => `${row.location_category} — ${row.name}`, 'Select location');
    fillSelect('delivery-trip-location', activeLocations, 'id', row => `${row.location_category} — ${row.name}`, 'Select location');
    fillSelect('delivery-trip-employee', state.employees, 'id', row => `${row.employee_code || '—'} — ${row.last_name}, ${row.first_name} (${row.position || 'No position'})`, 'Select employee');
  }

  function actionButton(label, fn, id, kind = 'outline') {
    return `<button class="btn btn-${kind} btn-sm" type="button" onclick="${fn}(${Number(id)})">${label}</button>`;
  }

  function renderTruckTypes() {
    const target = document.getElementById('logistics-truck-types-grid');
    if (!target) return;
    target.innerHTML = `<table><thead><tr><th>Truck Type</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead><tbody>${state.truckTypes.map(row => `
      <tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.description || '-')}</td><td>${Number(row.is_active) ? '<span class="status-badge active">Active</span>' : '<span class="status-badge inactive">Inactive</span>'}</td><td class="button-row">${actionButton('Edit', 'editLogisticsTruckType', row.id)} ${Number(row.is_active) ? actionButton('Deactivate', 'deactivateLogisticsTruckType', row.id) : ''}</td></tr>
    `).join('') || '<tr><td colspan="4">No truck types configured.</td></tr>'}</tbody></table>`;
  }

  function renderLocations() {
    const target = document.getElementById('logistics-locations-grid');
    if (!target) return;
    target.innerHTML = `<table><thead><tr><th>Category</th><th>Specific Location</th><th>Description</th><th>Status</th><th>Actions</th></tr></thead><tbody>${state.locations.map(row => `
      <tr><td>${escapeHtml(row.location_category)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.description || '-')}</td><td>${Number(row.is_active) ? '<span class="status-badge active">Active</span>' : '<span class="status-badge inactive">Inactive</span>'}</td><td class="button-row">${actionButton('Edit', 'editLogisticsLocation', row.id)} ${Number(row.is_active) ? actionButton('Deactivate', 'deactivateLogisticsLocation', row.id) : ''}</td></tr>
    `).join('') || '<tr><td colspan="5">No logistics locations configured.</td></tr>'}</tbody></table>`;
  }

  function renderRates() {
    const target = document.getElementById('logistics-rates-grid');
    if (!target) return;
    target.innerHTML = `<table><thead><tr><th>Truck</th><th>Location</th><th>Trip</th><th>Role</th><th>Trip Rate</th><th>Additional</th><th>Multiplier</th><th>Trip Pay</th><th>Rule</th><th>Status</th><th>Actions</th></tr></thead><tbody>${state.rates.map(row => `
      <tr><td>${escapeHtml(row.truck_type)}</td><td>${escapeHtml(row.location_category)} — ${escapeHtml(row.location_name)}</td><td>${escapeHtml(row.trip_type)}</td><td>${escapeHtml(row.role)}</td><td>${money(row.base_rate)}</td><td>${money(row.additional_rate)}</td><td>${Number(row.multiplier || 1).toFixed(2)}×</td><td>${money((Number(row.base_rate) * Number(row.multiplier)) + Number(row.additional_rate))}</td><td>${escapeHtml(row.special_rule_description || '-')}</td><td>${row.status === 'Active' ? '<span class="status-badge active">Active</span>' : '<span class="status-badge inactive">Inactive</span>'}</td><td class="button-row">${actionButton('Edit', 'editLogisticsRate', row.id)} ${row.status === 'Active' ? actionButton('Deactivate', 'deactivateLogisticsRate', row.id) : ''}</td></tr>
    `).join('') || '<tr><td colspan="11">No logistics rates configured.</td></tr>'}</tbody></table>`;
  }

  function tripActions(trip) {
    if (trip.status === 'Draft') return `${actionButton('Edit', 'editDeliveryTrip', trip.id)} ${actionButton('Submit', 'submitDeliveryTrip', trip.id, 'primary')} ${actionButton('Delete', 'deleteDeliveryTrip', trip.id)}`;
    if (trip.status === 'Submitted') return `${actionButton('Approve', 'approveDeliveryTrip', trip.id, 'primary')} ${actionButton('Reject', 'rejectDeliveryTrip', trip.id)}`;
    return '—';
  }

  function renderTrips() {
    const target = document.getElementById('delivery-trips-grid');
    if (!target) return;
    target.innerHTML = `<table><thead><tr><th>Date</th><th>Employee</th><th>Truck</th><th>Location</th><th>Trip</th><th>Role</th><th>Qty</th><th>Plate</th><th>Computation</th><th>Trip Pay</th><th>Status</th><th>Actions</th></tr></thead><tbody>${state.trips.map(row => `
      <tr><td>${escapeHtml(String(row.trip_date || '').slice(0, 10))}</td><td>${escapeHtml(row.employee_code || '')}<br>${escapeHtml(row.employee_name || '')}</td><td>${escapeHtml(row.truck_type)}</td><td>${escapeHtml(row.location_name)}</td><td>${escapeHtml(row.trip_type)}</td><td>${escapeHtml(row.role)}</td><td>${Number(row.output_quantity || 1)}</td><td>${escapeHtml(row.plate_number || '-')}</td><td>(${money(row.base_rate)} × ${Number(row.multiplier).toFixed(2)}) + ${money(row.additional_rate)} × ${Number(row.output_quantity || 1)}</td><td>${money(row.total_trip_pay)}</td><td><span class="status-badge ${escapeHtml(String(row.status).toLowerCase().replace(/\s+/g, '-'))}">${escapeHtml(row.status)}</span></td><td class="button-row">${tripActions(row)}</td></tr>
    `).join('') || '<tr><td colspan="12">No delivery trips found.</td></tr>'}</tbody></table>`;
  }

  async function loadLogisticsPayrollModule() {
    setDefaultDates();
    try {
      const [truckTypes, locations, rates, employees, trips] = await Promise.all([
        request('/api/payroll/logistics/truck-types?include_inactive=1'),
        request('/api/payroll/logistics/locations?include_inactive=1'),
        request('/api/payroll/logistics/rates?include_inactive=1'),
        request('/api/payroll/logistics/employees'),
        request('/api/payroll/logistics/trips')
      ]);
      state.truckTypes = truckTypes;
      state.locations = locations;
      state.rates = rates;
      state.employees = employees;
      state.trips = trips;
      populateSelectors();
      renderTruckTypes();
      renderLocations();
      renderRates();
      renderTrips();
      await refreshTripPreview();
      await loadLogisticsPayrollSummary();
    } catch (error) {
      const target = document.getElementById('delivery-trips-grid');
      if (target) target.innerHTML = `<div class="payroll-form-status error">${escapeHtml(error.message)}</div>`;
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
      document.querySelector('#logistics-rate-form [name="effective_date"]').value = today();
      document.querySelector('#logistics-rate-form [name="additional_rate"]').value = '0';
      document.querySelector('#logistics-rate-form [name="multiplier"]').value = '1';
      await loadLogisticsPayrollModule();
      await showMessage('Logistics rate saved.');
    } catch (error) { await showMessage(error.message, 'error'); }
  }

  function getTripFormPayload(status) {
    const form = document.getElementById('delivery-trip-form');
    const data = Object.fromEntries(new FormData(form).entries());
    data.status = status;
    return { form, data };
  }

  async function saveDeliveryTrip(event, status = 'Draft') {
    if (event) event.preventDefault();
    const { form, data } = getTripFormPayload(status);
    try {
      const existingTripId = Number(data.id || 0);
      await request(existingTripId ? `/api/payroll/logistics/trips/${existingTripId}` : '/api/payroll/logistics/trips', {
        method: existingTripId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
      });
      if (existingTripId && status === 'Submitted') {
        await request(`/api/payroll/logistics/trips/${existingTripId}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      }
      form.reset();
      document.getElementById('delivery-trip-date').value = today();
      const quantity = document.getElementById('delivery-trip-output-quantity');
      if (quantity) quantity.value = '1';
      await loadLogisticsPayrollModule();
      await showMessage(status === 'Submitted' ? 'Delivery trip submitted for approval.' : 'Delivery trip saved as draft.');
    } catch (error) { await showMessage(error.message, 'error'); }
  }

  async function submitDeliveryTripForm() { await saveDeliveryTrip(null, 'Submitted'); }

  async function refreshTripPreview() {
    const truck = document.getElementById('delivery-trip-truck-type')?.value;
    const location = document.getElementById('delivery-trip-location')?.value;
    const tripType = document.getElementById('delivery-trip-type')?.value;
    const role = document.getElementById('delivery-trip-role')?.value;
    const tripDate = document.getElementById('delivery-trip-date')?.value;
    const quantity = Math.max(1, Number(document.getElementById('delivery-trip-output-quantity')?.value || 1));
    const rateLabel = document.getElementById('delivery-trip-rate-preview');
    const payLabel = document.getElementById('delivery-trip-pay-preview');
    if (!truck || !location || !tripType || !role || !tripDate) return;
    try {
      const params = new URLSearchParams({ truck_type_id: truck, location_id: location, trip_type: tripType, role, trip_date: tripDate });
      const rate = await request(`/api/payroll/logistics/rates/preview?${params}`);
      const unitPay = Number(rate.total_trip_pay || 0);
      if (rateLabel) rateLabel.textContent = `(${money(rate.base_rate)} × ${Number(rate.multiplier).toFixed(2)}) + ${money(rate.additional_rate)} × ${quantity}${rate.special_rule_description ? ` — ${rate.special_rule_description}` : ''}`;
      if (payLabel) payLabel.textContent = money(unitPay * quantity);
    } catch (error) {
      if (rateLabel) rateLabel.textContent = error.message;
      if (payLabel) payLabel.textContent = money(0);
    }
  }

  function editLogisticsTruckType(id) {
    const row = state.truckTypes.find(item => Number(item.id) === Number(id));
    const form = document.getElementById('logistics-truck-type-form');
    if (!row || !form) return;
    form.elements.id.value = row.id; form.elements.name.value = row.name; form.elements.description.value = row.description || '';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function editLogisticsLocation(id) {
    const row = state.locations.find(item => Number(item.id) === Number(id));
    const form = document.getElementById('logistics-location-form');
    if (!row || !form) return;
    form.elements.id.value = row.id; form.elements.location_category.value = row.location_category; form.elements.name.value = row.name; form.elements.description.value = row.description || '';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function editLogisticsRate(id) {
    const row = state.rates.find(item => Number(item.id) === Number(id));
    const form = document.getElementById('logistics-rate-form');
    if (!row || !form) return;
    form.elements.id.value = row.id; form.elements.truck_type_id.value = row.truck_type_id; form.elements.location_id.value = row.location_id;
    form.elements.trip_type.value = row.trip_type; form.elements.role.value = row.role; form.elements.base_rate.value = row.base_rate;
    form.elements.additional_rate.value = row.additional_rate; form.elements.multiplier.value = row.multiplier; form.elements.effective_date.value = String(row.effective_date).slice(0, 10);
    form.elements.status.value = row.status; form.elements.special_rule_description.value = row.special_rule_description || '';
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function editDeliveryTrip(id) {
    const row = state.trips.find(item => Number(item.id) === Number(id));
    const form = document.getElementById('delivery-trip-form');
    if (!row || !form) return;
    form.elements.id.value = row.id; form.elements.employee_id.value = row.employee_id; form.elements.truck_type_id.value = row.truck_type_id;
    form.elements.location_id.value = row.location_id; form.elements.trip_date.value = String(row.trip_date).slice(0, 10); form.elements.trip_type.value = row.trip_type;
    form.elements.role.value = row.role; form.elements.plate_number.value = row.plate_number || '';
    if (form.elements.output_quantity) form.elements.output_quantity.value = row.output_quantity || 1;
    refreshTripPreview();
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function deactivateLogisticsTruckType(id) {
    if (!(await confirmAction('Deactivate this truck type? Existing trip history remains unchanged.', 'Deactivate Truck Type'))) return;
    try { await request(`/api/payroll/logistics/truck-types/${Number(id)}`, { method: 'DELETE' }); await loadLogisticsPayrollModule(); } catch (error) { await showMessage(error.message, 'error'); }
  }
  async function deactivateLogisticsLocation(id) {
    if (!(await confirmAction('Deactivate this location? Existing trip history remains unchanged.', 'Deactivate Location'))) return;
    try { await request(`/api/payroll/logistics/locations/${Number(id)}`, { method: 'DELETE' }); await loadLogisticsPayrollModule(); } catch (error) { await showMessage(error.message, 'error'); }
  }
  async function deactivateLogisticsRate(id) {
    if (!(await confirmAction('Deactivate this rate? Existing trip history remains unchanged.', 'Deactivate Logistics Rate'))) return;
    try { await request(`/api/payroll/logistics/rates/${Number(id)}`, { method: 'DELETE' }); await loadLogisticsPayrollModule(); } catch (error) { await showMessage(error.message, 'error'); }
  }
  async function submitDeliveryTrip(id) {
    try { await request(`/api/payroll/logistics/trips/${Number(id)}/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await loadLogisticsPayrollModule(); await showMessage('Delivery trip submitted for approval.'); } catch (error) { await showMessage(error.message, 'error'); }
  }
  async function approveDeliveryTrip(id) {
    if (!(await confirmAction('Approve this delivery trip for payroll?', 'Approve Delivery Trip'))) return;
    try { await request(`/api/payroll/logistics/trips/${Number(id)}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); await loadLogisticsPayrollModule(); await showMessage('Delivery trip approved.'); } catch (error) { await showMessage(error.message, 'error'); }
  }
  async function rejectDeliveryTrip(id) {
    const reason = window.prompt('Provide the rejection reason:');
    if (!reason) return;
    try { await request(`/api/payroll/logistics/trips/${Number(id)}/reject`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) }); await loadLogisticsPayrollModule(); await showMessage('Delivery trip rejected.'); } catch (error) { await showMessage(error.message, 'error'); }
  }
  async function deleteDeliveryTrip(id) {
    if (!(await confirmAction('Delete this Draft delivery trip?', 'Delete Delivery Trip'))) return;
    try { await request(`/api/payroll/logistics/trips/${Number(id)}`, { method: 'DELETE' }); await loadLogisticsPayrollModule(); await showMessage('Draft delivery trip deleted.'); } catch (error) { await showMessage(error.message, 'error'); }
  }

  async function loadLogisticsPayrollSummary() {
    const target = document.getElementById('logistics-payroll-summary-grid');
    if (!target) return;
    try {
      const startDate = document.getElementById('logistics-summary-start')?.value;
      const endDate = document.getElementById('logistics-summary-end')?.value;
      const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
      const result = await request(`/api/payroll/logistics/payroll-summary?${params}`);
      target.innerHTML = `<table><thead><tr><th>Employee</th><th>Position</th><th>Approved Trips</th><th>Total Logistics Pay</th></tr></thead><tbody>${result.rows.map(row => `<tr><td>${escapeHtml(row.employee_code || '')} — ${escapeHtml(row.employee_name)}</td><td>${escapeHtml(row.position || '-')}</td><td>${Number(row.approved_trip_count)}</td><td>${money(row.total_logistics_pay)}</td></tr>`).join('') || '<tr><td colspan="4">No approved delivery trips in this period.</td></tr>'}</tbody><tfoot><tr><th colspan="3">Total Logistics Pay</th><th>${money(result.total_logistics_pay)}</th></tr></tfoot></table>`;
    } catch (error) {
      target.innerHTML = `<div class="payroll-form-status error">${escapeHtml(error.message)}</div>`;
    }
  }

  function registryCell(record, role) {
    if (!record) return '<td></td><td></td><td></td><td></td>';
    return `<td>${escapeHtml(record.agency || 'Direct')}</td><td>${Number(record.no_of_days || 0)}</td><td>${escapeHtml(record.employee)}</td><td>${money(record.payroll_amount)}</td>`;
  }

  function renderSwrFxrRegistry(result) {
    const target = document.getElementById('swr-fxr-registry');
    if (!target) return;
    target.innerHTML = `<div class="swr-fxr-sheet">
      <div class="swr-fxr-heading"><strong>MARULAS INDUSTRIAL CORPORATION</strong><span>SWR-FXR-SUM PAYROLL REGISTRY</span><span>PAYROLL PERIOD: ${escapeHtml(result.payroll_period || '')}</span></div>
      <div class="table-wrap"><table class="swr-fxr-table"><thead><tr><th rowspan="2">#</th><th colspan="4">SEWER</th><th colspan="4">FIXER</th><th rowspan="2">TOTAL</th><th rowspan="2">PARTNER INFORMATION</th></tr><tr><th>Agency</th><th>No. of Days</th><th>Sewer</th><th>Amount</th><th>Agency</th><th>No. of Days</th><th>Fixer</th><th>Amount</th></tr></thead><tbody>${result.rows.map(row => `<tr><td>${row.line_number}</td>${registryCell(row.sewer, 'Sewer')}${registryCell(row.fixer, 'Fixer')}<td>${money(row.combined_amount)}</td><td>${escapeHtml(row.partner_information || 'Sewer + Fixer (55% / 45%)')}</td></tr>`).join('') || '<tr><td colspan="11">No Sewer/Fixer production payroll entries in this period.</td></tr>'}</tbody><tfoot><tr><th colspan="4">SEWER TOTAL</th><th>${money(result.totals?.sewer_share)}</th><th colspan="3">FIXER TOTAL</th><th>${money(result.totals?.fixer_share)}</th><th>GRAND TOTAL<br>${money(result.totals?.combined_payroll)}</th><th></th></tr></tfoot></table></div>
      <div class="swr-fxr-agency-totals"><h3>Agency Totals</h3><table><thead><tr><th>Agency</th><th>Sewer</th><th>Fixer</th><th>Total</th></tr></thead><tbody>${result.agency_totals.map(row => `<tr><td>${escapeHtml(row.agency)}</td><td>${money(row.sewer_amount)}</td><td>${money(row.fixer_amount)}</td><td>${money(row.total_amount)}</td></tr>`).join('') || '<tr><td colspan="4">No agency totals.</td></tr>'}</tbody></table></div>
    </div>`;
  }

  function renderSwrFxrRegistryEmpty(message) {
    const target = document.getElementById('swr-fxr-registry');
    if (!target) return;
    target.innerHTML = `<div class="payroll-empty-state">${escapeHtml(message)}</div>`;
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
    // Open synchronously from the user click. `noopener,noreferrer` makes some
    // browsers return null even when the popup opened, which looked like a block.
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

  function bindTripPreview() {
    ['delivery-trip-truck-type', 'delivery-trip-location', 'delivery-trip-date', 'delivery-trip-type', 'delivery-trip-role', 'delivery-trip-output-quantity'].forEach(id => {
      const element = document.getElementById(id);
      if (element && !element.dataset.logisticsBound) {
        element.addEventListener(id === 'delivery-trip-output-quantity' ? 'input' : 'change', refreshTripPreview);
        element.dataset.logisticsBound = '1';
      }
    });
  }

  function initialize() {
    setDefaultDates();
    bindTripPreview();
  }

  document.addEventListener('partialsLoaded', initialize);
  if (document.readyState !== 'loading') initialize();

  Object.assign(window, {
    loadLogisticsPayrollModule, saveLogisticsTruckType, saveLogisticsLocation, saveLogisticsRate,
    saveDeliveryTrip, submitDeliveryTripForm, refreshTripPreview, editLogisticsTruckType, editLogisticsLocation,
    editLogisticsRate, editDeliveryTrip, deactivateLogisticsTruckType, deactivateLogisticsLocation,
    deactivateLogisticsRate, submitDeliveryTrip, approveDeliveryTrip, rejectDeliveryTrip, deleteDeliveryTrip,
    loadLogisticsPayrollSummary, prepareSwrFxrRegistry, generateSwrFxrRegistry,
    loadSwrFxrRegistry: generateSwrFxrRegistry, printSwrFxrRegistry
  });
})();
