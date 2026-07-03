const MAX_ABSENCE_RANGE_DAYS = 31;

function dateKey(value, label) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const error = new Error(`${label} must use YYYY-MM-DD format.`);
    error.statusCode = 400;
    throw error;
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    const error = new Error(`${label} is invalid.`);
    error.statusCode = 400;
    throw error;
  }
  return text;
}

function addDays(value, days) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function absenceDateKeys(filters = {}, todayValue) {
  const today = dateKey(todayValue, 'today');
  let start = today;
  let end = today;

  if (filters.date) {
    start = dateKey(filters.date, 'date');
    end = start;
  } else if (filters.dateFrom || filters.dateTo) {
    start = dateKey(filters.dateFrom || filters.dateTo, filters.dateFrom ? 'date_from' : 'date_to');
    end = dateKey(filters.dateTo || today, filters.dateTo ? 'date_to' : 'today');
  } else if (filters.month && filters.year) {
    const month = Number(filters.month);
    const year = Number(filters.year);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 1900 || year > 2200) {
      const error = new Error('month and year are invalid.');
      error.statusCode = 400;
      throw error;
    }
    start = `${year}-${String(month).padStart(2, '0')}-01`;
    end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  }

  if (start > end) {
    const error = new Error('date_from cannot be after date_to.');
    error.statusCode = 400;
    throw error;
  }
  if (start > today) return [];
  if (end > today) end = today;

  const dates = [];
  for (let current = start; current <= end; current = addDays(current, 1)) {
    dates.push(current);
    if (dates.length > MAX_ABSENCE_RANGE_DAYS) {
      const error = new Error(`Absent filtering is limited to ${MAX_ABSENCE_RANGE_DAYS} days.`);
      error.statusCode = 400;
      throw error;
    }
  }
  return dates;
}

function workingAbsenceDateKeys(dates) {
  return dates.filter(value => new Date(`${value}T00:00:00.000Z`).getUTCDay() !== 0);
}

async function loadSyntheticAbsenceRows(pool, {
  dates = [],
  search = '',
  department = '',
} = {}) {
  const workDates = workingAbsenceDateKeys(dates);
  if (!workDates.length) return [];

  const calendarSql = workDates.map(() => 'SELECT CAST(? AS DATE) AS attendance_date').join(' UNION ALL ');
  const conditions = [
    "LOWER(COALESCE(e.status, 'Active')) NOT IN ('inactive', 'resigned', 'terminated', 'separated', 'offboarded')",
    '(e.date_hired IS NULL OR e.date_hired <= calendar.attendance_date)',
    'al.attendance_id IS NULL',
    'ats.summary_id IS NULL',
    `NOT EXISTS (
      SELECT 1
        FROM leave_requests lr
       WHERE lr.employee_id = e.id
         AND lr.status = 'Approved'
         AND calendar.attendance_date BETWEEN lr.date_from AND lr.date_to
    )`,
  ];
  const values = [...workDates];
  if (search) {
    conditions.push('(e.employee_code LIKE ? OR e.first_name LIKE ? OR e.last_name LIKE ?)');
    values.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (department) {
    conditions.push('d.name = ?');
    values.push(department);
  }

  const [rows] = await pool.execute(
    `SELECT NULL AS attendance_id, e.id AS employee_id,
            DATE_FORMAT(calendar.attendance_date, '%Y-%m-%d') AS date,
            NULL AS time_in, NULL AS time_out,
            NULL AS am_time_in, NULL AS am_time_out, NULL AS pm_time_in, NULL AS pm_time_out,
            0 AS overtime_hours, 0 AS late_minutes, 0 AS undertime_minutes, 0 AS overtime_minutes,
            'NONE' AS overtime_status, NULL AS overtime_reviewed_at, NULL AS overtime_review_reason,
            'Absent' AS status, 'MISSING' AS verification_status,
            0 AS regular_minutes, 0 AS summary_overtime_minutes,
            'NONE' AS summary_overtime_status, 0 AS summary_late_minutes,
            0 AS summary_undertime_minutes, 'Absent' AS attendance_status,
            0 AS payroll_eligible, 30 AS minimum_overtime_minutes,
            e.first_name, e.middle_name, e.last_name, e.employee_code,
            d.name AS department, e.position
       FROM employees e
       JOIN (${calendarSql}) calendar
       LEFT JOIN departments d ON d.id = e.department_id
       LEFT JOIN attendance_log al
         ON al.employee_id = e.id AND al.date = calendar.attendance_date
       LEFT JOIN attendance_summary ats
         ON ats.employee_id = e.id AND ats.attendance_date = calendar.attendance_date
      WHERE ${conditions.join(' AND ')}
      ORDER BY calendar.attendance_date DESC, e.last_name, e.first_name
      LIMIT 500`,
    values
  );
  return rows;
}

module.exports = {
  MAX_ABSENCE_RANGE_DAYS,
  absenceDateKeys,
  loadSyntheticAbsenceRows,
  workingAbsenceDateKeys,
};
