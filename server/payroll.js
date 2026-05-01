/* ============================================================
   server/payroll.js — Payroll endpoints (wages, rates, transactions)
   ============================================================ */

const express = require('express');
const router = express.Router();
const { requireAuth, requireRole, ROLES } = require('./middleware');

// Get all wage types
router.get('/wage-types', requireAuth, async (req, res) => {
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute('SELECT * FROM wage_types ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error('Error fetching wage types:', err);
    res.status(500).json({ error: 'Failed to fetch wage types' });
  }
});

// Get sewing types (production)
router.get('/sewing-types', requireAuth, async (req, res) => {
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute(`
      SELECT id, name, description, default_rate 
      FROM sewing_types 
      ORDER BY name
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching sewing types:', err);
    res.status(500).json({ error: 'Failed to fetch sewing types' });
  }
});

// Get logistics regions
router.get('/logistics-regions', requireAuth, async (req, res) => {
  try {
    const pool = require('../config/db');
    const [rows] = await pool.execute(`
      SELECT id, name, code, description, default_rate 
      FROM logistics_regions 
      ORDER BY name
    `);
    res.json(rows);
  } catch (err) {
    console.error('Error fetching logistics regions:', err);
    res.status(500).json({ error: 'Failed to fetch logistics regions' });
  }
});

// Get employee wage rate configuration
router.get('/employees/:id/wage-config', requireAuth, async (req, res) => {
  try {
    const pool = require('../config/db');
    const empId = req.params.id;

    console.log('\n=== GET /api/payroll/employees/:id/wage-config ===');
    console.log('Employee ID:', empId);
    console.log('Request user:', req.user?.username);

    // Get employee with current wage type
    const [empRows] = await pool.execute(`
      SELECT e.id, e.employee_code, e.first_name, e.last_name, 
             e.wage_type_id, w.name AS wage_type, w.id AS wage_type_id_val,
             e.department_id, d.name AS department
      FROM employees e
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.id = ?
    `, [empId]);

    if (!empRows.length) {
      console.error('❌ Employee not found with ID:', empId);
      return res.status(404).json({ error: 'Employee not found' });
    }

    const emp = empRows[0];
    console.log('✅ Employee found:', emp.employee_code, '| Wage type ID:', emp.wage_type_id, '| Wage type name:', emp.wage_type);

    // Get rates for this employee
    const [rates] = await pool.execute(`
      SELECT ewr.*, st.name AS sewing_type, lr.name AS region
      FROM employee_wage_rates ewr
      LEFT JOIN sewing_types st ON st.id = ewr.sewing_type_id
      LEFT JOIN logistics_regions lr ON lr.id = ewr.logistics_region_id
      WHERE ewr.employee_id = ? AND ewr.end_date IS NULL
      ORDER BY ewr.effective_date DESC
    `, [empId]);

    console.log('✅ Query result - Found', rates.length, 'active rate(s)');
    if (rates.length > 0) {
      console.log('✅ First rate details:', {
        rate: rates[0].rate,
        base_rate: rates[0].base_rate,
        hourly_rate: rates[0].hourly_rate,
        overtime_rate: rates[0].overtime_rate,
        sewing_type_id: rates[0].sewing_type_id,
        logistics_region_id: rates[0].logistics_region_id,
        effective_date: rates[0].effective_date,
        end_date: rates[0].end_date
      });
    }

    // Calculate current rate (use first rate if exists, else default)
    let currentRate = 0;
    if (rates.length > 0) {
      currentRate = parseFloat(rates[0].rate) || parseFloat(rates[0].base_rate) || 0;
    }

    // If no wage type is set, check if rates exist and infer the type
    let wageTypeToReturn = emp.wage_type;
    if (!emp.wage_type && rates.length > 0) {
      // Infer wage type from rates
      const firstRate = rates[0];
      if (firstRate.sewing_type_id) {
        wageTypeToReturn = 'Per-Piece';
      } else if (firstRate.logistics_region_id) {
        wageTypeToReturn = 'Per-Trip';
      }
      console.log('✅ Inferred wage type from rates:', wageTypeToReturn);
    }

    console.log('✅ Final response - wage_type:', wageTypeToReturn, '| current_rate:', currentRate);

    res.json({
      // Return fields at top level for frontend compatibility
      wage_type: wageTypeToReturn || null,
      current_rate: currentRate,
      wage_type_id: emp.wage_type_id_val,
      // Also include nested structure for reference
      employee: emp,
      rates: rates,
      availableSewingTypes: [],
      availableRegions: []
    });
  } catch (err) {
    console.error('Error fetching wage config:', err);
    res.status(500).json({ error: 'Failed to fetch wage configuration' });
  }
});

// Set employee wage type and rates (ADMIN only)
router.post('/employees/:id/wage-config', requireAuth, requireRole(ROLES.admin), async (req, res) => {
  try {
    const pool = require('../config/db');
    const empId = req.params.id;
    const { wage_type_id, rates } = req.body;

    console.log('\n=== POST /api/payroll/employees/:id/wage-config ===');
    console.log('Employee ID:', empId);
    console.log('Wage Type ID:', wage_type_id);
    console.log('Rates to save:', rates);

    // First verify employee exists
    const [empCheck] = await pool.execute(
      'SELECT id, employee_code, first_name, last_name FROM employees WHERE id = ?',
      [empId]
    );
    
    if (!empCheck.length) {
      console.error('❌ Employee not found with ID:', empId);
      return res.status(404).json({ error: 'Employee not found' });
    }
    
    console.log('✅ Employee found:', empCheck[0].employee_code);

    // Update employee wage type
    const [updateRes] = await pool.execute(
      'UPDATE employees SET wage_type_id = ? WHERE id = ?',
      [wage_type_id, empId]
    );
    
    console.log('✅ Updated wage_type_id. Rows affected:', updateRes.affectedRows);

    // Clear old rates
    const [clearRes] = await pool.execute(
      'UPDATE employee_wage_rates SET end_date = NOW() WHERE employee_id = ? AND end_date IS NULL',
      [empId]
    );
    
    console.log('✅ Cleared old rates. Rows affected:', clearRes.affectedRows);

    // Add new rates
    for (const rate of rates) {
      console.log('Adding rate:', rate);
      const [insertRes] = await pool.execute(`
        INSERT INTO employee_wage_rates 
        (employee_id, wage_type_id, base_rate, hourly_rate, overtime_rate, sewing_type_id, logistics_region_id, rate, effective_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURDATE())
      `, [
        empId,
        wage_type_id,
        rate.base_rate || null,
        rate.hourly_rate || null,
        rate.overtime_rate || null,
        rate.sewing_type_id || null,
        rate.logistics_region_id || null,
        rate.rate
      ]);
      
      console.log('✅ Rate inserted. ID:', insertRes.insertId);
    }
    
    // Verify saved data
    const [verifyRates] = await pool.execute(
      'SELECT * FROM employee_wage_rates WHERE employee_id = ? AND end_date IS NULL',
      [empId]
    );
    
    console.log('✅ Verification - Active rates count:', verifyRates.length);
    console.log('✅ Verification - First rate:', verifyRates[0]);

    res.json({ success: true, message: 'Wage configuration updated', ratesSaved: verifyRates.length });
  } catch (err) {
    console.error('❌ Error updating wage config:', err);
    res.status(500).json({ error: 'Failed to update wage configuration: ' + err.message });
  }
});

// Record production transaction (pieces produced)
router.post('/transactions/production', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { employee_id, sewing_type_id, quantity, rate, transaction_date } = req.body;

    // Calculate week and month
    const date = new Date(transaction_date);
    const week = Math.ceil((date.getDate() + new Date(date.getFullYear(), date.getMonth(), 1).getDay()) / 7);
    const monthYear = date.toISOString().slice(0, 7);

    const [result] = await pool.execute(`
      INSERT INTO production_transactions 
      (employee_id, sewing_type_id, quantity, rate, transaction_date, week_number, month_year)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [employee_id, sewing_type_id, quantity, rate, transaction_date, week, monthYear]);

    res.json({ 
      success: true, 
      id: result.insertId,
      amount: quantity * rate,
      message: `Recorded ${quantity} pieces at ₱${rate} each`
    });
  } catch (err) {
    console.error('Error recording production transaction:', err);
    res.status(500).json({ error: 'Failed to record transaction' });
  }
});

