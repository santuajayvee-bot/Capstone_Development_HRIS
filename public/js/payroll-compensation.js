/* Payroll & Compensation - Admin Setup - All Wage Types Supported */

let compEmployeesList = [];
let compSewingTypes = [];
let compLogisticsRegions = [];
let compWageTypes = [];
let selectedCompEmployee = null;

function normalizeCompWageType(value) {
  const name = String(value || '').trim();
  if (/piece/i.test(name)) return 'Per-Piece';
  if (/trip|logistics/i.test(name)) return 'Per-Trip';
  if (/hour/i.test(name)) return 'Hourly';
  if (/day|daily/i.test(name)) return 'Daily';
  if (/base|salary/i.test(name)) return 'Base Salary';
  return name;
}

function getCompWageTypeNameById(id) {
  const type = compWageTypes.find(item => String(item.id) === String(id));
  return type ? normalizeCompWageType(type.name) : '';
}

function getCompWageTypeIdByName(name) {
  const normalized = normalizeCompWageType(name);
  const type = compWageTypes.find(item => normalizeCompWageType(item.name) === normalized);
  return type ? String(type.id) : '';
}

function isCompWageType(idOrName, target) {
  const name = getCompWageTypeNameById(idOrName) || normalizeCompWageType(idOrName);
  return name === target;
}

function usesCompBaseRate(idOrName) {
  return isCompWageType(idOrName, 'Daily') || isCompWageType(idOrName, 'Hourly');
}

function formatCompCurrentRate(config) {
  const wageType = normalizeCompWageType(config?.wage_type);
  if (wageType === 'Per-Piece' || wageType === 'Per-Trip') return 'Configured per output rate';
  return `PHP ${parseFloat(config?.current_rate || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}`;
}

function renderCompWageTypeOptions() {
  const select = document.getElementById('comp-wage-type');
  if (!select || !compWageTypes.length) return;
  const selected = select.value;
  select.innerHTML = '<option value="">- Select wage type -</option>' + compWageTypes
    .map(type => `<option value="${type.id}">${normalizeCompWageType(type.name)}</option>`)
    .join('');
  if (selected && compWageTypes.some(type => String(type.id) === String(selected))) {
    select.value = selected;
  }
}

// Initialize
window.addEventListener('DOMContentLoaded', () => {
  console.log('📄 Compensation page loaded');
  loadCompEmployees();
  loadCompWageTypes();
  attachCompEventListeners();
});

// Load all employees
async function loadCompEmployees() {
  try {
    const res = await apiFetch('/api/employees');
    compEmployeesList = await res.json();
    
    const select = document.getElementById('comp-employee-select');
    select.innerHTML = '<option value="">— Choose an employee —</option>' +
      compEmployeesList.map(emp => `<option value="${emp.id}">${emp.employee_code} - ${emp.first_name} ${emp.last_name}</option>`).join('');
    
    console.log(`✅ Loaded ${compEmployeesList.length} employees`);
  } catch (e) {
    console.error('❌ Error loading employees:', e);
  }
}

// Load wage type options and related data
async function loadCompWageTypes() {
  try {
    const wageRes = await apiFetch('/api/payroll/wage-types');
    compWageTypes = await wageRes.json();
    renderCompWageTypeOptions();
    console.log(`âœ… Loaded ${compWageTypes.length} wage types`);

    const sewRes = await apiFetch('/api/payroll/sewing-types');
    compSewingTypes = await sewRes.json();
    console.log(`✅ Loaded ${compSewingTypes.length} sewing types`);
    
    const logRes = await apiFetch('/api/payroll/logistics-regions');
    compLogisticsRegions = await logRes.json();
    console.log(`✅ Loaded ${compLogisticsRegions.length} logistics regions`);
  } catch (e) {
    console.error('❌ Error loading wage types:', e);
  }
}

// Attach event listeners
function attachCompEventListeners() {
  const employeeSelect = document.getElementById('comp-employee-select');
  const wageTypeSelect = document.getElementById('comp-wage-type');
  
  if (employeeSelect) {
    employeeSelect.addEventListener('change', handleCompEmployeeSelect);
  }
  
  if (wageTypeSelect) {
    wageTypeSelect.addEventListener('change', handleWageTypeChange);
  }
}

