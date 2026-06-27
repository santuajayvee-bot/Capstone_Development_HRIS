const express = require('express');
const pool = require('../config/db');
const { requireAuth, requireRole, ROLES } = require('./middleware');
const { auditSecurityEvent } = require('./security-controls');
const {
  cleanText,
  listHolidays,
  normalizeHolidayPayload,
  syncNagerDateHolidays,
  upsertHoliday,
} = require('./holiday-service');

const router = express.Router();

const HOLIDAY_VIEW_ROLES = [
  ...ROLES.hr_ops,
  ...ROLES.payroll_any,
  ...ROLES.admin_any,
];
const HOLIDAY_MANAGE_ROLES = [
  ...ROLES.hr_ops,
  ...ROLES.admin_any,
];

function actorId(req) {
  return req.user?.id || req.user?.userId || null;
}

function isoDate(value) {
  if (!value) return '';
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

router.get('/', requireAuth, requireRole(HOLIDAY_VIEW_ROLES), async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const countryCode = req.query.country_code || 'PH';
    const activeOnly = req.query.active === 'all' ? false : true;
    const rows = await listHolidays(pool, { year, countryCode, activeOnly });
    res.json(rows);
  } catch (error) {
    console.error('[holidays:list]', error.message);
    res.status(400).json({ error: error.message || 'Failed to fetch holiday calendar.' });
  }
});

router.post('/sync', requireAuth, requireRole(HOLIDAY_MANAGE_ROLES), async (req, res) => {
  try {
    const year = Number(req.body?.year || new Date().getFullYear());
    const countryCode = cleanText(req.body?.country_code || 'PH', 2).toUpperCase();
    const synced = await syncNagerDateHolidays(pool, { year, countryCode, actorId: actorId(req) });
    await auditSecurityEvent(req, {
      action: 'holiday_calendar_synced',
      module: 'ATTENDANCE',
      targetTable: 'holiday_calendar',
      newValue: { year, country_code: countryCode, count: synced.length, source: 'NAGER_DATE' },
      result: 'allowed',
    });
    res.json({ message: `Synced ${synced.length} holiday(s) for ${countryCode} ${year}.`, count: synced.length, holidays: synced });
  } catch (error) {
    console.error('[holidays:sync]', error.message);
    res.status(400).json({ error: error.message || 'Failed to sync holiday calendar.' });
  }
});

router.post('/', requireAuth, requireRole(HOLIDAY_MANAGE_ROLES), async (req, res) => {
  try {
    const holiday = await upsertHoliday(pool, { ...req.body, actor_id: actorId(req), source: req.body?.source || 'MANUAL' });
    await auditSecurityEvent(req, {
      action: 'holiday_calendar_saved',
      module: 'ATTENDANCE',
      targetTable: 'holiday_calendar',
      targetRecord: holiday.holiday_date,
      newValue: holiday,
      result: 'allowed',
    });
    res.status(201).json({ message: 'Holiday saved.', holiday });
  } catch (error) {
    console.error('[holidays:post]', error.message);
    res.status(400).json({ error: error.message || 'Failed to save holiday.' });
  }
});

router.put('/:holidayId', requireAuth, requireRole(HOLIDAY_MANAGE_ROLES), async (req, res) => {
  try {
    const holidayId = Number(req.params.holidayId);
    if (!Number.isInteger(holidayId) || holidayId <= 0) return res.status(400).json({ error: 'holidayId is invalid.' });
    const [rows] = await pool.execute('SELECT * FROM holiday_calendar WHERE holiday_id = ? LIMIT 1', [holidayId]);
    if (!rows.length) return res.status(404).json({ error: 'Holiday not found.' });
    const existing = rows[0];
    const payload = normalizeHolidayPayload({
      ...existing,
      ...req.body,
      holiday_date: req.body.holiday_date || isoDate(existing.holiday_date),
      country_code: req.body.country_code || existing.country_code,
      source: req.body.source || existing.source || 'MANUAL',
    }, actorId(req));
    await pool.execute(
      `UPDATE holiday_calendar
          SET holiday_date = ?,
              country_code = ?,
              local_name = ?,
              name = ?,
              holiday_type = ?,
              multiplier = ?,
              is_paid = ?,
              is_active = ?,
              source = ?,
              updated_by = ?
        WHERE holiday_id = ?`,
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
        actorId(req),
        holidayId,
      ]
    );
    await auditSecurityEvent(req, {
      action: 'holiday_calendar_updated',
      module: 'ATTENDANCE',
      targetTable: 'holiday_calendar',
      targetRecord: holidayId,
      oldValue: existing,
      newValue: payload,
      result: 'allowed',
    });
    res.json({ message: 'Holiday updated.', holiday: { holiday_id: holidayId, ...payload } });
  } catch (error) {
    console.error('[holidays:put]', error.message);
    res.status(400).json({ error: error.message || 'Failed to update holiday.' });
  }
});

module.exports = router;
