const fs = require('fs');
const path = require('path');

function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map(statement => statement.trim())
    .filter(Boolean);
}

function stripLeadingComments(statement) {
  return statement.replace(/^(?:\s*--[^\r\n]*(?:\r?\n|$))+/g, '').trim();
}

function splitAlterClauses(body) {
  const clauses = [];
  let current = '';
  let quote = '';
  let depth = 0;

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    const previous = body[index - 1];

    if (quote) {
      current += character;
      if (character === quote && previous !== '\\') quote = '';
      continue;
    }

    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      current += character;
      continue;
    }

    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;

    if (character === ',' && depth === 0) {
      clauses.push(current.trim());
      current = '';
      continue;
    }

    current += character;
  }

  if (current.trim()) clauses.push(current.trim());
  return clauses;
}

function escapeSqlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "''");
}

function normalizeIdentifier(identifier) {
  const value = String(identifier).replace(/`/g, '');
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe SQL identifier in migration: ${identifier}`);
  }
  return value;
}

function runConditionalAlter(db, tableIdentifier, clause, conditionSql) {
  const table = normalizeIdentifier(tableIdentifier);
  const alterSql = `ALTER TABLE \`${table}\` ${clause}`;
  const escapedAlterSql = escapeSqlString(alterSql);
  const statements = [
    `SET @lgsv_migration_sql = IF(${conditionSql}, '${escapedAlterSql}', 'SELECT 1')`,
    'PREPARE lgsv_migration_stmt FROM @lgsv_migration_sql',
    'EXECUTE lgsv_migration_stmt',
    'DEALLOCATE PREPARE lgsv_migration_stmt'
  ];

  return statements.reduce(
    (chain, statement) => chain.then(() => db.runSql(statement)),
    Promise.resolve()
  );
}

function runAlterStatement(db, statement) {
  const executable = stripLeadingComments(statement);
  const match = executable.match(/^ALTER\s+TABLE\s+`?([A-Za-z0-9_]+)`?\s+([\s\S]+)$/i);
  if (!match) return db.runSql(statement);

  const table = normalizeIdentifier(match[1]);
  const clauses = splitAlterClauses(match[2]);

  return clauses.reduce((chain, clause) => chain.then(() => {
    const addMatch = clause.match(
      /^ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+`?([A-Za-z0-9_]+)`?\s+([\s\S]+)$/i
    );
    if (addMatch) {
      const column = normalizeIdentifier(addMatch[1]);
      const compatibleClause = `ADD COLUMN \`${column}\` ${addMatch[2]}`;
      const condition = `(SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${escapeSqlString(table)}' AND COLUMN_NAME = '${escapeSqlString(column)}') = 0`;
      return runConditionalAlter(db, table, compatibleClause, condition);
    }

    const dropMatch = clause.match(
      /^DROP\s+COLUMN\s+IF\s+EXISTS\s+`?([A-Za-z0-9_]+)`?$/i
    );
    if (dropMatch) {
      const column = normalizeIdentifier(dropMatch[1]);
      const compatibleClause = `DROP COLUMN \`${column}\``;
      const condition = `(SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${escapeSqlString(table)}' AND COLUMN_NAME = '${escapeSqlString(column)}') > 0`;
      return runConditionalAlter(db, table, compatibleClause, condition);
    }

    const modifyMatch = clause.match(
      /^MODIFY\s+COLUMN\s+IF\s+EXISTS\s+`?([A-Za-z0-9_]+)`?\s+([\s\S]+)$/i
    );
    if (modifyMatch) {
      const column = normalizeIdentifier(modifyMatch[1]);
      const compatibleClause = `MODIFY COLUMN \`${column}\` ${modifyMatch[2]}`;
      const condition = `(SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${escapeSqlString(table)}' AND COLUMN_NAME = '${escapeSqlString(column)}') > 0`;
      return runConditionalAlter(db, table, compatibleClause, condition);
    }

    return db.runSql(`ALTER TABLE \`${table}\` ${clause}`);
  }), Promise.resolve());
}

function runSqlFile(db, filename) {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', 'sqls', filename), 'utf8');
  return splitStatements(sql).reduce(
    (chain, statement) => chain.then(() => runAlterStatement(db, statement)),
    Promise.resolve()
  );
}

module.exports = {
  runSqlFile,
  splitAlterClauses,
  splitStatements
};
