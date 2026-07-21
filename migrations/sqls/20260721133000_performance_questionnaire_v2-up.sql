-- v2 is additive. Existing cycles and reviews are explicitly retained as v1
-- so their original questionnaire and finalized SHA-256 integrity hashes are
-- never silently recalculated.
ALTER TABLE performance_cycles
  ADD COLUMN IF NOT EXISTS questionnaire_version VARCHAR(16) NOT NULL DEFAULT 'v1' AFTER description_encrypted,
  ADD COLUMN IF NOT EXISTS competency_weight DECIMAL(5,2) NOT NULL DEFAULT 70.00 AFTER questionnaire_version,
  ADD COLUMN IF NOT EXISTS goal_weight DECIMAL(5,2) NOT NULL DEFAULT 30.00 AFTER competency_weight;

ALTER TABLE performance_reviews
  ADD COLUMN IF NOT EXISTS questionnaire_version VARCHAR(16) NOT NULL DEFAULT 'v1' AFTER status,
  ADD COLUMN IF NOT EXISTS questionnaire_snapshot_encrypted LONGTEXT NULL AFTER questionnaire_version,
  ADD COLUMN IF NOT EXISTS criteria_evidence_encrypted LONGTEXT NULL AFTER indicator_ratings_encrypted,
  ADD COLUMN IF NOT EXISTS criteria_remarks_encrypted LONGTEXT NULL AFTER criteria_evidence_encrypted,
  ADD COLUMN IF NOT EXISTS competency_score DECIMAL(4,2) NULL AFTER final_score,
  ADD COLUMN IF NOT EXISTS goal_score DECIMAL(4,2) NULL AFTER competency_score,
  ADD COLUMN IF NOT EXISTS scoring_snapshot_encrypted LONGTEXT NULL AFTER goal_score;

CREATE INDEX IF NOT EXISTS idx_performance_cycles_questionnaire_version
  ON performance_cycles (questionnaire_version);

CREATE INDEX IF NOT EXISTS idx_performance_reviews_questionnaire_version
  ON performance_reviews (questionnaire_version);
