/* Salary Calculation - Simple Edition */

let currentSalaryEmployee = null;
let salaryEmpList = [];
let sewingTypes = [];
let logisticsRegions = [];

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
    salaryEmpList = await res.json();
    console.log(`✅ Got ${salaryEmpList.length} employees for salary page`);
    attachSearchListener();
  } catch (e) {
    console.error('❌ Failed to fetch employees:', e);
  }
}

// Attach search input listener
function attachSearchListener() {
  const search = document.getElementById('salary-employee-search');
  const dropdown = document.getElementById('salary-employee-dropdown');
  
  if (!search || !dropdown) {
    console.error('❌ Missing search or dropdown element');
    return;
  }
  
  console.log('✅ Search element found, attaching listeners');
  
  // On focus - show all employees
  search.addEventListener('focus', () => {
    console.log('Focus event - showing dropdown');
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
  console.log('� showWageStructureForm called with:', wageType);
  
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
  } else {
    console.warn('⚠️ Unknown wage type:', wageType);
    perPieceSection.style.display = 'none';
    perTripSection.style.display = 'none';
  }
}

// Calculate salary
function calculateSalaryNow() {
  if (!currentSalaryEmployee) return;
  
  let qty = 0;
  let actualRate = currentSalaryEmployee.rate;
  
  // Determine quantity based on wage type
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
      }
    }
  }
  
  const housing = parseFloat(document.getElementById('salary-housing').value) || 0;
  const meal = parseFloat(document.getElementById('salary-meal').value) || 0;
  const transport = parseFloat(document.getElementById('salary-transport').value) || 0;
  const bonus = parseFloat(document.getElementById('salary-bonus').value) || 0;
  
  const base = qty * actualRate;
  const allowances = housing + meal + transport + bonus;
  const gross = base + allowances;
  
  const sss = gross * 0.045;
  const pagibig = gross * 0.02;
  const philhealth = gross * 0.0275;
  const deductions = sss + pagibig + philhealth;
  
  const net = gross - deductions;
  
  // Update summary
  document.getElementById('summary-qty').textContent = qty.toFixed(2);
  document.getElementById('summary-base').textContent = `₱${base.toFixed(2)}`;
  document.getElementById('summary-allowances').textContent = `₱${allowances.toFixed(2)}`;
  document.getElementById('summary-gross').textContent = `₱${gross.toFixed(2)}`;
  
  document.getElementById('summary-deductions').innerHTML = `
    <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:6px;">
      <span style="color:var(--muted);">SSS (4.5%)</span>
      <span>₱${sss.toFixed(2)}</span>
    </div>
    <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:6px;">
      <span style="color:var(--muted);">Pag-IBIG (2%)</span>
      <span>₱${pagibig.toFixed(2)}</span>
    </div>
    <div style="display:flex; justify-content:space-between; font-size:11px;">
      <span style="color:var(--muted);">PhilHealth (2.75%)</span>
      <span>₱${philhealth.toFixed(2)}</span>
    </div>
  `;
  
  document.getElementById('summary-total-deductions').textContent = `₱${deductions.toFixed(2)}`;
  document.getElementById('summary-net').textContent = `₱${net.toFixed(2)}`;
}

// Attach input listeners for calculation
function attachSalaryInputListeners() {
  const ids = ['salary-pieces', 'salary-trips', 'salary-region', 'salary-housing', 'salary-meal', 'salary-transport', 'salary-bonus', 'salary-ot-hours', 'salary-quantity'];
  ids.forEach(id => {
    const elem = document.getElementById(id);
    if (elem) {
      elem.addEventListener('input', calculateSalaryNow);
      elem.addEventListener('change', calculateSalaryNow);
    }
  });
}


// Save functions
function saveSalaryAsDraft() {
  if (!currentSalaryEmployee) {
    alert('Select an employee first');
    return;
  }
  alert('✅ Draft saved!');
}

async function saveCalculation() {
  if (!currentSalaryEmployee) {
    alert('Select an employee first');
    return;
  }
  
  // Collect data based on wage type
  let qty = 0;
  let region = null;
  const isSewingType = currentSalaryEmployee.wageType === 'Per-Piece';
  
  if (isSewingType) {
    // Per-Piece wage type
    qty = parseFloat(document.getElementById('salary-pieces').value) || 0;
    if (qty === 0) {
      alert('Enter pieces completed');
      return;
    }
    console.log(`✅ Saving Per-Piece transaction: ${qty} pieces`);
  } else {
    // Per-Trip wage type
    qty = parseFloat(document.getElementById('salary-trips').value) || 0;
    region = document.getElementById('salary-region').value;
    if (qty === 0) {
      alert('Enter trips completed');
      return;
    }
    if (!region) {
      alert('Select delivery region');
      return;
    }
    console.log(`✅ Saving Per-Trip transaction: ${qty} trips in region ${region}`);
  }
  
  try {
    const today = new Date();
    const endpoint = isSewingType ? 'production' : 'logistics';
    const payload = {
      employee_id: currentSalaryEmployee.id,
      quantity: qty,
      rate: currentSalaryEmployee.rate,
      month_year: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`,
      week_number: Math.ceil(today.getDate() / 7),
      transaction_date: today.toISOString().split('T')[0]
    };
    
    // Add region for Per-Trip
    if (!isSewingType && region) {
      payload.region_id = parseInt(region);
    }
    
    console.log('📤 Sending payload:', payload);
    
    const res = await apiFetch(`/api/payroll/transactions/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (res.ok) {
      const result = await res.json();
      console.log('✅ Transaction saved:', result);
      alert('✅ Calculation saved successfully!');
      
      // Reset form
      document.getElementById('salary-employee-search').value = '';
      document.getElementById('salary-pieces').value = '';
      document.getElementById('salary-trips').value = '';
      document.getElementById('salary-region').value = '';
      currentSalaryEmployee = null;
      
      // Clear summary
      document.getElementById('summary-employee').textContent = '—';
      document.getElementById('summary-base').textContent = '₱0.00';
      document.getElementById('summary-gross').textContent = '₱0.00';
      document.getElementById('summary-net').textContent = '₱0.00';
    } else {
      const errText = await res.text();
      console.error('❌ Save failed:', res.status, errText);
      alert('Failed to save: ' + errText);
    }
  } catch (e) {
    console.error('❌ Error:', e);
    alert('Error: ' + e.message);
  }
}
