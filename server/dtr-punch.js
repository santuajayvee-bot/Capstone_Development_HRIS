function minutesFromTime(value) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isLaterTime(candidate, current) {
  const candidateMinutes = minutesFromTime(candidate);
  const currentMinutes = minutesFromTime(current);
  return candidateMinutes !== null && currentMinutes !== null && candidateMinutes > currentMinutes;
}

function classifyDtrPunch(record, scanTime, policy, scanType = 'AUTO') {
  const scanMinutes = minutesFromTime(scanTime);
  const type = String(scanType || 'AUTO').toUpperCase();

  if (scanMinutes === null) {
    return { status: 'invalid', error: 'Scan time is invalid.' };
  }

  if (type === 'TIME_IN') {
    if (record?.time_in) return { status: 'duplicate', slot: 'time_in' };
    return { status: 'accepted', slot: 'time_in', attendanceType: 'TIME_IN' };
  }

  if (type === 'TIME_OUT') {
    if (record?.time_out && isLaterTime(scanTime, record.time_out)) {
      return { status: 'accepted', slot: 'time_out', attendanceType: 'TIME_OUT', updateExisting: true };
    }
    if (record?.time_out) return { status: 'duplicate', slot: 'time_out' };
    return { status: 'accepted', slot: 'time_out', attendanceType: 'TIME_OUT' };
  }

  if (!record?.time_in) {
    return { status: 'accepted', slot: 'time_in', attendanceType: 'TIME_IN' };
  }

  if (!record.time_out) {
    return { status: 'accepted', slot: 'time_out', attendanceType: 'TIME_OUT' };
  }

  if (isLaterTime(scanTime, record.time_out)) {
    return { status: 'accepted', slot: 'time_out', attendanceType: 'TIME_OUT', updateExisting: true };
  }
  return { status: 'duplicate', slot: 'time_out' };
}

function dtrUpdateValues(record, slot, scanTime) {
  const next = {
    time_in: record?.time_in || null,
    time_out: record?.time_out || null,
  };
  next[slot] = scanTime;
  next.am_time_in = next.time_in;
  next.am_time_out = null;
  next.pm_time_in = null;
  next.pm_time_out = next.time_out;
  return next;
}

function missingDtrPunches(record) {
  const missing = [];
  if (!record?.time_in) missing.push('Time in');
  if (!record?.time_out) missing.push('Time out');
  return missing;
}

function hasRequiredDtrPunches(record) {
  return missingDtrPunches(record).length === 0;
}

module.exports = {
  classifyDtrPunch,
  dtrUpdateValues,
  hasRequiredDtrPunches,
  isLaterTime,
  missingDtrPunches,
  minutesFromTime,
};
