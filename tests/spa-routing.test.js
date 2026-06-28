const assert = require('assert');
const fs = require('fs');
const path = require('path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

assert.match(
  serverSource,
  /const SPA_ROUTE_HANDLERS = \[\s+\.\.\.SPA_ROUTE_PATHS,\s+\.\.\.\[\.\.\.SPA_ROUTE_PATHS\]\.map\(routePath => `\$\{routePath\}\/`\),\s+\];/s,
  'SPA routes must serve both canonical and trailing-slash paths.'
);

assert.doesNotMatch(
  serverSource,
  /res\.redirect\(\s*308\s*,[^)]*SPA_ROUTE_PATHS/s,
  'SPA routes must not use permanent redirects because browsers cache them and can create redirect loops.'
);

console.log('SPA routing regression tests: PASS');
