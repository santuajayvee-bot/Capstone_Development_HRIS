const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const frontend = fs.readFileSync(path.join(root, 'public', 'js', 'attendance.js'), 'utf8');
const realtime = fs.readFileSync(path.join(root, 'public', 'js', 'attendance-realtime.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'public', 'css', 'attendance.css'), 'utf8');

assert.match(frontend, /event\.preventDefault\(\);[\s\S]*event\.stopPropagation\(\);/, 'Attendance action trigger must not bubble into the outside-click closer.');
assert.ok(
  frontend.includes('function handleAttendanceActionMenuDocumentClick(event)') &&
    frontend.includes("if (target?.closest?.('.att-row-menu, .att-menu-panel, .att-menu-trigger')) return;") &&
    frontend.includes('closeAttendanceActionMenus();'),
  'Outside-click closer must ignore clicks on the attendance trigger and menu.'
);
assert.match(frontend, /document\.addEventListener\('click', handleAttendanceActionMenuDocumentClick\)/, 'Attendance action menu must use the guarded outside-click closer.');
assert.match(frontend, /menu\.style\.left = `\$\{left\}px`;[\s\S]*menu\.style\.top = `\$\{top\}px`;/, 'Attendance row menu must be positioned near the trigger without layout shifting.');
assert.match(styles, /\.att-menu-panel\.open\s*\{[^}]*display:(?:flex|grid);/, 'Open attendance menu must be visible when toggled.');
assert.match(frontend, /if \(hasOpenAttendanceActionMenu\(\)\) return;\s*renderAttRecords\(\);/, 'A completed records request must not replace the row while its action menu is open.');
assert.match(realtime, /recordMenuOpen[\s\S]*!recordMenuOpen\) refreshTasks\.push\(loadAttRecords\(\)\);/, 'Realtime polling must pause attendance row refresh while an action menu is open.');

console.log('Attendance action menu stability tests: PASS');
