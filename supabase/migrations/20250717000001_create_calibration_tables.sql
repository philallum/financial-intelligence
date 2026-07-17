-- Migration: Create calibration pipeline tables for continuous learning system
-- Creates 7 tables: calibration_runs, calibration_stage_contributions,
-- calibration_regime_accuracy, calibration_counterfactuals, calibration_layer_signals,
-- calibration_confidence_drift, calibration_recommendations
-- Requirements: 1.4, 2.4, 3.6, 4.5, 5.6, 6.7, 7.3

-- =============================================================================
-- Table 1: calibration_runs
-- Tracks each calibration analysis run.
-- =============================================================================
CREATE TABLE IF NOT EXISTS calibration_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    trigger_reason VARCHAR(20) NOT NULL CHECK (trigger_reason IN ('threshold', 'schedule')),
    evaluation_count INTEGER NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'running'
        CHECK (status IN ('running', 'completed', 'partial', 'failed')),
    failed_stage VARCHAR(50),
    error_detail TEXT,
    recommendations_generated INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cr_status ON calibration_runs (status, started_at DESC);

-- =============================================================================
-- Table 2: calibration_stage_contributions
-- Per-stage contribution scores for evaluated forecasts.
-- =============================================================================
CREATE TABLE IF NOT EXISTS calibration_stage_contributions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES calibration_runs(id),
    evaluation_id UUID NOT NULL REFERENCES research_evaluations(id),
    batch_id UUID NOT NULL,
    asset VARCHAR(10) NOT NULL,
    regime VARCHAR(30) NOT NULL,
    stage_name VARCHAR(30) NOT NULL,
    contribution_score NUMERIC(6, 4) NOT NULL,
    layer_dominant VARCHAR(5),
    marginal_accuracy_delta NUMERIC(6, 4),
    is_low_confidence BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_csc_run ON calibration_stage_contributions (run_id);
CREATE INDEX idx_csc_stage_regime ON calibration_stage_contributions (stage_name, regime, asset);

