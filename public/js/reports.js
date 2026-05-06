/* ============================================================
   public/js/reports.js — Reports Module Logic
   ============================================================ */

let cachedPayslips = null;
let cachedAttendance = null;
let currentReportData = null; // Stores fully processed data synchronously

document.addEventListener('DOMContentLoaded', () => {
  const today = new Date().toISOString().split('T')[0];
  const dateFrom = document.getElementById('report-date-from');
  const dateTo = document.getElementById('report-date-to');
  
  if (dateFrom && dateTo) {
    const firstDay = new Date();
    firstDay.setDate(1);
    dateFrom.value = firstDay.toISOString().split('T')[0];
    dateTo.value = today;
  }

  setTimeout(() => {
    loadReportDependencies();
    setupFilterListeners();
  }, 1000);
});

const observeReports = new MutationObserver((mutations) => {
  for (let m of mutations) {
    if (m.target.id === 'page-reports' && m.target.classList.contains('active')) {
      const dateFrom = document.getElementById('report-date-from');
      const dateTo = document.getElementById('report-date-to');
      if (dateFrom && dateTo && !dateFrom.value) {
        const d = new Date();
        d.setDate(1);
        dateFrom.value = d.toISOString().split('T')[0];
        dateTo.value = new Date().toISOString().split('T')[0];
      }
      
      // Invalidate cache when navigating back to reports
      cachedPayslips = null;
      cachedAttendance = null;
      
      loadReportDependencies();
      setupFilterListeners();
    }
  }
});
const reportsPage = document.getElementById('page-reports');
if (reportsPage) observeReports.observe(reportsPage, { attributes: true, attributeFilter: ['class'] });

async function loadReportDependencies() {
  const empSelect = document.getElementById('report-employee');
  const periodSelect = document.getElementById('report-payroll-period');

  try {
    if (empSelect && empSelect.dataset.loaded !== 'true') {
      const res = await apiFetch('/api/employees');
      if (res && res.ok) {
        const employees = await res.json();
        let html = '<option value="all">All Employees</option>';
        employees.forEach(emp => {
          const role = emp.position || 'Employee';
          const dept = emp.department || 'No Dept';
          html += `<option value="${emp.id}">${emp.employee_code || emp.id} - ${emp.first_name} ${emp.last_name} (${role} | ${dept})</option>`;
        });
        empSelect.innerHTML = html;
        empSelect.dataset.loaded = 'true';
      }
    }

    if (periodSelect && periodSelect.dataset.loaded !== 'true') {
      const res2 = await apiFetch('/api/payroll/runs');
      if (res2 && res2.ok) {
        const runs = await res2.json();
        let html = '<option value="all">All Periods (Use Date Range)</option>';
        runs.forEach(run => {
          const start = run.start_date ? run.start_date.split('T')[0] : '';
          const end = run.end_date ? run.end_date.split('T')[0] : '';
          html += `<option value="${run.id}">${run.month_year || 'Run ' + run.id} (${start} to ${end})</option>`;
        });
        periodSelect.innerHTML = html;
        periodSelect.dataset.loaded = 'true';
      }
    }
    
    // Initial validation
    validateReportState();
  } catch (err) {
    console.error('Failed to load dependencies for reports', err);
  }
}

function setupFilterListeners() {
  const filters = ['report-date-from', 'report-date-to', 'report-employee', 'report-payroll-period', 'report-format'];
  filters.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      // Remove previous listener to avoid duplicates
      el.removeEventListener('change', validateReportState);
      el.addEventListener('change', validateReportState);
    }
  });
}

