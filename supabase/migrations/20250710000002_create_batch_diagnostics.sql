-- Migration: Create batch_diagnostics table for process observation
-- Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5

CREATE TABLE IF NOT EXISTS batch_diagnostics (
  asset        TEXT        PRIMARY KEY,
  batch_id     TEXT        NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  diagnostics  JSONB       NOT NULL
);

-- RLS: anon + service_role can read; only service_role can write
ALTER TABLE batch_diagnostics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow read for all roles"
  ON batch_diagnostics FOR SELECT
  USING (true);

CREATE POLICY "Allow write for service role"
  ON batch_diagnostics FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');
