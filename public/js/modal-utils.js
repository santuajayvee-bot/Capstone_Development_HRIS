/**
 * Bootstrap-backed modal utilities for system alerts and confirmations.
 * Uses the shared static-backdrop modal in index.html.
 */

const modalElement = document.getElementById('universal-modal');
const modalTitle = document.getElementById('modal-title');
const modalMessage = document.getElementById('modal-message');
const modalIcon = document.getElementById('modal-icon');
const modalConfirmBtn = document.getElementById('modal-confirm');
const modalCancelBtn = document.getElementById('modal-cancel');
const modalCloseBtn = document.getElementById('modal-close');
const nativeAlert = window.alert.bind(window);
const nativeConfirm = window.confirm.bind(window);

let modalPromiseResolve = null;
let bootstrapModal = null;

function getBootstrapModal() {
  if (!modalElement || !window.bootstrap?.Modal) return null;
  if (!bootstrapModal) {
    bootstrapModal = new bootstrap.Modal(modalElement, {
      backdrop: 'static',
      keyboard: false,
    });
  }
  return bootstrapModal;
}

function resolveModal(value) {
  if (modalPromiseResolve) {
    modalPromiseResolve(value);
    modalPromiseResolve = null;
  }
}

function setModalType(type) {
  const normalizedType = ['info', 'success', 'warning', 'error'].includes(type) ? type : 'info';
  const icons = {
    info: 'i',
    success: 'OK',
    warning: '!',
    error: '!',
  };

  modalIcon.textContent = icons[normalizedType];
  modalIcon.className = `lgsv-modal-icon lgsv-modal-icon-${normalizedType}`;
  modalConfirmBtn.className = 'btn btn-primary';

  if (normalizedType === 'success') modalConfirmBtn.className = 'btn btn-success';
  if (normalizedType === 'warning') modalConfirmBtn.className = 'btn btn-warning';
  if (normalizedType === 'error') modalConfirmBtn.className = 'btn btn-danger';

  modalCancelBtn.className = 'btn btn-outline';
}

function closeModal() {
  const modal = getBootstrapModal();
  if (modal) {
    modal.hide();
    return;
  }
  if (modalElement) modalElement.style.display = 'none';
}

function openModal() {
  const modal = getBootstrapModal();
  if (modal) {
    modal.show();
    return;
  }
  if (modalElement) modalElement.style.display = 'block';
}

function prepareModal(message, title, type) {
  setModalType(type);
  modalTitle.textContent = title;
  modalMessage.textContent = message;
}

modalConfirmBtn?.addEventListener('click', () => {
  resolveModal(true);
  closeModal();
});

modalCancelBtn?.addEventListener('click', () => {
  resolveModal(false);
});

modalCloseBtn?.addEventListener('click', () => {
  resolveModal(false);
});

modalElement?.addEventListener('hidden.bs.modal', () => {
  resolveModal(false);
});

async function showAlert(message, title = 'Alert', type = 'info') {
  if (!modalElement || !modalTitle || !modalMessage || !modalConfirmBtn || !modalCancelBtn || !modalIcon) {
    nativeAlert(String(message || ''));
    return;
  }

  return new Promise((resolve) => {
    modalPromiseResolve = () => resolve();

    prepareModal(String(message || ''), title, type);
    modalConfirmBtn.textContent = 'OK';
    modalCancelBtn.style.display = 'none';

    openModal();
  });
}

async function showConfirm(message, title = 'Confirm', confirmText = 'Yes', cancelText = 'Cancel') {
  if (!modalElement || !modalTitle || !modalMessage || !modalConfirmBtn || !modalCancelBtn || !modalIcon) {
    return nativeConfirm(String(message || ''));
  }

  return new Promise((resolve) => {
    modalPromiseResolve = resolve;

    prepareModal(String(message || ''), title, 'warning');
    modalConfirmBtn.textContent = confirmText;
    modalConfirmBtn.className = 'btn btn-danger';
    modalCancelBtn.textContent = cancelText;
    modalCancelBtn.style.display = 'inline-flex';

    openModal();
  });
}

window.showAlert = showAlert;
window.showConfirm = showConfirm;
window.closeModal = closeModal;
window.alert = (message) => {
  showAlert(String(message || ''), 'Notice', 'info');
};