function formatMoney(num) {
  const val = parseFloat(num) || 0;
  return '₱' + val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Master Report Data Aggregation
async function fetchMasterReportData() {
  const empId = document.getElementById('report-employee').value;
  const periodId = document.getElementById('report-payroll-period').value;
  const dateFrom = new Date(document.getElementById('report-date-from').value);
  const dateTo = new Date(document.getElementById('report-date-to').value);
  
  try {
    if (!cachedPayslips) {
      const pRes = await apiFetch('/api/payroll/payslips');
      if (pRes && pRes.ok) cachedPayslips = await pRes.json();
      else cachedPayslips = [];
    }
    
    if (!cachedAttendance) {
      const aRes = await apiFetch('/api/attendance');
      if (aRes && aRes.ok) cachedAttendance = await aRes.json();
      else cachedAttendance = [];
    }
  } catch(e) {
    console.error("Error fetching report data", e);
    return null;
  }

  // Filter payslips
  let filteredPayslips = cachedPayslips.filter(row => {
    if (empId !== 'all' && row.employee_id != empId) return false;
    
    if (periodId !== 'all' && row.payroll_run_id !== undefined) {
      if (row.payroll_run_id != periodId) return false;
      return true;
    }

    let rowDate = new Date(row.period_end || row.created_at || row.generated_at);
    if (!isNaN(rowDate) && !isNaN(dateFrom) && !isNaN(dateTo)) {
      if (rowDate < dateFrom || rowDate > dateTo) return false;
    }
    return true;
  });

  // Filter attendance
  let filteredAttendance = cachedAttendance.filter(row => {
    if (empId !== 'all' && row.employee_id != empId) return false;
    let rowDate = new Date(row.date);
    if (!isNaN(rowDate) && !isNaN(dateFrom) && !isNaN(dateTo)) {
      if (rowDate < dateFrom || rowDate > dateTo) return false;
    }
    return true;
  });

  let rows = [];
  let empDataMap = {};

  const empSelect = document.getElementById('report-employee');
  if (empSelect && empSelect.options) {
    for (let option of empSelect.options) {
      if (option.value === 'all') continue;
      
      if (empId === 'all' || option.value === empId) {
         let textParts = option.text.split(' (')[0];
         let cleanName = textParts.includes(' - ') ? textParts.split(' - ')[1] : textParts;
         empDataMap[option.value] = { name: cleanName, days: 0, payslips: [] };
      }
    }
  }

  filteredAttendance.forEach(a => {
    if (!empDataMap[a.employee_id]) {
      empDataMap[a.employee_id] = { name: a.employee_name || 'Unknown', days: 0, payslips: [] };
    }
    empDataMap[a.employee_id].days += 1;
  });

  filteredPayslips.forEach(ps => {
    if (!empDataMap[ps.employee_id]) {
      empDataMap[ps.employee_id] = { name: ps.employee_name || 'Unknown', days: 0, payslips: [] };
    }
    empDataMap[ps.employee_id].payslips.push(ps);
  });

  Object.keys(empDataMap).forEach(eId => {
    const data = empDataMap[eId];
    
    if (data.payslips.length > 0) {
      data.payslips.forEach(ps => {
        const periodStr = (ps.period_start ? ps.period_start.split('T')[0] : 'N/A') + ' to ' + (ps.period_end ? ps.period_end.split('T')[0] : 'N/A');
        rows.push([
          data.name,
          periodStr,
          data.days + ' Days',
          formatMoney(ps.total_earning),
          formatMoney(ps.total_deduction),
          formatMoney(ps.net_pay)
        ]);
      });
    } else {
      // Show everyone explicitly
      const periodStr = dateFrom.toISOString().split('T')[0] + ' to ' + dateTo.toISOString().split('T')[0];
      rows.push([
        data.name,
        periodStr,
        data.days + ' Days',
        '₱0.00', '₱0.00', '₱0.00'
      ]);
    }
  });

  const title = "Comprehensive Master Report";
  const headers = ["Employee Name", "Report Period", "Attendance Logged", "Gross Earnings", "Taxes & Deductions", "Net Pay"];

  return { title, headers, rows };
}

async function validateReportState() {
  const downloadBtns = document.querySelectorAll('button[onclick="generateMasterReport()"]');
  const formatEl = document.getElementById('report-format');
  if (!formatEl) return;
  
  const format = formatEl.value;
  const formatName = format === 'pdf' ? 'PDF Document' : format === 'excel' ? 'Excel File' : 'CSV File';
  
  const data = await fetchMasterReportData();
  currentReportData = data; // Store globally for synchronous access
  
  const hasData = data && data.rows && data.rows.length > 0;
  
  downloadBtns.forEach(btn => {
    btn.textContent = `Download ${formatName}`;
    btn.disabled = !hasData;
    if (!hasData) {
      btn.style.opacity = '0.5';
      btn.style.cursor = 'not-allowed';
      btn.title = 'No data available to generate a report.';
    } else {
      btn.style.opacity = '1';
      btn.style.cursor = 'pointer';
      btn.title = `Click to download the report as ${formatName}`;
    }
  });
}

function generateMasterReport() {
  try {
    const format = document.getElementById('report-format').value;
    const data = currentReportData; // Retrieved synchronously!
    
    if (!data || data.rows.length === 0) {
      alert("No data available for the selected filters. Please wait or try a different date range.");
      return;
    }

    const filename = `master_report_${new Date().toISOString().split('T')[0]}`;

    if (format === 'csv') {
      exportCSV(data, filename);
    } else if (format === 'excel') {
      exportExcel(data, filename);
    } else if (format === 'pdf') {
      exportPDF(data, filename);
    }
  } catch (err) {
    console.error("Error generating master report:", err);
    alert("An error occurred while generating the report. Please check the console.");
  }
}

async function previewMasterReport() {
  try {
    const modal = document.getElementById('reportPreviewModal');
    const titleEl = document.getElementById('previewModalTitle');
    const tableHead = document.getElementById('previewTableHead');
    const tableBody = document.getElementById('previewTableBody');
    
    if (!modal) {
      alert("Modal element not found in DOM.");
      return;
    }

    const data = await fetchMasterReportData();
    if (!data || data.rows.length === 0) {
      alert("No data found for the selected filters.");
      return;
    }

    titleEl.textContent = data.title;

    let thead = `<tr>${data.headers.map(h => `<th style="padding:12px 14px; color:#6c757d; font-weight:700; font-size:12px; text-transform:uppercase; border-bottom:2px solid var(--border);">${h}</th>`).join('')}</tr>`;
    let tbody = data.rows.map(row => `<tr style="transition: background 0.2s;" onmouseover="this.style.background='var(--bg)'" onmouseout="this.style.background='none'">${row.map(cell => `<td style="padding:12px 14px; border-bottom:1px solid var(--border); color:var(--text);">${cell}</td>`).join('')}</tr>`).join('');

    tableHead.innerHTML = thead;
    tableBody.innerHTML = tbody;
    modal.style.display = 'flex';
  } catch (err) {
    console.error("Error previewing master report:", err);
    alert("An error occurred while building the preview. Please check the console.");
  }
}

// Robust Backend Download Submitter
function submitSecureDownload(base64Data, filename, format) {
  let form = document.getElementById('secureDownloadForm');
  if (!form) {
    form = document.createElement('form');
    form.id = 'secureDownloadForm';
    form.method = 'POST';
    form.action = '/api/reports/download';
    form.style.display = 'none';

    const inputData = document.createElement('input');
    inputData.type = 'hidden';
    inputData.name = 'filedata';
    inputData.id = 'secureDownloadData';

    const inputName = document.createElement('input');
    inputName.type = 'hidden';
    inputName.name = 'filename';
    inputName.id = 'secureDownloadName';

    const inputFormat = document.createElement('input');
    inputFormat.type = 'hidden';
    inputFormat.name = 'format';
    inputFormat.id = 'secureDownloadFormat';

    const inputToken = document.createElement('input');
    inputToken.type = 'hidden';
    inputToken.name = 'token';
    inputToken.id = 'secureDownloadToken';

    form.appendChild(inputData);
    form.appendChild(inputName);
    form.appendChild(inputFormat);
    form.appendChild(inputToken);
    document.body.appendChild(form);
  }

  document.getElementById('secureDownloadData').value = base64Data;
  document.getElementById('secureDownloadName').value = filename;
  document.getElementById('secureDownloadFormat').value = format;
  document.getElementById('secureDownloadToken').value = getToken();
  
  form.submit();
}

// Format Exporters
function exportCSV(data, filename) {
  let csvContent = "\uFEFF" + data.headers.join(",") + "\n";
  data.rows.forEach(row => {
    let rowStr = row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",");
    csvContent += rowStr + "\n";
  });

  // Base64 encode the string safely for transport
  const base64Data = btoa(unescape(encodeURIComponent(csvContent)));
  submitSecureDownload(base64Data, filename, 'csv');
}

