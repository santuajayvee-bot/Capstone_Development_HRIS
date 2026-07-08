/* ============================================================
   public/js/onboarding.js — Industrial Onboarding (Secure-by-Design)
   ============================================================ */

let currentStep = 1;
const totalSteps = 3; 

// ── TAB MANAGEMENT ──────────────────────────────────────────

function switchIndustrialTab(tabId) {
  const buttons = document.querySelectorAll('.tab-btn');
  buttons.forEach(btn => btn.classList.remove('active'));
  
  const activeBtn = Array.from(buttons).find(btn => btn.innerText.toLowerCase().includes(tabId === 'workflows' ? 'tasks' : tabId.slice(0,3)));
  if (activeBtn) activeBtn.classList.add('active');

  const contents = document.querySelectorAll('.onb-tab-content');
  contents.forEach(content => content.style.display = 'none');
  
  const activeContent = document.getElementById(`onb-tab-${tabId}`);
  if (activeContent) activeContent.style.display = 'block';

  loadIndustrialData(tabId);
}

function loadIndustrialData(tabId) {
  switch(tabId) {
    case 'list': fetchOnboardingEmployees(); fetchIndustrialStats(); break;
    case 'workflows': fetchOnboardingTasks(); break;
    case 'safety': fetchSafetyTests(); break;
    case 'vault': fetchVaultDocuments(); break;
  }
}

async function fetchIndustrialStats() {
  try {
    const res = await apiFetch('/api/onboarding/dashboard');
    if (res && res.ok) {
      const data = await res.json();
      document.getElementById('stat-active-hires').textContent = data.newHires;
      document.getElementById('stat-biometric-rate').textContent = (data.biometricRate || 0) + '%';
      document.getElementById('stat-wage-ready').textContent = (data.wageReadyRate || 0) + '%';
      document.getElementById('stat-blockchain-hashes').textContent = data.hashes || 0;
    }
  } catch (err) { console.error(err); }
}

// ── WIZARD NAVIGATION ──────────────────────────────────────────

function openOnboardingWizard() {
  currentStep = 1;
  const form = document.getElementById('onboarding-form');
  if (form) form.reset();
  
  injectWizardSteps();
  updateStepUI();
  document.getElementById('onb-wizard-modal').style.display = 'flex';
}

