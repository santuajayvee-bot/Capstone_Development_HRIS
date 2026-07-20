const assert = require('assert');
const {
  calculatePieceShareCents,
  calculatePieceShareTotal,
  calculateProductionShareTotal,
} = require('../services/pieceRateMath');

const clientGrandProduction = '96423.694900';

assert.strictEqual(
  calculateProductionShareTotal(clientGrandProduction, '55.00'),
  53033.03,
  'The corrected 55% SEWING source total must round only after exact aggregation.'
);
assert.strictEqual(
  calculateProductionShareTotal(clientGrandProduction, '45.00'),
  43390.66,
  'The corrected 45% SEWING source total must round only after exact aggregation.'
);

assert.notStrictEqual(
  calculateProductionShareTotal(clientGrandProduction, '55.00'),
  54113.07,
  'The known client 55-sheet formula overstatement must not be treated as actual production.'
);

assert.strictEqual(
  calculateProductionShareTotal(clientGrandProduction, '55.00')
    + calculateProductionShareTotal(clientGrandProduction, '45.00'),
  96423.69,
  'The exact 55% and 45% allocations must reconcile to one full production amount.'
);

const dailyRows = [
  { quantity_produced: '1425.00', rate_per_piece: '0.3000', share_percentage: '55.00' },
  { quantity_produced: '2125.00', rate_per_piece: '0.3000', share_percentage: '55.00' },
  { quantity_produced: '2275.00', rate_per_piece: '0.3000', share_percentage: '55.00' },
];
assert.strictEqual(calculatePieceShareCents(dailyRows), 96113n);
assert.strictEqual(calculatePieceShareTotal(dailyRows), 961.13);
assert.notStrictEqual(
  dailyRows.reduce((sum, row) => sum + Math.round(Number(row.quantity_produced) * Number(row.rate_per_piece) * 0.55 * 100), 0) / 100,
  calculatePieceShareTotal(dailyRows),
  'Rounding each daily row must not replace exact aggregate rounding.'
);

assert.throws(
  () => calculatePieceShareTotal([{ quantity: 1, rate: '0.43355', percentage: 55 }]),
  /exceeds the supported 4-decimal precision/,
  'Unsupported rate precision must fail instead of being silently truncated.'
);

console.log('Fixed-point piece-rate math tests: PASS');
