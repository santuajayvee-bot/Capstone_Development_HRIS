const { runSqlMigration } = require('./utils/sql-migration');

exports.up = function up() {
  return runSqlMigration(__filename, 'up');
};

exports.down = function down() {
  return runSqlMigration(__filename, 'down');
};
