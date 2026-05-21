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
  const periodId = document.getElementById('report-payroll-period').value;
  let url = `/api/payroll/reports/financial-summary?payrollRunId=${periodId}`;
  try {
    const res = await apiFetch(url);
    if (!res || !res.ok) {
      if (res && res.status === 403) alert("Access Denied to View Payroll Data");
      return [];
    }
    let data = await res.json();
    if (!Array.isArray(data)) return [];

    const empId = document.getElementById('report-employee').value;
    if (empId && empId !== 'all') {
      data = data.filter(r => r.employee_id == empId || r.id == empId || r.employee_code == empId);
    }
    return data;
  } catch (err) {
    console.error("Error fetching report data", err);
    return [];
  }
}

async function validateReportState() {
  const downloadBtns = document.querySelectorAll('button[onclick="generateMasterReport()"]');
  const formatEl = document.getElementById('report-format');
  if (!formatEl) return;
  
  const format = formatEl.value;
  const formatName = format === 'pdf' ? 'PDF Document' : format === 'excel' ? 'Excel File' : 'CSV File';
  
  const data = await fetchMasterReportData();
  currentReportData = data;
  
  const hasData = data && data.length > 0;
  
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
    const data = currentReportData; 
    
    if (!data || data.length === 0) {
      alert("No data available for the selected filters.");
      return;
    }

    const empId = document.getElementById('report-employee').value;
    if (empId !== 'all' && data.length === 1) {
      currentIndividualData = data[0];
      if (format === 'csv') exportIndividualCSV();
      else if (format === 'excel') exportIndividualExcel();
      else if (format === 'pdf') exportIndividualPDF();
      return;
    }

    const filename = `master_report_${new Date().toISOString().split('T')[0]}`;
    if (format === 'csv') exportCSV(data, filename);
    else if (format === 'excel') exportExcel(data, filename);
    else if (format === 'pdf') exportOfficialPDF(data, filename);
  } catch (err) {
    console.error("Error generating master report:", err);
  }
}

async function previewMasterReport() {
  try {
    const data = await fetchMasterReportData();
    if (!data || data.length === 0) {
      alert("No data found for the selected filters.");
      return;
    }

    const empId = document.getElementById('report-employee').value;
    
    if (empId !== 'all' && data.length === 1) {
      // Individual Bond Paper Mode
      const user = getUser();
      if (user && user.role !== 'payroll_manager' && user.role !== 'admin' && user.role !== 'hr_admin' && user.role !== 'system_admin') {
        alert("Access Denied: Detailed individual view is restricted to Access Level 3 (Payroll Manager) or higher.");
        return;
      }
      currentIndividualData = data[0];
      renderIndividualBondPaper(data[0]);
      const modal = document.getElementById('individualPreviewModal');
      if(modal) modal.style.display = 'flex';
      return;
    }

    // Otherwise, All Employees Mode
    const modal = document.getElementById('reportPreviewModal');
    const titleEl = document.getElementById('previewModalTitle');
    const tableHead = document.getElementById('previewTableHead');
    const tableBody = document.getElementById('previewTableBody');
    
    if (!modal) return;

    titleEl.textContent = "Preview: Master Report";

    const headers = ["Employee", "Wage Type", "Calculation Details", "Gross", "Deductions (SSS/PH/PI)", "Net Pay"];
    let thead = `<tr>${headers.map(h => `<th style="padding:12px 14px; color:#6c757d; font-weight:700; font-size:12px; text-transform:uppercase; border-bottom:2px solid var(--border);">${h}</th>`).join('')}</tr>`;
    
    let tbody = data.map(row => {
      const deds = row.deductions_breakdown || [];
      const sss = deds.find(d => d.deduction_type === 'SSS')?.amount || 0;
      const ph = deds.find(d => d.deduction_type === 'PhilHealth')?.amount || 0;
      const pi = deds.find(d => d.deduction_type === 'Pag-IBIG')?.amount || 0;
      const totalDeds = sss + ph + pi;

      return `
        <tr style="transition: background 0.2s;" onmouseover="this.style.background='var(--bg)'" onmouseout="this.style.background='none'">
          <td style="padding:12px 14px; border-bottom:1px solid var(--border); font-weight:600;">${row.first_name} ${row.last_name}<br><small style="color:#6c757d;">${row.employee_code}</small></td>
          <td style="padding:12px 14px; border-bottom:1px solid var(--border);">${row.wage_type_name}</td>
          <td style="padding:12px 14px; border-bottom:1px solid var(--border); font-size:11px;">${(row.calculations || []).join('<br>')}</td>
          <td style="padding:12px 14px; border-bottom:1px solid var(--border);">${formatMoney(row.total_earning)}</td>
          <td style="padding:12px 14px; border-bottom:1px solid var(--border);">${formatMoney(totalDeds)}</td>
          <td style="padding:12px 14px; border-bottom:1px solid var(--border); color:var(--primary); font-weight:700;">${formatMoney(row.net_pay)}</td>
        </tr>
      `;
    }).join('');

    tableHead.innerHTML = thead;
    tableBody.innerHTML = tbody;
    modal.style.display = 'flex';
  } catch (err) {
    console.error("Error previewing master report:", err);
    alert("An error occurred while previewing the report.");
  }
}