function injectWizardSteps() {
  const form = document.getElementById('onboarding-form');
  if (!form) return;
  
  form.innerHTML = `
    <!-- STEP 1: COMPREHENSIVE DATA ENTRY -->
    <div class="wizard-step active" id="step-1">
      <h3 style="font-size:14px; color:#4f7cff; border-bottom:1px solid var(--border); padding-bottom:8px; margin-bottom:16px;">1. Personal Information</h3>
      <div class="form-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom:24px;">
        <div class="form-group"><label>First Name</label><input type="text" name="first_name" required></div>
        <div class="form-group"><label>Last Name</label><input type="text" name="last_name" required></div>
        <div class="form-group"><label>Date of Birth</label><input type="date" name="dob" required></div>
        <div class="form-group"><label>Gender</label><select name="gender" required><option value="Male">Male</option><option value="Female">Female</option></select></div>
        <div class="form-group"><label>Marital Status</label><select name="marital_status" required><option value="Single">Single</option><option value="Married">Married</option></select></div>
        <div class="form-group"><label>Blood Type</label>
          <select name="blood_type" required>
            <option value="">Select Blood Type</option>
            <option value="A+">A+</option><option value="A-">A-</option>
            <option value="B+">B+</option><option value="B-">B-</option>
            <option value="O+">O+</option><option value="O-">O-</option>
            <option value="AB+">AB+</option><option value="AB-">AB-</option>
          </select>
        </div>
      </div>

      <h3 style="font-size:14px; color:#4f7cff; border-bottom:1px solid var(--border); padding-bottom:8px; margin-bottom:16px;">2. Contact & Address</h3>
      <div class="form-group" style="margin-bottom:15px;"><label>Residential Address</label><textarea name="address" rows="2" required></textarea></div>
      <div class="form-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom:24px;">
        <div class="form-group"><label>Mobile (+63)</label><input type="text" name="mobile" placeholder="+63 9XX XXX XXXX" required></div>
        <div class="form-group"><label>Emergency Contact</label><input type="text" name="emergency_name" required></div>
      </div>

      <h3 style="font-size:14px; color:#4f7cff; border-bottom:1px solid var(--border); padding-bottom:8px; margin-bottom:16px;">3. Employment Details</h3>
      <div class="form-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin-bottom:24px;">
        <div class="form-group"><label>Branch</label><select name="branch" required><option value="Marilao">Marilao</option><option value="Manila">Manila</option></select></div>
        <div class="form-group"><label>Category</label><select name="category" required><option value="Regular">Regular</option><option value="Agency">Agency</option></select></div>
        <div class="form-group"><label>Position</label><select name="position" required><option value="Machine Operator">Machine Operator</option><option value="Driver">Driver</option><option value="Office Staff">Office Staff</option></select></div>
        <div class="form-group"><label>Wage Structure</label><select name="wage_structure" required><option value="Fixed">Fixed</option><option value="Hourly">Hourly</option><option value="Piece-Rate">Piece-Rate</option><option value="Per-Trip">Per-Trip</option></select></div>
      </div>

      <h3 style="font-size:14px; color:#4f7cff; border-bottom:1px solid var(--border); padding-bottom:8px; margin-bottom:16px;">4. Statutory IDs (Encrypted)</h3>
      <div class="form-grid" style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
        <div class="form-group"><label>TIN</label><input type="text" name="tin" required></div>
        <div class="form-group"><label>SSS</label><input type="text" name="sss" required></div>
        <div class="form-group"><label>PhilHealth</label><input type="text" name="philhealth" required></div>
        <div class="form-group"><label>Pag-IBIG</label><input type="text" name="pagibig" required></div>
      </div>
    </div>

    <!-- STEP 2: REVIEW & CONSENT -->
    <div class="wizard-step" id="step-2">
      <h2 style="font-size:18px; margin-bottom:16px;">Final Review</h2>
      <div id="onboarding-review-content" style="background:var(--bg); padding:20px; border:1px solid var(--border); border-radius:12px; margin-bottom:24px;"></div>
      
      <div style="background:#10b98111; border:1px solid #10b98133; padding:16px; border-radius:8px;">
        <label style="display:flex; gap:12px; cursor:pointer; align-items:flex-start;">
          <input type="checkbox" name="data_consent" required style="margin-top:4px;">
          <span style="font-size:12px; line-height:1.4;">I confirm that I have obtained written consent from the employee for the processing of their Personal Identifiable Information (PII) in accordance with the Data Privacy Act of 2012 (RA 10173).</span>
        </label>
      </div>
    </div>

    <!-- STEP 3: SUCCESS -->
    <div class="wizard-step" id="step-3" style="text-align:center; padding:40px 20px;">
       <div id="onb-final-processing">
          <div class="spinner" style="margin:0 auto 20px;"></div>
          <p style="font-size:14px; font-weight:600;">Securing Data & Generating ID...</p>
       </div>
       <div id="onb-final-success" style="display:none;">
          <div style="font-size:50px; color:#10b981; margin-bottom:20px;">✅</div>
          <h3 style="font-size:20px; margin-bottom:10px;">Onboarding Successful!</h3>
          <p style="font-size:14px; color:var(--muted); margin-bottom:30px;">New Employee ID: <strong id="new-emp-id" style="color:var(--text); font-size:18px;">EMP-XXXX</strong></p>
          <div style="display:flex; gap:12px; justify-content:center;">
            <button type="button" class="btn btn-primary" onclick="printOrientationPacket()">🖨️ Print Orientation Summary</button>
            <button type="button" class="btn btn-secondary" onclick="closeOnboardingWizard()">Close Window</button>
          </div>
       </div>
    </div>
  `;
}

function updateStepUI() {
  document.querySelectorAll('.wizard-step').forEach(step => step.classList.remove('active'));
  const targetStep = document.getElementById(`step-${currentStep}`);
  if (targetStep) targetStep.classList.add('active');

  document.querySelectorAll('.step-indicator').forEach(ind => {
    const step = parseInt(ind.dataset.step);
    ind.classList.remove('active', 'completed');
    if (step === currentStep) ind.classList.add('active');
    else if (step < currentStep) ind.classList.add('completed');
  });

  const line1 = document.getElementById('line-1');
  const line2 = document.getElementById('line-2');
  if (line1) line1.classList.toggle('active', currentStep > 1);
  if (line2) line2.classList.toggle('active', currentStep > 2);

  const nextBtn = document.getElementById('next-step');
  const prevBtn = document.getElementById('prev-step');
  
  prevBtn.style.visibility = (currentStep === 1 || currentStep === 3) ? 'hidden' : 'visible';
  
  if (currentStep === 2) {
    nextBtn.textContent = "Save & Finalize";
    nextBtn.style.background = "#10b981";
  } else if (currentStep === 3) {
    nextBtn.style.display = "none";
  } else {
    nextBtn.textContent = "Review & Next";
    nextBtn.style.background = "#4f7cff";
    nextBtn.style.display = "block";
  }
}

