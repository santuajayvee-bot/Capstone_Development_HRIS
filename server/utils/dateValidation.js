function todayManilaDateKey() {
  return new Date(Date.now() + (8 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function dateObjectToManilaDateKey(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const byType = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function isStrictDateOnly(value) {
  const text = String(value || '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function strictDateOnly(value, field = 'Date', options = {}) {
  const text = String(value || '').trim();
  if (!isStrictDateOnly(text)) {
    const error = new Error(`${field} must be a valid date using YYYY-MM-DD format.`);
    error.status = 400;
    error.statusCode = 400;
    throw error;
  }
  const today = todayManilaDateKey();
  if (options.noFuture && text > today) {
    const error = new Error(`${field} cannot be in the future.`);
    error.status = 400;
    error.statusCode = 400;
    throw error;
  }
  if (options.noPast && text < today) {
    const error = new Error(`${field} cannot be in the past.`);
    error.status = 400;
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function databaseDateOnly(value, field = 'Date', options = {}) {
  const normalized = value instanceof Date ? dateObjectToManilaDateKey(value) : value;
  return strictDateOnly(normalized, field, options);
}

function optionalDateOnly(value, field = 'Date', options = {}) {
  if (value === null || value === undefined || value === '') return null;
  return strictDateOnly(value, field, options);
}

function utcDateMs(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function inclusiveDays(startDate, endDate) {
  return Math.floor((utcDateMs(endDate) - utcDateMs(startDate)) / 86400000) + 1;
}

function yearFromDateOnly(value) {
  const text = value instanceof Date && !Number.isNaN(value.getTime())
    ? value.toISOString().slice(0, 10)
    : String(value || '').slice(0, 10);
  return Number(strictDateOnly(text, 'Date').slice(0, 4));
}

module.exports = {
  databaseDateOnly,
  inclusiveDays,
  isStrictDateOnly,
  optionalDateOnly,
  strictDateOnly,
  todayManilaDateKey,
  yearFromDateOnly,
};
