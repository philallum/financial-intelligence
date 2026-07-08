-- Migration: Research Similarity Archive Table (Phase 3 - Similarity Archive)
-- Creates the research_similarity_archive table for permanent storage of all
-- historical analogue matches produced by the Similarity Engine.
-- Every match (up to 50 per query fingerprint per batch) is archived here
-- with full layer breakdown and match explanation for explainability.
-- Requirements: 3.2 (database-level immutability), 4.3 (similarity archive table),
--              10.1 (persist all matches), 10.2 (engine_versions per record),
--              10.5 (layer breakdown + match explanation),
--              19.2 (additive schema change), 22.3 (index support), 22.4 (RLS enforcement)

-- =============================================================================
-- Table: research_similarity_archive
-- Permanent, immutable archive of all similarity matches produced by the
-- Similarity Engine during batch pipeline execution.
-- Once written, records are never updated or deleted — enforced by RLS policies.
-- =============================================================================
CREATE TABLE IF NOT EXISTS research_similarity_archive (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fingerprint_id VARCHAR NOT NULL,
    match_fingerprint_id VARCHAR NOT NULL,
    similarity_score NUMERIC(8, 6) NOT NULL,
    layer_breakdown JSONB NOT NULL,
    match_explanation JSONB NOT NULL,
    rank SMALLINT NOT NULL,
    batch_id UUID NOT NULL,
    engine_versions JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_sim_archive UNIQUE (fingerprint_id, match_fingerprint_id, batch_id)
);

-- =============================================================================
-- Indexes
-- =============================================================================

-- Lookup matches by fingerprint within a batch (primary query pattern)
CREATE INDEX IF NOT EXISTS idx_rsa_fp_batch
    ON research_similarity_archive (fingerprint_id, batch_id);

-- Lookup all matches within a batch run
CREATE INDEX IF NOT EXISTS idx_rsa_batch
    ON research_similarity_archive (batch_id);

-- =============================================================================
-- Row Level Security (Immutability Enforcement)
-- Prevents UPDATE and DELETE operations at the database level, ensuring that
-- immutability does not depend solely on application code discipline.
-- Only INSERT and SELECT are permitted.
-- =============================================================================

ALTER TABLE research_similarity_archive ENABLE ROW LEVEL SECURITY;

-- Allow all INSERTs (new records can be written)
DROP POLICY IF EXISTS research_similarity_archive_insert_policy ON PLACEHOLDER;
CREATE POLICY research_similarity_archive_insert_policy
    ON research_similarity_archive
    FOR INSERT
    WITH CHECK (true);

-- Allow all SELECTs (records can be read)
DROP POLICY IF EXISTS research_similarity_archive_select_policy ON PLACEHOLDER;
CREATE POLICY research_similarity_archive_select_policy
    ON research_similarity_archive
    FOR SELECT
    USING (true);

-- Deny all UPDATEs (immutability: no record modification)
DROP POLICY IF EXISTS research_similarity_archive_no_update_policy ON PLACEHOLDER;
CREATE POLICY research_similarity_archive_no_update_policy
    ON research_similarity_archive
    FOR UPDATE
    USING (false);

-- Deny all DELETEs (immutability: no record removal)
DROP POLICY IF EXISTS research_similarity_archive_no_delete_policy ON PLACEHOLDER;
CREATE POLICY research_similarity_archive_no_delete_policy
    ON research_similarity_archive
    FOR DELETE
    USING (false);
