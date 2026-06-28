require('dotenv').config();

const DEFAULT_BATCHES = [10, 50, 100];

function argValue(name) {
  const prefix = `--${name}=`;
  const item = process.argv.find(value => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : null;
}

function required(name, value) {
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  return body;
}

async function login(baseUrl, username, password) {
  const data = await requestJson(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  if (!data.token) throw new Error('Login response did not include a token.');
  return data.token;
}

function batchesFromArgs() {
  const raw = argValue('batches');
  if (!raw) return DEFAULT_BATCHES;
  const values = raw.split(',').map(value => Number(value.trim())).filter(Boolean);
  if (!values.length || values.some(value => !DEFAULT_BATCHES.includes(value))) {
    throw new Error('batches must be a comma-separated subset of 10,50,100.');
  }
  return values;
}

async function run() {
  const baseUrl = (argValue('base-url') || process.env.PERFORMANCE_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const username = required('PERFORMANCE_USERNAME or --username', argValue('username') || process.env.PERFORMANCE_USERNAME);
  const password = required('PERFORMANCE_PASSWORD or --password', argValue('password') || process.env.PERFORMANCE_PASSWORD);
  const payrollPeriod = required('PERFORMANCE_PAYROLL_PERIOD or --period', argValue('period') || process.env.PERFORMANCE_PAYROLL_PERIOD);
  const startDate = required('PERFORMANCE_PERIOD_START or --start', argValue('start') || process.env.PERFORMANCE_PERIOD_START);
  const endDate = required('PERFORMANCE_PERIOD_END or --end', argValue('end') || process.env.PERFORMANCE_PERIOD_END);
  const payType = argValue('pay-type') || process.env.PERFORMANCE_PAY_TYPE || '';
  const payrollFrequency = argValue('frequency') || process.env.PERFORMANCE_PAYROLL_FREQUENCY || 'Weekly';
  const batches = batchesFromArgs();

  const token = await login(baseUrl, username, password);
  for (const size of batches) {
    const started = Date.now();
    const payload = {
      payroll_period: payrollPeriod,
      month_year: payrollPeriod,
      start_date: startDate,
      end_date: endDate,
      payroll_frequency: payrollFrequency,
      performance_batch_size: size,
    };
    if (payType) payload.pay_type = payType;

    const result = await requestJson(`${baseUrl}/api/payroll/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const durationMs = Date.now() - started;
    const employees = Number(result.employeesProcessed || 0);
    console.log(`Payroll generation completed for ${employees} employees in ${durationMs}ms. batch=${size} period=${payrollPeriod}`);
  }
}

run().catch(error => {
  console.error(`Payroll performance batch test failed: ${error.message}`);
  process.exitCode = 1;
});
