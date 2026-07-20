'use strict';

const POWERS_OF_TEN = Array.from({ length: 13 }, (_, index) => 10n ** BigInt(index));

function decimalToScaledInteger(value, scale, label) {
  const text = String(value ?? 0).trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
  if (!match) throw new Error(`${label} must be a plain decimal value.`);

  const fraction = match[3] || '';
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) {
    throw new Error(`${label} exceeds the supported ${scale}-decimal precision.`);
  }

  const units = (BigInt(match[2]) * POWERS_OF_TEN[scale])
    + BigInt(fraction.slice(0, scale).padEnd(scale, '0') || '0');
  return match[1] === '-' ? -units : units;
}

function divideRoundHalfUp(value, divisor) {
  if (divisor <= 0n) throw new Error('Rounding divisor must be positive.');
  if (value < 0n) return -divideRoundHalfUp(-value, divisor);
  return (value + (divisor / 2n)) / divisor;
}

function centsToNumber(cents) {
  return Number(cents) / 100;
}

function calculatePieceShareCents(rows = []) {
  const exactScaleEightUnits = rows.reduce((sum, row) => {
    const quantity = decimalToScaledInteger(
      row.quantity_produced ?? row.quantity ?? 0,
      2,
      'Piece quantity'
    );
    const rate = decimalToScaledInteger(
      row.rate_per_piece ?? row.piece_rate ?? row.rate ?? 0,
      4,
      'Piece rate'
    );
    const percentage = decimalToScaledInteger(
      row.share_percentage ?? row.percentage ?? 100,
      2,
      'Piece share percentage'
    );
    return sum + (quantity * rate * percentage);
  }, 0n);

  // quantity(2) * rate(4) * percentage(2) = scale 8, then percentage / 100.
  return divideRoundHalfUp(exactScaleEightUnits, POWERS_OF_TEN[8]);
}

function calculatePieceShareTotal(rows = []) {
  return centsToNumber(calculatePieceShareCents(rows));
}

function calculateProductionShareTotal(fullProduction, percentage) {
  const production = decimalToScaledInteger(fullProduction, 6, 'Full production amount');
  const share = decimalToScaledInteger(percentage, 2, 'Piece share percentage');
  return centsToNumber(divideRoundHalfUp(production * share, POWERS_OF_TEN[8]));
}

module.exports = {
  calculatePieceShareCents,
  calculatePieceShareTotal,
  calculateProductionShareTotal,
};
