'use strict';

const { ProbeFailure } = require('../probeResult');

function identifier(name) {
  const value = String(name || '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new ProbeFailure('INVALID_PROBE_IDENTIFIER', 'Diagnostic identifier is invalid.');
  return `\`${value}\``;
}

async function tableExists(pool, tableName) {
  const [rows] = await pool.execute(
    `SELECT COUNT(*) AS count FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [String(tableName)]
  );
  return Number(rows?.[0]?.count || 0) > 0;
}

async function existingColumns(pool, tableName, candidates) {
  const list = Array.isArray(candidates) ? candidates.map(String) : [];
  if (!list.length) return new Set();
  const placeholders = list.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME IN (${placeholders})`,
    [String(tableName), ...list]
  );
  return new Set(rows.map(row => String(row.COLUMN_NAME)));
}

async function readOne(pool, tableName) {
  const [rows] = await pool.execute(`SELECT 1 AS readable FROM ${identifier(tableName)} LIMIT 1`);
  return rows;
}

function isTruthyEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function ageMinutes(value, now = Date.now()) {
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? Math.max(0, Math.floor((now - timestamp) / 60000)) : null;
}

function ageHours(value, now = Date.now()) {
  const minutes = ageMinutes(value, now);
  return minutes === null ? null : Math.floor(minutes / 60);
}

module.exports = { ageHours, ageMinutes, existingColumns, identifier, isTruthyEnv, readOne, tableExists };
