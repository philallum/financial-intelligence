-- Migration: Recreate api_keys table for commercial API release
-- Requirements: 1.3, 2.1, 2.2, 2.4, 5.1, 5.2, 5.3, 5.4
--
-- The original api_keys table (from 20240101000003) used SHA-256 hashes and a simple
-- tier/rate_limit_rpm schema. This migration drops it and recreates with the new schema:
-- Argon2id hashes, project_id FK, subscription plans, and usage counters.

-- Drop the old api_keys table
DROP TABLE IF EXISTS api_keys;

-- Create the updated api_keys table
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id),
  key_hash TEXT NOT NULL,                              -- Argon2id hash (longer than SHA-256)
  name VARCHAR(64) NOT NULL,                           -- Human-readable name (e.g., "Production Key 1")
  description VARCHAR(256),                            -- Optional description
  subscription_plan VARCHAR(20) NOT NULL DEFAULT 'FREE',
  is_active BOOLEAN NOT NULL DEFAULT true,
  rate_limit_override INTEGER,                         -- Enterprise custom limit (requests per period)
  daily_usage INTEGER NOT NULL DEFAULT 0,
  monthly_usage INTEGER NOT NULL DEFAULT 0,
  last_reset TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

-- Partial unique index: enforce unique key names per project among active keys
CREATE UNIQUE INDEX idx_api_keys_project_name_active
  ON api_keys (project_id, name)
  WHERE is_active = true;

-- Index on key_hash for fast lookup during authentication
CREATE INDEX idx_api_keys_hash
  ON api_keys (key_hash);

-- Index for looking up active keys by project
CREATE INDEX idx_api_keys_project_active
  ON api_keys (project_id)
  WHERE is_active = true;
