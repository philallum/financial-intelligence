-- Migration: Create prediction_explanations and drift_alerts tables
-- Requirements: 10.1, 10.2, 11.1, 11.2

CREATE TABLE IF NOT EXISTS prediction_explanations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    forecast_id UUID NOT NULL REFERENCES research_forecasts(id),
    asset TEXT NOT NULL,
    timestamp_utc TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    shap_values JSONB NOT NULL,
    top_features JSONB NOT NULL,
    base_value DOUBLE PRECISION NOT NULL,
    model_version TEXT NOT NULL
);

CREATE INDEX idx_prediction_explanations_asset_ts
    ON prediction_explanations (asset, timestamp_utc DESC);

CREATE TABLE IF NOT EXISTS drift_alerts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    regime TEXT NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    rolling_accuracy DOUBLE PRECISION NOT NULL,
    baseline_accuracy DOUBLE PRECISION NOT NULL,
    sigma DOUBLE PRECISION NOT NULL,
    deviation_sigmas DOUBLE PRECISION NOT NULL,
    retrain_triggered BOOLEAN NOT NULL DEFAULT false,
    retrain_outcome JSONB,
    resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_drift_alerts_regime_detected
    ON drift_alerts (regime, detected_at DESC);

-- RLS: anon + service_role can read; only service_role can write
ALTER TABLE prediction_explanations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all roles"
    ON prediction_explanations FOR SELECT
    USING (true);

CREATE POLICY "Allow write for service role"
    ON prediction_explanations FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');

ALTER TABLE drift_alerts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all roles"
    ON drift_alerts FOR SELECT
    USING (true);

CREATE POLICY "Allow write for service role"
    ON drift_alerts FOR ALL
    USING (auth.role() = 'service_role')
    WITH CHECK (auth.role() = 'service_role');
