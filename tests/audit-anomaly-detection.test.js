const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

const adminRbac = read('server/admin-rbac.js');
const server = read('server.js');
const securityControls = read('server/security-controls.js');
const systemAdminPage = read('public/pages/system-admin.html');
const systemAdminScript = read('public/js/system-admin.js');
const systemAdminCss = read('public/css/system-admin.css');

for (const type of ['SQL_INJECTION', 'XSS', 'BRUTE_FORCE', 'SESSION_MANIPULATION']) {
  assert(adminRbac.includes(`'${type}'`), `Backend anomaly classifier must include ${type}.`);
  assert(systemAdminPage.includes(`value="${type}"`), `Audit Trail UI must expose ${type} filtering.`);
}

assert(adminRbac.includes('classifyAuditAnomaly'), 'Backend must classify audit anomalies.');
assert(adminRbac.includes('auditAnomalyHaystack'), 'Backend must inspect audit row metadata for suspicious indicators.');
assert(securityControls.includes('auditSuspiciousRequestPatterns'), 'Security controls must audit suspicious request patterns.');
assert(securityControls.includes('detected_sql_injection_probe'), 'Suspicious request logger must detect SQL injection probes.');
assert(securityControls.includes('detected_xss_probe'), 'Suspicious request logger must detect XSS probes.');
assert(server.includes("app.use('/api', auditSuspiciousRequestPatterns);"), 'Suspicious request detector must be mounted for API requests.');
assert(adminRbac.includes('SQL injection indicators'), 'SQL injection anomaly reason must be present.');
assert(adminRbac.includes('browser storage indicators'), 'XSS anomaly reason must be present.');
assert(adminRbac.includes('Repeated failed authentication activity detected'), 'Brute-force anomaly reason must be present.');
assert(adminRbac.includes('Session/token tampering'), 'Session manipulation anomaly reason must be present.');
assert(adminRbac.includes("String(eventType || '').trim().toLowerCase() === 'anomaly'"), 'Audit API must support anomaly-only filtering.');

assert(systemAdminPage.includes('<option value="anomaly">Detected Anomalies</option>'), 'Audit action filter must include Detected Anomalies.');
assert(systemAdminPage.includes('id="audit-anomaly-filter"'), 'Audit Trail must include a threat-type filter.');
assert(systemAdminPage.includes('<th>Threat</th>'), 'Audit Trail table must display the detected threat column.');

assert(systemAdminScript.includes('auditThreatBadge'), 'Frontend must render anomaly badges.');
assert(systemAdminScript.includes('params.set(\'anomaly_type\', anomalyType)'), 'Frontend must send anomaly filter to backend.');
assert(systemAdminScript.includes("severity === 'critical'"), 'Frontend must map critical anomaly severity.');
assert(systemAdminCss.includes('.audit-threat-badge'), 'Anomaly badges must be styled.');

console.log('Audit anomaly detection controls: PASS');
