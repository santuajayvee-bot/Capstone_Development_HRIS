/* ============================================================
   DASHBOARD.JS — Dashboard page logic
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  // Nothing dynamic needed for static demo.
  // Hook action card buttons to navigate
  const addEmpBtn = document.getElementById('dash-add-emp');
  const reviewBtn = document.getElementById('dash-review');

  if (addEmpBtn) {
    addEmpBtn.addEventListener('click', () => {
      navigate('register', document.querySelector('[data-page="employees"]'));
    });
  }
  if (reviewBtn) {
    reviewBtn.addEventListener('click', () => {
      navigate('leave', document.querySelector('[data-page="leave"]'));
    });
  }
});