async function downloadOfficialLayout() {
  const periodId = document.getElementById('report-payroll-period').value;
  if (periodId === 'all') {
    alert("Please select a specific Payroll Period to Generate the Official Report.");
    return;
  }

  const data = currentReportData;
  if (!data || data.length === 0) {
    alert("No data available to download.");
    return;
  }

  const filename = `Official_Report_${new Date().toISOString().split('T')[0]}`;
  exportOfficialPDF(data, filename);
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

function exportOfficialPDF(data, filename) {
  if (typeof window.jspdf === 'undefined') {
    alert("PDF library not loaded.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF('portrait', 'in', [8.5, 11]); // Short Bond Paper Layout

  let periodText = 'All Periods';
  const periodEl = document.getElementById('report-payroll-period');
  if (periodEl && periodEl.selectedIndex >= 0) {
    periodText = periodEl.options[periodEl.selectedIndex].text;
  }

  // Header
  doc.setFontSize(16);
  doc.setFont("helvetica", "bold");
  doc.text("MARULAS INDUSTRIAL CORPORATION", 4.25, 0.75, { align: "center" });
  doc.setFontSize(12);
  doc.text(`Official Master Report`, 4.25, 1.0, { align: "center" });
  doc.setFontSize(10);
  doc.setFont("helvetica", "normal");
  doc.text(`Payroll Period: ${periodText}`, 4.25, 1.25, { align: "center" });
  doc.text(`Generated on: ${new Date().toLocaleString()}`, 4.25, 1.45, { align: "center" });

  // Table Data
  const headers = [["Employee ID & Name", "Wage Type", "Calculation Details", "Gross", "Deductions", "Net Pay"]];
  const rows = data.map(row => {
    const deds = row.deductions_breakdown || [];
    const sss = deds.find(d => d.deduction_type === 'SSS')?.amount || 0;
    const ph = deds.find(d => d.deduction_type === 'PhilHealth')?.amount || 0;
    const pi = deds.find(d => d.deduction_type === 'Pag-IBIG')?.amount || 0;
    const totalDeds = sss + ph + pi;

    return [
      `${row.employee_code}\n${row.first_name} ${row.last_name}`,
      row.wage_type_name,
      (row.calculations || []).join('\n'),
      formatMoney(row.total_earning),
      `SSS: ${formatMoney(sss)}\nPH: ${formatMoney(ph)}\nPI: ${formatMoney(pi)}`,
      formatMoney(row.net_pay)
    ];
  });

  doc.autoTable({
    startY: 1.75,
    head: headers,
    body: rows,
    theme: 'grid',
    styles: { fontSize: 8, font: "helvetica" },
    headStyles: { fillColor: [111, 66, 193] }
  });

  // Footer / Signatures
  const finalY = doc.lastAutoTable.finalY + 1.0;
  doc.setFontSize(10);
  doc.text("__________________________", 1.0, finalY);
  doc.text("PAYROLL MANAGER", 1.0, finalY + 0.2);
  doc.text("__________________________", 5.5, finalY);
  doc.text("PRESIDENT / EXECUTIVE", 5.5, finalY + 0.2);

  const base64Data = doc.output('datauristring').split(',')[1];
  submitSecureDownload(base64Data, filename, 'pdf');
}

function exportCSV(data, filename) {
  const headers = ["Employee Code", "Name", "Wage Type", "Gross Pay", "Deductions", "Net Pay"];
  let csvContent = "\uFEFF" + headers.join(",") + "\n";
  
  data.forEach(row => {
    const deds = (row.deductions_breakdown || []).map(d => `${d.deduction_type}:${d.amount}`).join("; ");
    const line = [
      row.employee_code,
      `${row.first_name} ${row.last_name}`,
      row.wage_type_name,
      row.total_earning,
      deds,
      row.net_pay
    ].map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(",");
    csvContent += line + "\n";
  });

  const base64Data = btoa(unescape(encodeURIComponent(csvContent)));
  submitSecureDownload(base64Data, filename, 'csv');
}

function exportExcel(data, filename) {
  if (typeof XLSX === 'undefined') {
    alert("Excel library not loaded.");
    return;
  }
  const headers = ["Employee Code", "Name", "Wage Type", "Calculation Detail", "Gross Pay", "SSS", "PhilHealth", "Pag-IBIG", "Net Pay"];
  const rows = data.map(row => {
    const deds = row.deductions_breakdown || [];
    return [
      row.employee_code,
      `${row.first_name} ${row.last_name}`,
      row.wage_type_name,
      (row.calculations || []).join(", "),
      row.total_earning,
      deds.find(d => d.deduction_type === 'SSS')?.amount || 0,
      deds.find(d => d.deduction_type === 'PhilHealth')?.amount || 0,
      deds.find(d => d.deduction_type === 'Pag-IBIG')?.amount || 0,
      row.net_pay
    ];
  });

  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Master Report");
  const base64Data = XLSX.write(workbook, { bookType: 'xlsx', type: 'base64' });
  submitSecureDownload(base64Data, filename, 'excel');
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
window.downloadOfficialLayout = downloadOfficialLayout;

/* =========================================
   Individual Master Summary Logic
   ========================================= */

let currentIndividualData = null;



function closeIndividualPreview() {
  document.getElementById('individualPreviewModal').style.display = 'none';
}

function renderIndividualBondPaper(row) {
  const container = document.getElementById('individualBondContent');
  const watermark = document.getElementById('bondWatermark');
  watermark.textContent = '';

  const deds = row.deductions_breakdown || [];
  const sss = deds.find(d => d.deduction_type === 'SSS')?.amount || 0;
  const ph = deds.find(d => d.deduction_type === 'PhilHealth')?.amount || 0;
  const pi = deds.find(d => d.deduction_type === 'Pag-IBIG')?.amount || 0;
  const totalDeds = sss + ph + pi;

  const isAgency = row.employee_code && row.employee_code.includes('AGN') ? 'Agency' : 'Regular';
  const jobPosition = row.wage_type_name === 'Piece-Rate' ? 'Production (Piece-Rate)' : 
                      row.wage_type_name === 'Logistics' ? 'Logistics / Transport' : 'Staff';

  const calculationsHTML = (row.calculations || []).map(c => `<div style="padding:2px 0;">${c}</div>`).join('');

  container.innerHTML = `
    <!-- Personnel Identity -->
    <div style="margin-bottom:20px; border:1px solid #ddd; padding:15px; border-radius:4px; font-family:sans-serif; background:white;">
      <h3 style="margin-top:0; border-bottom:1px solid #ddd; padding-bottom:5px; font-size:14px; color:#555; font-weight:bold;">PERSONNEL IDENTITY</h3>
      <table style="width:100%; font-size:12px; border-collapse:collapse;">
        <tr>
          <td style="width:120px; font-weight:bold; padding:4px 0;">Full Name:</td>
          <td style="padding:4px 0;">${row.first_name} ${row.last_name}</td>
          <td style="width:120px; font-weight:bold; padding:4px 0;">Employee ID:</td>
          <td style="padding:4px 0;">${row.employee_code}</td>
        </tr>
        <tr>
          <td style="font-weight:bold; padding:4px 0;">Employment Type:</td>
          <td style="padding:4px 0;">${isAgency}</td>
          <td style="font-weight:bold; padding:4px 0;">Job Position:</td>
          <td style="padding:4px 0;">${jobPosition}</td>
        </tr>
      </table>
    </div>

    <!-- Operational Floor Data -->
    <div style="margin-bottom:20px; border:1px solid #ddd; padding:15px; border-radius:4px; font-family:sans-serif; background:white;">
      <h3 style="margin-top:0; border-bottom:1px solid #ddd; padding-bottom:5px; font-size:14px; color:#555; font-weight:bold;">OPERATIONAL FLOOR DATA</h3>
      <div style="font-size:12px; font-family:'Courier New', Courier, monospace; background:#f9f9f9; padding:10px; border:1px solid #eee;">
        ${calculationsHTML || 'Fixed Salary Computation'}
      </div>
    </div>

    <!-- Deduction Breakdown -->
    <div style="margin-bottom:20px; border:1px solid #ddd; padding:15px; border-radius:4px; font-family:sans-serif; background:white;">
      <h3 style="margin-top:0; border-bottom:1px solid #ddd; padding-bottom:5px; font-size:14px; color:#555; font-weight:bold;">STATUTORY DEDUCTIONS</h3>
      <table style="width:100%; font-size:12px; border-collapse:collapse;">
        <tr>
          <td style="width:150px; padding:3px 0;">SSS Contribution:</td>
          <td style="font-family:'Courier New', Courier, monospace; padding:3px 0;">${formatMoney(sss)}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;">PhilHealth:</td>
          <td style="font-family:'Courier New', Courier, monospace; padding:3px 0;">${formatMoney(ph)}</td>
        </tr>
        <tr>
          <td style="padding:3px 0;">Pag-IBIG:</td>
          <td style="font-family:'Courier New', Courier, monospace; padding:3px 0;">${formatMoney(pi)}</td>
        </tr>
        <tr>
          <td style="font-weight:bold; padding-top:8px;">Total Deductions:</td>
          <td style="font-weight:bold; padding-top:8px; font-family:'Courier New', Courier, monospace;">${formatMoney(totalDeds)}</td>
        </tr>
      </table>
      <div style="font-size:10px; color:#777; margin-top:12px; font-style:italic;">Disclaimer: Income Tax is handled externally by the Accounting Dept.</div>
    </div>

    <!-- Financial Integrity -->
    <div style="margin-bottom:20px; border:1px solid #ddd; padding:15px; border-radius:4px; font-family:sans-serif; background:#f8f9fa;">
      <h3 style="margin-top:0; border-bottom:1px solid #ddd; padding-bottom:5px; font-size:14px; color:#555; font-weight:bold;">FINANCIAL INTEGRITY</h3>
      <table style="width:100%; font-size:14px; border-collapse:collapse;">
        <tr>
          <td style="width:150px; font-weight:bold; padding:4px 0;">Gross Pay:</td>
          <td style="font-family:'Courier New', Courier, monospace; font-size:16px; padding:4px 0;">${formatMoney(row.total_earning)}</td>
        </tr>
        <tr>
          <td style="font-weight:bold; color:#198754; font-size:16px; padding-top:12px;">NET PAY:</td>
          <td style="font-family:'Courier New', Courier, monospace; font-weight:bold; font-size:20px; color:#198754; padding-top:12px;">${formatMoney(row.net_pay)}</td>
        </tr>
      </table>
    </div>

    <!-- Security section removed for now -->
  `;
}

function exportIndividualPDF() {
  if (!currentIndividualData) return;
  const row = currentIndividualData;
  const filename = `Individual_Summary_${row.employee_code}_${new Date().toISOString().split('T')[0]}`;
  generateIndividualBondPDF(row, filename);
}

function exportIndividualCSV() {
  if (!currentIndividualData) return;
  const row = currentIndividualData;
  const filename = `Individual_Summary_${row.employee_code}_${new Date().toISOString().split('T')[0]}`;
  exportCSV([row], filename);
}

function exportIndividualExcel() {
  if (!currentIndividualData) return;
  const row = currentIndividualData;
  const filename = `Individual_Summary_${row.employee_code}_${new Date().toISOString().split('T')[0]}`;
  exportExcel([row], filename);
}

function generateIndividualBondPDF(row, filename) {
  if (typeof window.jspdf === 'undefined') {
    alert("PDF library not loaded.");
    return;
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF('portrait', 'in', [8.5, 11]);

  const deds = row.deductions_breakdown || [];
  const sss = deds.find(d => d.deduction_type === 'SSS')?.amount || 0;
  const ph = deds.find(d => d.deduction_type === 'PhilHealth')?.amount || 0;
  const pi = deds.find(d => d.deduction_type === 'Pag-IBIG')?.amount || 0;
  const totalDeds = sss + ph + pi;

  doc.setTextColor(0, 0, 0);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.text("MARULAS INDUSTRIAL CORPORATION", 4.25, 1.0, { align: "center" });
  doc.setFontSize(12);
  doc.setFont("helvetica", "normal");
  doc.text("INDIVIDUAL PAYROLL MASTER SUMMARY", 4.25, 1.3, { align: "center" });
  
  doc.setLineWidth(0.02);
  doc.line(1, 1.4, 7.5, 1.4);

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("PERSONNEL IDENTITY", 1, 1.8);
  doc.setFont("helvetica", "normal");
  doc.text(`Full Name: ${row.first_name} ${row.last_name}`, 1, 2.0);
  doc.text(`Employee ID: ${row.employee_code}`, 4.5, 2.0);
  doc.text(`Employment Type: Regular`, 1, 2.2);
  const jobPos = row.wage_type_name === 'Piece-Rate' ? 'Production (Piece-Rate)' : 
                 row.wage_type_name === 'Logistics' ? 'Logistics / Transport' : 'Staff';
  doc.text(`Job Position: ${jobPos}`, 4.5, 2.2);

  doc.setFont("helvetica", "bold");
  doc.text("OPERATIONAL FLOOR DATA", 1, 2.8);
  doc.setFont("courier", "normal");
  let y = 3.0;
  (row.calculations || ["Fixed Salary Computation"]).forEach(calc => {
    doc.text(calc, 1, y);
    y += 0.2;
  });

  doc.setFont("helvetica", "bold");
  doc.text("STATUTORY DEDUCTIONS", 1, y + 0.4);
  doc.setFont("helvetica", "normal");
  doc.text(`SSS Contribution:`, 1, y + 0.6);
  doc.setFont("courier", "normal");
  doc.text(`${formatMoney(sss)}`, 2.5, y + 0.6);
  
  doc.setFont("helvetica", "normal");
  doc.text(`PhilHealth:`, 1, y + 0.8);
  doc.setFont("courier", "normal");
  doc.text(`${formatMoney(ph)}`, 2.5, y + 0.8);
  
  doc.setFont("helvetica", "normal");
  doc.text(`Pag-IBIG:`, 1, y + 1.0);
  doc.setFont("courier", "normal");
  doc.text(`${formatMoney(pi)}`, 2.5, y + 1.0);
  
  doc.setFont("helvetica", "bold");
  doc.text(`Total Deductions:`, 1, y + 1.2);
  doc.setFont("courier", "bold");
  doc.text(`${formatMoney(totalDeds)}`, 2.5, y + 1.2);
  
  doc.setFont("helvetica", "italic");
  doc.setFontSize(8);
  doc.text("Disclaimer: Income Tax is handled externally by the Accounting Dept.", 1, y + 1.4);

  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("FINANCIAL INTEGRITY", 1, y + 2.0);
  doc.setFont("helvetica", "normal");
  doc.text(`Gross Pay:`, 1, y + 2.2);
  doc.setFont("courier", "normal");
  doc.text(`${formatMoney(row.total_earning)}`, 2.5, y + 2.2);
  
  doc.setFont("helvetica", "bold");
  doc.setTextColor(25, 135, 84); // Green
  doc.text(`NET PAY:`, 1, y + 2.5);
  doc.setFont("courier", "bold");
  doc.text(`${formatMoney(row.net_pay)}`, 2.5, y + 2.5);
  doc.setTextColor(0, 0, 0);

  doc.setFont("helvetica", "bold");
  doc.setFontSize(10);
  doc.text("__________________________", 1.5, 9.5);
  doc.text("PAYROLL MANAGER", 1.5, 9.7);
  doc.text("__________________________", 5.0, 9.5);
  doc.text("PRESIDENT / EXECUTIVE", 5.0, 9.7);

  const base64Data = doc.output('datauristring').split(',')[1];
  submitSecureDownload(base64Data, filename, 'pdf');
}


window.closeIndividualPreview = closeIndividualPreview;
window.exportIndividualPDF = exportIndividualPDF;
window.exportIndividualExcel = exportIndividualExcel;
window.exportIndividualCSV = exportIndividualCSV;
