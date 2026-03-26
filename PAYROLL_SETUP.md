# Payroll System Setup Guide

## If You're Getting "Unexpected Token <" Error When Running Payroll

This error means the database tables for payroll don't exist. Follow these steps to fix it:

### Step 1: Apply Database Migration

Run this command from your project root:

```bash
node database/apply-migration.js
```

This will create all required payroll tables:
- `wage_types` - Types of wage structures (Base Salary, Hourly, Per-Piece, Per-Trip)
- `sewing_types` - Production sewing types with rates
- `logistics_regions` - Delivery regions with rates
- `employee_wage_rates` - Custom rates per employee
- `production_transactions` - Track pieces produced
- `logistics_transactions` - Track trips completed
- `payroll_runs` - Monthly batch containers
- `payslips` - Individual paychecks
- `employee_deductions` - SSS, PhilHealth, Pag-IBIG, custom deductions

### Step 2: Restart Your Server

After the migration completes, restart your Express server:

```bash
npm start
```

### Step 3: Try Running Payroll Again

1. Login as Payroll Officer
2. Go to Payroll Page
3. Click "+ Run Payroll" button
4. Select month and dates
5. Click "Generate Payroll"

---

## Payroll Generation Process

### What Happens When You Run Payroll:

1. **Validates Input**: Checks month_year, start_date, end_date
2. **Creates Payroll Run**: Inserts record in `payroll_runs` table
3. **Fetches Active Employees**: Gets all employees with wage_type_id
4. **Calculates Earnings** (for each employee):
   - **Per-Piece**: Sums `production_transactions` for the month
   - **Per-Trip**: Sums `logistics_transactions` for the month
   - **Base/Hourly**: Fixed amount (configurable)
5. **Calculate Deductions**: Sums all active deductions from `employee_deductions`
6. **Creates Payslips**: Inserts payslip with (total_earning - total_deduction = net_pay)

### Response Format (Success):
```json
{
  "success": true,
  "payrollRunId": 1,
  "employeesProcessed": 5,
  "totalEmployees": 5,
  "message": "Payroll generated for 2026-03 - 5 employees processed"
}
```

### Response Format (Error):
```json
{
  "error": "...",
  "details": "...",
  "message": "..."
}
```

---

## Troubleshooting

### Error: "Payroll already generated for this month"
**Solution**: You've already created payroll for that month. Try a different month or delete the previous payroll run from the database.

### Error: "Database tables may not exist"
**Solution**: Run `node database/apply-migration.js` again. Check if all tables were created successfully.

### Error: "Failed to create payroll run"
**Solution**: Check database connection. Make sure your `.env` file has correct `DB_HOST`, `DB_USER`, `DB_PASSWORD`.

### Payroll Processes but Shows 0 Employees
**Solution**: 
- Check if any employees have `status = 'Active'`
- Check if employees have `wage_type_id` assigned
- Verify production/logistics transactions exist for that month

---

## Permission Requirements

- ✅ **Admin**: Can run payroll
- ✅ **Payroll Officer**: Can run payroll
- ✅ **Payroll Manager**: Can run payroll  
- ❌ **Employee**: Cannot run payroll

---

## Database Tables Reference

### `payroll_runs`
- `id` - Primary key
- `month_year` - Format: YYYY-MM
- `start_date` - Period start
- `end_date` - Period end
- `created_by` - User ID who generated it
- `created_at` - Timestamp

### `payslips`
- `id` - Primary key
- `payroll_run_id` - Foreign key to payroll_runs
- `employee_id` - Foreign key to employees
- `wage_type_id` - Foreign key to wage_types
- `total_earning` - Sum of transactions or base salary
- `total_deduction` - Sum of employee deductions
- `net_pay` - total_earning - total_deduction
- `generated_at` - Timestamp