// Handle employee selection
async function handleCompEmployeeSelect(e) {
  const empId = e.target.value;
  if (!empId) {
    return;
  }
  
  selectedCompEmployee = compEmployeesList.find(emp => emp.id == empId);
  console.log(`✅ Selected: ${selectedCompEmployee.employee_code}`);
  
  const infoDiv = document.getElementById('comp-employee-info');
  if (infoDiv) infoDiv.style.display = 'block';
  
  // Load current wage config
  try {
    const res = await apiFetch(`/api/payroll/employees/${empId}/wage-config`);
    const config = await res.json();
    
    console.log('📊 Loaded wage config:', config);
    
    document.getElementById('comp-current-wage').textContent = config.wage_type || '—';
    document.getElementById('comp-current-rate').textContent = formatCompCurrentRate(config);
    
    const wageTypeValue = config.wage_type_id ? String(config.wage_type_id) : getCompWageTypeIdByName(config.wage_type);
    document.getElementById('comp-wage-type').value = wageTypeValue;
    
    // Load current rates into forms if they exist
    if (config.rates && config.rates.length > 0) {
      const firstRate = config.rates[0];
      
      // Set base salary if exists
      if (usesCompBaseRate(wageTypeValue) && firstRate.base_rate) {
        document.getElementById('comp-base-salary').value = firstRate.base_rate;
      }
      
      // Set hourly rates if exists
      if (firstRate.hourly_rate) {
        document.getElementById('comp-hourly-rate').value = firstRate.hourly_rate;
      }
      if (firstRate.overtime_rate) {
        document.getElementById('comp-overtime-rate').value = firstRate.overtime_rate;
      }
    }
    
    // Show appropriate section
    if (wageTypeValue) {
      handleWageTypeChange({ target: { value: wageTypeValue } });
    }
    
  } catch (e) {
    console.log('ℹ️ No existing config for employee');
    document.getElementById('comp-current-wage').textContent = 'Not set';
    document.getElementById('comp-current-rate').textContent = '—';
    document.getElementById('comp-wage-type').value = '';
    clearAllForms();
  }
}

// Clear all form inputs
function clearAllForms() {
  document.getElementById('comp-base-salary').value = '';
  document.getElementById('comp-hourly-rate').value = '';
  document.getElementById('comp-overtime-rate').value = '';
}

// Handle wage type change
function handleWageTypeChange(e) {
  const wageTypeId = e.target.value;
  
  // Hide all sections first
  document.getElementById('comp-base-section').style.display = 'none';
  document.getElementById('comp-hourly-section').style.display = 'none';
  document.getElementById('comp-sewing-section').style.display = 'none';
  document.getElementById('comp-logistics-section').style.display = 'none';
  
  // Show appropriate section based on wage type
  if (isCompWageType(wageTypeId, 'Daily')) {
    // Daily
    console.log('🔧 Showing Daily rate form');
    document.getElementById('comp-base-section').style.display = 'block';
  } else if (isCompWageType(wageTypeId, 'Hourly')) {
    // Hourly
    console.log('🔧 Showing Hourly form');
    document.getElementById('comp-hourly-section').style.display = 'block';
  } else if (isCompWageType(wageTypeId, 'Per-Piece')) {
    // Per-Piece (Sewing)
    console.log('🔧 Showing Per-Piece (Sewing) form');
    document.getElementById('comp-sewing-section').style.display = 'block';
    renderSewingTypeRates();
  } else if (isCompWageType(wageTypeId, 'Per-Trip')) {
    // Per-Trip (Logistics)
    console.log('🔧 Showing Per-Trip (Logistics) form');
    document.getElementById('comp-logistics-section').style.display = 'block';
    renderLogisticsRegionRates();
  }
}

// Render sewing type rate inputs
function renderSewingTypeRates() {
  const container = document.getElementById('comp-sewing-items');
  container.innerHTML = compSewingTypes.map(sewing => `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: end; padding: 12px; background: white; border-radius: 4px; border: 1px solid var(--border);">
      <div>
        <label style="display: block; font-size: 10px; color: var(--muted); margin-bottom: 4px; font-weight: 600;">${sewing.name}</label>
        <input type="text" disabled value="${sewing.description || ''}" style="width: 100%; padding: 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--muted); font-size: 11px;" />
      </div>
      <div>
        <label style="display: block; font-size: 10px; color: var(--muted); margin-bottom: 4px; font-weight: 600;">Rate (₱)</label>
        <input type="number" 
               class="comp-rate-input" 
               data-sewing-id="${sewing.id}" 
               min="0" 
               step="0.01" 
               placeholder="${sewing.default_rate || '0.00'}" 
               value=""
               style="width: 100%; padding: 6px; border: 1px solid var(--border); border-radius: 4px; color: var(--text); background: white;" />
      </div>
    </div>
  `).join('');
}

// Render logistics region rate inputs
function renderLogisticsRegionRates() {
  const container = document.getElementById('comp-logistics-items');
  container.innerHTML = compLogisticsRegions.map(region => `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: end; padding: 12px; background: white; border-radius: 4px; border: 1px solid var(--border);">
      <div>
        <label style="display: block; font-size: 10px; color: var(--muted); margin-bottom: 4px; font-weight: 600;">${region.name}</label>
        <input type="text" disabled value="${region.description || ''}" style="width: 100%; padding: 6px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--muted); font-size: 11px;" />
      </div>
      <div>
        <label style="display: block; font-size: 10px; color: var(--muted); margin-bottom: 4px; font-weight: 600;">Rate (₱)</label>
        <input type="number" 
               class="comp-rate-input" 
               data-region-id="${region.id}" 
               min="0" 
               step="0.01" 
               placeholder="${region.default_rate || '0.00'}" 
               value=""
               style="width: 100%; padding: 6px; border: 1px solid var(--border); border-radius: 4px; color: var(--text); background: white;" />
      </div>
    </div>
  `).join('');
}

