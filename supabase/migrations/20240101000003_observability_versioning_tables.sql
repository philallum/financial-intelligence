-- Migration: Observability and Versioning Tables
-- Requirements: 10.1, 16.1, 16.2, 11.7
-- Tables: execution_traces, batch_runs, engine_versions, api_keys

-- =============================================================================
-- Table: execution_traces
-- Purpose: Record structured trace after every engine execution for auditability
-- =============================================================================
CREATE TABLE IF NOT EXISTS execution_traces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    batch_id UUID NOT NULL,
    engine_name VARCHAR(30) NOT NULL,
    engine_version VARCHAR(10) NOT NULL,
    input_hash VARCHAR(64) NOT NULL,
    output_hash VARCHAR(64) NOT NULL,
    execution_time_ms INTEGER NOT NULL,
    sample_size INTEGER,
    status VARCHAR(10) NOT NULL DEFAULT 'success',
    error_detail TEXT,
    timestamp_utc TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trace_batch ON execution_traces (batch_id, engine_name);

-- =============================================================================
-- Table: batch_runs
-- Purpose: Track batch pipeline executions with status and engine version snapshot
-- =============================================================================
CREATE TABLE IF NOT EXISTS batch_runs (
    batch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trigger_time TIMESTAMP WITH TIME ZONE NOT NULL,
    candle_boundary TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'running',
    engine_versions JSONB NOT NULL,
    total_duration_ms INTEGER,
    completed_at TIMESTAMP WITH TIME ZONE,
    failure_detail TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =============================================================================
-- Table: engine_versions
-- Purpose: Track versioned engine configurations with unique constraint
-- =============================================================================
CREATE TABLE IF NOT EXISTS engine_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    engine_name VARCHAR(30) NOT NULL,
    engine_version VARCHAR(10) NOT NULL,
    quantile_table_version VARCHAR(10),
    fingerprint_schema_version VARCHAR(10),
    config JSONB NOT NULL,
    activated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT uq_engine_ver UNIQUE (engine_name, engine_version)
);

-- =============================================================================
-- Table: api_keys
-- Purpose: Store hashed API keys with tier and rate limit configuration
-- =============================================================================
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash VARCHAR(64) NOT NULL UNIQUE,
    tier VARCHAR(20) NOT NULL,
    rate_limit_rpm INTEGER NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_used_at TIMESTAMP WITH TIME ZONE
);
