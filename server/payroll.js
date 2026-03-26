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

    // Get employee with current wage type
    const [empRows] = await pool.execute(`
      SELECT e.id, e.employee_code, e.first_name, e.last_name, 
             e.wage_type_id, w.name AS wage_type,
             e.department_id, d.name AS department
      FROM employees e
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
      LEFT JOIN departments d ON d.id = e.department_id
      WHERE e.id = ?
    `, [empId]);

    if (!empRows.length) return res.status(404).json({ error: 'Employee not found' });

    const emp = empRows[0];

    // Get rates for this employee
    const [rates] = await pool.execute(`
      SELECT ewr.*, st.name AS sewing_type, lr.name AS region
      FROM employee_wage_rates ewr
      LEFT JOIN sewing_types st ON st.id = ewr.sewing_type_id
      LEFT JOIN logistics_regions lr ON lr.id = ewr.logistics_region_id
      WHERE ewr.employee_id = ? AND ewr.end_date IS NULL
      ORDER BY ewr.effective_date
    `, [empId]);

    res.json({
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

    // Update employee wage type
    await pool.execute(
      'UPDATE employees SET wage_type_id = ? WHERE id = ?',
      [wage_type_id, empId]
    );

    // Clear old rates
    await pool.execute(
      'UPDATE employee_wage_rates SET end_date = NOW() WHERE employee_id = ? AND end_date IS NULL',
      [empId]
    );

    // Add new rates
    for (const rate of rates) {
      await pool.execute(`
        INSERT INTO employee_wage_rates 
        (employee_id, wage_type_id, base_rate, sewing_type_id, logistics_region_id, rate, effective_date)
        VALUES (?, ?, ?, ?, ?, ?, CURDATE())
      `, [
        empId,
        wage_type_id,
        rate.base_rate || null,
        rate.sewing_type_id || null,
        rate.logistics_region_id || null,
        rate.rate
      ]);
    }

    res.json({ success: true, message: 'Wage configuration updated' });
  } catch (err) {
    console.error('Error updating wage config:', err);
    res.status(500).json({ error: 'Failed to update wage configuration' });
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
router.post('/payroll/generate', requireAuth, requireRole(ROLES.admin), async (req, res) => {
  try {
    const pool = require('../config/db');
    const { month_year, start_date, end_date } = req.body;

    // Check if payroll already exists
    const [existing] = await pool.execute(
      'SELECT id FROM payroll_runs WHERE month_year = ?',
      [month_year]
    );

    if (existing.length) {
      return res.status(400).json({ error: 'Payroll already generated for this month' });
    }

    // Create payroll run
    const [runResult] = await pool.execute(`
      INSERT INTO payroll_runs (month_year, start_date, end_date, created_by)
      VALUES (?, ?, ?, ?)
    `, [month_year, start_date, end_date, req.user.userId]);

    const payrollRunId = runResult.insertId;

    // Get all active employees
    const [employees] = await pool.execute(`
      SELECT e.id, e.wage_type_id, w.name AS wage_type
      FROM employees e
      LEFT JOIN wage_types w ON w.id = e.wage_type_id
      WHERE e.status = 'Active'
    `);

    // Generate payslips for each employee
    for (const emp of employees) {
      let totalEarning = 0;

      if (emp.wage_type === 'Per-Piece') {
        // Sum production transactions
        const [prods] = await pool.execute(`
          SELECT SUM(amount) AS total
          FROM production_transactions
          WHERE employee_id = ? AND month_year = ?
        `, [emp.id, month_year]);
        totalEarning = prods[0]?.total || 0;
      } else if (emp.wage_type === 'Per-Trip') {
        // Sum logistics transactions
        const [trips] = await pool.execute(`
          SELECT SUM(amount) AS total
          FROM logistics_transactions
          WHERE employee_id = ? AND month_year = ?
        `, [emp.id, month_year]);
        totalEarning = trips[0]?.total || 0;
      }

      // Get deductions
      const [deducts] = await pool.execute(`
        SELECT SUM(amount) AS total
        FROM employee_deductions
        WHERE employee_id = ? AND start_date <= CURDATE() AND (end_date IS NULL OR end_date >= CURDATE())
      `, [emp.id]);
      const totalDeduction = deducts[0]?.total || 0;

      // Create payslip
      await pool.execute(`
        INSERT INTO payslips (payroll_run_id, employee_id, wage_type_id, total_earning, total_deduction, net_pay)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [payrollRunId, emp.id, emp.wage_type_id, totalEarning, totalDeduction, totalEarning - totalDeduction]);
    }

    res.json({ 
      success: true, 
      payrollRunId: payrollRunId,
      employeesProcessed: employees.length,
      message: `Payroll generated for ${month_year}` 
    });
  } catch (err) {
    console.error('Error generating payroll:', err);
    res.status(500).json({ error: 'Failed to generate payroll' });
  }
});

module.exports = router;