// Save compensation
async function saveCompensation() {
  if (!selectedCompEmployee) {
    alert('❌ Please select an employee');
    return;
  }
  
  const wageTypeId = document.getElementById('comp-wage-type').value;
  if (!wageTypeId) {
    alert('❌ Please select a wage type');
    return;
  }
  
  const rates = [];
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('💾 SAVING COMPENSATION');
  console.log('───────────────────────────────────────────────────────────');
  console.log('Employee ID:', selectedCompEmployee.id);
  console.log('Employee: ' + selectedCompEmployee.first_name + ' ' + selectedCompEmployee.last_name);
  console.log('Wage Type ID:', wageTypeId);
  
  try {
    // Collect rates based on wage type
    if (isCompWageType(wageTypeId, 'Daily')) {
      // Daily rate
      const baseSalary = parseFloat(document.getElementById('comp-base-salary').value) || 0;
      if (baseSalary <= 0) {
        alert('❌ For Daily: Please enter a valid daily rate');
        return;
      }
      rates.push({
        rate: baseSalary,
        base_rate: baseSalary,
        hourly_rate: null,
        overtime_rate: null,
        sewing_type_id: null,
        logistics_region_id: null
      });
      console.log('Rate: Daily ₱' + baseSalary.toLocaleString('en-PH', {minimumFractionDigits: 2}));
      
    } else if (isCompWageType(wageTypeId, 'Hourly')) {
      // Hourly
      const hourlyRate = parseFloat(document.getElementById('comp-hourly-rate').value) || 0;
      const overtimeRate = parseFloat(document.getElementById('comp-overtime-rate').value) || 0;
      
      if (hourlyRate <= 0) {
        alert('❌ For Hourly: Please enter a valid hourly rate');
        return;
      }
      
      rates.push({
        rate: hourlyRate,
        base_rate: hourlyRate,
        hourly_rate: hourlyRate,
        overtime_rate: overtimeRate || 0,
        sewing_type_id: null,
        logistics_region_id: null
      });
      console.log('Rate: Hourly ₱' + hourlyRate.toLocaleString('en-PH', {minimumFractionDigits: 2}) + ' | OT: ₱' + (overtimeRate || 0).toLocaleString('en-PH', {minimumFractionDigits: 2}));
      
    } else if (isCompWageType(wageTypeId, 'Per-Piece')) {
      // Per-Piece (Sewing)
      document.querySelectorAll('.comp-rate-input[data-sewing-id]').forEach(input => {
        const rate = parseFloat(input.value) || 0;
        if (rate > 0) {
          const sewingId = parseInt(input.getAttribute('data-sewing-id'));
          rates.push({
            rate,
            base_rate: null,
            hourly_rate: null,
            overtime_rate: null,
            sewing_type_id: sewingId,
            logistics_region_id: null
          });
        }
      });
      
      if (rates.length === 0) {
        alert('❌ For Per-Piece: Please enter at least one rate');
        return;
      }
      console.log('Rates: ' + rates.length + ' sewing type(s) configured');
      
    } else if (isCompWageType(wageTypeId, 'Per-Trip')) {
      // Per-Trip (Logistics)
      document.querySelectorAll('.comp-rate-input[data-region-id]').forEach(input => {
        const rate = parseFloat(input.value) || 0;
        if (rate > 0) {
          const regionId = parseInt(input.getAttribute('data-region-id'));
          rates.push({
            rate,
            base_rate: null,
            hourly_rate: null,
            overtime_rate: null,
            sewing_type_id: null,
            logistics_region_id: regionId
          });
        }
      });
      
      if (rates.length === 0) {
        alert('❌ For Per-Trip: Please enter at least one rate');
        return;
      }
      console.log('Rates: ' + rates.length + ' region(s) configured');
    }
    
    console.log('═══════════════════════════════════════════════════════════\n');
    
    if (rates.length === 0) {
      alert('Base salary is only supported through Daily or Hourly payroll setup.');
      return;
    }

    // Send to API
    const res = await apiFetch(`/api/payroll/employees/${selectedCompEmployee.id}/wage-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wage_type_id: parseInt(wageTypeId),
        rates
      })
    });
    
    const resData = await res.json();
    
    if (res.ok && resData.ratesSaved > 0) {
      console.log('✅ SUCCESS - Saved to database:', resData);
      alert(`✅ Compensation saved!\n✓ ${resData.ratesSaved} rate(s) successfully saved to database`);
      
      // Reload display
      await new Promise(r => setTimeout(r, 200));
      try {
        const reloadRes = await apiFetch(`/api/payroll/employees/${selectedCompEmployee.id}/wage-config`);
        const reloadData = await reloadRes.json();
        
        document.getElementById('comp-current-wage').textContent = reloadData.wage_type || '—';
        document.getElementById('comp-current-rate').textContent = formatCompCurrentRate(reloadData);
      } catch (e) {
        console.error('Could not refresh display:', e);
      }
    } else {
      console.error('❌ Save failed:', resData);
      alert('❌ Failed to save: ' + (resData.error || 'Unknown error'));
    }
    
  } catch (e) {
    console.error('❌ Exception during save:', e);
    alert('❌ Error: ' + e.message);
  }
}
