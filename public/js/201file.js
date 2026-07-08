let current201EmployeeId = null;
let employees201List = [];

function escape201(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

async function load201FileList() {
  const section = document.getElementById('201file-list');
  const title = document.getElementById('201file-detail-title');
  const detail = document.getElementById('201file-detail');
  if (!section || !title || !detail) return;

  section.innerHTML = '<p>Loading...</p>';
  detail.style.display = 'none';

  const res = await apiFetch('/api/201-files/list');
  if (!res || !res.ok) {
    section.innerHTML = '<p class="text-danger">Failed to load list.</p>';
    return;
  }

  const data = await res.json();
  employees201List = data;

  if (!data.length) {
    section.innerHTML = '<p>No employees found.</p>';
    return;
  }

  section.innerHTML = `
    <table class="table table-condensed" style="width:100%;border-collapse:collapse;">
      <thead><tr><th>Employee</th><th>Code</th><th>Dept</th><th>Status</th><th>Docs</th><th>Verified</th><th>Action</th></tr></thead>
      <tbody>${data.map(emp => `
        <tr>
          <td>${escape201(emp.name)}</td>
          <td>${escape201(emp.employee_code)}</td>
          <td>${escape201(emp.department || '-')}</td>
          <td>${escape201(emp.status)}</td>
          <td>${emp.document_count}</td>
          <td>${emp.verified_documents}</td>
          <td><button class="btn btn-outline" onclick="open201FileDetail(${emp.id})">Open</button></td>
        </tr>
      `).join('')}</tbody>
    </table>
  `;
}

function filter201FileList() {
  const query = (document.getElementById('201file-search').value || '').trim().toLowerCase();
  const table = document.querySelector('#201file-list table tbody');
  if (!table) return;
  [...table.rows].forEach(row => {
    const text = row.textContent.toLowerCase();
    row.style.display = text.includes(query) ? '' : 'none';
  });
}

function close201FileDetail() {
  const detail = document.getElementById('201file-detail');
  if (!detail) return;
  detail.style.display = 'none';
  current201EmployeeId = null;
}

async function open201FileDetail(employeeId) {
  current201EmployeeId = employeeId;
  const res = await apiFetch(`/api/201-files/${employeeId}`);
  if (!res || !res.ok) {
    alert('Failed to fetch 201-file details.');
    return;
  }

  const data = await res.json();

  const employeeInfo = document.getElementById('employee-info');
  const documentList = document.getElementById('document-list');
  const resultText = document.getElementById('sensitive-data-result');
  const detail = document.getElementById('201file-detail');

  if (resultText) resultText.textContent = '';

  employeeInfo.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px;">
      <div><strong>${escape201(data.employee.name)}</strong><br>Code: ${escape201(data.employee.code)}</div>
      <div>Position: ${escape201(data.employee.position || '-')}<br>Department: ${escape201(data.employee.department || '-')}<br>Status: ${escape201(data.employee.status || '-')}</div>
      <div id="201-sensitive-employee">Contact: ${escape201(data.employee.contactNumber || '-')}<br>Email: ${escape201(data.employee.email || '-')}</div>
      <div>Hired: ${escape201(data.employee.dateHired || '-')}<br>Supervisor: ${escape201(data.employee.supervisor || '-')}<br>Location: ${escape201(data.employee.workLocation || '-')}</div>
      <div style="grid-column:1/-1;"><button class="btn btn-outline" type="button" onclick="reveal201EmployeeSensitive()">Show personal details</button></div>
    </div>
  `;

  detail.style.display = 'block';

  renderDocumentList(data.documents || []);
  populateSensitiveData(data.sensitiveData);
  load201AccessLog(employeeId);
}

function renderDocumentList(documents) {
  const container = document.getElementById('document-list');
  if (!container) return;

  if (!documents.length) {
    container.innerHTML = '<p>No documents uploaded yet.</p>';
    return;
  }

  container.innerHTML = `<table class="table table-condensed" style="width:100%;border-collapse:collapse;"><thead><tr><th>Type</th><th>Name</th><th>Uploaded</th><th>Status</th><th>Verifier</th><th>Action</th></tr></thead><tbody>${documents.map(doc => `
      <tr>
        <td>${escape201(doc.document_type)}</td>
        <td>${escape201(doc.file_name)}</td>
        <td>${new Date(doc.uploaded_date).toLocaleDateString()}</td>
        <td>${escape201(doc.verification_status)}</td>
        <td>${escape201(doc.verified_by_name || '-')}</td>
        <td style="display:flex;gap:4px;">
          <button class="btn btn-outline" type="button" onclick="download201Document(${doc.id})">Download</button>
          <button class="btn btn-outline" onclick="verifyDocument(current201EmployeeId, ${doc.id}, 'Verified')">✓</button>
          <button class="btn btn-outline" onclick="verifyDocument(current201EmployeeId, ${doc.id}, 'Rejected')">✕</button>
          <button class="btn btn-outline" onclick="deleteDocument(current201EmployeeId, ${doc.id})">🗑</button>
        </td>
      </tr>`).join('')}</tbody></table>`;
}

function populateSensitiveData(sd) {
  ['sd-ssn', 'sd-taxid', 'sd-bank-account', 'sd-bank-routing', 'sd-emergency', 'sd-other'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
  const result = document.getElementById('sensitive-data-result');
  if (result) result.textContent = sd ? 'Sensitive values are hidden.' : 'No sensitive data saved.';
}

async function reveal201EmployeeSensitive() {
  if (!current201EmployeeId) return;
  const res = await apiFetch(`/api/201-files/${current201EmployeeId}/reveal-employee-sensitive`, { method: 'POST', body: '{}' });
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok) return alert(data.error || 'Failed to reveal personal details.');
  const target = document.getElementById('201-sensitive-employee');
  if (target) target.innerHTML = `Contact: ${escape201(data.contactNumber || '-')}<br>Email: ${escape201(data.email || '-')}<br>Address: ${escape201(data.residentialAddress || '-')}`;
}

async function reveal201SensitiveData() {
  if (!current201EmployeeId) return;
  const res = await apiFetch(`/api/201-files/${current201EmployeeId}/sensitive-data`);
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok) return alert(data.error || 'Failed to reveal sensitive data.');
  document.getElementById('sd-ssn').value = data.ssn || '';
  document.getElementById('sd-taxid').value = data.tax_id || '';
  document.getElementById('sd-bank-account').value = data.bank_account_number || '';
  document.getElementById('sd-bank-routing').value = data.bank_routing_number || '';
  document.getElementById('sd-emergency').value = data.emergency_contact_phone || '';
  document.getElementById('sd-other').value = data.other_sensitive_info || '';
  document.getElementById('sensitive-data-result').textContent = 'Sensitive values revealed for this session.';
}

async function download201Document(documentId) {
  const res = await apiFetch(`/api/201-files/${current201EmployeeId}/documents/${documentId}/download`);
  if (!res?.ok) return alert('Failed to download document.');
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = 'document';
  link.click();
  URL.revokeObjectURL(url);
}

async function upload201Document() {
  if (!current201EmployeeId) return false;

  const fileInput = document.getElementById('upload-document-file');
  const docType = document.getElementById('upload-document-type').value;

  if (!fileInput.files.length || !docType) {
    alert('Please select file and document type.');
    return false;
  }

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('document_type', docType);

  const res = await apiFetch(`/api/201-files/${current201EmployeeId}/documents`, {
    method: 'POST',
    body: formData,
  });

  if (!res || !res.ok) {
    const err = await res?.json().catch(() => ({}));
    alert(err.error || 'Upload failed');
    return false;
  }

  await open201FileDetail(current201EmployeeId);
  fileInput.value = '';
  document.getElementById('upload-document-type').value = '';
  return false;
}

async function verifyDocument(employeeId, docId, status) {
  const reason = status === 'Rejected'
    ? (typeof showPrompt === 'function'
      ? await showPrompt('Rejection reason (optional):', 'Reject Document', '')
      : prompt('Rejection reason (optional):'))
    : null;
  const res = await apiFetch(`/api/201-files/${employeeId}/verify-document/${docId}`, {
    method: 'PUT',
    body: JSON.stringify({ verification_status: status, rejection_reason: reason }),
  });
  if (!res || !res.ok) {
    const err = await res?.json().catch(() => ({}));
    alert(err.error || 'Failed to update status');
    return;
  }
  open201FileDetail(employeeId);
}

async function deleteDocument(employeeId, docId) {
  const confirmed = typeof showConfirm === 'function'
    ? await showConfirm('Delete this document?', 'Delete Document', 'Delete', 'Cancel')
    : confirm('Delete this document?');
  if (!confirmed) return;
  const res = await apiFetch(`/api/201-files/${employeeId}/documents/${docId}`, { method: 'DELETE' });
  if (!res || !res.ok) {
    const err = await res?.json().catch(() => ({}));
    alert(err.error || 'Failed to delete');
    return;
  }
  open201FileDetail(employeeId);
}

async function updateSensitiveData() {
  if (!current201EmployeeId) return false;

  const payload = {
    ssn: document.getElementById('sd-ssn').value.trim() || null,
    tax_id: document.getElementById('sd-taxid').value.trim() || null,
    bank_account_number: document.getElementById('sd-bank-account').value.trim() || null,
    bank_routing_number: document.getElementById('sd-bank-routing').value.trim() || null,
    emergency_contact_phone: document.getElementById('sd-emergency').value.trim() || null,
    other_sensitive_info: document.getElementById('sd-other').value.trim() || null,
  };

  const res = await apiFetch(`/api/201-files/${current201EmployeeId}/sensitive-data`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });

  if (!res || !res.ok) {
    const err = await res?.json().catch(() => ({}));
    alert(err.error || 'Failed to update sensitive data');
    return false;
  }

  const json = await res.json().catch(() => null);
  document.getElementById('sensitive-data-result').textContent = 'Saved successfully';
  document.getElementById('sensitive-data-result').className = 'text-success';

  // Re-load data from server to show persisted values and audit log update.
  await open201FileDetail(current201EmployeeId);
  return false;
}

async function load201AccessLog(employeeId) {
  const logEl = document.getElementById('access-log-list');
  if (!logEl) return;

  const res = await apiFetch(`/api/201-files/${employeeId}/access-log`);
  if (!res || !res.ok) {
    logEl.innerHTML = '<p class="text-danger">Failed to load audit log.</p>';
    return;
  }

  const logs = await res.json();
  if (!logs.length) {
    logEl.innerHTML = '<p>No log entries yet.</p>';
    return;
  }

  logEl.innerHTML = logs.map(log => `
    <div class="log-entry">
      <div class="meta">${new Date(log.accessed_at).toLocaleString()} · ${log.accessed_by_name}</div>
      <div class="action">${log.action}</div>
      <div>${log.resource_type} ${log.resource_id ? `#${log.resource_id}` : ''}</div>
      <div class="details"><pre style="margin:0;white-space:pre-wrap;word-break:break-word;">${JSON.stringify(log.details || {}, null, 2)}</pre></div>
    </div>
  `).join('');
}

window.load201FileList = load201FileList;
window.open201FileDetail = open201FileDetail;
window.close201FileDetail = close201FileDetail;
window.filter201FileList = filter201FileList;
window.upload201Document = upload201Document;
window.verifyDocument = verifyDocument;
window.deleteDocument = deleteDocument;
window.updateSensitiveData = updateSensitiveData;
window.reveal201EmployeeSensitive = reveal201EmployeeSensitive;
window.reveal201SensitiveData = reveal201SensitiveData;
window.download201Document = download201Document;
