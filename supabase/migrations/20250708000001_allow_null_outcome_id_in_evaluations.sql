-- Migration: Allow NULL outcome_id in research_evaluations
-- Required for the "outcome_unavailable" status when a forecast matures
-- but no corresponding market_outcome record exists after 8 hours.
--
-- Background: The evaluation engine marks timed-out forecasts with
-- status='outcome_unavailable' and outcome_id=NULL. The original schema
-- had outcome_id as NOT NULL, preventing these records from being persisted.

ALTER TABLE research_evaluations ALTER COLUMN outcome_id DROP NOT NULL;
