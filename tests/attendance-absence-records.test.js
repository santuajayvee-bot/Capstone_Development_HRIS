const assert = require('assert');
const {
  absenceDateKeys,
  loadSyntheticAbsenceRows,
  workingAbsenceDateKeys,
} = require('../server/attendance-absence');

assert.deepStrictEqual(absenceDateKeys({}, '2026-07-03'), ['2026-07-03']);
assert.deepStrictEqual(
  absenceDateKeys({ dateFrom: '2026-07-01', dateTo: '2026-07-03' }, '2026-07-03'),
  ['2026-07-01', '2026-07-02', '2026-07-03']
);
assert.deepStrictEqual(
  workingAbsenceDateKeys(['2026-07-03', '2026-07-05', '2026-07-06']),
  ['2026-07-03', '2026-07-06'],
  'Sundays must not be synthesized as absences.'
);
assert.deepStrictEqual(absenceDateKeys({ date: '2026-07-04' }, '2026-07-03'), []);
assert.throws(
  () => absenceDateKeys({ dateFrom: '2026-05-01', dateTo: '2026-07-03' }, '2026-07-03'),
  /limited to 31 days/
);

(async () => {
  let capturedSql = '';
  let capturedValues = [];
  const pool = {
    async execute(sql, values) {
      capturedSql = sql;
      capturedValues = values;
      return [[{ employee_id: 64, date: '2026-07-03', attendance_status: 'Absent' }]];
    },
  };
  const rows = await loadSyntheticAbsenceRows(pool, {
    dates: ['2026-07-03'],
    search: 'EMP000064',
    department: 'Engineering',
  });
  assert.strictEqual(rows.length, 1);
  assert.match(capturedSql, /al\.attendance_id IS NULL/);
  assert.match(capturedSql, /ats\.summary_id IS NULL/);
  assert.match(capturedSql, /lr\.status = 'Approved'/);
  assert.deepStrictEqual(capturedValues, ['2026-07-03', '%EMP000064%', '%EMP000064%', '%EMP000064%', 'Engineering']);
  console.log('Attendance absence record tests: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
