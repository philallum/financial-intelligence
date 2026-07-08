-- Migration: Create research_evaluations table (Phase 2 — Evaluation Engine)
-- Stores per-forecast evaluation metrics computed after forecast maturity.
-- Requirements: 3.2, 4.2, 7.9, 7.11, 19.2, 22.3, 22.4

-- =============================================================================
-- Table: research_evaluations
-- Purpose: Persist deterministic evaluation results for matured research forecasts.
-- Each record links a forecast to its realised outcome and contains all computed
-- accuracy/calibration metrics. Immutable once written (enforced via RLS).
-- =============================================================================
CREATE TABLE IF NOT EXISTS research_evaluations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    forecast_id UUID NOT NULL REFERENCES research_forecasts(id),
    outcome_id UUID NOT NULL REFERENCES market_outcomes(outcome_id),
    batch_id UUID NOT NULL,
    engine_version VARCHAR(10) NOT NULL,
    direction_accuracy SMALLINT NOT NULL CHECK (direction_accuracy IN (0, 1)),
    forecast_success BOOLEAN NOT NULL,
    tradeability_success BOOLEAN NOT NULL,
    expected_move_error NUMERIC(10, 2) NOT NULL,
    absolute_error NUMERIC(10, 2) NOT NULL,
    rmse_contribution NUMERIC(12, 4) NOT NULL,
    brier_score NUMERIC(7, 6) NOT NULL,
    confidence_calibration_score NUMERIC(7, 6) NOT NULL,
    calibration_bucket VARCHAR(10) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'evaluated',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_research_eval UNIQUE (forecast_id, batch_id)
);

-- =============================================================================
-- Indexes
-- =============================================================================
CREATE INDEX IF NOT EXISTS idx_re_batch ON research_evaluations (batch_id);
CREATE INDEX IF NOT EXISTS idx_re_bucket ON research_evaluations (calibration_bucket, direction_accuracy);
CREATE INDEX IF NOT EXISTS idx_re_engine ON research_evaluations (engine_version);

-- =============================================================================
-- Row-Level Security (RLS)
-- Enforces immutability: records may only be inserted and read, never modified
-- or deleted. This guarantees auditability and historical consistency.
-- Requirements: 19.2, 22.3, 22.4
-- =============================================================================
ALTER TABLE research_evaluations ENABLE ROW LEVEL SECURITY;

-- Allow INSERT for all authenticated roles (batch pipeline service role)
DROP POLICY IF EXISTS research_evaluations_insert_policy ON PLACEHOLDER;
CREATE POLICY research_evaluations_insert_policy
    ON research_evaluations
    FOR INSERT
    WITH CHECK (true);

-- Allow SELECT for all authenticated roles (read access for evaluation queries)
DROP POLICY IF EXISTS research_evaluations_select_policy ON PLACEHOLDER;
CREATE POLICY research_evaluations_select_policy
    ON research_evaluations
    FOR SELECT
    USING (true);

-- Deny UPDATE: no policy grants UPDATE access, so RLS blocks all updates
-- Deny DELETE: no policy grants DELETE access, so RLS blocks all deletes
