-- DOWN migration: remove versioned SSS contribution table imports.

DROP TABLE IF EXISTS sss_table_rows;
DROP TABLE IF EXISTS sss_table_versions;
