-- Migration: Fingerprint Topology Table (Phase 6 - S/R Topology Engine)
-- Creates the fingerprint_topology table for storing support/resistance structural
-- level analysis produced by the Topology Engine. Each record captures up to 20
-- structural levels with their properties, plus a 40-dimensional normalised vector
-- for similarity comparison.
-- Requirements: 13.2 (topology persisted per fingerprint+asset),
--              13.6 (topology vector 40 dimensions for similarity layer),
--              19.2 (additive schema change, no existing table modifications),
--              22.3 (index support for query patterns),
--              22.4 (RLS enforcement for immutability)

-- =============================================================================
-- Table: fingerprint_topology
-- Stores the S/R topology analysis for each market fingerprint. The Topology Engine
-- analyses up to 120 candles of price history to identify structural levels (support,
-- resistance, flip zones) with their strength, touch/rejection/breakout counts.
-- Once written, records are never updated or deleted — enforced by RLS policies.
-- =============================================================================
CREATE TABLE IF NOT EXISTS fingerprint_topology (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint_id UUID NOT NULL,
    asset VARCHAR(10) NOT NULL,
    levels JSONB NOT NULL DEFAULT '[]',
    topology_vector vector(40),
    insufficient_history BOOLEAN NOT NULL DEFAULT false,
    candle_count_used INTEGER NOT NULL,
    engine_version VARCHAR(10) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_topo_fp_asset UNIQUE (fingerprint_id, asset),
    CONSTRAINT fk_topo_fingerprint FOREIGN KEY (fingerprint_id, asset)
        REFERENCES market_fingerprints(fingerprint_id, asset)
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- Query topology records by asset with time ordering (descending for latest-first)
CREATE INDEX IF NOT EXISTS idx_topo_asset
    ON fingerprint_topology (asset, created_at DESC);

-- =============================================================================
-- Row Level Security (Immutability Enforcement)
-- Prevents UPDATE and DELETE operations at the database level, ensuring that
-- immutability does not depend solely on application code discipline.
-- Only INSERT and SELECT are permitted.
-- =============================================================================

ALTER TABLE fingerprint_topology ENABLE ROW LEVEL SECURITY;

-- Allow all INSERTs (new topology records can be written)
CREATE POLICY fingerprint_topology_insert_policy
    ON fingerprint_topology
    FOR INSERT
    WITH CHECK (true);

-- Allow all SELECTs (topology records can be read)
CREATE POLICY fingerprint_topology_select_policy
    ON fingerprint_topology
    FOR SELECT
    USING (true);

-- Deny all UPDATEs (immutability: no record modification)
CREATE POLICY fingerprint_topology_no_update_policy
    ON fingerprint_topology
    FOR UPDATE
    USING (false);

-- Deny all DELETEs (immutability: no record removal)
CREATE POLICY fingerprint_topology_no_delete_policy
    ON fingerprint_topology
    FOR DELETE
    USING (false);
