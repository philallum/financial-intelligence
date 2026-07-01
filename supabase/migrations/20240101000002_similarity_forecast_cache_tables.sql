-- Migration: Create similarity_matches, forecasts, and cached_forecasts tables
-- Requirements: 2.3, 4.4, 6.1, 6.6

-- =============================================================================
-- Table: similarity_matches
-- Stores top-N historically similar fingerprint matches per batch cycle.
-- =============================================================================
CREATE TABLE IF NOT EXISTS similarity_matches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint_id UUID NOT NULL,
    match_fingerprint_id UUID NOT NULL,
    similarity_score NUMERIC(8, 6) NOT NULL,
    rank SMALLINT NOT NULL,
    layer_breakdown JSONB NOT NULL,
    batch_id UUID NOT NULL,
    engine_version VARCHAR(10) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_sim_match UNIQUE (fingerprint_id, match_fingerprint_id, batch_id)
);

CREATE INDEX IF NOT EXISTS idx_sim_fp ON similarity_matches (fingerprint_id, batch_id);
CREATE INDEX IF NOT EXISTS idx_sim_rank ON similarity_matches (fingerprint_id, rank);

-- =============================================================================
-- Table: forecasts
-- Stores probabilistic forecast outputs per fingerprint per batch.
-- =============================================================================
CREATE TABLE IF NOT EXISTS forecasts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint_id UUID NOT NULL,
    direction_probabilities JSONB NOT NULL,
    expected_move_pips NUMERIC(8, 2) NOT NULL,
    confidence_raw NUMERIC(5, 4) NOT NULL,
    confidence_final NUMERIC(5, 4) NOT NULL,
    sample_size INTEGER NOT NULL,
    batch_id UUID NOT NULL,
    engine_version VARCHAR(10) NOT NULL,
    quantile_table_version VARCHAR(10) NOT NULL,
    fingerprint_schema_version VARCHAR(10) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uq_forecast UNIQUE (fingerprint_id, batch_id)
);

CREATE INDEX IF NOT EXISTS idx_forecast_fp ON forecasts (fingerprint_id, created_at DESC);

-- =============================================================================
-- Table: cached_forecasts
-- One active cached forecast per asset, keyed by asset with TTL boundary.
-- =============================================================================
CREATE TABLE IF NOT EXISTS cached_forecasts (
    asset VARCHAR(10) PRIMARY KEY,
    fingerprint_id UUID NOT NULL,
    payload JSONB NOT NULL,
    batch_id UUID NOT NULL,
    valid_from TIMESTAMP WITH TIME ZONE NOT NULL,
    valid_until TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cached_asset ON cached_forecasts (asset, valid_until);
