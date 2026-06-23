/* Salary Calculation - Simple Edition */

let currentSalaryEmployee = null;
let salaryEmpList = [];
let sewingTypes = [];
let logisticsRegions = [];
let salaryTruckTypes = [];
let salaryDeliveryLocations = [];
let payrollDeductionSettings = [];
let salaryPageInitialized = false;
let salarySearchListenerAttached = false;
let salaryPartnerSearchListenerAttached = false;
let salaryInputListenersAttached = false;
let salaryPieceRowCounter = 0;
let salaryPayrollValidation = null;
let salaryAgencyList = [];
let currentSalaryDraftId = null;
let salaryDepartmentFilterListenerAttached = false;

function salaryEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function normalizeSalaryWageType(value) {
  const name = String(value || '').trim();
  if (/piece/i.test(name)) return 'Per-Piece';
  if (/trip|logistics/i.test(name)) return 'Per-Trip';
  if (/hour/i.test(name)) return 'Hourly';
  if (/day|daily/i.test(name)) return 'Daily';
  if (/base|salary/i.test(name)) return 'Base Salary';
  return name;
}

// Init when DOM ready
window.addEventListener('DOMContentLoaded', () => {
  console.log('📄 Salary page ready');
  console.log('✅ Initializing wage types...');
  
  // Ensure wage types are loaded first
  fetchWageTypes().then(() => {
    console.log('✅ Wage types loaded, fetching employees...');
    fetchSalaryEmpList();
  }).catch(err => {
    console.error('❌ Failed to load wage types:', err);
    fetchSalaryEmpList(); // Try to continue anyway
  });
  
  attachSalaryInputListeners();
  console.log('✅ Input listeners attached');
});

async function loadSalaryCalculationPage() {
  if (!document.getElementById('salary-employee-search')) return;

  if (!salaryPageInitialized) {
    salaryPageInitialized = true;
    try {
      await fetchWageTypes();
      await fetchPayrollDeductionSettings();
      if (typeof loadPieceRateConfig === 'function') await loadPieceRateConfig();
    } catch (err) {
      console.error('Failed to load wage types:', err);
    }
    attachSalaryInputListeners();
  }

  await fetchSalaryEmpList();

  const pendingDraft = sessionStorage.getItem('continueSalaryDraft');
  if (pendingDraft) {
    sessionStorage.removeItem('continueSalaryDraft');
    try {
      await restoreSalaryDraftFromRecord(JSON.parse(pendingDraft));
    } catch (err) {
      console.error('Failed to restore salary draft:', err);
    }
  }

  const periodInput = document.getElementById('salary-payroll-period');
  if (periodInput && !periodInput.value) {
    const today = new Date();
    periodInput.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  }
}

async function fetchPayrollDeductionSettings() {
  try {
    const res = await apiFetch('/api/payroll/deduction-settings');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payrollDeductionSettings = await res.json();
  } catch (err) {
    console.warn('Failed to load payroll deduction settings:', err.message);
    payrollDeductionSettings = [];
  }
}

document.addEventListener('partialsLoaded', loadSalaryCalculationPage);

function getActivePieceRate(productType, sizeRange = '') {
  const sewCode = String(productType || '').trim();
  const selectedSize = String(sizeRange || '').trim();
  const rows = (window.pieceRateConfig?.piece_rates || []).filter(row => {
    if (Number(row.is_active) !== 1) return false;
    const rowSew = row.sew_type_code || row.product_type;
    const rowSize = row.size_range || row.product_category || '';
    return rowSew === sewCode && (!selectedSize || rowSize === selectedSize);
  });
  return rows.sort((a, b) => String(b.effective_date || '').localeCompare(String(a.effective_date || '')))[0] || null;
}

function getActiveShare(workerCategory) {
  const rows = (window.pieceRateConfig?.production_shares || []).filter(row => Number(row.is_active) === 1 && row.worker_category === workerCategory);
  return rows.sort((a, b) => String(b.effective_date || '').localeCompare(String(a.effective_date || '')))[0] || null;
}

function getPieceIncentivePreview(quantity, productType, productCategory, isSunday, shareEarnings) {
  const incentives = (window.pieceRateConfig?.incentives || []).filter(row => Number(row.is_active) === 1);
  const quota = incentives
    .filter(row => row.incentive_category === 'Quota Incentive' && Number(row.threshold_quantity || 0) <= quantity)
    .sort((a, b) => Number(b.threshold_quantity || 0) - Number(a.threshold_quantity || 0))[0];
  const sunday = isSunday ? incentives.find(row => row.incentive_category === 'Sunday Work Incentive') : null;
  const special = incentives.find(row =>
    row.incentive_category === 'Special Sewing Type Incentive'
    && (!row.sewing_type || row.sewing_type === productCategory || row.sewing_type === productType)
  );
  const sundayAmount = sunday
    ? sunday.computation_type === 'Percentage Multiplier'
      ? shareEarnings * ((Number(sunday.amount || 0)) / 100)
      : Number(sunday.amount || 0)
    : 0;
  return {
    quota: quota ? Number(quota.amount || 0) : 0,
    sunday: sundayAmount,
    special: special ? Number(special.amount || 0) : 0
  };
}

