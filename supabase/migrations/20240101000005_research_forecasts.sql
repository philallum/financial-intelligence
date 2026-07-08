-- Migration: Research Forecasts Table (Phase 1 - Prediction Persistence)
-- Creates the research_forecasts table for the permanent research archive.
-- Every forecast produced by the Batch Layer is persisted here as an immutable record.
-- Requirements: 3.2 (database-level immutability), 4.1 (persist every forecast),
--              9.1 (complete forecast metadata), 9.5 (new table, no existing modifications),
--              9.6 (uniqueness on fingerprint_id + batch_id),
--              19.2 (additive schema change), 22.3 (index support), 22.4 (RLS enforcement)

-- =============================================================================
-- Table: research_forecasts
-- Permanent, immutable archive of all forecasts produced by the Batch Layer.
-- Once written, records are never updated or deleted — enforced by RLS policies.
-- =============================================================================
CREATE TABLE IF NOT EXISTS research_forecasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint_id VARCHAR NOT NULL,
    batch_id UUID NOT NULL,
    asset VARCHAR(10) NOT NULL,
    timeframe VARCHAR(4) NOT NULL DEFAULT '4H',
    forecast_timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    forecast_expiry TIMESTAMPTZ NOT NULL,
    direction_probabilities JSONB NOT NULL,
    expected_move_pips NUMERIC(8, 2) NOT NULL,
    confidence_raw NUMERIC(7, 6) NOT NULL,
    confidence_final NUMERIC(7, 6) NOT NULL,
    tradeability_placeholder NUMERIC(5, 4),
    engine_versions JSONB NOT NULL,
    quantile_table_version VARCHAR(10) NOT NULL,
    regime JSONB NOT NULL,
    sample_size INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_research_forecast UNIQUE (fingerprint_id, batch_id)
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- Lookup by batch run
CREATE INDEX IF NOT EXISTS idx_rf_batch
    ON research_forecasts (batch_id);

-- Query by asset + timeframe with timestamp ordering (descending for latest-first)
CREATE INDEX IF NOT EXISTS idx_rf_asset_time
    ON research_forecasts (asset, timeframe, forecast_timestamp DESC);

-- Index for expiry-based queries (evaluation engine queries)
CREATE INDEX IF NOT EXISTS idx_rf_expiry
    ON research_forecasts (forecast_expiry);

-- Regime-based filtering for calibration and analysis
CREATE INDEX IF NOT EXISTS idx_rf_regime
    ON research_forecasts (asset, (regime->>'volatility_regime'), (regime->>'trend_regime'));

-- =============================================================================
-- Row Level Security (Immutability Enforcement)
-- Prevents UPDATE and DELETE operations at the database level, ensuring that
-- immutability does not depend solely on application code discipline.
-- Only INSERT and SELECT are permitted.
-- =============================================================================

ALTER TABLE research_forecasts ENABLE ROW LEVEL SECURITY;

-- Allow all INSERTs (new records can be written)
DROP POLICY IF EXISTS research_forecasts_insert_policy ON research_forecasts;
CREATE POLICY research_forecasts_insert_policy
    ON research_forecasts
    FOR INSERT
    WITH CHECK (true);

-- Allow all SELECTs (records can be read)
DROP POLICY IF EXISTS research_forecasts_select_policy ON research_forecasts;
CREATE POLICY research_forecasts_select_policy
    ON research_forecasts
    FOR SELECT
    USING (true);

-- Deny all UPDATEs (immutability: no record modification)
DROP POLICY IF EXISTS research_forecasts_no_update_policy ON research_forecasts;
CREATE POLICY research_forecasts_no_update_policy
    ON research_forecasts
    FOR UPDATE
    USING (false);

-- Deny all DELETEs (immutability: no record removal)
DROP POLICY IF EXISTS research_forecasts_no_delete_policy ON research_forecasts;
CREATE POLICY research_forecasts_no_delete_policy
    ON research_forecasts
    FOR DELETE
    USING (false);