-- =============================================================================
-- Table 3: calibration_regime_accuracy
-- Direction accuracy per regime-asset-direction combination.
-- =============================================================================
CREATE TABLE IF NOT EXISTS calibration_regime_accuracy (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES calibration_runs(id),
    regime VARCHAR(30) NOT NULL,
    asset VARCHAR(10) NOT NULL,
    direction VARCHAR(5) NOT NULL CHECK (direction IN ('up', 'down', 'flat')),
    accuracy_pct NUMERIC(5, 2) NOT NULL,
    sample_count INTEGER NOT NULL,
    is_significant BOOLEAN NOT NULL,
    is_underperforming BOOLEAN NOT NULL,
    accuracy_delta NUMERIC(5, 2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cra_run ON calibration_regime_accuracy (run_id);
CREATE INDEX idx_cra_regime_asset ON calibration_regime_accuracy (regime, asset, created_at DESC);

-- =============================================================================
-- Table 4: calibration_counterfactuals
-- Results of counterfactual "what-if" parameter analyses.
-- =============================================================================
CREATE TABLE IF NOT EXISTS calibration_counterfactuals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES calibration_runs(id),
    parameter_name VARCHAR(50) NOT NULL,
    baseline_value NUMERIC(8, 4) NOT NULL,
    alternative_value NUMERIC(8, 4) NOT NULL,
    baseline_accuracy NUMERIC(5, 2) NOT NULL,
    alternative_accuracy NUMERIC(5, 2) NOT NULL,
    accuracy_delta NUMERIC(5, 2) NOT NULL,
    baseline_brier NUMERIC(7, 6) NOT NULL,
    alternative_brier NUMERIC(7, 6) NOT NULL,
    brier_delta NUMERIC(7, 6) NOT NULL,
    baseline_ece NUMERIC(7, 6) NOT NULL,
    alternative_ece NUMERIC(7, 6) NOT NULL,
    ece_delta NUMERIC(7, 6) NOT NULL,
    sample_size INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ccf_run ON calibration_counterfactuals (run_id);
CREATE INDEX idx_ccf_param ON calibration_counterfactuals (parameter_name, accuracy_delta DESC);

-- =============================================================================
-- Table 5: calibration_layer_signals
-- Per-layer signal-to-noise correlation results.
-- =============================================================================
CREATE TABLE IF NOT EXISTS calibration_layer_signals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES calibration_runs(id),
    layer_name VARCHAR(5) NOT NULL,
    regime VARCHAR(30) NOT NULL,
    asset VARCHAR(10) NOT NULL,
    correlation_coefficient NUMERIC(6, 4) NOT NULL,
    sample_size INTEGER NOT NULL,
    classification VARCHAR(15) NOT NULL
        CHECK (classification IN ('high-signal', 'low-signal', 'neutral')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cls_run ON calibration_layer_signals (run_id);
CREATE INDEX idx_cls_layer_regime ON calibration_layer_signals (layer_name, regime, asset);

-- =============================================================================
-- Table 6: calibration_confidence_drift
-- Confidence calibration monitoring results.
-- =============================================================================
CREATE TABLE IF NOT EXISTS calibration_confidence_drift (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES calibration_runs(id),
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    bucket_accuracy JSONB NOT NULL,
    ece NUMERIC(7, 6) NOT NULL,
    miscalibrated_count INTEGER NOT NULL,
    alert_severity VARCHAR(10) NOT NULL CHECK (alert_severity IN ('none', 'low', 'high')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ccd_run ON calibration_confidence_drift (run_id);
CREATE INDEX idx_ccd_severity ON calibration_confidence_drift (alert_severity, created_at DESC);

-- =============================================================================
-- Table 7: calibration_recommendations
-- Synthesised parameter recommendations from analysis.
-- =============================================================================
CREATE TABLE IF NOT EXISTS calibration_recommendations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES calibration_runs(id),
    parameter_name VARCHAR(50) NOT NULL,
    current_value NUMERIC(8, 4) NOT NULL,
    recommended_value NUMERIC(8, 4) NOT NULL,
    sample_size INTEGER NOT NULL,
    projected_accuracy_improvement NUMERIC(5, 2) NOT NULL,
    confidence_level VARCHAR(10) NOT NULL CHECK (confidence_level IN ('low', 'medium', 'high')),
    explanation TEXT NOT NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'applied', 'rejected')),
    applied_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_crec_run ON calibration_recommendations (run_id);
CREATE INDEX idx_crec_status ON calibration_recommendations (status, created_at DESC);
CREATE INDEX idx_crec_param ON calibration_recommendations (parameter_name, status);

-- =============================================================================
-- Row Level Security policies
-- Pattern: anon + service_role can read; only service_role can write
-- =============================================================================

-- calibration_runs
ALTER TABLE calibration_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all roles"
  ON calibration_runs FOR SELECT
  USING (true);

CREATE POLICY "Allow write for service role"
  ON calibration_runs FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- calibration_stage_contributions
ALTER TABLE calibration_stage_contributions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all roles"
  ON calibration_stage_contributions FOR SELECT
  USING (true);

CREATE POLICY "Allow write for service role"
  ON calibration_stage_contributions FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- calibration_regime_accuracy
ALTER TABLE calibration_regime_accuracy ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all roles"
  ON calibration_regime_accuracy FOR SELECT
  USING (true);

CREATE POLICY "Allow write for service role"
  ON calibration_regime_accuracy FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- calibration_counterfactuals
ALTER TABLE calibration_counterfactuals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all roles"
  ON calibration_counterfactuals FOR SELECT
  USING (true);

CREATE POLICY "Allow write for service role"
  ON calibration_counterfactuals FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- calibration_layer_signals
ALTER TABLE calibration_layer_signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all roles"
  ON calibration_layer_signals FOR SELECT
  USING (true);

CREATE POLICY "Allow write for service role"
  ON calibration_layer_signals FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- calibration_confidence_drift
ALTER TABLE calibration_confidence_drift ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all roles"
  ON calibration_confidence_drift FOR SELECT
  USING (true);

CREATE POLICY "Allow write for service role"
  ON calibration_confidence_drift FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- calibration_recommendations
ALTER TABLE calibration_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all roles"
  ON calibration_recommendations FOR SELECT
  USING (true);

CREATE POLICY "Allow write for service role"
  ON calibration_recommendations FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
