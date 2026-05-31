/* Salary Calculation - Simple Edition */

let currentSalaryEmployee = null;
let salaryEmpList = [];
let sewingTypes = [];
let logisticsRegions = [];
let payrollDeductionSettings = [];
let salaryPageInitialized = false;
let salarySearchListenerAttached = false;
let salaryInputListenersAttached = false;

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
    } catch (err) {
      console.error('Failed to load wage types:', err);
    }
    attachSalaryInputListeners();
  }

  await fetchSalaryEmpList();

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
    
    return { sewingTypes, logisticsRegions };
  } catch (e) {
    console.error('❌ Error loading wage types:', e);
    sewingTypes = [];
    logisticsRegions = [];
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
    attachSearchListener();
  } catch (e) {
    console.error('❌ Failed to fetch employees:', e);
  }
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
    showDropdownList(salaryEmpList);
  });
  
  // On input - filter
  search.addEventListener('input', () => {
    const term = search.value.toLowerCase().trim();
    if (!term) {
      showDropdownList(salaryEmpList);
      return;
    }
    
    const filtered = salaryEmpList.filter(e => {
      const fullName = `${e.first_name} ${e.last_name}`.toLowerCase();
      const code = e.employee_code.toLowerCase();
      const dept = (e.department || '').toLowerCase();
      return fullName.includes(term) || code.includes(term) || dept.includes(term);
    });
    
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

// Handle employee selection
async function clickSalaryEmployee(id, code, first, last, dept, pos) {
  console.log(`\n=== Employee Selection ===`);
  console.log(`✅ Selected: ${code} - ${first} ${last}`);
  console.log(`Employee ID (from frontend): ${id}`);
  
  // Hide dropdown
  document.getElementById('salary-employee-dropdown').style.display = 'none';
  document.getElementById('salary-employee-search').value = `${code} - ${first} ${last}`;
  
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
        wageType: 'Not Set',
        rate: 0
      };
      alert('⚠️ Wage structure not configured for this employee. Please ask HR admin to set it up in Employee Management → Payroll & Compensation.');
      document.getElementById('salary-wage-type').textContent = 'Not Configured';
      document.getElementById('salary-rate').textContent = '₱0.00';
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
    
    // Store in global
    currentSalaryEmployee = {
      id: parseInt(id),
      code, first, last, dept, pos,
      wageType: config.wage_type,
      wageTypeId: config.wage_type_id || config.employee?.wage_type_id,
      rate: parseFloat(config.current_rate) || 0
    };
    
    console.log('✅ Current salary employee set:', currentSalaryEmployee);
    
    // Update display
    document.getElementById('salary-wage-type').textContent = config.wage_type || '—';
    document.getElementById('salary-rate').textContent = `₱${currentSalaryEmployee.rate.toLocaleString('en-US', {minimumFractionDigits: 2})}`;
    
    // Update summary employee name
    document.getElementById('summary-employee').textContent = `${first} ${last}`;
    document.getElementById('summary-wage-type').textContent = config.wage_type;
    document.getElementById('summary-rate').textContent = `₱${currentSalaryEmployee.rate.toFixed(2)}`;
    
    // Show info panel
    const panel = document.getElementById('salary-employee-info');
    if (panel) {
      panel.style.display = 'block';
      document.getElementById('salary-employee-name').textContent = `${code} - ${first} ${last}`;
      document.getElementById('salary-employee-dept-info').textContent = dept || '—';
      document.getElementById('salary-employee-pos-info').textContent = pos || '—';
      document.getElementById('salary-employee-wage-info').textContent = `${config.wage_type} • ₱${currentSalaryEmployee.rate.toLocaleString('en-US', {minimumFractionDigits: 2})}`;
    }
    
    // Show appropriate wage structure form
    console.log('🔄 Calling showWageStructureForm with:', config.wage_type);
    showWageStructureForm(config.wage_type);
    
    // Reset inputs
    document.getElementById('salary-pieces').value = '';
    document.getElementById('salary-trips').value = '';
    document.getElementById('salary-region').value = '';
    document.getElementById('salary-housing').value = '0';
    document.getElementById('salary-meal').value = '0';
    document.getElementById('salary-transport').value = '0';
    document.getElementById('salary-bonus').value = '0';
    document.getElementById('salary-ot-hours').value = '0';
    
    calculateSalaryNow();
    
  } catch (e) {
    console.error('❌ Error loading wage config:', e);
    alert('Failed to load wage config: ' + e.message);
  }
}

