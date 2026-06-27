(function exposeSecurityUtils(root) {
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    })[character]);
  }

  function setSafeText(element, value) {
    if (!element) return;
    element.textContent = String(value ?? '');
  }

  const api = Object.freeze({ escapeHTML, setSafeText });
  root.LgsvSecurity = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
