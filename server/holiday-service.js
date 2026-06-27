const VALID_HOLIDAY_TYPES = new Set(['REGULAR', 'SPECIAL_NON_WORKING', 'SPECIAL_WORKING', 'COMPANY', 'OTHER']);
const REGULAR_HOLIDAY_PATTERNS = [
  /new year/i,
  /maundy/i,
  /good friday/i,
  /araw ng kagitingan/i,
  /day of valor/i,
  /labor day/i,
  /independence day/i,
  /national heroes/i,
  /bonifacio/i,
  /christmas day/i,
  /rizal/i,
  /eid/i,
];
const SPECIAL_HOLIDAY_PATTERNS = [
  /special/i,
  /chinese new year/i,
  /edsa/i,
  /black saturday/i,
  /ninoy aquino/i,
  /all saints/i,
  /all souls/i,
  /immaculate conception/i,
  /christmas eve/i,
  /last day of the year/i,
  /new year's eve/i,
];

function cleanText(value, maxLength = 500) {
  return String(value ?? '').trim().replace(/[<>]/g, '').slice(0, maxLength);
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function normalizeCountryCode(value = 'PH') {
  const code = cleanText(value || 'PH', 2).toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : 'PH';
}

function normalizeHolidayType(value, fallback = 'REGULAR') {
  const normalized = cleanText(value, 40).toUpperCase();
  return VALID_HOLIDAY_TYPES.has(normalized) ? normalized : fallback;
}

function defaultMultiplier(type) {
  switch (normalizeHolidayType(type, 'OTHER')) {
    case 'REGULAR':
      return 2;
    case 'SPECIAL_NON_WORKING':
      return 1.3;
    case 'SPECIAL_WORKING':
      return 1;
    default:
      return 1;
  }
}

function classifyPhilippineHoliday(holiday) {
  const text = `${holiday?.localName || ''} ${holiday?.name || ''}`;
  if (SPECIAL_HOLIDAY_PATTERNS.some(pattern => pattern.test(text))) return 'SPECIAL_NON_WORKING';
  if (REGULAR_HOLIDAY_PATTERNS.some(pattern => pattern.test(text))) return 'REGULAR';
  return 'REGULAR';
}

function normalizeHolidayPayload(body = {}, actorId = null) {
  const holidayDate = cleanText(body.holiday_date || body.date, 10);
  if (!isDate(holidayDate)) throw new Error('holiday_date must use YYYY-MM-DD format.');
  const countryCode = normalizeCountryCode(body.country_code);
  const name = cleanText(body.name || body.local_name, 190);
  if (!name) throw new Error('Holiday name is required.');
  const holidayType = normalizeHolidayType(body.holiday_type || body.type);
  const multiplier = Number(body.multiplier ?? defaultMultiplier(holidayType));
  if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 5) {
    throw new Error('Holiday multiplier must be between 0 and 5.');
  }
  return {
    holiday_date: holidayDate,
    country_code: countryCode,
    local_name: cleanText(body.local_name || name, 190) || name,
    name,
    holiday_type: holidayType,
    multiplier: Number(multiplier.toFixed(2)),
    is_paid: body.is_paid === false || body.is_paid === 0 || body.is_paid === 'false' ? 0 : 1,
    is_active: body.is_active === false || body.is_active === 0 || body.is_active === 'false' ? 0 : 1,
    source: cleanText(body.source || 'MANUAL', 40).toUpperCase(),
    source_id: cleanText(body.source_id || null, 190) || null,
    source_payload: body.source_payload ? JSON.stringify(body.source_payload) : null,
    actor_id: actorId || null,
  };
}

function normalizeHolidayRow(row) {
  if (!row) return null;
  return {
    ...row,
    multiplier: Number(row.multiplier || 0),
    is_paid: Number(row.is_paid || 0) === 1,
    is_active: Number(row.is_active || 0) === 1,
  };
}

