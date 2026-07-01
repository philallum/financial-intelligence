-- Migration: Core Data Tables
-- Creates raw_candles, market_fingerprints (with EUR/USD partition), and market_outcomes tables.
-- Requirements: 1.4, 1.6, 3.5, 12.3

-- Enable pgvector extension for state layer vector columns
CREATE EXTENSION IF NOT EXISTS vector;

-- ============================================================
-- Table: raw_candles
-- Stores ingested 4H OHLC candle data from external providers.
-- ============================================================
CREATE TABLE IF NOT EXISTS raw_candles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    asset VARCHAR(10) NOT NULL,
    timeframe VARCHAR(4) NOT NULL DEFAULT '4H',
    timestamp_utc TIMESTAMP WITH TIME ZONE NOT NULL,
    open NUMERIC(10, 5) NOT NULL,
    high NUMERIC(10, 5) NOT NULL,
    low NUMERIC(10, 5) NOT NULL,
    close NUMERIC(10, 5) NOT NULL,
    volume NUMERIC,
    ingestion_time TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    batch_id UUID NOT NULL,
    CONSTRAINT uq_candle UNIQUE (asset, timeframe, timestamp_utc)
);

CREATE INDEX IF NOT EXISTS idx_raw_candles_asset_time
    ON raw_candles (asset, timeframe, timestamp_utc DESC);

-- ============================================================
-- Table: market_fingerprints (LIST partitioned by asset)
-- Stores deterministic market state fingerprints with 5 pgvector
-- state layer columns (L1-L5) and extensible JSONB state.
-- ============================================================
CREATE TABLE IF NOT EXISTS market_fingerprints (
    fingerprint_id UUID PRIMARY KEY,
    asset VARCHAR(10) NOT NULL,
    timeframe VARCHAR(4) NOT NULL DEFAULT '4H',
    timestamp_utc TIMESTAMP WITH TIME ZONE NOT NULL,
    market_state_version VARCHAR(10) NOT NULL,
    ohlc JSONB NOT NULL,
    return_profile JSONB NOT NULL,
    regime JSONB NOT NULL,
    -- 5 state layers stored as pgvector columns
    market_structure_vector vector(16),   -- L1: Price geometry, swing structure
    volatility_vector vector(12),          -- L2: ATR percentiles, dispersion
    liquidity_vector vector(20),           -- L3: S/R density field
    macro_vector vector(8),                -- L4: Cross-asset alignment
    sentiment_vector vector(6),            -- L5: Event/news pressure
    -- Extensible state (JSONB for future layers without schema migration)
    extended_state JSONB DEFAULT '{}',
    -- Normalisation binding
    quantile_table_version VARCHAR(10) NOT NULL,
    scaling_method VARCHAR(20) NOT NULL DEFAULT 'fixed',
    session VARCHAR(10) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    batch_id UUID NOT NULL,
    CONSTRAINT uq_fingerprint UNIQUE (asset, timeframe, timestamp_utc)
) PARTITION BY LIST (asset);

-- MVP partition for EUR/USD
CREATE TABLE IF NOT EXISTS market_fingerprints_eurusd PARTITION OF market_fingerprints
    FOR VALUES IN ('EURUSD');

-- ============================================================
-- Table: market_outcomes
-- Stores forward-looking outcome data linked to fingerprints.
-- ============================================================
CREATE TABLE IF NOT EXISTS market_outcomes (
    outcome_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint_id UUID NOT NULL REFERENCES market_fingerprints(fingerprint_id),
    horizon VARCHAR(4) NOT NULL DEFAULT '4H',
    net_return_pips NUMERIC(10, 2) NOT NULL,
    max_favourable_excursion NUMERIC(10, 2) NOT NULL,
    max_adverse_excursion NUMERIC(10, 2) NOT NULL,
    realised_volatility NUMERIC(10, 4) NOT NULL,
    timestamp_utc TIMESTAMP WITH TIME ZONE NOT NULL,
    batch_id UUID,
    engine_version VARCHAR(10),
    CONSTRAINT uq_outcome UNIQUE (fingerprint_id, horizon)
);

CREATE INDEX IF NOT EXISTS idx_outcomes_fp
    ON market_outcomes (fingerprint_id);

CREATE INDEX IF NOT EXISTS idx_outcomes_fp_horizon
    ON market_outcomes (fingerprint_id, horizon);
