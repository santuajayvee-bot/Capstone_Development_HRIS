async function recordTardinessPolicyAlert(conn, row, policy) {
  const threshold = Math.max(1, Number(policy.habitual_tardiness_threshold || 0));
  if (!policy.tardiness_alert_enabled || !threshold) return;
  const [counts] = await conn.execute(
    `SELECT COUNT(*) AS late_count
       FROM attendance_summary
      WHERE employee_id = ?
        AND attendance_date BETWEEN DATE_SUB(?, INTERVAL DAYOFMONTH(?) - 1 DAY) AND LAST_DAY(?)
        AND late_minutes > 0`,
    [row.employee_id, row.date, row.date, row.date]
  );
  const lateCount = Number(counts[0]?.late_count || 0);
  if (lateCount < threshold) return;

  const [existing] = await conn.execute(
    `SELECT 1
       FROM system_audit_log
      WHERE employee_id = ?
        AND Action_Type = 'ATTENDANCE_TARDINESS_POLICY_TRIGGERED'
        AND COALESCE(Created_At, timestamp) BETWEEN DATE_SUB(?, INTERVAL DAYOFMONTH(?) - 1 DAY) AND LAST_DAY(?)
      LIMIT 1`,
    [row.employee_id, row.date, row.date, row.date]
  );
  if (existing.length) return;

  const message = `Employee triggered Policy Violation: Habitual Tardiness (${lateCount}/${threshold}). Proceed to disciplinary review.`;
  await conn.execute(
    `INSERT INTO system_audit_log
       (user_id, employee_id, action_performed, module, new_value, Action_Type, Description, timestamp, Created_At)
     VALUES (NULL, ?, ?, 'ATTENDANCE', ?, 'ATTENDANCE_TARDINESS_POLICY_TRIGGERED', ?, NOW(), NOW())`,
    [
      row.employee_id,
      message,
      JSON.stringify({
        employee_id: row.employee_id,
        attendance_date: row.date,
        late_count: lateCount,
        threshold,
        payroll_config_id: policy.payroll_config_id || null,
        payroll_config_name: policy.payroll_config_name || null,
      }),
      message,
    ]
  );
}

module.exports = { recordTardinessPolicyAlert };
