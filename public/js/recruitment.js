/* ============================================================
   RECRUITMENT.JS — Onboarding / Recruitment tab switching
   ============================================================ */

function switchOnbTab(tab, el) {
  ['candidates', 'jobs'].forEach(t => {
    const panel = document.getElementById('onb-' + t);
    if (panel) panel.style.display = 'none';
  });

  const target = document.getElementById('onb-' + tab);
  if (target) target.style.display = 'block';

  document.querySelectorAll('#page-onboarding .tabs .tab')
    .forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
}

window.switchOnbTab = switchOnbTab;