// Record logistics transaction (trips completed)
router.post('/transactions/logistics', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { employee_id, logistics_region_id, rate, trip_reference, transaction_date } = req.body;

    // Calculate week and month
    const date = new Date(transaction_date);
    const week = Math.ceil((date.getDate() + new Date(date.getFullYear(), date.getMonth(), 1).getDay()) / 7);
    const monthYear = date.toISOString().slice(0, 7);

    const [result] = await pool.execute(`
      INSERT INTO logistics_transactions 
      (employee_id, logistics_region_id, rate, amount, trip_reference, transaction_date, week_number, month_year)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [employee_id, logistics_region_id, rate, rate, trip_reference, transaction_date, week, monthYear]);

    res.json({ 
      success: true, 
      id: result.insertId,
      amount: rate,
      message: `Recorded 1 trip to ${trip_reference || 'destination'} at ₱${rate}`
    });
  } catch (err) {
    console.error('Error recording logistics transaction:', err);
    res.status(500).json({ error: 'Failed to record transaction' });
  }
});

// Get payroll data for a month
router.get('/payroll/:monthYear', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const monthYear = req.params.monthYear; // Format: YYYY-MM

    const [payrollRun] = await pool.execute(
      'SELECT * FROM payroll_runs WHERE month_year = ?',
      [monthYear]
    );

    if (!payrollRun.length) {
      return res.status(404).json({ error: 'No payroll run for this month' });
    }

    const [payslips] = await pool.execute(`
      SELECT ps.*, e.employee_code, e.first_name, e.last_name, 
             d.name AS department, w.name AS wage_type
      FROM payslips ps
      JOIN employees e ON e.id = ps.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN wage_types w ON w.id = ps.wage_type_id
      WHERE ps.payroll_run_id = ?
      ORDER BY e.employee_code
    `, [payrollRun[0].id]);

    res.json({
      payrollRun: payrollRun[0],
      payslips: payslips
    });
  } catch (err) {
    console.error('Error fetching payroll:', err);
    res.status(500).json({ error: 'Failed to fetch payroll' });
  }
});

// Generate payroll for a month
router.post('/generate', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { month_year, start_date, end_date } = req.body;

    console.log('📊 Starting payroll generation for:', { month_year, start_date, end_date });

    // Validate inputs
    if (!month_year || !start_date || !end_date) {
      return res.status(400).json({ error: 'month_year, start_date, and end_date are required' });
    }

    // Check if payroll already exists
    try {
      const [existing] = await pool.execute(
        'SELECT id FROM payroll_runs WHERE month_year = ?',
        [month_year]
      );

      if (existing.length) {
        return res.status(400).json({ error: `Payroll already generated for ${month_year}` });
      }
    } catch (dbErr) {
      console.error('❌ Error checking existing payroll:', dbErr);
      throw new Error(`Failed to check existing payroll: ${dbErr.message}`);
    }

    // Create payroll run
    let payrollRunId;
    try {
      const [runResult] = await pool.execute(`
        INSERT INTO payroll_runs (month_year, start_date, end_date, created_by)
        VALUES (?, ?, ?, ?)
      `, [month_year, start_date, end_date, req.user.id || req.user.userId]);

      payrollRunId = runResult.insertId;
      console.log('✅ Payroll run created with ID:', payrollRunId);
    } catch (dbErr) {
      console.error('❌ Error creating payroll run:', dbErr);
      throw new Error(`Failed to create payroll run: ${dbErr.message}`);
    }

    // Get all active employees
    let employees = [];
    try {
      const [empData] = await pool.execute(`
        SELECT e.id, e.wage_type_id, w.name AS wage_type
        FROM employees e
        LEFT JOIN wage_types w ON w.id = e.wage_type_id
        WHERE e.status = 'Active'
      `);
      employees = empData;
      console.log(`✅ Found ${employees.length} active employees`);
    } catch (dbErr) {
      console.error('❌ Error fetching employees:', dbErr);
      throw new Error(`Failed to fetch employees: ${dbErr.message}`);
    }

    // Generate payslips for each employee
    let processedCount = 0;
    for (const emp of employees) {
      try {
        let totalEarning = 0;

        if (emp.wage_type === 'Per-Piece') {
          // Sum production transactions
          const [prods] = await pool.execute(`
            SELECT COALESCE(SUM(amount), 0) AS total
            FROM production_transactions
            WHERE employee_id = ? AND month_year = ?
          `, [emp.id, month_year]);
          totalEarning = prods[0]?.total || 0;
        } else if (emp.wage_type === 'Per-Trip') {
          // Sum logistics transactions
          const [trips] = await pool.execute(`
            SELECT COALESCE(SUM(amount), 0) AS total
            FROM logistics_transactions
            WHERE employee_id = ? AND month_year = ?
          `, [emp.id, month_year]);
          totalEarning = trips[0]?.total || 0;
        } else {
          // Base Salary or Hourly - use a default or configured amount
          totalEarning = 0; // Can be customized
        }

        // Get deductions
        const [deducts] = await pool.execute(`
          SELECT COALESCE(SUM(amount), 0) AS total
          FROM employee_deductions
          WHERE employee_id = ? AND is_active = 1
        `, [emp.id]);
        const totalDeduction = deducts[0]?.total || 0;

        // Create payslip
        await pool.execute(`
          INSERT INTO payslips (payroll_run_id, employee_id, wage_type_id, total_earning, total_deduction, net_pay)
          VALUES (?, ?, ?, ?, ?, ?)
        `, [payrollRunId, emp.id, emp.wage_type_id || 1, totalEarning, totalDeduction, totalEarning - totalDeduction]);

        processedCount++;
      } catch (slipErr) {
        console.error(`❌ Error creating payslip for employee ${emp.id}:`, slipErr);
        // Continue with next employee instead of failing entire payroll
      }
    }

    console.log(`✅ Payroll generation completed. Processed ${processedCount} out of ${employees.length} employees`);

    res.json({ 
      success: true, 
      payrollRunId: payrollRunId,
      employeesProcessed: processedCount,
      totalEmployees: employees.length,
      message: `Payroll generated for ${month_year} - ${processedCount} employees processed` 
    });
  } catch (err) {
    console.error('❌ Error generating payroll:', err);
    res.status(500).json({ 
      error: 'Failed to generate payroll',
      details: err.message,
      message: err.message
    });
  }
});

// Get employee personal and employment details for payroll officer (READ-ONLY)
router.get('/employees/:id/readonly', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const empId = req.params.id;

    const [rows] = await pool.execute(`
      SELECT 
        e.id, e.employee_code, e.first_name, e.last_name, e.email,
        e.contact_number, e.residential_address, e.birth_date,
        d.name AS department, p.name AS position, s.id AS supervisor_id,
        CONCAT(s.first_name, ' ', s.last_name) AS supervisor_name,
        e.date_hired, e.employment_status, e.wage_type_id, w.name AS wage_type,
        e.sss_number, e.philhealth_number, e.pagibig_number, e.tin,
        e.bank_name, e.bank_account, e.status
      FROM employees e
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN positions p ON p.id = e.position_id
      LEFT JOIN employees s ON s.id = e.supervisor_id
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
      WHERE e.id = ?
    `, [empId]);

    if (!rows.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Error fetching employee readonly:', err);
    res.status(500).json({ error: 'Failed to fetch employee details' });
  }
});

// Get employee government contributions for payroll deductions
router.get('/employees/:id/government-contributions', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const empId = req.params.id;

    // Get employee government info
    const [empRows] = await pool.execute(`
      SELECT e.id, e.sss_number, e.philhealth_number, e.pagibig_number, e.tin
      FROM employees e
      WHERE e.id = ?
    `, [empId]);

    if (!empRows.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    // Get employee deductions
    const [deductions] = await pool.execute(`
      SELECT id, deduction_type, amount, description, start_date, end_date, is_active
      FROM employee_deductions
      WHERE employee_id = ? AND is_active = 1
      ORDER BY deduction_type
    `, [empId]);

    res.json({
      employee_id: empRows[0].id,
      government_ids: {
        sss_number: empRows[0].sss_number || 'Not provided',
        philhealth_number: empRows[0].philhealth_number || 'Not provided',
        pagibig_number: empRows[0].pagibig_number || 'Not provided',
        tin: empRows[0].tin || 'Not provided'
      },
      deductions: deductions || []
    });
  } catch (err) {
    console.error('Error fetching government contributions:', err);
    res.status(500).json({ error: 'Failed to fetch government contributions' });
  }
});

// Get all payroll records for a specific month (table view)
router.get('/payroll-records/:monthYear', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { monthYear } = req.params;

    const [payslips] = await pool.execute(`
      SELECT ps.id, ps.payroll_run_id, ps.employee_id, ps.total_earning, ps.total_deduction, ps.net_pay,
             e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS employee_name,
             d.name AS department, w.name AS wage_type, pr.month_year, pr.start_date, pr.end_date,
             ps.created_at, ps.status
      FROM payslips ps
      JOIN employees e ON e.id = ps.employee_id
      LEFT JOIN departments d ON d.id = e.department_id
      LEFT JOIN wage_types w ON w.id = ps.wage_type_id
      LEFT JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
      WHERE pr.month_year = ?
      ORDER BY e.employee_code
    `, [monthYear]);

    // Calculate summary stats
    const totalPayroll = payslips.reduce((sum, p) => sum + p.total_earning, 0);
    const totalDeductions = payslips.reduce((sum, p) => sum + p.total_deduction, 0);
    const avgSalary = payslips.length > 0 ? totalPayroll / payslips.length : 0;
    const employeesPaid = payslips.filter(p => p.status === 'Disbursed').length;

    res.json({
      summary: {
        totalPayroll,
        totalDeductions,
        avgSalary,
        employeesPaid,
        totalEmployees: payslips.length,
        monthYear
      },
      payslips
    });
  } catch (err) {
    console.error('Error fetching payroll records:', err);
    res.status(500).json({ error: 'Failed to fetch payroll records' });
  }
});

// Get employee transaction history for a specific month
router.get('/employees/:id/transactions/:monthYear', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { id: empId, monthYear } = req.params;

    // Get employee wage type
    const [empData] = await pool.execute(`
      SELECT e.wage_type_id, w.name AS wage_type, e.department_id, d.name AS department
      FROM employees e
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.id = ?
    `, [empId]);

    if (!empData.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const wageType = empData[0].wage_type;
    const department = empData[0].department;
    let transactions = [];

    if (wageType === 'Per-Piece') {
      // Get production transactions
      const [prods] = await pool.execute(`
        SELECT pt.id, pt.quantity, pt.rate, pt.amount, pt.transaction_date, pt.week_number,
               st.name AS transaction_type
        FROM production_transactions pt
        JOIN sewing_types st ON st.id = pt.sewing_type_id
        WHERE pt.employee_id = ? AND pt.month_year = ?
        ORDER BY pt.transaction_date DESC
      `, [empId, monthYear]);
      transactions = prods;
    } else if (wageType === 'Per-Trip') {
      // Get logistics transactions
      const [trips] = await pool.execute(`
        SELECT lt.id, lt.rate, lt.amount, lt.trip_reference, lt.transaction_date, lt.week_number,
               lr.name AS transaction_type
        FROM logistics_transactions lt
        JOIN logistics_regions lr ON lr.id = lt.logistics_region_id
        WHERE lt.employee_id = ? AND lt.month_year = ?
        ORDER BY lt.transaction_date DESC
      `, [empId, monthYear]);
      transactions = trips;
    }

    const totalAmount = transactions.reduce((sum, t) => sum + t.amount, 0);

    res.json({
      wageType,
      department,
      monthYear,
      transactions,
      totalAmount,
      transactionCount: transactions.length
    });
  } catch (err) {
    console.error('Error fetching employee transactions:', err);
    res.status(500).json({ error: 'Failed to fetch employee transactions' });
  }
});

// Get employee monthly summary for salary calculation
router.get('/employees/:id/monthly-summary/:monthYear', requireAuth, requireRole(ROLES.payroll_any), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { id: empId, monthYear } = req.params;

    // Get employee info
    const [empData] = await pool.execute(`
      SELECT e.id, e.employee_code, CONCAT(e.first_name, ' ', e.last_name) AS name, 
             e.wage_type_id, e.department_id, w.name AS wage_type, d.name AS department,
             e.position, e.sss_number, e.philhealth_number, e.pagibig_number
      FROM employees e
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.id = ?
    `, [empId]);

    if (!empData.length) {
      return res.status(404).json({ error: 'Employee not found' });
    }

    const emp = empData[0];
    let totalEarning = 0;
    let earnings = {};

    // Calculate earnings based on wage type
    if (emp.wage_type === 'Per-Piece') {
      const [prods] = await pool.execute(`
        SELECT st.name AS type, SUM(pt.quantity) AS quantity, SUM(pt.amount) AS amount
        FROM production_transactions pt
        JOIN sewing_types st ON st.id = pt.sewing_type_id
        WHERE pt.employee_id = ? AND pt.month_year = ?
        GROUP BY pt.sewing_type_id
        ORDER BY st.name
      `, [empId, monthYear]);
      earnings.production = prods;
      totalEarning = prods.reduce((sum, p) => sum + (p.amount || 0), 0);
    } else if (emp.wage_type === 'Per-Trip') {
      const [trips] = await pool.execute(`
        SELECT lr.name AS region, COUNT(*) AS trips, SUM(lt.amount) AS amount
        FROM logistics_transactions lt
        JOIN logistics_regions lr ON lr.id = lt.logistics_region_id
        WHERE lt.employee_id = ? AND lt.month_year = ?
        GROUP BY lt.logistics_region_id
        ORDER BY lr.name
      `, [empId, monthYear]);
      earnings.logistics = trips;
      totalEarning = trips.reduce((sum, t) => sum + (t.amount || 0), 0);
    }

    // Get deductions
    const [deductions] = await pool.execute(`
      SELECT deduction_type, amount, description
      FROM employee_deductions
      WHERE employee_id = ? AND is_active = 1
      ORDER BY deduction_type
    `, [empId]);

    const totalDeduction = deductions.reduce((sum, d) => sum + d.amount, 0);

    res.json({
      employee: {
        id: emp.id,
        code: emp.employee_code,
        name: emp.name,
        department: emp.department,
        position: emp.position,
        wageType: emp.wage_type,
        governmentIds: {
          sss: emp.sss_number || 'Not provided',
          philhealth: emp.philhealth_number || 'Not provided',
          pagibig: emp.pagibig_number || 'Not provided'
        }
      },
      earnings,
      totalEarning,
      deductions,
      totalDeduction,
      netPay: totalEarning - totalDeduction,
      monthYear
    });
  } catch (err) {
    console.error('Error fetching monthly summary:', err);
    res.status(500).json({ error: 'Failed to fetch monthly summary' });
  }
});

module.exports = router;
