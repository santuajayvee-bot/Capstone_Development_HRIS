const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';

const payrollRouter = require('../server/payroll');
const { requireAuth } = require('../server/middleware');

function runMiddleware(middleware, req) {
  let response = null;
  let nextCalled = false;
  const res = {
    status(code) {
      response = { code };
      return this;
    },
    json(payload) {
      response = response || {};
      response.payload = payload;
      return payload;
    },
  };

  return Promise.resolve(middleware(req, res, () => { nextCalled = true; }))
    .then(() => ({ response, nextCalled }));
}

function findRoute(router, method, path) {
  return router.stack.find(layer => layer.route
    && layer.route.path === path
    && layer.route.methods[method]);
}

(async () => {
  const unauthenticated = await runMiddleware(requireAuth, {
    headers: {},
    originalUrl: '/api/payroll/piece-rates',
    socket: {},
  });

  assert.strictEqual(unauthenticated.nextCalled, false);
  assert.strictEqual(unauthenticated.response.code, 401);
  assert.strictEqual(unauthenticated.response.payload.error, 'No token provided.');

  const route = findRoute(payrollRouter, 'post', '/piece-rates');
  assert.ok(route, 'POST /piece-rates route should exist.');

  const handlers = route.route.stack.map(layer => layer.handle);
  assert.strictEqual(handlers[0], requireAuth, 'POST /piece-rates must authenticate before any handler runs.');
  assert.ok(handlers.length >= 4, 'POST /piece-rates should include auth, role, tamper guard, and handler.');

  const payrollSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'payroll.js'), 'utf8');
  assert.match(
    payrollSource,
    /o\.status = 'Paid' AND o\.payroll_run_id = \?/,
    'A paid shared daily output must remain available to its second partner within the same payroll run.'
  );
  assert.match(
    payrollSource,
    /getApprovedPieceRatePayroll\(connection, emp\.id, period, payrollRunId\)/,
    'Payroll generation must scope shared-output reuse to the current payroll run.'
  );
  assert.match(
    payrollSource,
    /DATE_FORMAT\(o\.output_date, '%Y-%m-%d'\) AS output_date/,
    'Sewing registries must preserve MySQL DATE values without a UTC day shift.'
  );
  assert.match(
    payrollSource,
    /const productionValue = quantity \* Number\(row\.rate_per_piece\)/,
    'Share registry detail cells must display production value from quantity multiplied by rate.'
  );
  assert.match(
    payrollSource,
    /current\.daily\[outputDate\] = \(current\.daily\[outputDate\] \|\| 0\) \+ dayValue/,
    'Share registry daily values must retain full precision until the final displayed subtotal.'
  );
  assert.match(
    payrollSource,
    /SELECT s2\.id[\s\S]*?WHERE s2\.piece_rate_output_id = o\.id[\s\S]*?LIMIT 1/,
    'The main sewing registry must select only one worker share per physical production output.'
  );
  assert.match(
    payrollSource,
    /const exactGrandAmount = calculatePieceShareTotal\(rows\.map\(row => \(\{[\s\S]*?share_percentage: kind === 'main' \? 100 : row\.share_percentage/,
    'Registry grand amounts must use exact aggregation, with the main production register valued at 100%.'
  );
  assert.match(
    payrollSource,
    /return calculatePieceShareTotal\(rows\)/,
    'Payroll gross pay must aggregate fixed-point piece shares before final rounding.'
  );

  const reportsSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'reports.js'), 'utf8');
  const registryPrintSource = reportsSource.match(/async function printSewingRegistryHtml[\s\S]*?\r?\n}\r?\n\r?\nfunction renderSewingRegistryHtml/)?.[0] || '';
  assert.match(
    registryPrintSource,
    /apiFetch\([\s\S]*?\{ cache: 'no-store' \}/,
    'Sewing registry printing must request the current server data without browser caching.'
  );
  assert.doesNotMatch(
    registryPrintSource,
    /outputCache\.(get|set)\(/,
    'Sewing registry printing must not reuse a stale in-memory registry payload.'
  );
  assert.match(
    reportsSource,
    /Date\.UTC\(Number\(match\[1\]\), Number\(match\[2\]\) - 1, Number\(match\[3\]\)\)/,
    'Sewing registry date labels must use explicit UTC calendar components.'
  );
  assert.match(
    reportsSource,
    /tr\{break-inside:avoid;page-break-inside:avoid\}/,
    'Printed sewing registry rows must not split or collapse across PDF page breaks.'
  );
  assert.match(
    reportsSource,
    /Daily Production Value/,
    '55/45 registry detail columns must identify their values as daily production value.'
  );
  assert.match(
    reportsSource,
    /sewing-registry-share-total th\{background:#fff36a\}/,
    '55/45 daily earnings totals must use the client-style yellow highlight.'
  );

  const pieceRateSeedSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'seed-client-piece-rate-configuration.js'), 'utf8');
  const historicalSeedSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'seed-client-historical-piece-rate-daily.js'), 'utf8');
  const confirmedHistoricalSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'data', 'client-historical-piece-rate-confirmed.js'), 'utf8');
  const pieceRateMigrationSource = fs.readFileSync(path.join(__dirname, '..', 'database', 'migrate-piece-rate-payroll.js'), 'utf8');
  assert.match(pieceRateSeedSource, /HT: Object\.freeze\(\{[\s\S]*?'14-19': '0\.2786'/,
    'The client piece-rate matrix must configure the HT sewing type.');
  assert.doesNotMatch(pieceRateSeedSource, /MS: Object\.freeze\(/,
    'The client piece-rate matrix must not activate MS as a duplicate of HT.');
  assert.match(historicalSeedSource, /Historical workbook import is blocked in production/,
    'The client workbook importer must remain local-only.');
  assert.match(historicalSeedSource, /is already payroll-locked/,
    'The client workbook importer must not overwrite payroll-locked output.');
  assert.match(historicalSeedSource, /client_sewing_workbook_imported/,
    'The client workbook importer must create an audit entry.');
  assert.doesNotMatch(historicalSeedSource, /require\(['"]xlsx['"]\)/,
    'The confirmed workflow must not silently bulk-import spreadsheet rows.');
  assert.match(confirmedHistoricalSource, /firstName: 'Irene'/,
    'The confirmed source must retain the client-approved sewer name locally.');
  assert.match(confirmedHistoricalSource, /firstName: 'Clariza'/,
    'The confirmed source must retain the mapped fixer name locally.');
  assert.match(confirmedHistoricalSource, /output\('2026-05-31', 'HL', '24-26', 700\)/,
    'The confirmed source must include the May 31 records.');
  assert.match(confirmedHistoricalSource, /totalQuantity: 20699/,
    'The confirmed Irene source must preserve the 20,699-piece total.');
  assert.match(confirmedHistoricalSource, /sewerShare: '4113\.69'/,
    'The confirmed Irene source must preserve the client 55% total.');
  assert.match(confirmedHistoricalSource, /fixerShare: '3365\.75'/,
    'The confirmed Irene source must preserve the client 45% total.');
  assert.match(pieceRateMigrationSource, /\('HT', 'HT sewing operation'/,
    'Fresh piece-rate schemas must seed the official HT sewing type.');
  assert.doesNotMatch(pieceRateMigrationSource, /\('MS', 'MS sewing operation'/,
    'Fresh piece-rate schemas must not seed MS as a duplicate of HT.');
  assert.match(reportsSource, /function reportPieceRate[\s\S]*?minimumFractionDigits: 4,[\s\S]*?maximumFractionDigits: 4/,
    'Printed piece-rate registries must display all configured rates to four decimal places.');
  assert.match(payrollSource, /function pieceRatePeso[\s\S]*?minimumFractionDigits: 4,[\s\S]*?maximumFractionDigits: 4/,
    'Server-generated piece-rate reports must retain four-decimal rate precision.');

  const payrollUiSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'payroll.js'), 'utf8');
  assert.match(payrollUiSource, /piece_rate: Number\(row\.piece_rate \|\| 0\)\.toFixed\(4\)/,
    'Editing a configured piece rate must preserve four decimal places in the input.');

  console.log('Payroll piece-rate auth tests: PASS');
})()
  .finally(() => require('../config/db').end());
