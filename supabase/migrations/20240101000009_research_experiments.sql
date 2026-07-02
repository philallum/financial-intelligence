-- Migration: Research Experiments Table (Phase 5 - Platform Observability)
-- Creates the research_experiments table for A/B engine testing and offline experimentation.
-- Experiment outputs are written exclusively to this table and are never read by the live
-- Batch_Layer or Runtime_Layer, ensuring complete production isolation.
-- Requirements: 5.1 (A/B engine testing support), 5.2 (production isolation),
--              5.4 (failure recording with partial results),
--              19.2 (additive schema change), 22.3 (index support), 22.4 (RLS enforcement)

-- =============================================================================
-- Table: research_experiments
-- Stores experiment outputs for side-by-side engine version comparisons.
-- Experiments need status updates as they run (running → completed/failed),
-- so UPDATE is permitted. DELETE is denied to preserve experiment history.
-- =============================================================================
CREATE TABLE IF NOT EXISTS research_experiments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_id UUID NOT NULL,
    engine_versions JSONB NOT NULL,
    original_batch_id UUID,
    input_fingerprint_id VARCHAR,
    output JSONB,
    status VARCHAR(20) NOT NULL DEFAULT 'running',
    failure_detail TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_experiment UNIQUE (experiment_id, input_fingerprint_id)
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- Lookup by experiment identifier (for grouping all runs of an experiment)
CREATE INDEX IF NOT EXISTS idx_exp_id
    ON research_experiments (experiment_id);

-- =============================================================================
-- Row Level Security
-- Experiments need status transitions (running → completed/failed) during execution,
-- so UPDATE is permitted. DELETE is denied to preserve the full experiment history.
-- Only INSERT, SELECT, and UPDATE are permitted.
-- =============================================================================

ALTER TABLE research_experiments ENABLE ROW LEVEL SECURITY;

-- Allow all INSERTs (new experiment records can be written)
CREATE POLICY research_experiments_insert_policy
    ON research_experiments
    FOR INSERT
    WITH CHECK (true);

-- Allow all SELECTs (experiment records can be read)
CREATE POLICY research_experiments_select_policy
    ON research_experiments
    FOR SELECT
    USING (true);

-- Allow UPDATEs (experiments need status transitions during execution)
CREATE POLICY research_experiments_update_policy
    ON research_experiments
    FOR UPDATE
    USING (true);

-- Deny all DELETEs (experiment history is preserved permanently)
CREATE POLICY research_experiments_no_delete_policy
    ON research_experiments
    FOR DELETE
    USING (false);
