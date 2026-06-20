function statutoryDeductionKey(name) {
  const normalized = String(name || '').trim().toLowerCase().replace(/[\s-]+/g, '');
  if (normalized === 'sss') return 'SSS';
  if (normalized === 'philhealth') return 'PhilHealth';
  if (normalized === 'pagibig') return 'Pag-IBIG';
  return null;
}

function settingIsNewer(candidate, current) {
  const candidateDate = String(candidate.effective_date || '').slice(0, 10);
  const currentDate = String(current.effective_date || '').slice(0, 10);
  if (candidateDate !== currentDate) return candidateDate > currentDate;
  return Number(candidate.id || 0) > Number(current.id || 0);
}

// A current statutory rate supersedes earlier versions of the same deduction.
function selectCurrentStatutoryDeductions(settings) {
  const currentByName = new Map();
  for (const setting of settings || []) {
    const key = statutoryDeductionKey(setting.name);
    if (!key) continue;
    const current = currentByName.get(key);
    if (!current || settingIsNewer(setting, current)) {
      currentByName.set(key, { ...setting, name: key });
    }
  }
  return [...currentByName.values()];
}

module.exports = { selectCurrentStatutoryDeductions };