function moveStep(delta) {
  if (delta === 1 && !validateCurrentStep()) return;
  currentStep += delta;
  updateStepUI();
  if (currentStep === 2) prepareReview();
  if (currentStep === 3) submitOnboarding();
}

function validateCurrentStep() {
  const activeStep = document.getElementById(`step-${currentStep}`);
  if (!activeStep) return true;
  if (window.LGSVValidation && !window.LGSVValidation.validateScope(activeStep)) return false;
  const inputs = activeStep.querySelectorAll('input[required], select[required], textarea[required]');
  for (let input of inputs) {
    if (input.type === 'checkbox' && !input.checked) { alert("Please check the consent box."); return false; }
    if (input.type !== 'checkbox' && !input.value.trim()) {
      input.style.borderColor = "#ef4444";
      alert(`${input.closest('.form-group')?.querySelector('label')?.textContent || 'This field'} is required.`);
      return false;
    }
  }
  return true;
}

function prepareReview() {
  const form = document.getElementById('onboarding-form');
  const fd = new FormData(form);
  const reviewEl = document.getElementById('onboarding-review-content');
  let html = '<div style="display:grid; grid-template-columns:1fr 1fr; gap:15px;">';
  const fields = ['first_name', 'last_name', 'branch', 'position', 'wage_structure'];
  fields.forEach(f => {
    html += `<div><strong style="color:var(--muted); font-size:11px; text-transform:uppercase;">${f.replace('_', ' ')}:</strong><br><span style="font-size:14px; font-weight:600;">${fd.get(f) || 'N/A'}</span></div>`;
  });
  html += '</div>';
  reviewEl.innerHTML = html;
}

async function submitOnboarding() {
  const form = document.getElementById('onboarding-form');
  const fd = new FormData(form);
  const data = {};
  fd.forEach((v, k) => data[k] = v);

  try {
    const res = await apiFetch('/api/onboarding/register', {
      method: 'POST',
      body: JSON.stringify(data)
    });

    if (res && res.ok) {
      const result = await res.json();
      document.getElementById('onb-final-processing').style.display = 'none';
      document.getElementById('onb-final-success').style.display = 'block';
      document.getElementById('new-emp-id').textContent = result.employee_code;
    } else {
      alert("Save failed.");
      moveStep(-1);
    }
  } catch (err) { console.error(err); moveStep(-1); }
}

// ── PRE-ENROLLMENT VERIFICATION ─────────────────────────────

let currentVerificationEmp = null;

async function openVerificationModal(empId) {
  currentVerificationEmp = empId;
  const res = await apiFetch('/api/onboarding/employees');
  const employees = await res.json();
  const emp = employees.find(e => e.id === empId);
  if (!emp) return;

  document.getElementById('verify-emp-id').value = empId;
  document.getElementById('verify-emp-info').innerHTML = `
    <div style="font-weight:700;">${emp.first_name} ${emp.last_name}</div>
    <div style="font-size:12px; color:var(--muted);">${emp.position} • ${emp.branch}</div>
  `;

  // Dynamic Checklist based on Position
  const checklist = document.getElementById('trade-test-checklist');
  let tasks = [];
  if (emp.position === 'Machine Operator') {
    tasks = ['Sewing Machine Safety Check', 'Material Handling Proficiency', 'Stitch Consistency Test'];
  } else if (emp.position === 'Driver') {
    tasks = ['Vehicle Inspection Test', 'Logistics Route Knowledge', 'Cargo Securing Skills'];
  } else {
    tasks = ['Office Policy Briefing', 'System Access Test', 'Workflow Understanding'];
  }

  checklist.innerHTML = tasks.map(t => `
    <label style="display:flex; gap:12px; margin-bottom:8px; align-items:center;">
      <input type="checkbox" required>
      <span style="font-size:12px;">${t}</span>
    </label>
  `).join('');

  document.getElementById('onb-verify-modal').style.display = 'flex';
}

function closeVerifyModal() {
  document.getElementById('onb-verify-modal').style.display = 'none';
}