function exportExcel(data, filename) {
  if (typeof XLSX === 'undefined') {
    alert("Excel library not loaded.");
    return;
  }
  const worksheet = XLSX.utils.aoa_to_sheet([data.headers, ...data.rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Master Report");
  
  // Natively output Base64 string from SheetJS
  const base64Data = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });
  submitSecureDownload(base64Data, filename, 'excel');
}

function exportPDF(data, filename) {
  if (typeof window.jspdf === 'undefined') {
    alert("PDF library not loaded.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF('landscape');
  
  doc.setFontSize(16);
  doc.text(data.title, 14, 15);
  doc.setFontSize(10);
  doc.text(`Generated on: ${new Date().toLocaleDateString()}`, 14, 22);

  doc.autoTable({
    startY: 28,
    head: [data.headers],
    body: data.rows,
    theme: 'grid',
    styles: { fontSize: 10 },
    headStyles: { fillColor: [79, 124, 255] } 
  });

  // Output as Data URI string, then strip the prefix to get pure base64
  const dataUri = doc.output('datauristring');
  const base64Data = dataUri.split(',')[1];
  submitSecureDownload(base64Data, filename, 'pdf');
}

function closeReportPreview() {
  const modal = document.getElementById('reportPreviewModal');
  if (modal) modal.style.display = 'none';
}

// Expose functions to window
window.generateMasterReport = generateMasterReport;
window.previewMasterReport = previewMasterReport;
window.closeReportPreview = closeReportPreview;
window.validateReportState = validateReportState;
