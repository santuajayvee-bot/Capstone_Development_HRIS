/* ============================================================
   ATTENDANCE.JS — Attendance tab switching & overview
   ============================================================ */

function switchAttTab(tab, el) {
  const tabs = ['overview', 'records', 'overtime'];
  tabs.forEach(t => {
    const el = document.getElementById('att-' + t);
    if (el) el.style.display = 'none';
  });

  const target = document.getElementById('att-' + tab);
  if (target) target.style.display = 'block';

  document.querySelectorAll('#page-attendance .tabs .tab')
    .forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
}

// Expose globally
window.switchAttTab = switchAttTab;
