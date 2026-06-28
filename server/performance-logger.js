function startPerformanceTimer(operationName, initial = {}) {
  return {
    operationName,
    startTime: new Date(),
    startNs: process.hrtime.bigint(),
    employeesProcessed: Number(initial.employeesProcessed || initial.employeeCount || 0),
    payrollPeriod: initial.payrollPeriod || null,
    metadata: initial.metadata || null,
  };
}

function normalizePerformanceBatchSize(value) {
  if (value === undefined || value === null || value === '') return null;
  const size = Number(value);
  if (![10, 50, 100].includes(size)) {
    throw new Error('performance_batch_size must be one of 10, 50, or 100.');
  }
  return size;
}

function operationLabel(operationName) {
  const labels = {
    payroll_generation: 'Payroll generation',
    payroll_generation_preview: 'Payroll generation preview',
    salary_calculation_save: 'Salary calculation save',
    salary_calculation_submit: 'Salary calculation submit',
    salary_calculation_submit_for_approval: 'Salary calculation submit for approval',
  };
  if (labels[operationName]) return labels[operationName];
  return String(operationName || '')
    .replace(/_/g, ' ')
    .replace(/^\w/, char => char.toUpperCase());
}

async function savePerformanceLog(db, payload) {
  if (!db?.execute) return;
  try {
    await db.execute(
      `INSERT INTO performance_logs
         (operation_name, employees_processed, payroll_period, start_time, end_time, duration_ms, status, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        payload.operationName,
        payload.employeesProcessed,
        payload.payrollPeriod,
        payload.startTime,
        payload.endTime,
        payload.durationMs,
        payload.status,
        payload.metadata ? JSON.stringify(payload.metadata) : null,
      ]
    );
  } catch (error) {
    if (!/performance_logs|ER_NO_SUCH_TABLE/i.test(error.message || '')) {
      console.warn('[performance] Failed to save performance log:', error.message);
    }
  }
}

async function completePerformanceLog(db, timer, details = {}) {
  if (!timer) return null;
  const endTime = new Date();
  const durationMs = Number((process.hrtime.bigint() - timer.startNs) / 1000000n);
  const payload = {
    operationName: timer.operationName,
    employeesProcessed: Number(details.employeesProcessed ?? timer.employeesProcessed ?? 0),
    payrollPeriod: details.payrollPeriod || timer.payrollPeriod || null,
    startTime: timer.startTime,
    endTime,
    durationMs,
    status: details.status === 'failed' ? 'failed' : 'success',
    metadata: details.metadata || timer.metadata || null,
  };

  const label = operationLabel(payload.operationName);
  const verb = payload.status === 'success' ? 'completed' : 'failed';
  console.log(`${label} ${verb} for ${payload.employeesProcessed} employees in ${payload.durationMs}ms.`);
  console.log('[performance]', {
    operation_name: payload.operationName,
    employees_processed: payload.employeesProcessed,
    payroll_period: payload.payrollPeriod,
    start_time: payload.startTime.toISOString(),
    end_time: payload.endTime.toISOString(),
    duration_ms: payload.durationMs,
    status: payload.status,
  });

  await savePerformanceLog(db, payload);
  return payload;
}

module.exports = {
  completePerformanceLog,
  normalizePerformanceBatchSize,
  startPerformanceTimer,
};