// Show appropriate wage structure form based on wage type
function showWageStructureForm(wageType) {
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
    
    // Populate regions dropdown
    const regionSelect = document.getElementById('salary-region');
    if (!regionSelect) {
      console.error('❌ salary-region select not found');
      return;
    }
    
    if (!logisticsRegions || logisticsRegions.length === 0) {
      console.warn('⚠️ No regions loaded');
      regionSelect.innerHTML = '<option value="">No regions available</option>';
    } else {
      regionSelect.innerHTML = '<option value="">— Select region —</option>' +
        logisticsRegions.map(r => `<option value="${r.id}" data-rate="${r.default_rate || 0}">${r.name} - ₱${parseFloat(r.default_rate || 0).toFixed(2)}</option>`).join('');
    }
    
    console.log('✅ Per-Trip form ready with', logisticsRegions.length, 'regions');
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
  
  // Determine quantity and rate based on wage type
  if (currentSalaryEmployee.wageType === 'Per-Piece') {
    const pieces = parseFloat(document.getElementById('salary-pieces').value) || 0;
    qty = pieces;
    
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
    const trips = parseFloat(document.getElementById('salary-trips').value) || 0;
    const regionId = document.getElementById('salary-region').value;
    
    qty = trips;
    
    // Check if region has different rate
    if (regionId) {
      const region = logisticsRegions.find(r => r.id == regionId);
      if (region) {
        actualRate = parseFloat(region.default_rate) || currentSalaryEmployee.rate;
        console.log(`📊 Per-Trip: ${trips} trips in ${region.name} @ ₱${actualRate.toFixed(2)}/trip`);
        calculationNote = `${trips} trips @ ₱${actualRate}/trip (${region.name})`;
      }
    }
    
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
  
  const base = qty * actualRate;
  const allowances = housing + meal + transport + bonus;
  const gross = base + allowances;
  
  const appliedDeductions = calculateConfiguredDeductions(gross);
  const deductions = appliedDeductions.reduce((sum, item) => sum + item.amount, 0);
  
  const net = gross - deductions;
  
  // Update summary
  document.getElementById('summary-qty').textContent = qty.toFixed(2);
  document.getElementById('summary-base').textContent = `₱${base.toFixed(2)}`;
  document.getElementById('summary-allowances').textContent = `₱${allowances.toFixed(2)}`;
  document.getElementById('summary-gross').textContent = `₱${gross.toFixed(2)}`;
  
  document.getElementById('summary-deductions').innerHTML = appliedDeductions.length
    ? appliedDeductions.map(item => `
      <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:6px;">
        <span style="color:var(--muted);">${item.name}</span>
        <span>₱${item.amount.toFixed(2)}</span>
      </div>
    `).join('')
    : '<div style="color:var(--muted); font-size:11px;">No configured deductions for this payroll week.</div>';
  
  document.getElementById('summary-total-deductions').textContent = `₱${deductions.toFixed(2)}`;
  document.getElementById('summary-net').textContent = `₱${net.toFixed(2)}`;
  const deductionNote = document.getElementById('summary-deduction-note');
  if (deductionNote) {
    deductionNote.classList.toggle('applied', deductions > 0);
    deductionNote.textContent = deductions > 0
      ? `${appliedDeductions.length} deduction rule${appliedDeductions.length === 1 ? '' : 's'} applied. Net pay already reflects the deduction.`
      : 'No deduction applied for this payroll week/schedule.';
  }
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

  const ids = ['salary-pieces', 'salary-trips', 'salary-region', 'salary-housing', 'salary-meal', 'salary-transport', 'salary-bonus', 'salary-ot-hours', 'salary-quantity', 'salary-hours-worked', 'salary-days-worked'];
  let attachedAny = false;
  ids.forEach(id => {
    const elem = document.getElementById(id);
    if (elem) {
      elem.addEventListener('input', calculateSalaryNow);
      elem.addEventListener('change', calculateSalaryNow);
      attachedAny = true;
    }
  });
  salaryInputListenersAttached = attachedAny;
}


// Save functions
async function saveSalaryAsDraft() {
  if (!currentSalaryEmployee) {
    alert('❌ Select an employee first');
    return;
  }
  await saveSalaryRecord('Draft');
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
    hoursWorked = parseFloat(document.getElementById('salary-hours-worked').value) || 0;
    basePayAmount = (hoursWorked + otHours) * currentSalaryEmployee.rate;
    
    if (hoursWorked === 0) {
      await showAlert('Please enter hours worked', 'Warning', 'warning');
      return;
    }
  } else if (currentSalaryEmployee.wageType === 'Daily') {
    daysWorked = parseFloat(document.getElementById('salary-days-worked').value) || 0;
    basePayAmount = daysWorked * currentSalaryEmployee.rate;
    
    if (daysWorked === 0) {
      await showAlert('Please enter days worked', 'Warning', 'warning');
      return;
    }
  } else if (currentSalaryEmployee.wageType === 'Per-Piece') {
    quantity = parseFloat(document.getElementById('salary-pieces').value) || 0;
    basePayAmount = quantity * currentSalaryEmployee.rate;

    if (quantity === 0) {
      await showAlert('Please enter pieces completed', 'Warning', 'warning');
      return;
    }
  } else if (currentSalaryEmployee.wageType === 'Per-Trip') {
    quantity = parseFloat(document.getElementById('salary-trips').value) || 0;
    const regionId = document.getElementById('salary-region').value;
    const region = logisticsRegions.find(r => r.id == regionId);
    const tripRate = region ? (parseFloat(region.default_rate) || currentSalaryEmployee.rate) : currentSalaryEmployee.rate;
    basePayAmount = quantity * tripRate;

    if (quantity === 0) {
      await showAlert('Please enter trips completed', 'Warning', 'warning');
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
    employee_id: currentSalaryEmployee.id,
    wage_type_id: currentSalaryEmployee.wageTypeId || 1,
    base_rate: currentSalaryEmployee.rate,
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
    status
  };
  
  console.log('📤 Sending payload to API:', payload);
  
  const res = await apiFetch('/api/payroll/salary-calculation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  
  if (res.ok) {
    const result = await res.json();
    console.log('✅ Salary calculation saved to database:', result);
    
    let wageDetails = '';
    if (currentSalaryEmployee.wageType === 'Hourly') {
      wageDetails = `Hours Worked: ${hoursWorked}\n`;
    } else if (currentSalaryEmployee.wageType === 'Daily') {
      wageDetails = `Days Worked: ${daysWorked}\n`;
    }
    
    await showAlert(`Salary calculation ${status === 'Draft' ? 'saved as draft' : 'submitted'}.\n\nEmployee: ${currentSalaryEmployee.first} ${currentSalaryEmployee.last}\nWage Type: ${currentSalaryEmployee.wageType}\n${wageDetails}Gross Pay: ₱${grossPay.toLocaleString('en-US', {minimumFractionDigits: 2})}\nNet Pay: ₱${netPay.toLocaleString('en-US', {minimumFractionDigits: 2})}`, 'Success', 'success');
    resetCalculationForm();
    if (typeof loadSalaryCalculations === 'function') loadSalaryCalculations();
  } else {
    const errText = await res.text();
    throw new Error(errText || 'Failed to save salary calculation');
  }
}

// Reset the calculation form
function resetCalculationForm() {
  document.getElementById('salary-employee-search').value = '';
  document.getElementById('salary-pieces').value = '';
  document.getElementById('salary-trips').value = '';
  document.getElementById('salary-region').value = '';
  document.getElementById('salary-hours-worked').value = '';
  document.getElementById('salary-days-worked').value = '';
  document.getElementById('salary-housing').value = '0';
  document.getElementById('salary-meal').value = '0';
  document.getElementById('salary-transport').value = '0';
  document.getElementById('salary-bonus').value = '0';
  document.getElementById('salary-ot-hours').value = '0';
  
  document.getElementById('summary-employee').textContent = '—';
  document.getElementById('summary-base').textContent = '₱0.00';
  document.getElementById('summary-allowances').textContent = '₱0.00';
  document.getElementById('summary-gross').textContent = '₱0.00';
  document.getElementById('summary-total-deductions').textContent = '₱0.00';
  document.getElementById('summary-net').textContent = '₱0.00';
  
  currentSalaryEmployee = null;
  console.log('✅ Form reset');
}
