const assert = require('assert');
const { selectCurrentStatutoryDeductions } = require('../server/services/statutoryDeductionSelection');

async function run() {
  const selected = selectCurrentStatutoryDeductions([
    { id: 1, name: 'SSS', effective_date: '2026-05-28', rate_or_amount: 4.5 },
    { id: 2, name: 'SSS', effective_date: '2026-06-05', rate_or_amount: 1.25 },
    { id: 3, name: 'PhilHealth', effective_date: '2026-05-28', rate_or_amount: 2.75 },
    { id: 4, name: 'PhilHealth', effective_date: '2026-06-05', rate_or_amount: 0.63 },
    { id: 5, name: 'Pag-IBIG', effective_date: '2026-05-28', rate_or_amount: 2 },
    { id: 6, name: 'Withholding Tax', effective_date: '2026-06-05', rate_or_amount: 4.75 },
  ]);

  assert.strictEqual(selected.length, 3);
  assert.deepStrictEqual(
    selected.map(row => [row.name, Number(row.rate_or_amount)]).sort((a, b) => a[0].localeCompare(b[0])),
    [['Pag-IBIG', 2], ['PhilHealth', 0.63], ['SSS', 1.25]]
  );

  console.log('Statutory deduction selection test: PASS');
}

run().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
