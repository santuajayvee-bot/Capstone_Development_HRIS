const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, '..', 'public', 'js', 'salary-calculation.js');
const source = `${fs.readFileSync(sourcePath, 'utf8')}
globalThis.__salaryCalculationTestApi = {
  normalizeSalaryWageType,
  salaryUsesAttendanceValidation,
  salaryApiError,
};`;

const context = {
  console,
  Date,
  Error,
  JSON,
  Set,
  String,
  Number,
  Array,
  window: { addEventListener() {} },
  document: { addEventListener() {} },
};
vm.createContext(context);
vm.runInContext(source, context, { filename: sourcePath });

(async () => {
  const api = context.__salaryCalculationTestApi;

  assert.strictEqual(api.salaryUsesAttendanceValidation('Base Salary'), true);
  assert.strictEqual(api.salaryUsesAttendanceValidation('Monthly'), true);
  assert.strictEqual(api.salaryUsesAttendanceValidation('Daily'), true);
  assert.strictEqual(api.salaryUsesAttendanceValidation('Hourly'), true);
  assert.strictEqual(api.salaryUsesAttendanceValidation('Per-Piece'), false);
  assert.strictEqual(api.salaryUsesAttendanceValidation('Per-Trip'), false);

  const error = await api.salaryApiError({
    text: async () => JSON.stringify({
      error: 'No validated payroll-ready attendance exists. Days Worked must be greater than zero.',
      validation: {
        errors: [
          'No validated payroll-ready attendance exists.',
          'Days Worked must be greater than zero.',
        ],
      },
    }),
  }, 'Payroll submission failed.');

  assert.strictEqual(
    error.message,
    'No validated payroll-ready attendance exists.\nDays Worked must be greater than zero.'
  );
  assert.strictEqual(error.message.includes('{"error"'), false);

  console.log('Salary calculation UI tests: PASS');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