async function listHolidays(pool, { year, countryCode = 'PH', activeOnly = true } = {}) {
  const conditions = ['country_code = ?'];
  const values = [normalizeCountryCode(countryCode)];
  if (year) {
    const numericYear = Number(year);
    if (!Number.isInteger(numericYear) || numericYear < 1900 || numericYear > 2200) throw new Error('year is invalid.');
    conditions.push('YEAR(holiday_date) = ?');
    values.push(numericYear);
  }
  if (activeOnly) conditions.push('is_active = 1');
  const [rows] = await pool.execute(
    `SELECT *
       FROM holiday_calendar
      WHERE ${conditions.join(' AND ')}
      ORDER BY holiday_date, name`,
    values
  );
  return rows.map(normalizeHolidayRow);
}

async function getHolidayForDate(pool, date, countryCode = 'PH') {
  if (!isDate(date)) return null;
  try {
    const [rows] = await pool.execute(
      `SELECT *
         FROM holiday_calendar
        WHERE holiday_date = ?
          AND country_code = ?
          AND is_active = 1
        LIMIT 1`,
      [date, normalizeCountryCode(countryCode)]
    );
    return normalizeHolidayRow(rows[0] || null);
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') return null;
    throw error;
  }
}

async function upsertHoliday(pool, holiday) {
  const payload = normalizeHolidayPayload(holiday, holiday.actor_id);
  const [result] = await pool.execute(
    `INSERT INTO holiday_calendar
       (holiday_date, country_code, local_name, name, holiday_type, multiplier,
        is_paid, is_active, source, source_id, source_payload, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       local_name = VALUES(local_name),
       name = VALUES(name),
       holiday_type = VALUES(holiday_type),
       multiplier = VALUES(multiplier),
       is_paid = VALUES(is_paid),
       is_active = VALUES(is_active),
       source = VALUES(source),
       source_id = VALUES(source_id),
       source_payload = VALUES(source_payload),
       updated_by = VALUES(updated_by)`,
    [
      payload.holiday_date,
      payload.country_code,
      payload.local_name,
      payload.name,
      payload.holiday_type,
      payload.multiplier,
      payload.is_paid,
      payload.is_active,
      payload.source,
      payload.source_id,
      payload.source_payload,
      payload.actor_id,
      payload.actor_id,
    ]
  );
  return { ...payload, affected_rows: result.affectedRows };
}

async function fetchNagerDateHolidays(year, countryCode = 'PH') {
  const numericYear = Number(year);
  if (!Number.isInteger(numericYear) || numericYear < 1900 || numericYear > 2200) {
    throw new Error('year is invalid.');
  }
  const code = normalizeCountryCode(countryCode);
  const url = `https://date.nager.at/api/v3/PublicHolidays/${numericYear}/${code}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Holiday provider returned HTTP ${response.status}.`);
  const data = await response.json();
  if (!Array.isArray(data)) throw new Error('Holiday provider returned an invalid response.');
  return data;
}

async function syncNagerDateHolidays(pool, { year, countryCode = 'PH', actorId = null } = {}) {
  const providerRows = await fetchNagerDateHolidays(year, countryCode);
  const synced = [];
  for (const row of providerRows) {
    const holidayType = classifyPhilippineHoliday(row);
    const holiday = await upsertHoliday(pool, {
      holiday_date: row.date,
      country_code: countryCode,
      local_name: row.localName || row.name,
      name: row.name || row.localName,
      holiday_type: holidayType,
      multiplier: defaultMultiplier(holidayType),
      is_paid: true,
      is_active: true,
      source: 'NAGER_DATE',
      source_id: `${countryCode}:${row.date}:${row.name || row.localName}`,
      source_payload: row,
      actor_id: actorId,
    });
    synced.push(holiday);
  }
  return synced;
}

module.exports = {
  VALID_HOLIDAY_TYPES,
  cleanText,
  defaultMultiplier,
  getHolidayForDate,
  isDate,
  listHolidays,
  normalizeCountryCode,
  normalizeHolidayPayload,
  normalizeHolidayType,
  syncNagerDateHolidays,
  upsertHoliday,
};
