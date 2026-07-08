const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(root, 'public', 'pages', 'system-admin.html'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'public', 'js', 'system-admin.js'), 'utf8');

assert(
  page.includes('id="sysadmin-tabs" hidden'),
  'System Admin tab bar should remain hidden in static HTML until the page controller initializes.'
);

assert(
  controller.includes("const tabs = document.getElementById('sysadmin-tabs');") &&
    controller.includes('if (tabs) tabs.hidden = false;'),
  'System Admin controller must reveal the tab bar after initialization.'
);

assert(
  /function initSystemAdmin\(\)[\s\S]*switchSysAdminTab\(activeTab, null, \{ skipRouteUpdate: true \}\)/.test(controller),
  'System Admin initialization must activate the requested/current tab instead of leaving the default account panel only.'
);

assert(
  controller.includes("if (targetTab === 'audit')    requestAnimationFrame(loadAuditLog);"),
  'Audit Trail tab must still load audit entries when selected.'
);

console.log('System Admin tab visibility checks: PASS');