function updatePieceDetailView() {
  const preview = currentSalaryEmployee?.piecePreview;
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  const peso = value => `PHP ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  set('salary-piece-rate-view', peso(preview?.piece_rate));
  set('salary-share-view', preview ? `${Number(preview.share_percentage || 0)}%` : '0%');
  set('salary-quota-view', peso(preview?.quota_incentive));
  set('salary-sunday-view', peso(preview?.sunday_incentive));
  set('salary-special-view', peso(preview?.special_incentive));
}

function salaryMoney(value) {
  return `PHP ${Number(value || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

window.restoreSalaryDraftFromRecord = restoreSalaryDraftFromRecord;

function setSummaryField(id, value) {
  const element = document.getElementById(id);
  if (!element) return;
  if (typeof element.value !== 'undefined') element.value = value;
  else element.textContent = value;
}

function updateSalaryRateVisibility(wageType) {
  const normalized = normalizeSalaryWageType(wageType);
  const hideRate = normalized === 'Per-Piece' || normalized === 'Per-Trip';
  const rateField = document.getElementById('salary-rate-field');
  const summaryRateWrap = document.getElementById('summary-rate-wrap');
  const summaryBaseLabel = document.getElementById('summary-base-label');
  const wageInfo = document.getElementById('salary-employee-wage-info');
  if (rateField) rateField.style.display = hideRate ? 'none' : '';
  if (summaryRateWrap) summaryRateWrap.style.display = hideRate ? 'none' : '';
  if (summaryBaseLabel) {
    summaryBaseLabel.textContent = normalized === 'Per-Piece'
      ? 'Piece Earnings'
      : normalized === 'Per-Trip'
        ? 'Trip Earnings'
        : 'Base Pay';
  }
  if (hideRate && wageInfo && currentSalaryEmployee) {
    wageInfo.textContent = normalized;
  }
}

function renderSummaryDeductions(appliedDeductions) {
  const container = document.getElementById('summary-deductions');
  if (!container) return;
  container.innerHTML = appliedDeductions.length
    ? appliedDeductions.map(item => `
      <div class="salary-summary-breakdown-row">
        <span class="salary-summary-breakdown-name">${salaryEscape(item.name)}</span>
        <span class="salary-summary-breakdown-amount">₱${Number(item.amount || 0).toFixed(2)}</span>
      </div>
    `).join('')
    : '<div class="salary-summary-breakdown-empty">No configured deductions for this payroll week.</div>';
}

function salaryValidationBox() {
  let box = document.getElementById('salary-payroll-validation');
  if (box) return box;
  box = document.createElement('div');
  box.id = 'salary-payroll-validation';
  box.style.cssText = 'display:none;margin-top:12px;padding:12px;border:1px solid var(--border);border-radius:6px;background:var(--bg);font-size:12px;line-height:1.5;';
  const daily = document.getElementById('daily-section');
  const hourly = document.getElementById('hourly-section');
  if (daily?.parentNode) daily.parentNode.insertBefore(box, daily.nextSibling);
  else if (hourly?.parentNode) hourly.parentNode.insertBefore(box, hourly.nextSibling);
  return box;
}

function renderSalaryPayrollValidation(validation) {
  const box = salaryValidationBox();
  if (!box) return;
  if (!validation || validation.skipped) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }
  const ok = !!validation.ok;
  box.style.display = 'block';
  box.style.borderColor = ok ? 'rgba(16,185,129,.45)' : 'rgba(244,63,94,.55)';
  const errors = (validation.errors || []).map(item => `<li>${salaryEscape(item)}</li>`).join('');
  const warnings = (validation.warnings || []).map(item => `<li>${salaryEscape(item)}</li>`).join('');
  const metric = validation.wage_type === 'Hourly'
    ? `Hours Worked: ${Number(validation.hours_worked || 0).toFixed(2)}`
    : `Days Worked: ${Number(validation.days_worked || 0).toFixed(2)}`;
  box.innerHTML = `
    <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start;">
      <div>
        <div style="color:${ok ? '#34d399' : '#fb7185'};font-size:12px;">${ok ? 'Payroll validation ready' : 'Payroll validation blocked'}</div>
        <div style="color:var(--muted);margin-top:4px;">${salaryEscape(validation.date_from)} to ${salaryEscape(validation.date_to)} · ${metric} · Rate: ₱${Number(validation.rate || 0).toFixed(2)}</div>
      </div>
      <div style="color:var(--muted);white-space:nowrap;">${salaryEscape(validation.validation_status || '-')}</div>
    </div>
    ${errors ? `<ul style="margin:8px 0 0 18px;color:#fb7185;">${errors}</ul>` : ''}
    ${warnings ? `<ul style="margin:8px 0 0 18px;color:#fbbf24;">${warnings}</ul>` : ''}
  `;
}

async function loadSalaryPayrollValidation() {
  if (!currentSalaryEmployee || !['Daily', 'Hourly'].includes(currentSalaryEmployee.wageType)) {
    salaryPayrollValidation = null;
    renderSalaryPayrollValidation(null);
    return null;
  }
  const period = document.getElementById('salary-payroll-period')?.value || new Date().toISOString().slice(0, 7);
  try {
    const res = await apiFetch(`/api/payroll/employees/${currentSalaryEmployee.id}/payroll-validation?payroll_period=${encodeURIComponent(period)}`);
    const validation = await res.json();
    if (!res.ok) throw new Error(validation.error || 'Failed to validate payroll attendance.');
    salaryPayrollValidation = validation;
    renderSalaryPayrollValidation(validation);
    if (validation.ok) {
      currentSalaryEmployee.rate = Number(validation.rate || currentSalaryEmployee.rate || 0);
      const rateEl = document.getElementById('salary-rate');
      if (rateEl) rateEl.textContent = `₱${currentSalaryEmployee.rate.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      if (currentSalaryEmployee.wageType === 'Daily') {
        const input = document.getElementById('salary-days-worked');
        if (input) input.value = Number(validation.days_worked || 0).toFixed(2);
      }
      if (currentSalaryEmployee.wageType === 'Hourly') {
        const input = document.getElementById('salary-hours-worked');
        if (input) input.value = Number(validation.hours_worked || 0).toFixed(2);
      }
      calculateSalaryNow();
    }
    return validation;
  } catch (err) {
    salaryPayrollValidation = { ok: false, errors: [err.message], warnings: [] };
    renderSalaryPayrollValidation(salaryPayrollValidation);
    return salaryPayrollValidation;
  }
}

function getActivePairRule(pairingType) {
  const rows = (window.pieceRateConfig?.production_share_rules || [])
    .filter(row => Number(row.is_active) === 1 && row.pairing_type === pairingType);
  return rows.sort((a, b) => String(b.effective_date || '').localeCompare(String(a.effective_date || '')))[0] || null;
}

function pieceOptionHtml(type) {
  if (type === 'sew') {
    return (window.pieceRateConfig?.sew_types || [])
      .filter(row => Number(row.is_active) === 1)
      .map(row => `<option value="${row.code}">${row.code}${row.description ? ` - ${row.description}` : ''}</option>`)
      .join('');
  }
  if (type === 'size') {
    return (window.pieceRateConfig?.size_ranges || [])
      .filter(row => Number(row.is_active) === 1)
      .map(row => `<option value="${row.size_range}">${row.size_range}${row.description ? ` - ${row.description}` : ''}</option>`)
      .join('');
  }
  return '';
}

// A piece row can be created while the payroll configuration is still loading.
// Refresh rows after the configuration arrives so they do not remain stuck with
// only their placeholder option.
function refreshSalaryPieceRowOptions() {
  document.querySelectorAll('#salary-piece-rows tr').forEach(tr => {
    const sewSelect = tr.querySelector('.piece-row-sew');
    const sizeSelect = tr.querySelector('.piece-row-size');
    if (!sewSelect || !sizeSelect) return;

    const selectedSew = sewSelect.value;
    const selectedSize = sizeSelect.value;
    sewSelect.innerHTML = `<option value="">Select type</option>${pieceOptionHtml('sew')}`;
    sizeSelect.innerHTML = `<option value="">Select size</option>${pieceOptionHtml('size')}`;
    if ([...sewSelect.options].some(option => option.value === selectedSew)) sewSelect.value = selectedSew;
    if ([...sizeSelect.options].some(option => option.value === selectedSize)) sizeSelect.value = selectedSize;
  });

  calculateSalaryNow();
}

function addSalaryPieceRow(row = {}) {
  const tbody = document.getElementById('salary-piece-rows');
  if (!tbody) return;
  const id = ++salaryPieceRowCounter;
  const tr = document.createElement('tr');
  tr.dataset.rowId = String(id);
  tr.innerHTML = `
    <td><select class="piece-row-sew"><option value="">Select type</option>${pieceOptionHtml('sew')}</select></td>
    <td><select class="piece-row-size"><option value="">Select size</option>${pieceOptionHtml('size')}</select></td>
    <td><input class="piece-row-qty" type="number" min="1" step="1" value="${row.quantity_produced || ''}" placeholder="0" /></td>
    <td><span class="piece-row-rate salary-readonly">PHP 0.00</span></td>
    <td><span class="piece-row-amount salary-readonly">PHP 0.00</span></td>
    <td><button class="btn btn-outline btn-sm" type="button" onclick="removeSalaryPieceRow(this)">Remove</button></td>
  `;
  tbody.appendChild(tr);
  tr.querySelector('.piece-row-sew').value = row.sew_type_code || row.product_type || '';
  tr.querySelector('.piece-row-size').value = row.size_range || row.product_category || '';
  tr.querySelectorAll('select,input').forEach(input => {
    input.addEventListener('input', calculateSalaryNow);
    input.addEventListener('change', calculateSalaryNow);
  });
  calculateSalaryNow();
}

function removeSalaryPieceRow(button) {
  button.closest('tr')?.remove();
  if (!document.querySelector('#salary-piece-rows tr')) addSalaryPieceRow();
  calculateSalaryNow();
}

function getSalaryPieceRows() {
  return [...document.querySelectorAll('#salary-piece-rows tr')].map(tr => {
    const sewType = tr.querySelector('.piece-row-sew')?.value || '';
    const sizeRange = tr.querySelector('.piece-row-size')?.value || '';
    const quantity = Number(tr.querySelector('.piece-row-qty')?.value || 0);
    const rate = getActivePieceRate(sewType, sizeRange);
    const pieceRate = Number(rate?.piece_rate || 0);
    const amount = quantity * pieceRate;
    const rateEl = tr.querySelector('.piece-row-rate');
    const amountEl = tr.querySelector('.piece-row-amount');
    if (rateEl) rateEl.textContent = salaryMoney(pieceRate);
    if (amountEl) amountEl.textContent = salaryMoney(amount);
    return {
      sew_type_code: sewType,
      size_range: sizeRange,
      product_type: sewType,
      product_category: sizeRange,
      quantity_produced: quantity,
      piece_rate: pieceRate,
      amount
    };
  });
}

function updateSalarySummary(qty, base, allowances, gross, appliedDeductions, deductions, net) {
  document.getElementById('summary-qty').textContent = Number(qty || 0).toFixed(2);
  setSummaryField('summary-base', `₱${Number(base || 0).toFixed(2)}`);
  setSummaryField('summary-allowances', `₱${Number(allowances || 0).toFixed(2)}`);
  setSummaryField('summary-gross', `₱${Number(gross || 0).toFixed(2)}`);
  renderSummaryDeductions(appliedDeductions);
  setSummaryField('summary-total-deductions', `₱${Number(deductions || 0).toFixed(2)}`);
  setSummaryField('summary-net', `₱${Number(net || 0).toFixed(2)}`);
  const deductionNote = document.getElementById('summary-deduction-note');
  if (deductionNote) {
    deductionNote.classList.toggle('applied', deductions > 0);
    deductionNote.textContent = deductions > 0
      ? `${appliedDeductions.length} deduction rule${appliedDeductions.length === 1 ? '' : 's'} applied. Net pay already reflects the deduction.`
      : 'No deduction applied for this payroll week/schedule.';
  }
}

function calculatePieceSalaryNow() {
  updatePiecePartnerControls();
  const rows = getSalaryPieceRows();
  const validRows = rows.filter(row => row.sew_type_code && row.size_range && row.quantity_produced > 0 && row.piece_rate > 0);
  const rawTotal = validRows.reduce((sum, row) => sum + row.amount, 0);
  const qty = validRows.reduce((sum, row) => sum + row.quantity_produced, 0);
  const selectedRole = salaryProductionKind(currentSalaryEmployee?.pos || currentSalaryEmployee?.position);
  const pairingType = selectedRole === 'Fixer'
    ? 'Standard Sewer-Fixer'
    : document.getElementById('salary-piece-pairing')?.value || 'Standard Sewer-Fixer';
  const rule = getActivePairRule(pairingType);
  const worker1Share = Number(rule?.worker1_share || (pairingType === 'Substitute Sewer-Sewer' ? 50 : 55));
  const worker2Share = Number(rule?.worker2_share || (pairingType === 'Substitute Sewer-Sewer' ? 50 : 45));
  const worker1Earnings = rawTotal * (worker1Share / 100);
  const worker2Earnings = rawTotal * (worker2Share / 100);
  const selectedShare = selectedRole === 'Fixer' ? worker2Share : worker1Share;
  const selectedEarnings = selectedRole === 'Fixer' ? worker2Earnings : worker1Earnings;
  const quota = Number(document.getElementById('salary-quota-incentive')?.value || 0);
  const sunday = Number(document.getElementById('salary-sunday-incentive')?.value || 0);
  const special = Number(document.getElementById('salary-special-incentive')?.value || 0);
  const incentives = quota + sunday + special;
  const base = selectedEarnings + incentives;
  const housing = parseFloat(document.getElementById('salary-housing').value) || 0;
  const meal = parseFloat(document.getElementById('salary-meal').value) || 0;
  const transport = parseFloat(document.getElementById('salary-transport').value) || 0;
  const bonus = parseFloat(document.getElementById('salary-bonus').value) || 0;
  const allowances = housing + meal + transport + bonus;
  const gross = base + allowances;
  const appliedDeductions = calculateConfiguredDeductions(gross);
  const deductions = appliedDeductions.reduce((sum, item) => sum + item.amount, 0);
  const net = gross - deductions;

  currentSalaryEmployee.piecePreview = validRows.length ? {
    product_type: validRows[0].sew_type_code,
    product_category: validRows[0].size_range,
    sew_type_code: validRows[0].sew_type_code,
    size_range: validRows[0].size_range,
    worker_category: selectedRole || 'Sewer',
    piece_rate: validRows[0].piece_rate,
    production_value: rawTotal,
    share_percentage: selectedShare,
    worker2_share_percentage: worker2Share,
    worker1_earnings: worker1Earnings,
    worker2_earnings: worker2Earnings,
    quota_incentive: quota,
    sunday_incentive: sunday,
    special_incentive: special,
    final_gross_pay: base,
    pairing_type: pairingType,
    partner_employee_id: document.getElementById('salary-piece-partner')?.value || null,
    production_date: document.getElementById('salary-piece-production-date')?.value || new Date().toISOString().split('T')[0],
    rows: validRows
  } : null;

  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  document.getElementById('salary-pieces').value = qty;
  set('salary-piece-raw-total', salaryMoney(rawTotal));
  set('salary-share-view', `${selectedShare}%`);
  set('salary-piece-worker1-earnings', salaryMoney(selectedEarnings));
  set('salary-piece-worker2-share', `${worker2Share}%`);
  set('salary-piece-worker2-earnings', salaryMoney(worker2Earnings));
  set('salary-piece-final', salaryMoney(base));
  updatePieceDetailView();
  updateSalarySummary(qty, base, allowances, gross, appliedDeductions, deductions, net);
}

// Fetch wage type reference data (sewing types, logistics regions)
async function fetchWageTypes() {
  try {
    console.log('📡 Fetching sewing types...');
    const sewRes = await apiFetch('/api/payroll/sewing-types');
    if (!sewRes.ok) {
      console.error('❌ Failed to fetch sewing types:', sewRes.status);
      sewingTypes = [];
    } else {
      sewingTypes = await sewRes.json();
      console.log(`✅ Loaded ${sewingTypes.length} sewing types:`, sewingTypes);
    }
    
    console.log('📡 Fetching logistics regions...');
    const logRes = await apiFetch('/api/payroll/logistics-regions');
    if (!logRes.ok) {
      console.error('❌ Failed to fetch logistics regions:', logRes.status);
      logisticsRegions = [];
    } else {
      logisticsRegions = await logRes.json();
      console.log(`✅ Loaded ${logisticsRegions.length} logistics regions:`, logisticsRegions);
    }

    const [truckRes, locationRes] = await Promise.all([
      apiFetch('/api/payroll/logistics/truck-types'),
      apiFetch('/api/payroll/logistics/locations')
    ]);
    salaryTruckTypes = truckRes.ok ? await truckRes.json() : [];
    salaryDeliveryLocations = locationRes.ok ? await locationRes.json() : [];
    return { sewingTypes, logisticsRegions };
  } catch (e) {
    console.error('❌ Error loading wage types:', e);
    sewingTypes = [];
    logisticsRegions = [];
    salaryTruckTypes = [];
    salaryDeliveryLocations = [];
    return { sewingTypes: [], logisticsRegions: [] };
  }
}

// Fetch all employees
async function fetchSalaryEmpList() {
  try {
    const res = await apiFetch('/api/employees');
    if (!res || !res.ok) {
      throw new Error(res ? `HTTP ${res.status}` : 'No response from employee API');
    }
    salaryEmpList = await res.json();
    console.log(`✅ Got ${salaryEmpList.length} employees for salary page`);
    await fetchSalaryAgencies();
    populateSalaryAgencyOptions();
    populateSalaryDepartmentFilter();
    attachSearchListener();
    attachPartnerSearchListener();
  } catch (e) {
    console.error('❌ Failed to fetch employees:', e);
  }
}

function salaryEmployeeDepartmentKey(emp) {
  return String(emp?.department_id || emp?.department || '').trim();
}

function selectedSalaryDepartmentKey() {
  return String(document.getElementById('salary-department-filter')?.value || '').trim();
}

function getDepartmentFilteredSalaryEmployees() {
  const departmentKey = selectedSalaryDepartmentKey();
  return (salaryEmpList || []).filter(emp => !departmentKey || salaryEmployeeDepartmentKey(emp) === departmentKey);
}

function filterSalaryEmployees(term = '') {
  return getDepartmentFilteredSalaryEmployees().filter(emp => employeeMatchesTerm(emp, term));
}

function populateSalaryDepartmentFilter() {
  const select = document.getElementById('salary-department-filter');
  if (!select) return;

  const current = select.value || '';
  const departments = [...new Map((salaryEmpList || [])
    .map(emp => {
      const key = salaryEmployeeDepartmentKey(emp);
      const label = String(emp.department || '').trim();
      return key && label ? [key, label] : null;
    })
    .filter(Boolean))]
    .sort((a, b) => a[1].localeCompare(b[1]));

  select.innerHTML = '<option value="">All departments</option>' + departments
    .map(([key, label]) => `<option value="${salaryEscape(key)}">${salaryEscape(label)}</option>`)
    .join('');

  if (departments.some(([key]) => key === current)) select.value = current;

  if (!salaryDepartmentFilterListenerAttached) {
    salaryDepartmentFilterListenerAttached = true;
    select.addEventListener('change', () => {
      const search = document.getElementById('salary-employee-search');
      const dropdown = document.getElementById('salary-employee-dropdown');
      if (currentSalaryEmployee && selectedSalaryDepartmentKey() && salaryEmployeeDepartmentKey(currentSalaryEmployee) !== selectedSalaryDepartmentKey()) {
        resetCalculationForm();
      }
      if (dropdown && search === document.activeElement) showDropdownList(filterSalaryEmployees(search.value));
      else if (dropdown) dropdown.style.display = 'none';
    });
  }
}

async function fetchSalaryAgencies() {
  try {
    const res = await apiFetch('/api/payroll/agencies');
    if (!res || !res.ok) throw new Error(res ? `HTTP ${res.status}` : 'No response from agency API');
    const rows = await res.json();
    salaryAgencyList = (Array.isArray(rows) ? rows : [])
      .map(row => String(row.name || row.agency_name || '').trim())
      .filter(Boolean);
  } catch (err) {
    console.warn('Failed to fetch payroll agencies, using employee agency names only:', err.message);
    salaryAgencyList = [];
  }
}

function populateSalaryAgencyOptions(preferredAgency = '') {
  const select = document.getElementById('salary-agency');
  if (!select) return;

  const current = preferredAgency || select.value || '';
  const employeeAgencies = (salaryEmpList || [])
    .map(emp => String(emp.agency_name || '').trim())
    .filter(Boolean);
  const agencies = [...new Set([...salaryAgencyList, ...employeeAgencies])]
    .sort((a, b) => a.localeCompare(b));

  const noAgencyHint = agencies.length
    ? ''
    : '<option value="" disabled>No agencies configured</option>';

  select.innerHTML = '<option value="">Direct / No agency</option>' + noAgencyHint + agencies
    .map(agency => `<option value="${salaryEscape(agency)}">${salaryEscape(agency)}</option>`)
    .join('');

  if (current && !agencies.includes(current)) {
    select.insertAdjacentHTML('beforeend', `<option value="${salaryEscape(current)}">${salaryEscape(current)}</option>`);
  }
  select.value = current;
  updateSalaryAgencySummary();
}

function updateSalaryAgencySummary() {
  const agency = document.getElementById('salary-agency')?.value || '';
  const summary = document.getElementById('summary-agency');
  if (summary) summary.textContent = agency || '-';
}

// Attach search input listener
function attachSearchListener() {
  if (salarySearchListenerAttached) return;

  const search = document.getElementById('salary-employee-search');
  const dropdown = document.getElementById('salary-employee-dropdown');
  
  if (!search || !dropdown) {
    console.error('❌ Missing search or dropdown element');
    return;
  }
  
  console.log('✅ Search element found, attaching listeners');
  
  salarySearchListenerAttached = true;

  // On focus - show all employees
  search.addEventListener('focus', async () => {
    console.log('Focus event - showing dropdown');
    await fetchSalaryEmpList();
    showDropdownList(filterSalaryEmployees(search.value));
  });
  
  // On input - filter
  search.addEventListener('input', () => {
    const term = search.value.toLowerCase().trim();
    const filtered = filterSalaryEmployees(term);
    
    console.log(`🔍 Filtered to ${filtered.length} employees`);
    showDropdownList(filtered);
  });
  
  // Close on outside click
  document.addEventListener('click', (e) => {
    if (!search.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.style.display = 'none';
      console.log('Closed dropdown');
    }
  });
}

// Show dropdown with list of employees
function showDropdownList(empList) {
  const dropdown = document.getElementById('salary-employee-dropdown');
  if (!dropdown) return;
  
  if (!empList || empList.length === 0) {
    dropdown.innerHTML = '<div style="padding:10px; color:var(--muted);">No employees</div>';
    dropdown.style.display = 'block';
    return;
  }
  
  // Build HTML for each employee
  let html = '';
  empList.forEach(emp => {
    html += `
      <div style="padding:10px 12px; cursor:pointer; border-bottom:1px solid var(--border);" 
           onclick="clickSalaryEmployee('${emp.id}', '${emp.employee_code}', '${emp.first_name}', '${emp.last_name}', '${emp.department || ''}', '${emp.position || ''}')">
        <div style="font-weight:600; color:var(--text);">${emp.employee_code} - ${emp.first_name} ${emp.last_name}</div>
        <div style="font-size:11px; color:var(--muted);">${emp.department || 'N/A'} • ${emp.position || 'N/A'}</div>
      </div>
    `;
  });
  
  dropdown.innerHTML = html;
  dropdown.style.display = 'block';
  console.log(`📋 Showing ${empList.length} employees in dropdown`);
}

function employeeMatchesTerm(emp, term) {
  const needle = String(term || '').toLowerCase().trim();
  if (!needle) return true;

  const fullName = `${emp.first_name || ''} ${emp.last_name || ''}`.toLowerCase();
  const code = String(emp.employee_code || '').toLowerCase();
  const dept = String(emp.department || '').toLowerCase();
  const pos = String(emp.position || '').toLowerCase();

  return fullName.includes(needle) || code.includes(needle) || dept.includes(needle) || pos.includes(needle);
}

function attachPartnerSearchListener() {
  if (salaryPartnerSearchListenerAttached) return;

  const search = document.getElementById('salary-piece-partner-search');
  const dropdown = document.getElementById('salary-piece-partner-dropdown');
  const hiddenInput = document.getElementById('salary-piece-partner');

  if (!search || !dropdown || !hiddenInput) return;

  salaryPartnerSearchListenerAttached = true;

  search.addEventListener('focus', async () => {
    if (!salaryEmpList.length) await fetchSalaryEmpList();
    showPartnerDropdown(filterPiecePartnerEmployees(search.value));
  });

  search.addEventListener('input', () => {
    hiddenInput.value = '';
    const term = search.value.toLowerCase().trim();
    showPartnerDropdown(filterPiecePartnerEmployees(term));
    calculateSalaryNow();
  });

  document.addEventListener('click', (event) => {
    if (!search.contains(event.target) && !dropdown.contains(event.target)) {
      dropdown.style.display = 'none';
    }
  });
}

function salaryProductionKind(position) {
  const value = String(position || '').toLowerCase();
  if (value.includes('fixer')) return 'Fixer';
  if (value.includes('sewer')) return 'Sewer';
  return '';
}

function requiredPiecePartnerRole() {
  const selectedRole = salaryProductionKind(currentSalaryEmployee?.pos || currentSalaryEmployee?.position);
  if (selectedRole === 'Fixer') return 'Sewer';
  const pairingType = document.getElementById('salary-piece-pairing')?.value || 'Standard Sewer-Fixer';
  return pairingType === 'Substitute Sewer-Sewer' ? 'Sewer' : 'Fixer';
}

function filterPiecePartnerEmployees(term = '') {
  const requiredRole = requiredPiecePartnerRole();
  return (salaryEmpList || [])
    .filter(emp => String(emp.id) !== String(currentSalaryEmployee?.id || ''))
    .filter(emp => !requiredRole || salaryProductionKind(emp.position) === requiredRole)
    .filter(emp => employeeMatchesTerm(emp, term));
}

function clearSalaryPiecePartner() {
  const search = document.getElementById('salary-piece-partner-search');
  const hiddenInput = document.getElementById('salary-piece-partner');
  const dropdown = document.getElementById('salary-piece-partner-dropdown');
  if (search) search.value = '';
  if (hiddenInput) hiddenInput.value = '';
  if (dropdown) dropdown.style.display = 'none';
}

function updatePiecePartnerControls() {
  const pairingSelect = document.getElementById('salary-piece-pairing');
  const partnerSearch = document.getElementById('salary-piece-partner-search');
  const selectedRole = salaryProductionKind(currentSalaryEmployee?.pos || currentSalaryEmployee?.position);
  if (pairingSelect) {
    const substituteOption = [...pairingSelect.options].find(option => option.value === 'Substitute Sewer-Sewer' || option.textContent === 'Substitute Sewer-Sewer');
    if (selectedRole === 'Fixer') {
      pairingSelect.value = 'Standard Sewer-Fixer';
      if (substituteOption) substituteOption.disabled = true;
    } else if (substituteOption) {
      substituteOption.disabled = false;
    }
  }
  const role = requiredPiecePartnerRole();
  if (partnerSearch) {
    partnerSearch.placeholder = role
      ? `Search ${role.toLowerCase()} employee...`
      : 'Search partner employee...';
  }
  const selectedPartner = (salaryEmpList || []).find(emp => String(emp.id) === String(document.getElementById('salary-piece-partner')?.value || ''));
  if (selectedPartner && role && salaryProductionKind(selectedPartner.position) !== role) clearSalaryPiecePartner();
}

function showPartnerDropdown(empList) {
  const dropdown = document.getElementById('salary-piece-partner-dropdown');
  if (!dropdown) return;

  dropdown.innerHTML = '';
  updatePiecePartnerControls();
  const requiredRole = requiredPiecePartnerRole();
  const options = (empList || []).slice(0, 30);

  if (!options.length) {
    const empty = document.createElement('div');
    empty.style.padding = '10px';
    empty.style.color = 'var(--muted)';
    empty.textContent = requiredRole ? `No ${requiredRole.toLowerCase()} employees found` : 'No employees found';
    dropdown.appendChild(empty);
    dropdown.style.display = 'block';
    return;
  }

  options.forEach(emp => {
    const item = document.createElement('button');
    item.type = 'button';
    item.style.display = 'block';
    item.style.width = '100%';
    item.style.padding = '10px 12px';
    item.style.cursor = 'pointer';
    item.style.border = '0';
    item.style.borderBottom = '1px solid var(--border)';
    item.style.background = 'transparent';
    item.style.textAlign = 'left';

    const title = document.createElement('div');
    title.style.fontWeight = '600';
    title.style.color = 'var(--text)';
    title.textContent = `${emp.employee_code || 'EMP'} - ${emp.first_name || ''} ${emp.last_name || ''}`.trim();

    const meta = document.createElement('div');
    meta.style.fontSize = '11px';
    meta.style.color = 'var(--muted)';
    meta.textContent = `${emp.department || 'N/A'} - ${emp.position || 'N/A'}`;

    item.appendChild(title);
    item.appendChild(meta);
    item.addEventListener('click', () => selectSalaryPiecePartner(emp));
    dropdown.appendChild(item);
  });

  dropdown.style.display = 'block';
}

function selectSalaryPiecePartner(emp) {
  const search = document.getElementById('salary-piece-partner-search');
  const dropdown = document.getElementById('salary-piece-partner-dropdown');
  const hiddenInput = document.getElementById('salary-piece-partner');

  if (hiddenInput) hiddenInput.value = emp.id || '';
  if (search) search.value = `${emp.employee_code || 'EMP'} - ${emp.first_name || ''} ${emp.last_name || ''}`.trim();
  if (dropdown) dropdown.style.display = 'none';

  calculateSalaryNow();
}

function selectedSalaryPiecePartner() {
  const partnerId = document.getElementById('salary-piece-partner')?.value || '';
  return (salaryEmpList || []).find(emp => String(emp.id) === String(partnerId)) || null;
}

function getPieceOutputPairPayload() {
  const partner = selectedSalaryPiecePartner();
  const partnerId = partner?.id ? String(partner.id) : '';
  const selectedId = currentSalaryEmployee?.id ? String(currentSalaryEmployee.id) : '';
  const selectedRole = salaryProductionKind(currentSalaryEmployee?.pos || currentSalaryEmployee?.position);
  const partnerRole = salaryProductionKind(partner?.position);
  const requiredRole = requiredPiecePartnerRole();

  if (!selectedRole || !['Sewer', 'Fixer'].includes(selectedRole)) {
    throw new Error('Selected employee must have a Sewer or Fixer position for per-piece partner output.');
  }
  if (!partnerId) throw new Error('Please enter the partner employee for this per-piece output.');
  if (partnerId === selectedId) throw new Error('Sewer and partner cannot be the same employee.');
  if (requiredRole && partnerRole !== requiredRole) {
    throw new Error(`Partner employee must be classified as ${requiredRole}.`);
  }

  if (selectedRole === 'Fixer') {
    return {
      employee_id: Number(partnerId),
      partner_employee_id: Number(selectedId),
      pairing_type: 'Standard Sewer-Fixer',
      selected_role: selectedRole,
      partner_role: partnerRole
    };
  }

  return {
    employee_id: Number(selectedId),
    partner_employee_id: Number(partnerId),
    pairing_type: document.getElementById('salary-piece-pairing')?.value || 'Standard Sewer-Fixer',
    selected_role: selectedRole,
    partner_role: partnerRole
  };
}

function salaryPositionKind(position) {
  const value = String(position || '').toLowerCase();
  if (value.includes('driver')) return 'Driver';
  if (value.includes('helper')) return 'Helper';
  return '';
}

function populateLogisticsCrewSelects(selectedEmployee = null) {
  const driverSelect = document.getElementById('salary-driver-employee');
  const helper1Select = document.getElementById('salary-helper1-employee');
  const helper2Select = document.getElementById('salary-helper2-employee');
  if (!driverSelect || !helper1Select || !helper2Select) return;

  const option = emp => `<option value="${emp.id}">${salaryEscape(emp.employee_code || 'EMP')} - ${salaryEscape(`${emp.first_name || ''} ${emp.last_name || ''}`.trim())}</option>`;
  const drivers = salaryEmpList.filter(emp => salaryPositionKind(emp.position) === 'Driver');
  const helpers = salaryEmpList.filter(emp => salaryPositionKind(emp.position) === 'Helper');
  driverSelect.innerHTML = '<option value="">Select driver</option>' + drivers.map(option).join('');
  helper1Select.innerHTML = '<option value="">Select helper 1</option>' + helpers.map(option).join('');
  helper2Select.innerHTML = '<option value="">No helper 2 / incomplete crew</option>' + helpers.map(option).join('');

  if (selectedEmployee) {
    const kind = salaryPositionKind(selectedEmployee.pos || selectedEmployee.position);
    if (kind === 'Driver') driverSelect.value = selectedEmployee.id;
    if (kind === 'Helper') helper1Select.value = selectedEmployee.id;
  }

  updateLogisticsCrewAvailability();
}

async function loadSalaryLogisticsCrewConfig() {
  try {
    const [truckRes, locationRes] = await Promise.all([
      apiFetch('/api/payroll/logistics/truck-types'),
      apiFetch('/api/payroll/logistics/locations')
    ]);
    salaryTruckTypes = truckRes.ok ? await truckRes.json() : [];
    salaryDeliveryLocations = locationRes.ok ? await locationRes.json() : [];
    populateSalaryDeliveryLocations();

    const truckSelect = document.getElementById('salary-truck-type');
    if (truckSelect) {
      const selectedTruck = truckSelect.value;
      truckSelect.innerHTML = '<option value="">Select truck</option>' + salaryTruckTypes
        .filter(truck => Number(truck.is_active) === 1)
        .map(truck => `<option value="${truck.id}">${salaryEscape(truck.name)}</option>`)
        .join('');
      if (salaryTruckTypes.some(truck => String(truck.id) === selectedTruck && Number(truck.is_active) === 1)) {
        truckSelect.value = selectedTruck;
      }
    }
  } catch (error) {
    console.error('Failed to load logistics crew configuration:', error);
  }
}

function updateLogisticsCrewAvailability() {
  const selects = [
    document.getElementById('salary-driver-employee'),
    document.getElementById('salary-helper1-employee'),
    document.getElementById('salary-helper2-employee')
  ].filter(Boolean);
  const selectedByControl = new Map(selects.map(select => [select, String(select.value || '')]));

  selects.forEach(select => {
    const selectedElsewhere = new Set(
      [...selectedByControl.entries()]
        .filter(([other]) => other !== select)
        .map(([, value]) => value)
        .filter(Boolean)
    );
    [...select.options].forEach(option => {
      option.disabled = Boolean(option.value) && selectedElsewhere.has(String(option.value));
    });
  });
}

function getLogisticsPreview() {
  const tripCount = Math.max(1, Number(document.getElementById('salary-trips')?.value || 1));
  const truckTypeId = document.getElementById('salary-truck-type')?.value || '';
  const locationId = document.getElementById('salary-delivery-location')?.value || '';
  const tripType = document.getElementById('salary-trip-type')?.value || '1st Trip';
  const driverId = document.getElementById('salary-driver-employee')?.value || '';
  const helper1Id = document.getElementById('salary-helper1-employee')?.value || '';
  const helper2Id = document.getElementById('salary-helper2-employee')?.value || '';
  const configuredRates = currentSalaryEmployee?.logisticsRates || {};
  const driverRate = Math.max(0, Number(configuredRates.driver || 0));
  const helperRate = Math.max(0, Number(configuredRates.helper || 0));
  const crewStatus = helper2Id ? 'Complete' : helper1Id ? 'Incomplete' : '-';
  const missingHelperShare = crewStatus === 'Incomplete' ? helperRate / 2 : 0;
  const driverGross = driverId ? (driverRate + missingHelperShare) * tripCount : 0;
  const helper1Gross = helper1Id ? (helperRate + missingHelperShare) * tripCount : 0;
  const helper2Gross = helper2Id ? helperRate * tripCount : 0;
  const selectedId = String(currentSalaryEmployee?.id || '');
  const selectedGross = selectedId === String(driverId) ? driverGross
    : selectedId === String(helper1Id) ? helper1Gross
      : selectedId === String(helper2Id) ? helper2Gross
        : 0;

  return {
    tripCount,
    truckTypeId,
    locationId,
    tripType,
    driverId,
    helper1Id,
    helper2Id,
    driverRate,
    helperRate,
    crewStatus,
    missingHelperShare,
    driverGross,
    helper1Gross,
    helper2Gross,
    selectedGross
  };
}

function updateLogisticsPreview() {
  updateLogisticsCrewAvailability();
  const preview = getLogisticsPreview();
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
  set('salary-driver-rate-view', salaryMoney(preview.driverRate));
  set('salary-helper-rate-view', salaryMoney(preview.helperRate));
  set('salary-crew-status-view', preview.crewStatus === 'Incomplete' ? '2-person crew' : preview.crewStatus === 'Complete' ? '3-person crew' : '-');
  set('salary-missing-helper-share-view', salaryMoney(preview.missingHelperShare));
  set('salary-driver-gross-view', salaryMoney(preview.driverGross));
  set('salary-helper1-gross-view', salaryMoney(preview.helper1Gross));
  set('salary-helper2-gross-view', preview.helper2Id ? salaryMoney(preview.helper2Gross) : '-');
  set('salary-logistics-note', currentSalaryEmployee?.logisticsRateError
    || (preview.crewStatus === 'Incomplete'
      ? `Helper 2 salary is split equally: ${salaryMoney(preview.missingHelperShare)} added to Driver and Helper 1.`
      : preview.crewStatus === 'Complete'
        ? 'Complete crew: Driver and Helper trip pay are loaded from the active logistics configuration.'
        : 'Select the delivery crew, area, truck, location, and trip type.'));
  return preview;
}

function populateSalaryDeliveryLocations() {
  const locationSelect = document.getElementById('salary-delivery-location');
  if (!locationSelect) return;
  const selectedLocation = locationSelect.value;
  const locations = salaryDeliveryLocations.filter(location => Number(location.is_active) === 1);
  locationSelect.innerHTML = '<option value="">Select location</option>' + locations
    .map(location => `<option value="${location.id}">${salaryEscape(location.location_category)} - ${salaryEscape(location.name)}</option>`)
    .join('');
  if (locations.some(location => String(location.id) === selectedLocation)) locationSelect.value = selectedLocation;
}

async function refreshLogisticsConfiguredRates() {
  if (!currentSalaryEmployee || currentSalaryEmployee.wageType !== 'Per-Trip') return;
  const preview = getLogisticsPreview();
  currentSalaryEmployee.logisticsRates = {};
  currentSalaryEmployee.logisticsRateError = '';
  if (!preview.truckTypeId || !preview.locationId || !preview.tripType || !document.getElementById('salary-trip-date')?.value) {
    updateLogisticsPreview();
    return;
  }

  const params = new URLSearchParams({
    truck_type_id: preview.truckTypeId,
    location_id: preview.locationId,
    trip_type: preview.tripType,
    trip_date: document.getElementById('salary-trip-date').value
  });
  try {
    const [driverRes, helperRes] = await Promise.all([
      apiFetch(`/api/payroll/logistics/rates/preview?${params}&role=Driver`),
      apiFetch(`/api/payroll/logistics/rates/preview?${params}&role=Helper`)
    ]);
    const [driverRate, helperRate] = await Promise.all([
      driverRes.json().catch(() => ({})),
      helperRes.json().catch(() => ({}))
    ]);
    if (!driverRes.ok || !helperRes.ok) {
      currentSalaryEmployee.logisticsRateError = driverRate.error || helperRate.error || 'No active logistics rate matches the selected delivery details.';
    } else {
      currentSalaryEmployee.logisticsRates = {
        driver: Number(driverRate.total_trip_pay || 0),
        helper: Number(helperRate.total_trip_pay || 0)
      };
    }
  } catch (error) {
    currentSalaryEmployee.logisticsRateError = 'Unable to load the configured logistics rates.';
  }
  calculateSalaryNow();
}

// Handle employee selection
async function clickSalaryEmployee(id, code, first, last, dept, pos) {
  const selectedEmployee = (salaryEmpList || []).find(emp => String(emp.id) === String(id)) || {};
  code = code || selectedEmployee.employee_code || '';
  first = first || selectedEmployee.first_name || '';
  last = last || selectedEmployee.last_name || '';
  dept = dept || selectedEmployee.department || '';
  pos = pos || selectedEmployee.position || '';
  console.log(`\n=== Employee Selection ===`);
  console.log(`✅ Selected: ${code} - ${first} ${last}`);
  console.log(`Employee ID (from frontend): ${id}`);
  currentSalaryDraftId = null;
  
  // Hide dropdown
  document.getElementById('salary-employee-dropdown').style.display = 'none';
  document.getElementById('salary-employee-search').value = `${code} - ${first} ${last}`;
  const partnerSearch = document.getElementById('salary-piece-partner-search');
  const partnerInput = document.getElementById('salary-piece-partner');
  if (partnerSearch) partnerSearch.value = '';
  if (partnerInput) partnerInput.value = '';
  
  // Show basic info
  document.getElementById('salary-dept').textContent = dept || '—';
  document.getElementById('salary-pos').textContent = pos || '—';
  
  // Fetch wage config
  try {
    console.log(`📡 Fetching: /api/payroll/employees/${id}/wage-config`);
    const res = await apiFetch(`/api/payroll/employees/${id}/wage-config`);
    console.log('📡 Wage config response status:', res.status);
    
    if (!res.ok) {
      console.warn('⚠️ Response not OK:', res.statusText);
      // If no wage config exists, ask user to set it up
      currentSalaryEmployee = {
        id: parseInt(id),
        code, first, last, dept, pos,
        department_id: selectedEmployee.department_id || null,
        department: dept,
        position: pos,
        wageType: 'Not Set',
        rate: 0
      };
      alert('⚠️ Wage structure not configured for this employee. Please ask HR admin to set it up in Employee Management → Payroll & Compensation.');
      document.getElementById('salary-wage-type').textContent = 'Not Configured';
      document.getElementById('salary-rate').textContent = '₱0.00';
      updateSalaryRateVisibility('');
      return;
    }
    
    const config = await res.json();
    console.log('\n📊 === Wage Config Response ===');
    console.log('Full config object:', config);
    console.log('  - wage_type:', config.wage_type, `(type: ${typeof config.wage_type})`);
    console.log('  - current_rate:', config.current_rate, `(type: ${typeof config.current_rate})`);
    console.log('  - wage_type_id:', config.wage_type_id);
    console.log('  - rates array length:', config.rates?.length);
    
    if (!config.wage_type) {
      console.warn('⚠️ No wage type in config');
      alert('⚠️ Wage structure not configured. Please ask HR admin to set it up.');
      return;
    }
    
    const normalizedWageType = normalizeSalaryWageType(config.wage_type);

    // Store in global
    currentSalaryEmployee = {
      id: parseInt(id),
      code, first, last, dept, pos,
      department_id: selectedEmployee.department_id || config.employee?.department_id || null,
      department: dept,
      position: pos,
      wageType: normalizedWageType,
      wageTypeId: config.wage_type_id || config.employee?.wage_type_id,
      rate: parseFloat(config.current_rate) || 0,
      agencyName: config.employee?.agency_name || ''
    };
    salaryPayrollValidation = null;
    renderSalaryPayrollValidation(null);
    populateSalaryDeliveryLocations();
    populateLogisticsCrewSelects(currentSalaryEmployee);
    loadSalaryLogisticsCrewConfig();
    refreshLogisticsConfiguredRates();
    
    console.log('✅ Current salary employee set:', currentSalaryEmployee);
    
    // Update display
    document.getElementById('salary-dept').textContent = dept || '-';
    document.getElementById('salary-pos').textContent = pos || '-';
    const workerSource = document.getElementById('salary-worker-source');
    if (workerSource) workerSource.textContent = config.employee?.employment_type || config.employee?.hiring_type || '-';
    populateSalaryAgencyOptions(config.employee?.agency_name || '');
    document.getElementById('salary-wage-type').textContent = config.wage_type || '—';
    document.getElementById('salary-rate').textContent = `₱${currentSalaryEmployee.rate.toLocaleString('en-US', {minimumFractionDigits: 2})}`;
    
    // Update summary employee name
    document.getElementById('summary-employee').textContent = `${first} ${last}`;
    updateSalaryAgencySummary();
    document.getElementById('summary-wage-type').textContent = config.wage_type;
    document.getElementById('summary-rate').textContent = `₱${currentSalaryEmployee.rate.toFixed(2)}`;
    
    // Show info panel
    const panel = document.getElementById('salary-employee-info');
    if (panel) {
      panel.style.display = 'block';
      document.getElementById('salary-employee-name').textContent = `${code} - ${first} ${last}`;
      document.getElementById('salary-employee-dept-info').textContent = dept || '—';
      document.getElementById('salary-employee-pos-info').textContent = pos || '—';
      document.getElementById('salary-employee-wage-info').textContent = ['Per-Piece', 'Per-Trip'].includes(normalizedWageType)
        ? normalizedWageType
        : `${config.wage_type} • ₱${currentSalaryEmployee.rate.toLocaleString('en-US', {minimumFractionDigits: 2})}`;
    }
    
    // Show appropriate wage structure form
    console.log('🔄 Calling showWageStructureForm with:', normalizedWageType);
    showWageStructureForm(normalizedWageType);
    
    // Reset inputs
    document.getElementById('salary-pieces').value = '';
    const pieceProductionDate = document.getElementById('salary-piece-production-date');
    if (pieceProductionDate && !pieceProductionDate.value) pieceProductionDate.value = new Date().toISOString().split('T')[0];
    const pieceSewer = document.getElementById('salary-piece-sewer');
    if (pieceSewer) pieceSewer.textContent = `${code} - ${first} ${last}`;
    updatePiecePartnerControls();
    const tripDate = document.getElementById('salary-trip-date');
    if (tripDate && !tripDate.value) tripDate.value = new Date().toISOString().split('T')[0];
    document.getElementById('salary-trips').value = normalizedWageType === 'Per-Trip' ? '1' : '';
    document.getElementById('salary-housing').value = '0';
    document.getElementById('salary-meal').value = '0';
    document.getElementById('salary-transport').value = '0';
    document.getElementById('salary-bonus').value = '0';
    document.getElementById('salary-ot-hours').value = '0';

    if (['Daily', 'Hourly'].includes(normalizedWageType)) {
      await loadSalaryPayrollValidation();
    } else {
      calculateSalaryNow();
    }
    
  } catch (e) {
    console.error('❌ Error loading wage config:', e);
    alert('Failed to load wage config: ' + e.message);
  }
}

async function restoreSalaryDraftFromRecord(record) {
  if (!record || record.status !== 'Draft') return;
  if (!salaryEmpList.length) await fetchSalaryEmpList();
  const employee = salaryEmpList.find(emp => String(emp.id) === String(record.employee_id)) || {};
  const nameParts = String(record.employee_name || '').trim().split(/\s+/);
  await clickSalaryEmployee(
    record.employee_id,
    record.employee_code || employee.employee_code || '',
    employee.first_name || nameParts[0] || '',
    employee.last_name || nameParts.slice(1).join(' ') || '',
    record.department || employee.department || '',
    record.position || employee.position || ''
  );

  currentSalaryDraftId = record.id;
  const setValue = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.value = value ?? '';
  };
  setValue('salary-payroll-period', record.payroll_period || String(record.calculation_date || '').slice(0, 7));
  setValue('salary-hours-worked', Number(record.hours_worked || 0) || '');
  setValue('salary-days-worked', Number(record.days_worked || 0) || '');
  setValue('salary-housing', Number(record.housing_allowance || 0));
  setValue('salary-meal', Number(record.meal_allowance || 0));
  setValue('salary-transport', Number(record.transport_allowance || 0));
  setValue('salary-bonus', Number(record.bonus_allowance || 0));
  setValue('salary-ot-hours', Number(record.overtime_hours || 0));
  if (record.agency_name) setValue('salary-agency', record.agency_name);
  calculateSalaryNow();
  if (typeof showAlert === 'function') {
    await showAlert('Draft loaded. You can continue editing, save it again, or submit it.', 'Draft Loaded', 'success');
  }
}

// Show appropriate wage structure form based on wage type
function showWageStructureForm(wageType) {
  wageType = normalizeSalaryWageType(wageType);
  updateSalaryRateVisibility(wageType);
  const draftButton = document.getElementById('save-salary-draft-btn');
  const saveButton = document.getElementById('save-salary-calculation-btn');
  if (draftButton) draftButton.textContent = wageType === 'Per-Trip' ? 'Save Crew Draft' : 'Save Draft';
  if (saveButton) saveButton.textContent = wageType === 'Per-Trip' ? 'Submit Crew Payroll' : 'Save Calculation';
  const dailyOutputButton = document.getElementById('save-daily-output-btn');
  if (dailyOutputButton) dailyOutputButton.style.display = wageType === 'Per-Piece' ? 'inline-flex' : 'none';
  console.log('🔄 showWageStructureForm called with:', wageType);
  
  const perPieceSection = document.getElementById('per-piece-section');
  const perTripSection = document.getElementById('per-trip-section');
  
  if (!perPieceSection || !perTripSection) {
    console.error('❌ Form sections not found in DOM');
    return;
  }
  
  console.log('📦 Per-piece section element:', perPieceSection);
  console.log('📦 Per-trip section element:', perTripSection);
  
  if (wageType === 'Per-Piece') {
    console.log('✅ Showing Per-Piece form...');
    perPieceSection.style.display = 'block';
    perTripSection.style.display = 'none';
    const hourlySection = document.getElementById('hourly-section');
    const dailySection = document.getElementById('daily-section');
    if (hourlySection) hourlySection.style.display = 'none';
    if (dailySection) dailySection.style.display = 'none';
    if (!document.querySelector('#salary-piece-rows tr')) addSalaryPieceRow();
    console.log('Per-Piece work output table ready');
    return;
    
    // Populate other sewing types
    const container = document.getElementById('salary-other-sewing');
    if (!container) {
      console.error('❌ salary-other-sewing container not found');
      return;
    }
    
    if (!sewingTypes || sewingTypes.length === 0) {
      console.warn('⚠️ No sewing types loaded');
      container.innerHTML = '<div style="color: var(--muted); padding: 8px;">No sewing types available</div>';
    } else {
      container.innerHTML = sewingTypes.map(st => `
        <div style="display: flex; gap: 8px; align-items: center;">
          <input type="number" id="sewing-${st.id}" min="0" step="1" placeholder="0" 
                 data-sewing-id="${st.id}" data-sewing-rate="${st.default_rate || 0}"
                 oninput="calculateSalaryNow()"
                 style="flex: 1; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 12px;" />
          <span style="min-width: 100px; font-size: 11px; color: var(--muted);">${st.name}</span>
          <span style="min-width: 80px; text-align: right; font-weight: 600; color: var(--accent);">₱${parseFloat(st.default_rate || 0).toFixed(2)}</span>
        </div>
      `).join('');
    }
    
    console.log('✅ Per-Piece form ready with', sewingTypes.length, 'sewing types');
    
  } else if (wageType === 'Per-Trip') {
    console.log('✅ Showing Per-Trip form...');
    perPieceSection.style.display = 'none';
    perTripSection.style.display = 'block';
    const hourlySection = document.getElementById('hourly-section');
    const dailySection = document.getElementById('daily-section');
    if (hourlySection) hourlySection.style.display = 'none';
    if (dailySection) dailySection.style.display = 'none';
    
    // Keep the legacy region ID internal while exposing only the two areas used for crew payroll.
    const regionSelect = document.getElementById('salary-region') || document.createElement('select');
    if (!regionSelect) {
      console.error('❌ salary-region select not found');
      return;
    }
    
    const manila = logisticsRegions.find(region => String(region.name || '').trim().toLowerCase() === 'manila');
    const province = logisticsRegions.find(region => String(region.name || '').trim().toLowerCase() === 'provincial')
      || logisticsRegions.find(region => String(region.name || '').toLowerCase().includes('province'));
    regionSelect.innerHTML = '<option value="">Select area</option>' +
      (manila ? `<option value="${manila.id}">Manila</option>` : '') +
      (province ? `<option value="${province.id}">Province</option>` : '');
    if (!manila || !province) console.warn('Manila or Province logistics region is missing.');

    const truckSelect = document.getElementById('salary-truck-type');
    if (truckSelect) {
      const selectedTruck = truckSelect.value;
      const activeTrucks = salaryTruckTypes.filter(truck => Number(truck.is_active) === 1);
      truckSelect.innerHTML = '<option value="">Select truck</option>' + activeTrucks
        .map(truck => `<option value="${truck.id}">${salaryEscape(truck.name)}</option>`)
        .join('');
      if (activeTrucks.some(truck => String(truck.id) === selectedTruck)) truckSelect.value = selectedTruck;
    }
    
    console.log('✅ Per-Trip crew form ready');
    populateLogisticsCrewSelects(currentSalaryEmployee);
    loadSalaryLogisticsCrewConfig();
  } else if (wageType === 'Hourly') {
    console.log('✅ Showing form for Hourly wage type');
    perPieceSection.style.display = 'none';
    perTripSection.style.display = 'none';
    
    const hourlySection = document.getElementById('hourly-section');
    const dailySection = document.getElementById('daily-section');
    if (hourlySection) hourlySection.style.display = 'block';
    if (dailySection) dailySection.style.display = 'none';
    
    console.log('ℹ️ Salary calculated based on hours worked × hourly rate');
  } else if (wageType === 'Daily') {
    console.log('✅ Showing form for Daily wage type');
    perPieceSection.style.display = 'none';
    perTripSection.style.display = 'none';
    
    const hourlySection = document.getElementById('hourly-section');
    const dailySection = document.getElementById('daily-section');
    if (hourlySection) hourlySection.style.display = 'none';
    if (dailySection) dailySection.style.display = 'block';
    
    console.log('ℹ️ Salary calculated based on days worked × daily rate');
  } else if (wageType === 'Base Salary') {
    console.log('✅ Showing form for Base Salary wage type');
    perPieceSection.style.display = 'none';
    perTripSection.style.display = 'none';
    
    const hourlySection = document.getElementById('hourly-section');
    const dailySection = document.getElementById('daily-section');
    if (hourlySection) hourlySection.style.display = 'none';
    if (dailySection) dailySection.style.display = 'none';
    
    console.log('ℹ️ Salary is fixed monthly amount with allowances');
  } else {
    console.warn('⚠️ Unknown wage type:', wageType);
    perPieceSection.style.display = 'none';
    perTripSection.style.display = 'none';
    
    const hourlySection = document.getElementById('hourly-section');
    const dailySection = document.getElementById('daily-section');
    if (hourlySection) hourlySection.style.display = 'none';
    if (dailySection) dailySection.style.display = 'none';
  }
}

// Calculate salary
function calculateSalaryNow() {
  if (!currentSalaryEmployee) return;
  
  let qty = 0;
  let actualRate = currentSalaryEmployee.rate;
  let calculationNote = '';
  if (currentSalaryEmployee.wageType === 'Per-Piece') {
    calculatePieceSalaryNow();
    return;
  }
  
  // Determine quantity and rate based on wage type
  if (currentSalaryEmployee.wageType === 'Per-Piece') {
    const pieces = parseFloat(document.getElementById('salary-pieces').value) || 0;
    qty = pieces;
    const productSelect = document.getElementById('salary-piece-product');
    const sizeSelect = document.getElementById('salary-piece-size-range');
    const workerSelect = document.getElementById('salary-worker-category');
    const productType = productSelect?.value || '';
    const sizeRange = sizeSelect?.value || '';
    const productRate = getActivePieceRate(productType, sizeRange);
    const workerShare = getActiveShare(workerSelect?.value || '');
    const isSunday = document.getElementById('salary-is-sunday')?.checked || false;
    actualRate = productRate ? Number(productRate.piece_rate || 0) : 0;
    currentSalaryEmployee.piecePreview = null;
    if (productRate && workerShare) {
      const productionValue = pieces * actualRate;
      const shareEarnings = productionValue * (Number(workerShare.percentage_share || 0) / 100);
      const resolvedSize = productRate.size_range || productRate.product_category || sizeRange;
      const incentives = getPieceIncentivePreview(pieces, productType, resolvedSize, isSunday, shareEarnings);
      currentSalaryEmployee.piecePreview = {
        product_type: productType,
        product_category: resolvedSize,
        sew_type_code: productType,
        size_range: resolvedSize,
        worker_category: workerShare.worker_category,
        piece_rate: actualRate,
        production_value: productionValue,
        share_percentage: Number(workerShare.percentage_share || 0),
        quota_incentive: incentives.quota,
        sunday_incentive: incentives.sunday,
        special_incentive: incentives.special,
        final_gross_pay: shareEarnings + incentives.quota + incentives.sunday + incentives.special
      };
      calculationNote = `${pieces} pieces x ${actualRate} x ${workerShare.percentage_share}%`;
    }
    
    // Add other sewing types completed
    let otherSewingTotal = 0;
    document.querySelectorAll('[data-sewing-id]').forEach(input => {
      const count = parseFloat(input.value) || 0;
      if (count > 0) {
        const rate = parseFloat(input.getAttribute('data-sewing-rate')) || 0;
        qty += (count * rate / currentSalaryEmployee.rate); // Normalize to base rate units
        otherSewingTotal += count;
      }
    });
    
    console.log(`📊 Per-Piece: ${pieces} base pieces + ${otherSewingTotal} other sewing = ${qty.toFixed(2)} total`);
    calculationNote = `${pieces} pieces @ ₱${currentSalaryEmployee.rate}/piece`;
    
  } else if (currentSalaryEmployee.wageType === 'Per-Trip') {
    const logistics = updateLogisticsPreview();
    qty = logistics.tripCount;
    actualRate = logistics.selectedGross || logistics.driverRate || currentSalaryEmployee.rate;
    calculationNote = logistics.crewStatus === 'Incomplete'
      ? `Incomplete crew: missing helper share ${salaryMoney(logistics.missingHelperShare)}`
      : 'Complete logistics crew';
    
  } else if (currentSalaryEmployee.wageType === 'Hourly') {
    // For Hourly: hours worked × hourly rate
    const hoursWorked = parseFloat(document.getElementById('salary-hours-worked').value) || 0;
    const otHours = parseFloat(document.getElementById('salary-ot-hours').value) || 0;
    
    qty = hoursWorked + otHours;
    actualRate = currentSalaryEmployee.rate; // This is the hourly rate
    
    console.log(`📊 Hourly: ${hoursWorked} regular hours + ${otHours} OT hours = ${qty} total @ ₱${actualRate.toFixed(2)}/hour`);
    calculationNote = `${hoursWorked} hours @ ₱${actualRate}/hour`;
    
  } else if (currentSalaryEmployee.wageType === 'Daily') {
    // For Daily: days worked × daily rate
    const daysWorked = parseFloat(document.getElementById('salary-days-worked').value) || 0;
    
    qty = daysWorked;
    actualRate = currentSalaryEmployee.rate; // This is the daily rate
    
    console.log(`📊 Daily: ${daysWorked} days @ ₱${actualRate.toFixed(2)}/day`);
    calculationNote = `${daysWorked} days @ ₱${actualRate}/day`;
    
  } else if (currentSalaryEmployee.wageType === 'Base Salary') {
    // For Base Salary, the rate is the monthly salary
    qty = 1;
    console.log(`📊 Base Salary: ₱${actualRate.toFixed(2)} per month`);
    calculationNote = 'Monthly salary';
  }
  
  const housing = parseFloat(document.getElementById('salary-housing').value) || 0;
  const meal = parseFloat(document.getElementById('salary-meal').value) || 0;
  const transport = parseFloat(document.getElementById('salary-transport').value) || 0;
  const bonus = parseFloat(document.getElementById('salary-bonus').value) || 0;
  
  const base = currentSalaryEmployee.wageType === 'Per-Piece' && currentSalaryEmployee.piecePreview
    ? currentSalaryEmployee.piecePreview.final_gross_pay
    : currentSalaryEmployee.wageType === 'Per-Trip'
      ? actualRate
    : qty * actualRate;
  const allowances = housing + meal + transport + bonus;
  const gross = base + allowances;
  
  const appliedDeductions = calculateConfiguredDeductions(gross);
  const deductions = appliedDeductions.reduce((sum, item) => sum + item.amount, 0);
  
  const net = gross - deductions;
  
  // Update summary
  document.getElementById('summary-qty').textContent = qty.toFixed(2);
  setSummaryField('summary-base', `₱${base.toFixed(2)}`);
  setSummaryField('summary-allowances', `₱${allowances.toFixed(2)}`);
  setSummaryField('summary-gross', `₱${gross.toFixed(2)}`);
  renderSummaryDeductions(appliedDeductions);
  setSummaryField('summary-total-deductions', `₱${deductions.toFixed(2)}`);
  setSummaryField('summary-net', `₱${net.toFixed(2)}`);
  const deductionNote = document.getElementById('summary-deduction-note');
  if (deductionNote) {
    deductionNote.classList.toggle('applied', deductions > 0);
    deductionNote.textContent = deductions > 0
      ? `${appliedDeductions.length} deduction rule${appliedDeductions.length === 1 ? '' : 's'} applied. Net pay already reflects the deduction.`
      : 'No deduction applied for this payroll week/schedule.';
  }
  updatePieceDetailView();
}

function currentPayrollWeek() {
  return Math.min(5, Math.max(1, Math.ceil(new Date().getDate() / 7)));
}

function scheduleApplies(schedule, week) {
  const label = `${week}${week === 1 ? 'st' : week === 2 ? 'nd' : week === 3 ? 'rd' : 'th'} Week`;
  return schedule === 'Every Payroll' || schedule === label;
}

function calculateConfiguredDeductions(gross) {
  const week = currentPayrollWeek();
  return payrollDeductionSettings
    .filter(setting => Number(setting.is_active) === 1 && scheduleApplies(setting.apply_schedule, week))
    .map(setting => {
      const amount = setting.computation_type === 'Percentage'
        ? gross * ((parseFloat(setting.rate_or_amount) || 0) / 100)
        : setting.computation_type === 'Fixed Amount'
          ? parseFloat(setting.rate_or_amount) || 0
          : 0;
      return { name: setting.name, amount };
    })
    .filter(item => item.amount > 0);
}

// Attach input listeners for calculation
function attachSalaryInputListeners() {
  if (salaryInputListenersAttached) return;

  const ids = ['salary-pieces', 'salary-piece-product', 'salary-piece-size-range', 'salary-worker-category', 'salary-is-sunday', 'salary-piece-pairing', 'salary-piece-partner', 'salary-quota-incentive', 'salary-sunday-incentive', 'salary-special-incentive', 'salary-trip-date', 'salary-trips', 'salary-delivery-location', 'salary-truck-type', 'salary-trip-type', 'salary-driver-employee', 'salary-helper1-employee', 'salary-helper2-employee', 'salary-housing', 'salary-meal', 'salary-transport', 'salary-bonus', 'salary-ot-hours', 'salary-quantity', 'salary-hours-worked', 'salary-days-worked', 'salary-agency'];
  let attachedAny = false;
  ids.forEach(id => {
    const elem = document.getElementById(id);
    if (elem) {
      elem.addEventListener('input', calculateSalaryNow);
      elem.addEventListener('change', calculateSalaryNow);
      if (id === 'salary-agency') elem.addEventListener('change', updateSalaryAgencySummary);
      if (id === 'salary-piece-pairing') {
        elem.addEventListener('change', () => {
          updatePiecePartnerControls();
          const search = document.getElementById('salary-piece-partner-search');
          const dropdown = document.getElementById('salary-piece-partner-dropdown');
          if (dropdown && search === document.activeElement) showPartnerDropdown(filterPiecePartnerEmployees(search.value));
        });
      }
      if (['salary-trip-date', 'salary-delivery-location', 'salary-truck-type', 'salary-trip-type'].includes(id)) {
        elem.addEventListener('change', refreshLogisticsConfiguredRates);
      }
      attachedAny = true;
    }
  });
  const periodInput = document.getElementById('salary-payroll-period');
  if (periodInput && !periodInput.dataset.validationListenerAttached) {
    periodInput.dataset.validationListenerAttached = '1';
    periodInput.addEventListener('change', () => {
      if (currentSalaryEmployee && ['Daily', 'Hourly'].includes(currentSalaryEmployee.wageType)) {
        loadSalaryPayrollValidation();
      }
      if (currentSalaryEmployee && ['Per-Piece', 'Per-Trip'].includes(currentSalaryEmployee.wageType)
        && periodInput.dataset.activeEncodingPeriod
        && periodInput.dataset.activeEncodingPeriod !== periodInput.value) {
        resetCalculationForm();
        periodInput.dataset.activeEncodingPeriod = '';
      }
    });
  }
  salaryInputListenersAttached = attachedAny;
}


// Save functions
async function saveSalaryAsDraft() {
  if (!currentSalaryEmployee) {
    alert('❌ Select an employee first');
    return;
  }
  try {
    await saveSalaryRecord('Draft');
  } catch (e) {
    console.error('Error saving salary draft:', e);
    alert('Draft was not saved: ' + e.message);
  }
  return;
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('💾 SAVING SALARY CALCULATION AS DRAFT');
  console.log('───────────────────────────────────────────────────────────');
  console.log('Employee:', currentSalaryEmployee.code, '-', currentSalaryEmployee.first);
  console.log('Wage Type:', currentSalaryEmployee.wageType);
  
  // Collect calculation data
  const draftData = {
    employee_id: currentSalaryEmployee.id,
    wage_type: currentSalaryEmployee.wageType,
    salary_data: collectSalaryData(),
    saved_at: new Date().toISOString(),
    status: 'draft'
  };
  
  console.log('Draft Data:', draftData);
  
  // Save to localStorage for draft persistence
  const drafts = JSON.parse(localStorage.getItem('salaryDrafts') || '{}');
  drafts[currentSalaryEmployee.id] = draftData;
  localStorage.setItem('salaryDrafts', JSON.stringify(drafts));
  
  console.log('✅ Draft saved to browser storage');
  alert('✅ Salary calculation saved as draft!\n(Local storage - can be restored in this session)');
  console.log('═══════════════════════════════════════════════════════════\n');
}

// Helper: Collect all salary calculation data
function collectSalaryData() {
  const wageType = currentSalaryEmployee.wageType;
  const data = {
    employee_id: currentSalaryEmployee.id,
    employee_code: currentSalaryEmployee.code,
    employee_name: `${currentSalaryEmployee.first} ${currentSalaryEmployee.last}`,
    agency_name: document.getElementById('salary-agency')?.value || '',
    wage_type: wageType,
    rate: currentSalaryEmployee.rate,
    housing: parseFloat(document.getElementById('salary-housing').value) || 0,
    meal: parseFloat(document.getElementById('salary-meal').value) || 0,
    transport: parseFloat(document.getElementById('salary-transport').value) || 0,
    bonus: parseFloat(document.getElementById('salary-bonus').value) || 0,
    ot_hours: parseFloat(document.getElementById('salary-ot-hours').value) || 0,
    calculation_date: new Date().toISOString().split('T')[0]
  };
  
  // Add wage-type specific data
  if (wageType === 'Per-Piece') {
    data.pieces = parseFloat(document.getElementById('salary-pieces').value) || 0;
    data.other_sewing = {};
    document.querySelectorAll('[data-sewing-id]').forEach(input => {
      const sewingId = input.getAttribute('data-sewing-id');
      const value = parseFloat(input.value) || 0;
      if (value > 0) {
        data.other_sewing[sewingId] = value;
      }
    });
  } else if (wageType === 'Per-Trip') {
    data.trips = parseFloat(document.getElementById('salary-trips').value) || 0;
    data.region_id = document.getElementById('salary-region').value || null;
  } else if (wageType === 'Base Salary' || wageType === 'Hourly') {
    data.quantity = 1; // Base Salary is monthly, Hourly is monthly hours
  }
  
  return data;
}

async function saveCalculation() {
  if (!currentSalaryEmployee) {
    alert('❌ Select an employee first');
    return;
  }
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('💾 SAVING SALARY CALCULATION');
  console.log('───────────────────────────────────────────────────────────');
  console.log('Employee:', currentSalaryEmployee.code, '-', currentSalaryEmployee.first);
  console.log('Wage Type:', currentSalaryEmployee.wageType);
  
  try {
    await saveSalaryRecord('Submitted');
  } catch (e) {
    console.error('❌ Error during save:', e);
    alert('Error: ' + e.message);
  }
  console.log('═══════════════════════════════════════════════════════════\n');
}

// Save production transaction for Per-Piece
async function saveProductionTransaction() {
  const pieces = parseFloat(document.getElementById('salary-pieces').value) || 0;
  
  if (pieces === 0) {
    alert('❌ Enter pieces completed');
    return;
  }
  
  console.log(`📊 Per-Piece: ${pieces} pieces @ ₱${currentSalaryEmployee.rate}/piece`);
  
  const today = new Date();
  const payload = {
    employee_id: currentSalaryEmployee.id,
    sewing_type_id: 1, // Default - can be enhanced
    quantity: pieces,
    rate: currentSalaryEmployee.rate,
    transaction_date: today.toISOString().split('T')[0]
  };
  
  console.log('📤 Sending payload:', payload);
  
  const res = await apiFetch('/api/payroll/transactions/production', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  
  if (res.ok) {
    const result = await res.json();
    console.log('✅ Production transaction saved:', result);
    alert(`✅ Transaction saved!\n${result.message}`);
    resetCalculationForm();
  } else {
    const errText = await res.text();
    throw new Error(errText || 'Failed to save transaction');
  }
}

// Save logistics transaction for Per-Trip
async function saveLogisticsTransaction() {
  const trips = parseFloat(document.getElementById('salary-trips').value) || 0;
  const regionId = document.getElementById('salary-region').value;
  
  if (trips === 0) {
    alert('❌ Enter trips completed');
    return;
  }
  
  if (!regionId) {
    alert('❌ Select delivery region');
    return;
  }
  
  console.log(`📊 Per-Trip: ${trips} trips in region ${regionId} @ ₱${currentSalaryEmployee.rate}/trip`);
  
  const today = new Date();
  const payload = {
    employee_id: currentSalaryEmployee.id,
    logistics_region_id: parseInt(regionId),
    rate: currentSalaryEmployee.rate,
    trip_reference: `Trip-${today.getTime()}`,
    transaction_date: today.toISOString().split('T')[0]
  };
  
  console.log('📤 Sending payload:', payload);
  
  const res = await apiFetch('/api/payroll/transactions/logistics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  
  if (res.ok) {
    const result = await res.json();
    console.log('✅ Logistics transaction saved:', result);
    alert(`✅ Transaction saved!\n${result.message}`);
    resetCalculationForm();
  } else {
    const errText = await res.text();
    throw new Error(errText || 'Failed to save transaction');
  }
}

// Save salary record for all wage types
async function saveSalaryRecord(status = 'Submitted') {
  console.log(`📊 ${currentSalaryEmployee.wageType}: ₱${currentSalaryEmployee.rate}`);

  const salaryPage = document.getElementById('page-salary-calculation') || document.getElementById('salary-calculation-root');
  if (window.LGSVValidation && salaryPage && !window.LGSVValidation.validateScope(salaryPage)) return;

  if (status !== 'Draft' && ['Daily', 'Hourly'].includes(currentSalaryEmployee.wageType)) {
    const validation = await loadSalaryPayrollValidation();
    if (!validation?.ok) {
      const message = (validation?.errors || ['Payroll validation failed.']).join('\n');
      await showAlert(message, 'Payroll Validation Blocked', 'warning');
      return;
    }
  }
  
  // Collect all calculation data
  const housing = parseFloat(document.getElementById('salary-housing').value) || 0;
  const meal = parseFloat(document.getElementById('salary-meal').value) || 0;
  const transport = parseFloat(document.getElementById('salary-transport').value) || 0;
  const bonus = parseFloat(document.getElementById('salary-bonus').value) || 0;
  const otHours = parseFloat(document.getElementById('salary-ot-hours').value) || 0;
  
  let hoursWorked = 0;
  let daysWorked = 0;
  let quantity = 1;
  let basePayAmount = currentSalaryEmployee.rate;
  
  // Handle different wage types
  if (currentSalaryEmployee.wageType === 'Hourly') {
    hoursWorked = salaryPayrollValidation?.ok ? Number(salaryPayrollValidation.hours_worked || 0) : parseFloat(document.getElementById('salary-hours-worked').value) || 0;
    basePayAmount = (hoursWorked + otHours) * currentSalaryEmployee.rate;
    
    if (status !== 'Draft' && hoursWorked === 0) {
      await showAlert('Please enter hours worked', 'Warning', 'warning');
      return;
    }
  } else if (currentSalaryEmployee.wageType === 'Daily') {
    daysWorked = salaryPayrollValidation?.ok ? Number(salaryPayrollValidation.days_worked || 0) : parseFloat(document.getElementById('salary-days-worked').value) || 0;
    basePayAmount = daysWorked * currentSalaryEmployee.rate;
    
    if (status !== 'Draft' && daysWorked === 0) {
      await showAlert('Please enter days worked', 'Warning', 'warning');
      return;
    }
  } else if (currentSalaryEmployee.wageType === 'Per-Piece') {
    calculateSalaryNow();
    let pairPayload = null;
    try {
      pairPayload = getPieceOutputPairPayload();
    } catch (error) {
      await showAlert(error.message, 'Warning', 'warning');
      return;
    }
    const pieceRows = getSalaryPieceRows();
    const invalidRows = pieceRows.filter(row => row.sew_type_code || row.size_range || row.quantity_produced > 0)
      .filter(row => !row.sew_type_code || !row.size_range || !(row.quantity_produced > 0) || !(row.piece_rate > 0));
    quantity = pieceRows.reduce((sum, row) => sum + (row.piece_rate > 0 ? row.quantity_produced : 0), 0);
    if (invalidRows.length || !currentSalaryEmployee.piecePreview) {
      await showAlert('Please complete at least one valid Type of Sew, Size Range, and quantity row with an active configured rate.', 'Warning', 'warning');
      return;
    }
    basePayAmount = currentSalaryEmployee.piecePreview.final_gross_pay;

    if (quantity === 0) {
      await showAlert('Please enter pieces completed', 'Warning', 'warning');
      return;
    }
  } else if (currentSalaryEmployee.wageType === 'Per-Trip') {
    const logistics = updateLogisticsPreview();
    quantity = logistics.tripCount;
    basePayAmount = logistics.selectedGross;
    if (!logistics.truckTypeId) {
      await showAlert('Please select the truck used for this delivery.', 'Truck Required', 'warning');
      return;
    }
    if (!logistics.locationId) {
      await showAlert('Please select the configured delivery location.', 'Delivery Location Required', 'warning');
      return;
    }
    if (!logistics.driverId || !logistics.helper1Id) {
      await showAlert('Select the Driver and Delivery Helper 1. Delivery Helper 2 is optional.', 'Delivery Crew Required', 'warning');
      return;
    }
    const crewIds = [logistics.driverId, logistics.helper1Id, logistics.helper2Id].filter(Boolean);
    if (new Set(crewIds).size !== crewIds.length) {
      await showAlert('Driver and helpers cannot be the same employee.', 'Warning', 'warning');
      return;
    }
    if (!(basePayAmount > 0)) {
      await showAlert(currentSalaryEmployee.logisticsRateError || 'The selected employee must be part of the delivery crew and active Driver and Helper rates must be configured.', 'Logistics Rate Required', 'warning');
      return;
    }
  }
  
  const totalAllowances = housing + meal + transport + bonus;
  const grossPay = basePayAmount + totalAllowances;
  
  const appliedDeductions = calculateConfiguredDeductions(grossPay);
  const totalDeductions = appliedDeductions.reduce((sum, item) => sum + item.amount, 0);
  const deductionByName = appliedDeductions.reduce((acc, item) => {
    acc[item.name.toLowerCase()] = item.amount;
    return acc;
  }, {});
  
  // Calculate net pay
  const netPay = grossPay - totalDeductions;
  
  console.log('💰 Salary Summary:');
  console.log('  Base:', basePayAmount);
  console.log('  Allowances:', totalAllowances);
  console.log('  Gross:', grossPay);
  console.log('  Deductions:', totalDeductions);
  console.log('  Net:', netPay);
  
  const today = new Date();
  const payload = {
    salary_calculation_id: currentSalaryDraftId || null,
    employee_id: currentSalaryEmployee.id,
    wage_type_id: currentSalaryEmployee.wageTypeId || 1,
    base_rate: ['Per-Piece', 'Per-Trip'].includes(currentSalaryEmployee.wageType) ? 0 : currentSalaryEmployee.rate,
    quantity,
    hours_worked: hoursWorked,
    days_worked: daysWorked,
    housing_allowance: housing,
    meal_allowance: meal,
    transport_allowance: transport,
    bonus_allowance: bonus,
    total_allowances: totalAllowances,
    overtime_hours: otHours,
    overtime_amount: 0,
    gross_pay: grossPay,
    sss_deduction: deductionByName.sss || 0,
    pagibig_deduction: deductionByName['pag-ibig'] || deductionByName.pagibig || 0,
    philhealth_deduction: deductionByName.philhealth || 0,
    total_deductions: totalDeductions,
    net_pay: netPay,
    calculation_date: today.toISOString().split('T')[0],
    payroll_period: document.getElementById('salary-payroll-period')?.value || today.toISOString().slice(0, 7),
    agency_name: document.getElementById('salary-agency')?.value || '',
    status
  };
  if (currentSalaryEmployee.wageType === 'Per-Trip') {
    const logistics = updateLogisticsPreview();
    const logisticsPayload = {
      truck_type_id: logistics.truckTypeId,
      location_id: logistics.locationId,
      trip_type: logistics.tripType,
      trip_count: logistics.tripCount,
      transaction_date: document.getElementById('salary-trip-date')?.value || payload.calculation_date,
      driver_employee_id: logistics.driverId,
      helper1_employee_id: logistics.helper1Id,
      helper2_employee_id: logistics.helper2Id || null,
      trip_reference: `Trip-${Date.now()}`,
      calculation_status: status
    };
    const logisticsRes = await apiFetch('/api/payroll/transactions/logistics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(logisticsPayload)
    });
    const logisticsResult = await logisticsRes.json().catch(() => ({}));
    if (!logisticsRes.ok) throw new Error(logisticsResult.error || 'Failed to save logistics crew transaction');
    await showAlert(`${logisticsResult.message}\n\nCrew Status: ${logisticsResult.crew_status}\nMissing Helper Share: ${salaryMoney(logisticsResult.missing_helper_share)}`, 'Success', 'success');
    const tripPeriodInput = document.getElementById('salary-payroll-period');
    if (tripPeriodInput) tripPeriodInput.dataset.activeEncodingPeriod = payload.payroll_period;
    resetCalculationForm({ preserveTripConfiguration: true });
    if (typeof loadSalaryCalculations === 'function') loadSalaryCalculations();
    return;
  }
  if (currentSalaryEmployee.wageType === 'Per-Piece') {
    payload.base_rate = 0;
    payload.product_type = currentSalaryEmployee.piecePreview?.product_type || document.getElementById('salary-piece-product')?.value || null;
    payload.product_category = currentSalaryEmployee.piecePreview?.product_category || null;
    payload.sew_type_code = currentSalaryEmployee.piecePreview?.sew_type_code || payload.product_type;
    payload.size_range = currentSalaryEmployee.piecePreview?.size_range || document.getElementById('salary-piece-size-range')?.value || payload.product_category;
    payload.worker_category = currentSalaryEmployee.piecePreview?.worker_category || document.getElementById('salary-worker-category')?.value || null;
    payload.quantity_produced = quantity;
    payload.is_sunday = false;
    const pairPayload = getPieceOutputPairPayload();
    payload.partner_employee_id = pairPayload.partner_employee_id;
    payload.pairing_type = pairPayload.pairing_type;
    payload.production_date = currentSalaryEmployee.piecePreview?.production_date || payload.calculation_date;
    payload.piece_rows = currentSalaryEmployee.piecePreview?.rows || [];
    payload.quota_incentive = currentSalaryEmployee.piecePreview?.quota_incentive || 0;
    payload.sunday_incentive = currentSalaryEmployee.piecePreview?.sunday_incentive || 0;
    payload.special_incentive = currentSalaryEmployee.piecePreview?.special_incentive || 0;

    // A per-piece save is a daily output entry, not a new payroll calculation.
    // The API aggregates each share into the employee's one calculation record
    // for the selected payroll period.
    const dailyRows = currentSalaryEmployee.piecePreview?.rows || [];
    const savedOutputs = [];
    for (const row of dailyRows) {
      const outputResponse = await apiFetch('/api/payroll/piece-rate-outputs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payroll_period: payload.payroll_period,
          production_date: payload.production_date,
          employee_id: pairPayload.employee_id,
          partner_employee_id: payload.partner_employee_id,
          output_mode: 'partner',
          calculation_status: status,
          pairing_type: payload.pairing_type,
          sew_type_code: row.sew_type_code,
          size_range: row.size_range,
          quantity_produced: row.quantity_produced
        })
      });
      const outputResult = await outputResponse.json().catch(() => ({}));
      if (!outputResponse.ok) throw new Error(outputResult.error || 'Failed to save daily piece-rate output.');
      savedOutputs.push(outputResult);
    }
    await showAlert(
      `${savedOutputs.length} daily per-piece output${savedOutputs.length === 1 ? '' : 's'} saved. The payroll record for ${payload.payroll_period} was updated.`,
      'Daily Output Saved',
      'success'
    );
    const piecePeriodInput = document.getElementById('salary-payroll-period');
    if (piecePeriodInput) piecePeriodInput.dataset.activeEncodingPeriod = payload.payroll_period;
    resetCalculationForm({ preservePieceConfiguration: true });
    if (typeof loadSalaryCalculations === 'function') loadSalaryCalculations();
    return;
  }
  
  console.log('📤 Sending payload to API:', payload);
  
  const res = await apiFetch('/api/payroll/salary-calculation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  
  if (res.ok) {
    const result = await res.json();
    currentSalaryDraftId = status === 'Draft' ? (result.calculation_id || result.id || currentSalaryDraftId) : null;
    console.log('✅ Salary calculation saved to database:', result);
    
    let wageDetails = '';
    if (currentSalaryEmployee.wageType === 'Hourly') {
      wageDetails = `Hours Worked: ${hoursWorked}\n`;
    } else if (currentSalaryEmployee.wageType === 'Daily') {
      wageDetails = `Days Worked: ${daysWorked}\n`;
    }
    
    await showAlert(`Salary calculation ${status === 'Draft' ? 'saved as draft' : 'submitted'}.\n\nEmployee: ${currentSalaryEmployee.first} ${currentSalaryEmployee.last}\nWage Type: ${currentSalaryEmployee.wageType}\n${wageDetails}Gross Pay: ₱${grossPay.toLocaleString('en-US', {minimumFractionDigits: 2})}\nNet Pay: ₱${netPay.toLocaleString('en-US', {minimumFractionDigits: 2})}`, 'Success', 'success');
    if (status !== 'Draft') resetCalculationForm({ preservePieceConfiguration: currentSalaryEmployee.wageType === 'Per-Piece' });
    if (typeof loadSalaryCalculations === 'function') loadSalaryCalculations();
  } else {
    const errText = await res.text();
    throw new Error(errText || 'Failed to save salary calculation');
  }
}

// Reset the calculation form
function resetCalculationForm({ preservePieceConfiguration = false, preserveTripConfiguration = false } = {}) {
  currentSalaryDraftId = null;
  // Keep operation, size, employee, and pairing selections after a per-piece
  // save; clear only quantities for the next daily output entry.
  const preserveEncodingConfiguration = preservePieceConfiguration || preserveTripConfiguration;
  if (!preserveEncodingConfiguration) document.getElementById('salary-employee-search').value = '';
  document.getElementById('salary-pieces').value = '';
  const pieceRows = document.getElementById('salary-piece-rows');
  if (pieceRows) {
    if (preservePieceConfiguration) pieceRows.querySelectorAll('.piece-row-qty').forEach(input => { input.value = ''; });
    else pieceRows.innerHTML = '';
  }
  const pieceProduct = document.getElementById('salary-piece-product');
  if (pieceProduct && !preservePieceConfiguration) pieceProduct.value = '';
  const pieceSize = document.getElementById('salary-piece-size-range');
  if (pieceSize && !preservePieceConfiguration) pieceSize.value = '';
  const piecePartner = document.getElementById('salary-piece-partner');
  if (piecePartner && !preservePieceConfiguration) piecePartner.value = '';
  const piecePartnerSearch = document.getElementById('salary-piece-partner-search');
  if (piecePartnerSearch && !preservePieceConfiguration) piecePartnerSearch.value = '';
  const piecePairing = document.getElementById('salary-piece-pairing');
  if (piecePairing && !preservePieceConfiguration) piecePairing.value = 'Standard Sewer-Fixer';
  ['salary-quota-incentive', 'salary-sunday-incentive', 'salary-special-incentive'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '0';
  });
  const workerCategory = document.getElementById('salary-worker-category');
  if (workerCategory && !preservePieceConfiguration) workerCategory.value = '';
  const isSunday = document.getElementById('salary-is-sunday');
  if (isSunday) isSunday.checked = false;
  if (!preserveTripConfiguration) document.getElementById('salary-trips').value = '';
  const deliveryLocation = document.getElementById('salary-delivery-location');
  if (deliveryLocation && !preserveTripConfiguration) deliveryLocation.value = '';
  const tripDate = document.getElementById('salary-trip-date');
  if (tripDate && !preserveTripConfiguration) tripDate.value = '';
  const truckType = document.getElementById('salary-truck-type');
  if (truckType && !preserveTripConfiguration) truckType.value = '';
  const tripType = document.getElementById('salary-trip-type');
  if (tripType && !preserveTripConfiguration) tripType.value = '1st Trip';
  ['salary-driver-employee', 'salary-helper1-employee', 'salary-helper2-employee'].forEach(id => {
    const select = document.getElementById(id);
    if (select && !preserveTripConfiguration) select.value = '';
  });
  document.getElementById('salary-hours-worked').value = '';
  document.getElementById('salary-days-worked').value = '';
  document.getElementById('salary-housing').value = '0';
  document.getElementById('salary-meal').value = '0';
  document.getElementById('salary-transport').value = '0';
  document.getElementById('salary-bonus').value = '0';
  document.getElementById('salary-ot-hours').value = '0';
  const agency = document.getElementById('salary-agency');
  if (agency) agency.value = '';
  
  document.getElementById('summary-employee').textContent = '—';
  const summaryAgency = document.getElementById('summary-agency');
  if (summaryAgency) summaryAgency.textContent = '-';
  setSummaryField('summary-base', '₱0.00');
  setSummaryField('summary-allowances', '₱0.00');
  setSummaryField('summary-gross', '₱0.00');
  setSummaryField('summary-total-deductions', '₱0.00');
  setSummaryField('summary-net', '₱0.00');
  renderSummaryDeductions([]);
  if (currentSalaryEmployee) currentSalaryEmployee.piecePreview = null;
  if (preserveEncodingConfiguration) calculateSalaryNow();
  else updatePieceDetailView();
  updateLogisticsPreview();
  
  if (!preserveEncodingConfiguration) {
    currentSalaryEmployee = null;
    updateSalaryRateVisibility('');
    const draftButton = document.getElementById('save-salary-draft-btn');
    const saveButton = document.getElementById('save-salary-calculation-btn');
    if (draftButton) draftButton.textContent = 'Save Draft';
    if (saveButton) saveButton.textContent = 'Save Calculation';
  }
  console.log('✅ Form reset');
}
