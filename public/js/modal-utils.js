/**
 * Modal Utilities - Bootstrap-style alert and confirm dialogs.
 */

const modalOverlay = document.getElementById('universal-modal');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalIcon = document.getElementById('modal-icon');
const modalConfirmBtn = document.getElementById('modal-confirm');
const modalCancelBtn = document.getElementById('modal-cancel');

let modalPromiseResolve = null;

function setModalType(type) {
  const normalizedType = ['info', 'success', 'warning', 'error'].includes(type) ? type : 'info';
  const icons = {
    info: 'i',
    success: 'OK',
    warning: '!',
    error: '!'
  };

  modalIcon.textContent = icons[normalizedType];
  modalIcon.className = `modal-icon-custom modal-icon-${normalizedType}`;
  modalConfirmBtn.className = 'btn-modal btn-modal-primary';

  if (normalizedType === 'success') modalConfirmBtn.className = 'btn-modal btn-modal-success';
  if (normalizedType === 'warning') modalConfirmBtn.className = 'btn-modal btn-modal-warning';
  if (normalizedType === 'error') modalConfirmBtn.className = 'btn-modal btn-modal-danger';

  modalCancelBtn.className = 'btn-modal btn-modal-secondary';
}

function closeModal() {
  modalOverlay.style.display = 'none';
}

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

modalOverlay.addEventListener('click', (event) => {
  if (event.target === modalOverlay) {
    if (modalPromiseResolve) {
      modalPromiseResolve(false);
      modalPromiseResolve = null;
    }
    closeModal();
  }
});

async function showAlert(message, title = 'Alert', type = 'info') {
  return new Promise((resolve) => {
    modalPromiseResolve = () => resolve();

    setModalType(type);
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalConfirmBtn.textContent = 'OK';
    modalCancelBtn.style.display = 'none';

    modalOverlay.style.display = 'flex';
  });
}

async function showConfirm(message, title = 'Confirm', confirmText = 'Yes', cancelText = 'Cancel') {
  return new Promise((resolve) => {
    modalPromiseResolve = resolve;

    setModalType('warning');
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    modalConfirmBtn.textContent = confirmText;
    modalConfirmBtn.className = 'btn-modal btn-modal-danger';
    modalCancelBtn.textContent = cancelText;
    modalCancelBtn.style.display = 'inline-flex';

    modalOverlay.style.display = 'flex';
  });
}

window.showAlert = showAlert;
window.showConfirm = showConfirm;
window.closeModal = closeModal;