async function saveVerification() {
  const form = document.getElementById('verify-form');
  const fd = new FormData(form);
  const data = {};
  fd.forEach((v, k) => data[k] = v);

  // Validate checklist
  const checks = document.querySelectorAll('#trade-test-checklist input[type="checkbox"]');
  const allChecked = Array.from(checks).every(c => c.checked);
  if (!allChecked) { alert("All physical skill assessment tasks must be checked."); return; }

  try {
    const res = await apiFetch(`/api/onboarding/verify/${data.emp_id}`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
    if (res && res.ok) {
      alert("Verification Benchmark Saved!");
      closeVerifyModal();
      fetchOnboardingEmployees();
    } else {
      alert("Failed to save verification.");
    }
  } catch (err) { console.error(err); }
}

async function fetchOnboardingEmployees() {
  const listEl = document.getElementById('onboarding-employee-list');
  if (!listEl) return;
  try {
    const res = await apiFetch('/api/onboarding/employees');
    if (res && res.ok) {
      const employees = await res.json();
      listEl.innerHTML = employees.map(emp => {
        const canFinalize = emp.trade_test_status === 'passed' && emp.orientation_status === 'completed';
        
        return `
        <tr style="border-bottom:1px solid var(--border);">
          <td style="padding:16px; font-size:13px; font-weight:700; color:#4f7cff;">${emp.employee_code}</td>
          <td style="padding:16px; font-size:13px; font-weight:600;">${emp.first_name} ${emp.last_name}</td>
          <td style="padding:16px;">
            <div style="font-size:10px; font-weight:700; color:${emp.trade_test_status === 'passed' ? '#10b981' : '#f59e0b'};">
              TRADE: ${emp.trade_test_status.toUpperCase()}
            </div>
            <div style="font-size:10px; font-weight:700; color:${emp.orientation_status === 'completed' ? '#10b981' : '#f59e0b'};">
              OSH: ${emp.orientation_status.toUpperCase()}
            </div>
          </td>
          <td style="padding:16px;">
            <button class="btn btn-secondary" style="font-size:10px; padding:4px 8px;" onclick="openVerificationModal(${emp.id})">🛡️ Verify Skills</button>
          </td>
          <td style="padding:16px;">
            <span style="font-size:10px; padding:2px 8px; border-radius:10px; background:#4f7cff22; color:#4f7cff; font-weight:700;">NEWLY HIRED</span>
          </td>
          <td style="padding:16px;">
            <button class="btn btn-primary" style="font-size:10px; padding:6px 12px; opacity:${canFinalize ? 1 : 0.4};" 
                    ${canFinalize ? '' : 'disabled'}
                    onclick="finalizeEnrollment(${emp.id})">Finalize Hiring</button>
          </td>
        </tr>
      `; }).join('');
    }
  } catch (err) { console.error(err); }
}

async function finalizeEnrollment(empId) {
  const confirmed = typeof showConfirm === 'function'
    ? await showConfirm('Finalize enrollment? This will anchor the wage structure to the blockchain.', 'Finalize Hiring', 'Finalize', 'Cancel')
    : confirm('Finalize enrollment? This will anchor the wage structure to the blockchain.');
  if (!confirmed) return;
  try {
    const res = await apiFetch(`/api/onboarding/finalize/${empId}`, { method: 'POST' });
    if (res && res.ok) {
      alert("Hiring Finalized! Worker moved to main workforce list.");
      fetchOnboardingEmployees();
      fetchIndustrialStats();
    }
  } catch (err) { alert("Cannot finalize. Check if orientation and trade tests are complete."); }
}

// ── DUMMY DATA FOR TASKS ───────────────────────────────────

function fetchOnboardingTasks() {
  const el = document.getElementById('onboarding-tasks-list');
  if (!el) return;
  el.innerHTML = '<div class="onb-card">Monitoring physical benchmarks for all new recruits...</div>';
}
function fetchSafetyTests() { /* Same as above */ }
function fetchVaultDocuments() { /* Same as above */ }
function printOrientationPacket() { window.print(); }
function closeOnboardingWizard() { document.getElementById('onb-wizard-modal').style.display = 'none'; fetchOnboardingEmployees(); }

// Global scope
window.switchIndustrialTab = switchIndustrialTab;
window.openOnboardingWizard = openOnboardingWizard;
window.closeOnboardingWizard = closeOnboardingWizard;
window.moveStep = moveStep;
window.finalizeEnrollment = finalizeEnrollment;
window.filterOnboardingList = filterOnboardingList;
window.printOrientationPacket = printOrientationPacket;
window.openVerificationModal = openVerificationModal;
window.closeVerifyModal = closeVerifyModal;
window.saveVerification = saveVerification;
