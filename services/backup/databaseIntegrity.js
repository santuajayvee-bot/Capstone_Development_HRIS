'use strict';

const { sha256Text } = require('./artifactIntegrity');
const { backupError } = require('./backupErrors');

function validateDatabaseIdentifier(value, fieldName = 'database name') {
  const identifier = String(value || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_$]{0,63}$/.test(identifier)) {
    throw backupError(`${fieldName} is invalid.`, 'INVALID_DATABASE_IDENTIFIER');
  }
  return identifier;
}

function validateTableIdentifier(value) {
  const identifier = String(value || '').trim();
  if (!/^[A-Za-z0-9_$]{1,64}$/.test(identifier)) {
    throw backupError('Database contains a table name that cannot be checked safely.', 'UNSUPPORTED_TABLE_IDENTIFIER');
  }
  return identifier;
}

function quoteInternalIdentifier(value) {
  return `\`${String(value).replace(/`/g, '``')}\``;
}

function canonicalValue(value) {
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('hex');
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function normalizeSchemaRows(tableRows, columnRows) {
  const tables = tableRows.map(row => ({
    name: validateTableIdentifier(row.table_name ?? row.TABLE_NAME),
    engine: canonicalValue(row.engine ?? row.ENGINE),
    collation: canonicalValue(row.table_collation ?? row.TABLE_COLLATION),
  })).sort((left, right) => left.name.localeCompare(right.name, 'en'));
  const columns = columnRows.map(row => ({
    table: validateTableIdentifier(row.table_name ?? row.TABLE_NAME),
    name: canonicalValue(row.column_name ?? row.COLUMN_NAME),
    position: Number(row.ordinal_position ?? row.ORDINAL_POSITION),
    type: canonicalValue(row.column_type ?? row.COLUMN_TYPE),
    nullable: canonicalValue(row.is_nullable ?? row.IS_NULLABLE),
    default: canonicalValue(row.column_default ?? row.COLUMN_DEFAULT),
    key: canonicalValue(row.column_key ?? row.COLUMN_KEY),
    extra: canonicalValue(row.extra ?? row.EXTRA),
    collation: canonicalValue(row.collation_name ?? row.COLLATION_NAME),
  })).sort((left, right) => left.table.localeCompare(right.table, 'en') || left.position - right.position);
  return { tables, columns };
}

async function createDatabaseIntegrityReport(executor, options = {}) {
  if (!executor || typeof executor.execute !== 'function') {
    throw backupError('Database executor is required for integrity checks.', 'DATABASE_EXECUTOR_REQUIRED');
  }
  const databaseName = validateDatabaseIdentifier(options.databaseName);
  const includeRowCounts = Boolean(options.includeRowCounts);
  const checkTables = options.checkTables !== false;
  const [tableRows] = await executor.execute(
    `SELECT TABLE_NAME AS table_name, ENGINE AS engine, TABLE_COLLATION AS table_collation
       FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
      ORDER BY TABLE_NAME`,
    [databaseName]
  );
  const [columnRows] = await executor.execute(
    `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name,
            ORDINAL_POSITION AS ordinal_position, COLUMN_TYPE AS column_type,
            IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default,
            COLUMN_KEY AS column_key, EXTRA AS extra, COLLATION_NAME AS collation_name
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [databaseName]
  );
  const schema = normalizeSchemaRows(tableRows, columnRows);
  const rowCounts = {};
  const tableChecks = [];
  for (const table of schema.tables) {
    // Both identifiers came from the server and were constrained above. MySQL
    // placeholders cannot represent identifiers, so only these validated names
    // are interpolated into the diagnostic statement.
    const qualifiedTable = `${quoteInternalIdentifier(databaseName)}.${quoteInternalIdentifier(table.name)}`;
    if (includeRowCounts) {
      const [countRows] = await executor.execute(`SELECT COUNT(*) AS row_count FROM ${qualifiedTable}`);
      rowCounts[table.name] = Number(countRows[0]?.row_count || 0);
    }
    if (checkTables) {
      try {
        const [checks] = await executor.execute(`CHECK TABLE ${qualifiedTable} QUICK`);
        const normalized = checks.map(check => ({
          type: canonicalValue(check.Msg_type ?? check.msg_type),
          message: canonicalValue(check.Msg_text ?? check.msg_text),
        }));
        tableChecks.push({
          table: table.name,
          ok: normalized.some(check => check.type === 'status' && String(check.message).toLowerCase() === 'ok'),
          checks: normalized,
        });
      } catch (_) {
        tableChecks.push({ table: table.name, ok: false, checks: [{ type: 'error', message: 'Integrity check failed.' }] });
      }
    }
  }
  const schemaHash = sha256Text(JSON.stringify({ tables: schema.tables, columns: schema.columns }));
  const rowCountHash = includeRowCounts ? sha256Text(JSON.stringify(rowCounts)) : null;
  return {
    formatVersion: 1,
    databaseName,
    checkedAt: new Date().toISOString(),
    tableCount: schema.tables.length,
    columnCount: schema.columns.length,
    schemaHash,
    rowCountHash,
    rowCounts: includeRowCounts ? rowCounts : null,
    tableChecks,
    allTablesHealthy: tableChecks.every(check => check.ok),
    schema,
  };
}

function compareIntegrityReports(expected, actual) {
  if (!expected || !actual) {
    return {
      valid: false,
      schemaMatches: false,
      rowCountsMatch: null,
      missingTables: [],
      unexpectedTables: [],
      rowCountMismatches: [],
      reason: 'Expected and actual integrity reports are required.',
    };
  }
  const expectedTables = new Set((expected.schema?.tables || []).map(table => table.name));
  const actualTables = new Set((actual.schema?.tables || []).map(table => table.name));
  const missingTables = [...expectedTables].filter(table => !actualTables.has(table)).sort();
  const unexpectedTables = [...actualTables].filter(table => !expectedTables.has(table)).sort();
  const schemaMatches = expected.schemaHash === actual.schemaHash && !missingTables.length && !unexpectedTables.length;
  const rowCountMismatches = [];
  let rowCountsMatch = null;
  if (expected.rowCounts) {
    rowCountsMatch = true;
    for (const [table, expectedCount] of Object.entries(expected.rowCounts)) {
      const actualCount = actual.rowCounts?.[table];
      if (Number(expectedCount) !== Number(actualCount)) {
        rowCountsMatch = false;
        rowCountMismatches.push({ table, expected: Number(expectedCount), actual: Number(actualCount ?? -1) });
      }
    }
  }
  const tableChecksHealthy = actual.allTablesHealthy !== false;
  return {
    valid: schemaMatches && rowCountsMatch !== false && tableChecksHealthy,
    schemaMatches,
    rowCountsMatch,
    tableChecksHealthy,
    missingTables,
    unexpectedTables,
    rowCountMismatches,
    expectedSchemaHash: expected.schemaHash || null,
    actualSchemaHash: actual.schemaHash || null,
  };
}

module.exports = {
  compareIntegrityReports,
  createDatabaseIntegrityReport,
  validateDatabaseIdentifier,
  validateTableIdentifier,
};
