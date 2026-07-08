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
const nativePrompt = window.prompt.bind(window);

let modalPromiseResolve = null;
let bootstrapModal = null;
let modalMode = 'alert';
let promptInputElement = null;
let deviceRegistrationFields = null;

function elevateUniversalModalLayer() {
  if (modalElement) modalElement.style.zIndex = '40010';
  const liftBackdrops = () => {
    document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
      backdrop.style.zIndex = '40000';
    });
  };
  liftBackdrops();
  requestAnimationFrame(liftBackdrops);
  setTimeout(liftBackdrops, 0);
}

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
    elevateUniversalModalLayer();
    return;
  }
  if (modalElement) {
    modalElement.style.display = 'block';
    elevateUniversalModalLayer();
  }
}

function prepareModal(message, title, type) {
  setModalType(type);
  modalTitle.textContent = title;
  const finalMessage = typeof window.LGSVValidation?.formatValidationAlert === 'function'
    ? window.LGSVValidation.formatValidationAlert(message)
    : message;
  modalMessage.textContent = finalMessage;
}

function promptInputType(message, title) {
  return /password|passcode|current password|account password/i.test(`${message || ''} ${title || ''}`)
    ? 'password'
    : 'text';
}

function preparePromptModal(message, title, defaultValue = '') {
  setModalType('info');
  modalTitle.textContent = title;
  modalMessage.innerHTML = '';
  const label = document.createElement('label');
  label.className = 'form-label';
  label.textContent = message;
  const input = document.createElement('input');
  input.type = promptInputType(message, title);
  input.className = 'form-control';
  input.value = defaultValue || '';
  input.autocomplete = input.type === 'password' ? 'current-password' : 'off';
  modalMessage.appendChild(label);
  modalMessage.appendChild(input);
  promptInputElement = input;
  modalConfirmBtn.textContent = 'Continue';
  modalConfirmBtn.className = 'btn btn-primary';
  modalCancelBtn.textContent = 'Cancel';
  modalCancelBtn.style.display = 'inline-flex';
  modalMode = 'prompt';
}

modalConfirmBtn?.addEventListener('click', () => {
  if (modalMode === 'trustedDeviceRegistration') {
    const deviceName = deviceRegistrationFields?.deviceName?.value?.trim() || '';
    const password = deviceRegistrationFields?.password?.value || '';
    if (!password) {
      deviceRegistrationFields?.password?.focus();
      return;
    }
    resolveModal({ deviceName, password });
    closeModal();
    return;
  }
  if (modalMode === 'prompt') {
    resolveModal(promptInputElement?.value ?? '');
    closeModal();
    return;
  }
  resolveModal(true);
  closeModal();
});

modalCancelBtn?.addEventListener('click', () => {
  resolveModal(false);
  closeModal();
});

modalCloseBtn?.addEventListener('click', () => {
  resolveModal(false);
  closeModal();
});

modalElement?.addEventListener('hidden.bs.modal', () => {
  if (modalMode === 'prompt') {
    resolveModal(false);
  } else {
    resolveModal(false);
  }
  modalMode = 'alert';
  promptInputElement = null;
  deviceRegistrationFields = null;
});

modalElement?.addEventListener('shown.bs.modal', elevateUniversalModalLayer);

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
    modalMode = 'confirm';

    openModal();
  });
}

async function showPrompt(message, title = 'Input Required', defaultValue = '') {
  if (!modalElement || !modalTitle || !modalMessage || !modalConfirmBtn || !modalCancelBtn || !modalIcon) {
    return nativePrompt(String(message || ''), defaultValue || '');
  }

  return new Promise((resolve) => {
    modalPromiseResolve = resolve;
    preparePromptModal(String(message || ''), title, defaultValue);
    openModal();
  });
}

async function showTrustedDeviceRegistrationModal(defaultDeviceName = '') {
  if (!modalElement || !modalTitle || !modalMessage || !modalConfirmBtn || !modalCancelBtn || !modalIcon) {
    const approved = nativeConfirm('Register this browser and computer as a trusted device?');
    if (!approved) return false;
    return {
      deviceName: defaultDeviceName || 'Trusted Device',
      password: nativePrompt('Confirm your account password:') || '',
    };
  }

  return new Promise((resolve) => {
    modalPromiseResolve = resolve;
    setModalType('info');
    modalTitle.textContent = 'Register Trusted Device';
    modalMessage.innerHTML = `
      <div class="trusted-device-modal">
        <p class="trusted-device-modal-note">Register this browser and computer only if it is private and controlled by you.</p>
        <label class="form-label" for="trusted-device-name-input">Device name</label>
        <input class="form-control" id="trusted-device-name-input" type="text" maxlength="120" autocomplete="off">
        <label class="form-label" for="trusted-device-password-input">Account password</label>
        <input class="form-control" id="trusted-device-password-input" type="password" autocomplete="current-password">
      </div>
    `;
    const deviceName = document.getElementById('trusted-device-name-input');
    const password = document.getElementById('trusted-device-password-input');
    if (deviceName) deviceName.value = defaultDeviceName || 'Trusted Device';
    deviceRegistrationFields = { deviceName, password };
    modalConfirmBtn.textContent = 'Register Device';
    modalConfirmBtn.className = 'btn btn-primary';
    modalCancelBtn.textContent = 'Cancel';
    modalCancelBtn.style.display = 'inline-flex';
    modalMode = 'trustedDeviceRegistration';
    openModal();
    setTimeout(() => deviceName?.focus(), 120);
  });
}

window.showAlert = showAlert;
window.showConfirm = showConfirm;
window.showPrompt = showPrompt;
window.showTrustedDeviceRegistrationModal = showTrustedDeviceRegistrationModal;
window.closeModal = closeModal;
window.alert = (message) => {
  showAlert(String(message || ''), 'Notice', 'info');
};
