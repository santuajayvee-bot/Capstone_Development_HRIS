/**
 * Modal Utilities — Replace JavaScript alert() and confirm() with Bootstrap modals
 */

// Get modal elements
const modalOverlay = document.getElementById('universal-modal');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalIcon = document.getElementById('modal-icon');
const modalConfirmBtn = document.getElementById('modal-confirm');
const modalCancelBtn = document.getElementById('modal-cancel');

let modalPromiseResolve = null;

// Handle modal button clicks
modalConfirmBtn.addEventListener('click', () => {
  if (modalPromiseResolve) {
    modalPromiseResolve(true);
    modalPromiseResolve = null;
  }
  closeModal();
});

modalCancelBtn.addEventListener('click', () => {
  if (modalPromiseResolve) {
    modalPromiseResolve(false);
    modalPromiseResolve = null;
  }
  closeModal();
});

// Close modal when clicking outside (on backdrop)
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) {
    if (modalPromiseResolve) {
      modalPromiseResolve(false);
      modalPromiseResolve = null;
    }
    closeModal();
  }
});

/**
 * Show an alert modal
 * @param {string} message - Message to display
 * @param {string} title - Title (default: "Alert")
 * @param {string} type - Type: 'info', 'success', 'warning', 'error' (default: 'info')
 */
async function showAlert(message, title = 'Alert', type = 'info') {
  return new Promise((resolve) => {
    modalPromiseResolve = () => resolve();
    
    // Set icon based on type
    const icons = {
      info: 'ℹ️',
      success: '✓',
      warning: '⚠️',
      error: '❌'
    };
    
    const colors = {
      info: '#4f7cff',
      success: '#10b981',
      warning: '#f59e0b',
      error: '#ef4444'
    };
    
    modalIcon.textContent = icons[type] || icons.info;
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalConfirmBtn.textContent = 'OK';
    modalConfirmBtn.style.background = colors[type] || colors.info;
    modalCancelBtn.style.display = 'none';
    
    modalOverlay.style.display = 'flex';
  });
}

/**
 * Show a confirmation modal
 * @param {string} message - Message to display
 * @param {string} title - Title (default: "Confirm")
 * @param {string} confirmText - Confirm button text (default: "Yes")
 * @param {string} cancelText - Cancel button text (default: "Cancel")
 * @returns {boolean} - true if confirmed, false if cancelled
 */
async function showConfirm(message, title = 'Confirm', confirmText = 'Yes', cancelText = 'Cancel') {
  return new Promise((resolve) => {
    modalPromiseResolve = resolve;
    
    modalIcon.textContent = '❓';
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalConfirmBtn.textContent = confirmText;
    modalConfirmBtn.style.background = '#ef4444';
    modalCancelBtn.textContent = cancelText;
    modalCancelBtn.style.display = 'block';
    
    modalOverlay.style.display = 'flex';
  });
}

/**
 * Close the modal
 */
function closeModal() {
  modalOverlay.style.display = 'none';
}

/**
 * Override global alert and confirm if needed
 * Uncomment the lines below to make window.alert and window.confirm use modals
 */
// window.alert = showAlert;
// window.confirm = showConfirm;

// Expose functions globally
window.showAlert = showAlert;
window.showConfirm = showConfirm;
window.closeModal = closeModal;
