const TRIP_TYPES = Object.freeze(['1st Trip', '2nd Trip', 'Additional Trip']);
const RATE_TRIP_TYPES = Object.freeze([...TRIP_TYPES, 'Any']);
const TRIP_ROLES = Object.freeze(['Driver', 'Helper']);
const TRIP_STATUSES = Object.freeze(['Draft', 'Submitted', 'Approved', 'Included in Payroll', 'Rejected']);

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function isTripBasedWageType(value) {
  return /(per[-\s]?trip|trip[-\s]?based|logistics)/i.test(String(value || ''));
}

function normalizeTripType(value, { allowAny = false } = {}) {
  const text = String(value || '').trim().toLowerCase();
  const map = {
    '1': '1st Trip', '1st': '1st Trip', '1st trip': '1st Trip', 'first': '1st Trip', 'first trip': '1st Trip',
    '2': '2nd Trip', '2nd': '2nd Trip', '2nd trip': '2nd Trip', 'second': '2nd Trip', 'second trip': '2nd Trip',
    'additional': 'Additional Trip', 'additional trip': 'Additional Trip', '3rd trip': 'Additional Trip',
    'any': 'Any'
  };
  const normalized = map[text] || '';
  if (!normalized || (!allowAny && normalized === 'Any')) throw new Error('Trip type must be 1st Trip, 2nd Trip, or Additional Trip.');
  return normalized;
}

function normalizeTripRole(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'driver') return 'Driver';
  if (text === 'helper') return 'Helper';
  throw new Error('Role must be Driver or Helper.');
}

function normalizeTripStatus(value) {
  const text = String(value || '').trim().toLowerCase();
  const matched = TRIP_STATUSES.find(status => status.toLowerCase() === text);
  if (!matched) throw new Error('Invalid delivery-trip status.');
  return matched;
}

function computeTripPay({ baseRate, multiplier, additionalRate }) {
  const base = Number(baseRate);
  const factor = Number(multiplier);
  const additional = Number(additionalRate || 0);
  if (!Number.isFinite(base) || base < 0) throw new Error('Base rate must be a valid non-negative amount.');
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('Multiplier must be greater than zero.');
  if (!Number.isFinite(additional) || additional < 0) throw new Error('Additional rate must be a valid non-negative amount.');
  return roundMoney((base * factor) + additional);
}

async function findActiveLogisticsRate(pool, { truckTypeId, locationId, tripType, role, tripDate }) {
  const normalizedTripType = normalizeTripType(tripType);
  const normalizedRole = normalizeTripRole(role);
  const [rows] = await pool.execute(`
    SELECT r.*, tt.name AS truck_type, ll.name AS location_name, ll.location_category
      FROM logistics_rates r
      JOIN truck_types tt ON tt.id = r.truck_type_id
      JOIN logistics_locations ll ON ll.id = r.location_id
     WHERE r.truck_type_id = ?
       AND r.location_id = ?
       AND r.role = ?
       AND r.status = 'Active'
       AND r.trip_type IN (?, 'Any')
       AND r.effective_date <= ?
     ORDER BY CASE WHEN r.trip_type = ? THEN 0 ELSE 1 END,
              r.effective_date DESC,
              r.id DESC
     LIMIT 1
  `, [Number(truckTypeId), Number(locationId), normalizedRole, normalizedTripType, tripDate, normalizedTripType]);
  return rows[0] || null;
}

module.exports = {
  TRIP_TYPES,
  RATE_TRIP_TYPES,
  TRIP_ROLES,
  TRIP_STATUSES,
  roundMoney,
  isTripBasedWageType,
  normalizeTripType,
  normalizeTripRole,
  normalizeTripStatus,
  computeTripPay,
  findActiveLogisticsRate,
};
