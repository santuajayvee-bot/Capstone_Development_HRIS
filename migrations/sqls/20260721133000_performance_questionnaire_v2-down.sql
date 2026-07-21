-- WARNING: This rollback permanently removes v2 questionnaire snapshots,
-- encrypted criterion narratives, and v2 score fields. Take a verified backup
-- before running it. It does not alter existing v1 review data.
DROP INDEX IF EXISTS idx_performance_cycles_questionnaire_version ON performance_cycles;
DROP INDEX IF EXISTS idx_performance_reviews_questionnaire_version ON performance_reviews;

ALTER TABLE performance_reviews
  DROP COLUMN IF EXISTS scoring_snapshot_encrypted,
  DROP COLUMN IF EXISTS goal_score,
  DROP COLUMN IF EXISTS competency_score,
  DROP COLUMN IF EXISTS criteria_remarks_encrypted,
  DROP COLUMN IF EXISTS criteria_evidence_encrypted,
  DROP COLUMN IF EXISTS questionnaire_snapshot_encrypted,
  DROP COLUMN IF EXISTS questionnaire_version;

ALTER TABLE performance_cycles
  DROP COLUMN IF EXISTS goal_weight,
  DROP COLUMN IF EXISTS competency_weight,
  DROP COLUMN IF EXISTS questionnaire_version;
